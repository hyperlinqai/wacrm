-- ============================================================
-- Re-attribute Meta leads that the customer's app pushed first.
--
-- The customer's app receives the same leadgen webhook as the CRM and
-- creates the contact through the public API a few milliseconds
-- earlier, so the contact is born with source = 'api'. The lead
-- pipeline then matches it but (until this fix) only rewrote 'manual'.
-- This sets source = 'meta_ads' on contacts that have a meta_leads
-- row and were created within 15 minutes of that lead — the same rule
-- the pipeline now applies going forward.
-- ============================================================
\set account '3463fcc5-bcc5-42dd-99bb-22a93d9d43d1'
set role service_role;

-- Preview
SELECT c.phone, c.source, c.created_at::timestamp(0), coalesce(l.lead_created_at, l.created_at)::timestamp(0) AS lead_at
FROM contacts c JOIN meta_leads l ON l.contact_id = c.id
WHERE c.account_id = :'account' AND c.source = 'api'
  AND abs(extract(epoch FROM (c.created_at - coalesce(l.lead_created_at, l.created_at)))) <= 900
ORDER BY c.created_at;

BEGIN;
UPDATE contacts c SET source = 'meta_ads'
FROM meta_leads l
WHERE l.contact_id = c.id
  AND c.account_id = :'account'
  AND c.source = 'api'
  AND abs(extract(epoch FROM (c.created_at - coalesce(l.lead_created_at, l.created_at)))) <= 900;
COMMIT;
-- ROLLBACK;
