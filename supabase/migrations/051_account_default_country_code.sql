-- ============================================================
-- 051_account_default_country_code.sql — a country for bare numbers
--
-- Most contact lists arrive as national numbers: "9831023021" rather
-- than "+919831023021". Nothing in the app could tell the difference
-- between that and a valid international number, because the E.164
-- check only asked for 7–15 digits starting non-zero — so a bare
-- 10-digit number passed validation and went to Meta as-is, where it
-- is read as some other country entirely and the send simply fails.
--
-- This column says which country a bare national number belongs to.
-- It is deliberately nullable: with no value set, a number that lacks
-- a country code is reported as unresolvable rather than guessed at,
-- because guessing wrong sends a real message to a real stranger.
--
-- Stored as an ISO 3166-1 alpha-2 region code ("IN", "GB", "US"),
-- which is what phone parsers take. It is NOT a dial prefix: several
-- countries share +1, and only the region tells them apart.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS default_country_code TEXT;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_default_country_code_format;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_default_country_code_format
  CHECK (default_country_code IS NULL OR default_country_code ~ '^[A-Z]{2}$');

COMMENT ON COLUMN accounts.default_country_code IS
  'ISO 3166-1 alpha-2 region ("IN") used to resolve contact numbers that carry no country code. NULL = do not guess; report such numbers as unresolvable.';
