-- ============================================================
-- 047_lead_form_segment_tag.sql — auto-segment web-form leads
--
-- Every lead form now owns a "segment" tag (`lead_forms.tag_id`) that
-- is applied to the contact on each submission, so a form's leads are
-- immediately targetable as a broadcast audience ("Contacts with tag
-- …") and by tag-triggered automations — no manual tagging step.
--
-- Backfill: forms created before this migration get a tag named after
-- the form, and the contacts of their existing submissions are tagged
-- retroactively so historical leads land in the segment too.
-- ============================================================

ALTER TABLE lead_forms
  ADD COLUMN IF NOT EXISTS tag_id UUID REFERENCES tags(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lead_forms_tag ON lead_forms(tag_id);

COMMENT ON COLUMN lead_forms.tag_id IS
  'Segment tag applied to every contact that submits this form. NULL = create one named after the form on next save/submission.';

-- Backfill a segment tag for every existing form that has none.
DO $$
DECLARE
  f RECORD;
  v_tag_id UUID;
BEGIN
  FOR f IN
    SELECT id, name, account_id, created_by
    FROM lead_forms
    WHERE tag_id IS NULL
  LOOP
    INSERT INTO tags (user_id, account_id, name, color)
    VALUES (f.created_by, f.account_id, f.name, '#0ea5e9')
    RETURNING id INTO v_tag_id;

    UPDATE lead_forms SET tag_id = v_tag_id WHERE id = f.id;

    -- Tag the contacts of submissions received before this migration.
    INSERT INTO contact_tags (contact_id, tag_id)
    SELECT DISTINCT s.contact_id, v_tag_id
    FROM lead_form_submissions s
    WHERE s.lead_form_id = f.id AND s.contact_id IS NOT NULL
    ON CONFLICT (contact_id, tag_id) DO NOTHING;
  END LOOP;
END
$$;
