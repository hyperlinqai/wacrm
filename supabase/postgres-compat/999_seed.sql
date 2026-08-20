-- Demo seed for a stock Postgres apply. Idempotent on demo@wacrm.local.
-- With the self-host stack (supabase/self-host) running, this user can
-- log in: demo@wacrm.local / Demo123!

DO $$
DECLARE
  v_user_id      uuid := '11111111-1111-4111-8111-111111111111';
  v_account_id   uuid;
  v_tag_lead     uuid := '21111111-1111-4111-8111-111111111111';
  v_tag_customer uuid := '21111111-1111-4111-8111-111111111112';
  v_tag_vip      uuid := '21111111-1111-4111-8111-111111111113';
  v_c1           uuid := '31111111-1111-4111-8111-111111111111';
  v_c2           uuid := '31111111-1111-4111-8111-111111111112';
  v_c3           uuid := '31111111-1111-4111-8111-111111111113';
  v_c4           uuid := '31111111-1111-4111-8111-111111111114';
  v_conv1        uuid := '41111111-1111-4111-8111-111111111111';
  v_conv2        uuid := '41111111-1111-4111-8111-111111111112';
  v_pipe         uuid := '51111111-1111-4111-8111-111111111111';
  v_st_new       uuid := '52111111-1111-4111-8111-111111111111';
  v_st_qual      uuid := '52111111-1111-4111-8111-111111111112';
  v_st_prop      uuid := '52111111-1111-4111-8111-111111111113';
  v_st_won       uuid := '52111111-1111-4111-8111-111111111114';
  v_auto         uuid := '61111111-1111-4111-8111-111111111111';
  v_doc          uuid := '71111111-1111-4111-8111-111111111111';
