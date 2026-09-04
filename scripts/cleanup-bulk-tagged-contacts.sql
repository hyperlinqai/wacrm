-- ============================================================
-- Remove the tags the public API bug sprayed onto new contacts.
--
-- Between 2026-09-02 18:36 UTC and the deploy of the fix, every contact
-- created or updated through POST /api/v1/contacts with a `tags` array
-- received EVERY tag in the account (setContactTags took the whole
-- tag map instead of the requested names). Those tags were written in
-- one burst within seconds of the contact's creation.
--
-- This removes contact_tags rows that
--   * belong to a contact created on/after the bug started,
--   * were written within 30 seconds of that contact's creation
--     (the burst — tags a person adds later are untouched), and
--   * are not the Meta Lead Ads segment tag, which the lead pipeline
--     applies legitimately in that same window.
--
-- It is scoped to one account. Run query 1 first: it changes nothing
-- and shows exactly what query 2 deletes. The intended tags of the
-- affected API calls are unknown (the caller's request bodies are not
-- logged), so they cannot be restored here — the caller can resend
-- them once the fix is live.
-- ============================================================

\set account '3463fcc5-bcc5-42dd-99bb-22a93d9d43d1'
\set bug_started '2026-09-02 18:30:00+00'
\set keep_tag '6383fd1f-ec98-4615-aab9-c71583e9897f'

set role service_role;

-- ════════════════════════════════════════════════════════════
-- 1. PREVIEW — read-only
-- ════════════════════════════════════════════════════════════
WITH burst AS (
  SELECT ct.id, c.id AS contact_id, c.phone, c.created_at, t.name
  FROM contact_tags ct
  JOIN contacts c ON c.id = ct.contact_id
  JOIN tags t ON t.id = ct.tag_id
  WHERE c.account_id = :'account'
    AND c.created_at >= :'bug_started'
    AND ct.created_at <= c.created_at + interval '30 seconds'
    AND ct.tag_id <> :'keep_tag'
)
SELECT contact_id, phone, created_at::timestamp(0), count(*) AS tags_to_remove
FROM burst
GROUP BY contact_id, phone, created_at
ORDER BY created_at;

-- ════════════════════════════════════════════════════════════
-- 2. APPLY — same predicate, inside a transaction. Compare the
--    row count with the preview's total before COMMIT.
-- ════════════════════════════════════════════════════════════
BEGIN;

DELETE FROM contact_tags ct
USING contacts c
WHERE ct.contact_id = c.id
  AND c.account_id = :'account'
  AND c.created_at >= :'bug_started'
  AND ct.created_at <= c.created_at + interval '30 seconds'
  AND ct.tag_id <> :'keep_tag';

-- Matches the preview? COMMIT. Anything unexpected? ROLLBACK.
COMMIT;
-- ROLLBACK;
