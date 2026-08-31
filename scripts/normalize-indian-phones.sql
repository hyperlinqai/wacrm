-- ============================================================
-- Normalise Indian contact numbers to E.164 (+91XXXXXXXXXX).
--
-- Run query 1 first. It writes nothing and shows exactly what query 2
-- would do. Both share the same `repair` CTE, so the preview cannot
-- drift from the update.
--
-- What this deliberately does NOT touch:
--
--   * Numbers Excel flattened to "9.18319E+11". The digits that survive
--     start with "91", so a plain "already has 91, just add +" rule
--     turns them into a well-formed number belonging to a stranger.
--     Excel discarded the real digits; nothing can bring them back.
--   * Fragments like "6284" and "329", and wrong-length numbers like
--     "942409015". Prefixing +91 to those invents a number.
--   * Any row whose cleaned value is already held by another contact.
--     `contacts.phone_normalized` is a generated column (digits of
--     `phone`) carrying a UNIQUE index per account AND per organization,
--     so such an UPDATE would abort the whole statement. Those rows are
--     one person stored twice; merge them in the UI, where you can
--     choose which name, tags and history survive.
--
-- The rules assume Indian numbering: a mobile is 10 digits starting
-- 6-9, country code 91. A 12-digit number starting 91 that is NOT
-- Indian would be misread — read the preview if your list is not
-- India-only.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. PREVIEW — read-only, changes nothing
-- ════════════════════════════════════════════════════════════
WITH repair AS (
  SELECT p.id, p.account_id, p.organization_id, p.name, p.phone, p.new_phone,
         CASE
           WHEN p.new_phone IS NULL   THEN 'skip: no rule matches'
           WHEN p.new_phone = p.phone THEN 'skip: already correct'
           WHEN EXISTS (
             SELECT 1 FROM contacts o
             WHERE o.id <> p.id
               AND o.phone_normalized = regexp_replace(p.new_phone, '\D', '', 'g')
               AND (o.account_id = p.account_id OR o.organization_id = p.organization_id)
           )                          THEN 'skip: collides with another contact'
           ELSE 'update'
         END AS verdict
  FROM (
    SELECT c.id, c.account_id, c.organization_id, c.name, c.phone,
           CASE
             WHEN d.digits ~ '^91[6-9][0-9]{9}$'   THEN '+' || d.digits               -- has 91, needs +
             WHEN d.digits ~ '^[6-9][0-9]{9}$'     THEN '+91' || d.digits             -- bare mobile
             WHEN d.digits ~ '^0[6-9][0-9]{9}$'    THEN '+91' || right(d.digits, 10)  -- trunk zero
             WHEN d.digits ~ '^0091[6-9][0-9]{9}$' THEN '+91' || right(d.digits, 10)  -- 00 prefix
           END AS new_phone
    FROM contacts c
    CROSS JOIN LATERAL (SELECT regexp_replace(c.phone, '\D', '', 'g') AS digits) d
    WHERE c.phone IS NOT NULL
      AND c.phone !~ '[eE]'      -- Excel scientific notation: unrecoverable
  ) p
)
SELECT verdict, count(*) AS rows,
       string_agg(phone || ' -> ' || coalesce(new_phone, '(none)'), E'\n'
                  ORDER BY phone) AS examples
FROM repair
GROUP BY verdict
ORDER BY rows DESC;


-- ════════════════════════════════════════════════════════════
-- 2. APPLY — wrapped in a transaction so you can check the row
--    count before committing. Same CTE, verbatim.
-- ════════════════════════════════════════════════════════════
BEGIN;

WITH repair AS (
  SELECT p.id, p.phone, p.new_phone,
         CASE
           WHEN p.new_phone IS NULL   THEN 'skip: no rule matches'
           WHEN p.new_phone = p.phone THEN 'skip: already correct'
           WHEN EXISTS (
             SELECT 1 FROM contacts o
             WHERE o.id <> p.id
               AND o.phone_normalized = regexp_replace(p.new_phone, '\D', '', 'g')
               AND (o.account_id = p.account_id OR o.organization_id = p.organization_id)
           )                          THEN 'skip: collides with another contact'
           ELSE 'update'
         END AS verdict
  FROM (
    SELECT c.id, c.account_id, c.organization_id, c.phone,
           CASE
             WHEN d.digits ~ '^91[6-9][0-9]{9}$'   THEN '+' || d.digits
             WHEN d.digits ~ '^[6-9][0-9]{9}$'     THEN '+91' || d.digits
             WHEN d.digits ~ '^0[6-9][0-9]{9}$'    THEN '+91' || right(d.digits, 10)
             WHEN d.digits ~ '^0091[6-9][0-9]{9}$' THEN '+91' || right(d.digits, 10)
           END AS new_phone
    FROM contacts c
    CROSS JOIN LATERAL (SELECT regexp_replace(c.phone, '\D', '', 'g') AS digits) d
    WHERE c.phone IS NOT NULL
      AND c.phone !~ '[eE]'
  ) p
)
UPDATE contacts c
   SET phone = r.new_phone
  FROM repair r
 WHERE c.id = r.id
   AND r.verdict = 'update';

-- Compare the reported row count with the preview's "update" count.
-- Matches? COMMIT. Anything unexpected? ROLLBACK.
COMMIT;
-- ROLLBACK;
