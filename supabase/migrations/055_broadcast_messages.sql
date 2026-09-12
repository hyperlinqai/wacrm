-- ============================================================
-- 055: record broadcast sends as conversation messages
--
-- A broadcast used to live only in `broadcast_recipients` (delivery
-- stats). The recipient's conversation never heard about it, so:
--   * the inbox thread showed the customer's reply with no context,
--   * an external inbox grouping threads by route (CRM Live Chat) could
--     not show broadcast recipients at all until they replied.
--
-- Now every recipient that reached Meta (whatsapp_message_id set) gets
-- an outbound `messages` row in the contact's conversation, tagged with
-- `broadcast_id`, created at the send time and carrying the rendered
-- template body. Meta's delivery/read webhooks already update messages
-- by `message_id`, so the ticks on the bubble stay live.
--
-- Done in a trigger rather than app code because three code paths write
-- recipient rows (public API, resume, and the dashboard's browser-side
-- fan-out) and they must all behave the same. The same function
-- backfills every recipient sent before this migration.
-- ============================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS broadcast_id UUID REFERENCES public.broadcasts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_broadcast
  ON public.messages (broadcast_id) WHERE broadcast_id IS NOT NULL;

-- Render "{{1}}, {{2}}…" in a template body with the recipient's params.
CREATE OR REPLACE FUNCTION public.render_template_body(p_body TEXT, p_params JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_out TEXT := p_body;
  v_i   INT;
BEGIN
  IF p_body IS NULL THEN RETURN NULL; END IF;
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'array' THEN RETURN v_out; END IF;
  FOR v_i IN 1..jsonb_array_length(p_params) LOOP
    v_out := replace(v_out, '{{' || v_i || '}}', COALESCE(p_params ->> (v_i - 1), ''));
  END LOOP;
  RETURN v_out;
END;
$$;

-- Ensure the recipient's conversation exists and holds one outbound
-- message for this send. Idempotent: a second call for the same
-- recipient is a no-op (unique (conversation_id, message_id)).
CREATE OR REPLACE FUNCTION public.record_broadcast_message(p_recipient_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
  r               public.broadcast_recipients%ROWTYPE;
  b               public.broadcasts%ROWTYPE;
  v_conversation  UUID;
  v_body          TEXT;
  v_status        TEXT;
  v_sent_at       TIMESTAMPTZ;
  v_message       UUID;
BEGIN
  SELECT * INTO r FROM public.broadcast_recipients WHERE id = p_recipient_id;
  IF NOT FOUND OR r.whatsapp_message_id IS NULL OR r.contact_id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO b FROM public.broadcasts WHERE id = r.broadcast_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_sent_at := COALESCE(r.sent_at, r.created_at, now());

  -- One conversation per (organization, contact) — reuse or create.
  SELECT id INTO v_conversation
  FROM public.conversations
  WHERE organization_id = b.organization_id AND contact_id = r.contact_id;
  IF v_conversation IS NULL THEN
    INSERT INTO public.conversations (user_id, account_id, organization_id, contact_id, status, created_at, updated_at)
    VALUES (b.user_id, b.account_id, b.organization_id, r.contact_id, 'open', v_sent_at, v_sent_at)
    ON CONFLICT (organization_id, contact_id) DO UPDATE SET updated_at = public.conversations.updated_at
    RETURNING id INTO v_conversation;
  END IF;

  SELECT public.render_template_body(t.body_text, r.template_params) INTO v_body
  FROM public.message_templates t
  WHERE t.organization_id = b.organization_id AND t.name = b.template_name
  ORDER BY (t.language = b.template_language) DESC, t.updated_at DESC NULLS LAST
  LIMIT 1;

  v_status := CASE r.status
    WHEN 'read'      THEN 'read'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'failed'    THEN 'failed'
    ELSE 'sent'
  END;

  INSERT INTO public.messages
    (conversation_id, sender_type, content_type, content_text, template_name, message_id, status, created_at, broadcast_id)
  VALUES
    (v_conversation, 'bot', 'template', v_body, b.template_name, r.whatsapp_message_id, v_status, v_sent_at, b.id)
  ON CONFLICT (conversation_id, message_id) DO NOTHING
  RETURNING id INTO v_message;

  IF v_message IS NULL THEN RETURN NULL; END IF;

  -- Surface it as the latest message unless something newer already is.
  UPDATE public.conversations
  SET last_message_text = COALESCE(v_body, '[template: ' || b.template_name || ']'),
      last_message_at   = v_sent_at,
      updated_at        = GREATEST(updated_at, v_sent_at)
  WHERE id = v_conversation
    AND (last_message_at IS NULL OR last_message_at <= v_sent_at);

  RETURN v_message;
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_recipient_record_message_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.whatsapp_message_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.whatsapp_message_id IS DISTINCT FROM NEW.whatsapp_message_id)
  THEN
    PERFORM public.record_broadcast_message(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS broadcast_recipient_record_message ON public.broadcast_recipients;
CREATE TRIGGER broadcast_recipient_record_message
  AFTER INSERT OR UPDATE OF whatsapp_message_id ON public.broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.broadcast_recipient_record_message_trigger();

-- Backfill every send that reached Meta before this migration, oldest
-- first so `last_message_*` lands on the newest send.
DO $$
DECLARE
  v_rec  RECORD;
  v_done INT := 0;
BEGIN
  FOR v_rec IN
    SELECT id FROM public.broadcast_recipients
    WHERE whatsapp_message_id IS NOT NULL
    ORDER BY sent_at NULLS FIRST, created_at
  LOOP
    IF public.record_broadcast_message(v_rec.id) IS NOT NULL THEN v_done := v_done + 1; END IF;
  END LOOP;
  RAISE NOTICE '055: recorded % broadcast sends as messages', v_done;
END;
$$;