BEGIN
  -- instance_id must be the nil UUID: GoTrue scopes every user lookup to
  -- it, and a NULL here makes password logins fail with
  -- "Invalid login credentials".
  INSERT INTO auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    raw_user_meta_data, raw_app_meta_data, role, aud
  )
  VALUES (
    v_user_id,
    '00000000-0000-0000-0000-000000000000',
    'demo@wacrm.local',
    crypt('Demo123!', gen_salt('bf')),
    now(),
    jsonb_build_object('full_name', 'Demo Owner'),
    '{"provider":"email","providers":["email"]}'::jsonb,
    'authenticated',
    'authenticated'
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE auth.users
  SET instance_id = '00000000-0000-0000-0000-000000000000'
  WHERE id = v_user_id AND instance_id IS NULL;

  -- GoTrue also requires an identities row for password users. On a
  -- fresh database (before GoTrue's migrations run) the table may not
  -- exist yet — GoTrue backfills identities from users in that case.
  IF to_regclass('auth.identities') IS NOT NULL THEN
    INSERT INTO auth.identities (
      id, provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    )
    VALUES (
      gen_random_uuid(),
      v_user_id::text,
      v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', 'demo@wacrm.local'),
      'email',
      now(), now(), now()
    )
    ON CONFLICT (provider_id, provider) DO NOTHING;
  END IF;

  SELECT account_id INTO v_account_id
  FROM profiles
  WHERE user_id = v_user_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Seed failed: handle_new_user did not create a profile/account for demo@wacrm.local';
  END IF;

  UPDATE profiles
  SET full_name = 'Demo Owner',
      email = 'demo@wacrm.local',
      beta_features = ARRAY['flows', 'ai_replies']
  WHERE user_id = v_user_id;

  UPDATE accounts
  SET name = 'WA-CRM Demo',
      default_currency = 'USD'
  WHERE id = v_account_id;

  INSERT INTO tags (id, user_id, account_id, name, color) VALUES
    (v_tag_lead,     v_user_id, v_account_id, 'Lead',     '#3b82f6'),
    (v_tag_customer, v_user_id, v_account_id, 'Customer', '#22c55e'),
    (v_tag_vip,      v_user_id, v_account_id, 'VIP',      '#a855f7')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO contacts (id, user_id, account_id, phone, name, email, company) VALUES
    (v_c1, v_user_id, v_account_id, '+15551230001', 'Aisha Khan',    'aisha@example.com',  'Northwind'),
    (v_c2, v_user_id, v_account_id, '+15551230002', 'James Patel',   'james@example.com',  'Contoso'),
    (v_c3, v_user_id, v_account_id, '+15551230003', 'Sofia Alvarez', 'sofia@example.com',  'Fabrikam'),
    (v_c4, v_user_id, v_account_id, '+15551230004', 'Omar Hassan',   'omar@example.com',   'Adventure Works')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO contact_tags (contact_id, tag_id) VALUES
    (v_c1, v_tag_lead),
    (v_c2, v_tag_customer),
    (v_c2, v_tag_vip),
    (v_c3, v_tag_lead),
    (v_c4, v_tag_customer)
  ON CONFLICT (contact_id, tag_id) DO NOTHING;

  INSERT INTO contact_notes (id, contact_id, user_id, account_id, note_text) VALUES
    ('e1111111-1111-4111-8111-111111111111', v_c1, v_user_id, v_account_id, 'Asked for a product demo next week.'),
    ('e1111111-1111-4111-8111-111111111112', v_c2, v_user_id, v_account_id, 'Existing customer — renewal in 45 days.')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO conversations (
    id, user_id, account_id, contact_id, status,
    assigned_agent_id, last_message_text, last_message_at, unread_count
  ) VALUES
    (v_conv1, v_user_id, v_account_id, v_c1, 'open', v_user_id,
     'Can you send the pricing sheet?', now() - interval '12 minutes', 1),
    (v_conv2, v_user_id, v_account_id, v_c2, 'pending', v_user_id,
     'Thanks — we will review internally.', now() - interval '2 hours', 0)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO messages (id, conversation_id, sender_type, sender_id, content_type, content_text, status, created_at)
  VALUES
    ('81111111-1111-4111-8111-111111111111', v_conv1, 'customer', NULL, 'text',
     'Hi, I saw your WhatsApp ad. Do you offer onboarding support?', 'read', now() - interval '40 minutes'),
    ('81111111-1111-4111-8111-111111111112', v_conv1, 'agent', v_user_id, 'text',
     'Yes — we include a 2-week onboarding for every new workspace.', 'read', now() - interval '35 minutes'),
    ('81111111-1111-4111-8111-111111111113', v_conv1, 'customer', NULL, 'text',
     'Can you send the pricing sheet?', 'delivered', now() - interval '12 minutes'),
    ('81111111-1111-4111-8111-111111111114', v_conv2, 'agent', v_user_id, 'text',
     'Here is the renewal quote for this quarter.', 'read', now() - interval '5 hours'),
    ('81111111-1111-4111-8111-111111111115', v_conv2, 'customer', NULL, 'text',
     'Thanks — we will review internally.', 'read', now() - interval '2 hours')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO pipelines (id, user_id, account_id, name) VALUES
    (v_pipe, v_user_id, v_account_id, 'Sales pipeline')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO pipeline_stages (id, pipeline_id, name, position, color) VALUES
    (v_st_new,  v_pipe, 'New',         0, '#94a3b8'),
    (v_st_qual, v_pipe, 'Qualified',   1, '#3b82f6'),
    (v_st_prop, v_pipe, 'Proposal',    2, '#f59e0b'),
    (v_st_won,  v_pipe, 'Closed won',  3, '#22c55e')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO deals (
    id, user_id, account_id, pipeline_id, stage_id, contact_id, conversation_id,
    title, value, currency, status, notes
  ) VALUES
    ('91111111-1111-4111-8111-111111111111', v_user_id, v_account_id, v_pipe, v_st_qual, v_c1, v_conv1,
     'Northwind onboarding', 4800, 'USD', 'open', 'Waiting on pricing follow-up'),
    ('91111111-1111-4111-8111-111111111112', v_user_id, v_account_id, v_pipe, v_st_prop, v_c2, v_conv2,
     'Contoso renewal', 12600, 'USD', 'open', 'Quote sent'),
    ('91111111-1111-4111-8111-111111111113', v_user_id, v_account_id, v_pipe, v_st_won, v_c4, NULL,
     'Adventure Works kickoff', 8900, 'USD', 'won', 'Closed last month')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO message_templates (
    id, user_id, account_id, name, category, language, body_text, footer_text, status
  ) VALUES
    ('a1111111-1111-4111-8111-111111111111', v_user_id, v_account_id,
     'welcome_message', 'Utility', 'en_US',
     'Hi {{1}}, welcome to WA-CRM. Reply here and a teammate will pick this up.',
     'Sent via WA-CRM', 'DRAFT')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO quick_replies (id, account_id, user_id, title, kind, content_text)
  VALUES
    ('b1111111-1111-4111-8111-111111111111', v_account_id, v_user_id, 'Greeting',
     'text', 'Thanks for messaging us — how can we help today?')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO automations (id, user_id, account_id, name, description, trigger_type, trigger_config, is_active)
  VALUES
    (v_auto, v_user_id, v_account_id, 'Tag new inbound chats',
     'Adds the Lead tag when a new conversation starts.',
     'first_inbound_message', '{}'::jsonb, false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO automation_steps (id, automation_id, step_type, step_config, position)
  VALUES
    ('c1111111-1111-4111-8111-111111111111', v_auto, 'add_tag',
     jsonb_build_object('tag_id', v_tag_lead), 0)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO ai_knowledge_documents (id, account_id, created_by, title, content)
  VALUES
    (v_doc, v_account_id, v_user_id, 'Business hours',
     'Support is available Monday to Friday, 9:00 to 18:00 IST. After hours, leave a message and we reply the next business day.')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO ai_knowledge_chunks (id, document_id, account_id, chunk_index, content)
  VALUES
    ('d1111111-1111-4111-8111-111111111111', v_doc, v_account_id, 0,
     'Support is available Monday to Friday, 9:00 to 18:00 IST. After hours, leave a message and we reply the next business day.')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  VALUES (v_user_id, v_account_id, 'online', now())
  ON CONFLICT (user_id) DO UPDATE SET status = 'online', last_seen_at = now();
END
$$;
