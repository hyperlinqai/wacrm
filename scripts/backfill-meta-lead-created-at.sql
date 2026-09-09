-- Backfill contacts.created_at from the Meta lead's own created_time.
--
-- Before apps/api/src/lib/meta-leads/process-lead.ts passed the lead's
-- created_time through to the insert, a contact created by the Meta
-- Lead Ads Sync got created_at = the moment the Sync ran. A June lead
-- pulled in on 2 September therefore showed as a September contact.
-- meta_leads.lead_created_at has always held Meta's timestamp, so the
-- true date is recoverable for every linked contact.
--
-- Rule: for each contact linked to at least one meta_leads row, if the
-- earliest lead predates created_at, set created_at to that lead time.
-- A contact that predates its lead (an app-created contact who later
-- submitted an ad form) is left alone. updated_at is bumped by the
-- table's trigger, which is fine.
--
-- Usage (psql / scripts/apply-postgres.sh):
--   BEGIN; \i scripts/backfill-meta-lead-created-at.sql; COMMIT;

WITH earliest AS (
  SELECT ml.contact_id, min(ml.lead_created_at) AS lead_at
    FROM meta_leads ml
   WHERE ml.contact_id IS NOT NULL
     AND ml.lead_created_at IS NOT NULL
   GROUP BY ml.contact_id
)
UPDATE contacts c
   SET created_at = e.lead_at
  FROM earliest e
 WHERE c.id = e.contact_id
   AND e.lead_at < c.created_at;
