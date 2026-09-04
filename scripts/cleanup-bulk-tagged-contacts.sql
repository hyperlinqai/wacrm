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

-- ============================================================
-- 3. The other burst: contacts that already existed
--
-- The same bug hit PUT-style calls too. When the caller first synced
-- its lead list (2026-09-02 18:35–18:36 UTC) 99 contacts imported days
-- earlier received every tag in one burst. Those rows sit in that one
-- window and nowhere else, so: remove every contact_tags row written
-- in the window for a contact that got 20+ rows in it (the burst
-- tail gave the last 16 contacts only 21–50 tags each), except the
-- Meta segment tag on a contact that genuinely came through a Meta
-- lead. Tags from before the window, and anything a person added
-- afterwards, are untouched. Preview, then apply.
-- ============================================================
\set burst_from '2026-09-02 18:34:00+00'
\set burst_to   '2026-09-02 18:38:00+00'

WITH hit AS (
  SELECT ct.contact_id
  FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id
  WHERE c.account_id = :'account'
    AND ct.created_at >= :'burst_from' AND ct.created_at < :'burst_to'
  GROUP BY ct.contact_id HAVING count(*) >= 20
)
SELECT count(*) AS rows_to_remove, count(DISTINCT ct.contact_id) AS contacts
FROM contact_tags ct JOIN hit ON hit.contact_id = ct.contact_id
WHERE ct.created_at >= :'burst_from' AND ct.created_at < :'burst_to'
  AND NOT (ct.tag_id = :'keep_tag'
           AND EXISTS (SELECT 1 FROM meta_leads ml WHERE ml.contact_id = ct.contact_id));

BEGIN;
WITH hit AS (
  SELECT ct.contact_id
  FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id
  WHERE c.account_id = :'account'
    AND ct.created_at >= :'burst_from' AND ct.created_at < :'burst_to'
  GROUP BY ct.contact_id HAVING count(*) >= 20
)
DELETE FROM contact_tags ct
USING hit
WHERE hit.contact_id = ct.contact_id
  AND ct.created_at >= :'burst_from' AND ct.created_at < :'burst_to'
  AND NOT (ct.tag_id = :'keep_tag'
           AND EXISTS (SELECT 1 FROM meta_leads ml WHERE ml.contact_id = ct.contact_id));
COMMIT;
-- ROLLBACK;
