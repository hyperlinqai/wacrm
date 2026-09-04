-- ============================================================
-- 053_contact_phone_autonormalize.sql — clean the number on the way in
--
-- Until now a contact's number was stored exactly as typed or
-- imported: "9831023021", "0 98310-23021", "91 98310 23021". None of
-- those can be messaged — Meta needs "+919831023021" — and the only
-- way to repair them was to open the Validation page after the fact
-- and press Fix. Every path that creates a contact (manual form, CSV
-- import, public API, inbound WhatsApp, Meta Lead Ads, flows) had to
-- remember to do the same thing, and most of them did not.
--
-- This migration moves that repair into the database so it happens on
-- every insert, and on every change of the number, no matter which
-- code path wrote it:
--
--   1. `phone_country_rules` — per-country dial code, trunk prefix and
--      the national-number pattern. Generated from libphonenumber-js's
--      own metadata (the same library the app's `cleanPhone` uses), so
--      the database and the app agree on what a valid number is.
--   2. `normalize_contact_phone(raw, country)` — the pure rule, mirroring
--      `packages/shared/src/whatsapp/phone-clean.ts` as far as SQL can:
--        * "+…" / "00…"           → keep the country code, drop formatting
--        * valid national number  → prefix the account's dial code
--        * trunk "0" + national   → drop the 0, prefix the dial code
--        * dial code without "+"  → add the "+"
--      Anything it cannot resolve SAFELY is left exactly as written, so
--      the Validation page can still show it and a human can decide.
--      It never invents digits: Excel-flattened "9.18E+11", fragments,
--      and wrong-length numbers pass through untouched.
--   3. A BEFORE INSERT OR UPDATE OF phone trigger on `contacts` that
--      applies the rule with the account's `default_country_code`
--      (migration 051). With no default country set, only the
--      already-international cases are cleaned — a bare national
--      number is not guessed at, exactly as the app behaves.
--
-- What this deliberately does NOT do: rewrite the rows that already
-- exist. That is the Validation page's job, where the operator sees
-- the before/after and the "same person stored twice" collisions the
-- unique index (022/043) would otherwise turn into a failed bulk
-- update. Press "Fix" there once after deploying.
--
-- Idempotent: re-running reseeds the rules and recreates the trigger.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Country rules (from libphonenumber-js metadata, version 4)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phone_country_rules (
  country_code     TEXT PRIMARY KEY CHECK (country_code ~ '^[A-Z]{2}$'),
  -- Dial code without "+", e.g. "91". Several countries share one.
  calling_code     TEXT NOT NULL,
  -- Trunk prefix dropped when dialling internationally ("0" for India,
  -- "1" for the US), NULL where the country has none.
  national_prefix  TEXT,
  -- True where "011" (not "00") is the international access prefix
  -- (North America). Elsewhere "011…" can be a real number — Delhi's
  -- STD code is 011 — so it must not be stripped blindly.
  idd_011          BOOLEAN NOT NULL DEFAULT false,
  -- Regex the national significant number must match in full.
  national_pattern TEXT NOT NULL
);

ALTER TABLE public.phone_country_rules OWNER TO postgres;
COMMENT ON TABLE public.phone_country_rules IS
  'Per-country phone rules for normalize_contact_phone(). Generated from libphonenumber-js metadata; regenerate rather than hand-edit.';

-- Reference data readable by everyone, writable by nobody but the owner.
ALTER TABLE public.phone_country_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS phone_country_rules_read ON public.phone_country_rules;
CREATE POLICY phone_country_rules_read ON public.phone_country_rules
  FOR SELECT USING (true);
GRANT SELECT ON public.phone_country_rules TO authenticated, service_role;

INSERT INTO public.phone_country_rules
  (country_code, calling_code, national_prefix, idd_011, national_pattern)
VALUES
  ('AC', '247', NULL, false, '(?:[01589]\d|[2-467])\d{4}'),
  ('AD', '376', NULL, false, '(?:1|6\d)\d{7}|[135-9]\d{5}'),
  ('AE', '971', '0', false, '(?:[4-7]\d|9[0-689])\d{7}|800\d{2,9}|[2-4679]\d{7}'),
  ('AF', '93', '0', false, '[2-7]\d{8}'),
  ('AG', '1', '1', true, '(?:268|[58]\d\d|900)\d{7}'),
  ('AI', '1', '1', true, '(?:264|[58]\d\d|900)\d{7}'),
  ('AL', '355', '0', false, '(?:700\d\d|900)\d{3}|8\d{5,7}|(?:[2-5]|6\d)\d{7}'),
  ('AM', '374', '0', false, '(?:[1-489]\d|55|60|77)\d{6}'),
  ('AO', '244', NULL, false, '[29]\d{8}'),
  ('AR', '54', '0', false, '(?:11|[89]\d\d)\d{8}|[2368]\d{9}'),
  ('AS', '1', '1', true, '(?:[58]\d\d|684|900)\d{7}'),
  ('AT', '43', '0', false, '1\d{3,12}|2\d{6,12}|43(?:(?:0\d|5[02-9])\d{3,9}|2\d{4,5}|[3467]\d{4}|8\d{4,6}|9\d{4,7})|5\d{4,12}|8\d{7,12}|9\d{8,12}|(?:[367]\d|4[0-24-9])\d{4,11}'),
  ('AU', '61', '0', false, '1(?:[0-79]\d{7}(?:\d(?:\d{2})?)?|8[0-24-9]\d{7})|[2-478]\d{8}|1\d{4,7}'),
  ('AW', '297', NULL, false, '(?:[25-79]\d\d|800)\d{4}'),
  ('AX', '358', '0', false, '2\d{4,9}|35\d{4,5}|(?:60\d\d|800)\d{4,6}|7\d{5,11}|(?:[14]\d|3[0-46-9]|50)\d{4,8}'),
  ('AZ', '994', '0', false, '365\d{6}|(?:[124579]\d|60|88)\d{7}'),
  ('BA', '387', '0', false, '6\d{8}|(?:[35689]\d|49|70)\d{6}'),
  ('BB', '1', '1', true, '(?:246|[58]\d\d|900)\d{7}'),
  ('BD', '880', '0', false, '[1-469]\d{9}|8[0-79]\d{7,8}|[2-79]\d{8}|[2-9]\d{7}|[3-9]\d{6}|[57-9]\d{5}'),
  ('BE', '32', '0', false, '4\d{8}|[1-9]\d{7}'),
  ('BF', '226', NULL, false, '[024-7]\d{7}'),
  ('BG', '359', '0', false, '00800\d{7}|[2-7]\d{6,7}|[89]\d{6,8}|2\d{5}'),
  ('BH', '973', NULL, false, '[136-9]\d{7}'),
  ('BI', '257', NULL, false, '(?:[267]\d|31)\d{6}'),
  ('BJ', '229', NULL, false, '(?:01\d|8)\d{7}'),
  ('BL', '590', '0', false, '7090\d{5}|(?:[56]9|[89]\d)\d{7}'),
  ('BM', '1', '1', true, '(?:441|[58]\d\d|900)\d{7}'),
  ('BN', '673', NULL, false, '[2-578]\d{6}'),
  ('BO', '591', '0', false, '(?:[2-7]\d\d|8001)\d{5}'),
  ('BQ', '599', NULL, false, '(?:[34]1|7\d)\d{5}'),
  ('BR', '55', '0', false, '[1-467]\d{9,10}|55[0-46-9]\d{8}|[34]\d{7}|55\d{7,8}|(?:5[0-46-9]|[89]\d)\d{7,9}'),
  ('BS', '1', '1', true, '(?:242|[58]\d\d|900)\d{7}'),
  ('BT', '975', NULL, false, '[178]\d{7}|[2-8]\d{6}'),
  ('BW', '267', NULL, false, '(?:0800|(?:[37]|800)\d)\d{6}|(?:[2-6]\d|90)\d{5}'),
  ('BY', '375', '8', false, '(?:[12]\d|33|44|902)\d{7}|8(?:0[0-79]\d{5,7}|[1-7]\d{9})|8(?:1[0-489]|[5-79]\d)\d{7}|8[1-79]\d{6,7}|8[0-79]\d{5}|8\d{5}'),
  ('BZ', '501', NULL, false, '(?:0800\d|[2-8])\d{6}'),
  ('CA', '1', '1', true, '[2-9]\d{9}|3\d{6}'),
  ('CC', '61', '0', false, '1(?:[0-79]\d{8}(?:\d{2})?|8[0-24-9]\d{7})|[148]\d{8}|1\d{5,7}'),
  ('CD', '243', '0', false, '(?:(?:[189]|5\d)\d|2)\d{7}|[1-68]\d{6}'),
  ('CF', '236', NULL, false, '8776\d{4}|(?:[27]\d|61)\d{6}'),
  ('CG', '242', NULL, false, '222\d{6}|(?:0\d|80)\d{7}'),
  ('CH', '41', '0', false, '8\d{11}|[2-9]\d{8}'),
  ('CI', '225', NULL, false, '[02]\d{9}'),
  ('CK', '682', NULL, false, '[2-578]\d{4}'),
  ('CL', '56', NULL, false, '12300\d{6}|6\d{9,10}|[2-9]\d{8}'),
  ('CM', '237', NULL, false, '[26]\d{8}|88\d{6,7}'),
  ('CN', '86', '0', false, '(?:(?:1[03-689]|2\d)\d\d|6)\d{8}|1\d{10}|[126]\d{6}(?:\d(?:\d{2})?)?|86\d{5,6}|(?:[3-579]\d|8[0-57-9])\d{5,9}'),
  ('CO', '57', '0', false, '(?:46|60\d\d)\d{6}|(?:1\d|[39])\d{9}'),
  ('CR', '506', NULL, false, '(?:8\d|90)\d{8}|(?:[24-8]\d{3}|3005)\d{4}'),
  ('CU', '53', '0', false, '(?:[2-7]|8\d\d)\d{7}|[2-47]\d{6}|[34]\d{5}'),
  ('CV', '238', NULL, false, '(?:[2-59]\d\d|800)\d{4}'),
  ('CW', '599', NULL, false, '(?:[34]1|60|(?:7|9\d)\d)\d{5}'),
  ('CX', '61', '0', false, '1(?:[0-79]\d{8}(?:\d{2})?|8[0-24-9]\d{7})|[148]\d{8}|1\d{5,7}'),
  ('CY', '357', NULL, false, '(?:[279]\d|[58]0)\d{6}'),
  ('CZ', '420', NULL, false, '(?:[2-578]\d|60)\d{7}|9\d{8,11}'),
  ('DE', '49', '0', false, '[2579]\d{5,14}|49(?:[34]0|69|8\d)\d\d?|49(?:37|49|60|7[089]|9\d)\d{1,3}|49(?:2[024-9]|3[2-689]|7[1-7])\d{1,8}|(?:1|[368]\d|4[0-8])\d{3,13}|49(?:[015]\d|2[13]|31|[46][1-8])\d{1,9}'),
  ('DJ', '253', NULL, false, '(?:2\d|77)\d{6}'),
  ('DK', '45', NULL, false, '[2-9]\d{7}'),
  ('DM', '1', '1', true, '(?:[58]\d\d|767|900)\d{7}'),
  ('DO', '1', '1', true, '(?:[58]\d\d|900)\d{7}'),
  ('DZ', '213', '0', false, '(?:[1-4]|[5-79]\d|80)\d{7}'),
  ('EC', '593', '0', false, '1\d{9,10}|(?:[2-7]|9\d)\d{7}'),
  ('EE', '372', NULL, false, '8\d{9}|[4578]\d{7}|(?:[3-8]\d|90)\d{5}'),
  ('EG', '20', '0', false, '[189]\d{8,9}|[24-6]\d{8}|[135]\d{7}'),
  ('EH', '212', '0', false, '[5-8]\d{8}'),
  ('ER', '291', '0', false, '[178]\d{6}'),
  ('ES', '34', NULL, false, '(?:400|[5-9]\d\d)\d{6}'),
  ('ET', '251', '0', false, '(?:11|[2-57-9]\d)\d{7}'),
  ('FI', '358', '0', false, '[1-35689]\d{4}|7\d{10,11}|(?:[124-7]\d|3[0-46-9])\d{8}|[1-9]\d{5,8}'),
  ('FJ', '679', NULL, false, '45\d{5}|(?:0800\d|[235-9])\d{6}'),
  ('FK', '500', NULL, false, '[2-7]\d{4}'),
  ('FM', '691', NULL, false, '(?:[39]\d\d|820)\d{4}'),
  ('FO', '298', NULL, false, '[2-9]\d{5}'),
  ('FR', '33', '0', false, '[1-9]\d{8}'),
  ('GA', '241', NULL, false, '(?:[067]\d|11)\d{6}|[2-7]\d{6}'),
  ('GB', '44', '0', false, '[1-357-9]\d{9}|[18]\d{8}|8\d{6}'),
  ('GD', '1', '1', true, '(?:473|[58]\d\d|900)\d{7}'),
  ('GE', '995', '0', false, '(?:[3-57]\d\d|800)\d{6}'),
  ('GF', '594', '0', false, '(?:694\d|7093)\d{5}|(?:59|[89]\d)\d{7}'),
  ('GG', '44', '0', false, '(?:1481|[357-9]\d{3})\d{6}|8\d{6}(?:\d{2})?'),
  ('GH', '233', '0', false, '[235]\d{8}|800\d{5,6}'),
  ('GI', '350', NULL, false, '(?:[25]\d|60)\d{6}'),
  ('GL', '299', NULL, false, '(?:19|[2-689]\d|70)\d{4}'),
  ('GM', '220', NULL, false, '[48]\d{8}|[2-9]\d{6}'),
  ('GN', '224', NULL, false, '722\d{6}|(?:3|6\d)\d{7}'),
  ('GP', '590', '0', false, '7090\d{5}|(?:[56]9|[89]\d)\d{7}'),
  ('GQ', '240', NULL, false, '222\d{6}|(?:3\d|55|[89]0)\d{7}'),
  ('GR', '30', NULL, false, '5005000\d{3}|8\d{9,11}|(?:[269]\d|70)\d{8}'),
  ('GT', '502', NULL, false, '80\d{6}|(?:1\d{3}|[2-7])\d{7}'),
  ('GU', '1', '1', true, '(?:[58]\d\d|671|900)\d{7}'),
  ('GW', '245', NULL, false, '[49]\d{8}|4\d{6}'),
  ('GY', '592', NULL, false, '(?:[2-8]\d{3}|9008)\d{3}'),
  ('HK', '852', NULL, false, '8[0-46-9]\d{6,7}|9\d{4,7}|(?:[2-7]|9\d{3})\d{7}'),
  ('HN', '504', NULL, false, '8\d{10}|[237-9]\d{7}'),
  ('HR', '385', '0', false, '[2-69]\d{8}|80\d{5,7}|[1-79]\d{7}|6\d{6}'),
  ('HT', '509', NULL, false, '[2-589]\d{7}'),
  ('HU', '36', '06', false, '[235-7]\d{8}|[1-9]\d{7}'),
  ('ID', '62', '0', false, '00[1-9]\d{9,14}|(?:[1-36]|8\d{5})\d{6}|00\d{9}|[1-9]\d{8,10}|[2-9]\d{7}'),
  ('IE', '353', '0', false, '(?:1\d|[2569])\d{6,8}|4\d{6,9}|7\d{8}|8\d{8,9}'),
  ('IL', '972', '0', false, '1\d{6}(?:\d{3,5})?|[57]\d{8}|[1-489]\d{7}'),
  ('IM', '44', '0', false, '1624\d{6}|(?:[3578]\d|90)\d{8}'),
  ('IN', '91', '0', false, '(?:000800|[2-9]\d\d)\d{7}|1\d{7,12}'),
  ('IO', '246', NULL, false, '3\d{6}'),
  ('IQ', '964', '0', false, '(?:1|7\d\d)\d{7}|[2-6]\d{7,8}'),
  ('IR', '98', '0', false, '[1-9]\d{9}|(?:[1-8]\d\d|9)\d{3,4}'),
  ('IS', '354', NULL, false, '(?:38\d|[4-9])\d{6}'),
  ('IT', '39', NULL, false, '0\d{5,11}|1\d{8,10}|3(?:[0-8]\d{7,10}|9\d{7,8})|(?:43|55|70)\d{8}|8\d{5}(?:\d{2,4})?'),
  ('JE', '44', '0', false, '1534\d{6}|(?:[3578]\d|90)\d{8}'),
  ('JM', '1', '1', true, '(?:[58]\d\d|658|900)\d{7}'),
  ('JO', '962', '0', false, '(?:(?:[2689]|7\d)\d|32|427|53)\d{6}'),
  ('JP', '81', '0', false, '00[1-9]\d{6,14}|[25-9]\d{9}|(?:00|[1-9]\d\d)\d{6}'),
  ('KE', '254', '0', false, '(?:[17]\d\d|900)\d{6}|(?:2|80)0\d{6,7}|[4-6]\d{6,8}'),
  ('KG', '996', '0', false, '8\d{9}|[235-9]\d{8}'),
  ('KH', '855', '0', false, '1\d{9}|[1-9]\d{7,8}'),
  ('KI', '686', '0', false, '(?:[37]\d|6[0-79])\d{6}|(?:[2-48]\d|50)\d{3}'),
  ('KM', '269', NULL, false, '[3478]\d{6}'),
  ('KN', '1', '1', true, '(?:[58]\d\d|900)\d{7}'),
  ('KP', '850', '0', false, '85\d{6}|(?:19\d|[2-7])\d{7}'),
  ('KR', '82', '0', false, '00[1-9]\d{8,11}|(?:[12]|5\d{3})\d{7}|[13-6]\d{9}|(?:[1-6]\d|80)\d{7}|[3-6]\d{4,5}|(?:00|7)0\d{8}'),
  ('KW', '965', NULL, false, '18\d{5}|(?:[2569]\d|41)\d{6}'),
  ('KY', '1', '1', true, '(?:345|[58]\d\d|900)\d{7}'),
  ('KZ', '7', '8', false, '8\d{13}|[78]\d{9}'),
  ('LA', '856', '0', false, '[23]\d{9}|3\d{8}|(?:[235-8]\d|41)\d{6}'),
  ('LB', '961', '0', false, '[27-9]\d{7}|[13-9]\d{6}'),
  ('LC', '1', '1', true, '(?:[58]\d\d|758|900)\d{7}'),
  ('LI', '423', '0', false, '[68]\d{8}|(?:[2378]\d|90)\d{5}'),
  ('LK', '94', '0', false, '[1-9]\d{8}'),
  ('LR', '231', '0', false, '(?:[2457]\d|33|88)\d{7}|(?:2\d|[4-6])\d{6}'),
  ('LS', '266', NULL, false, '(?:[256]\d\d|800)\d{5}'),
  ('LT', '370', '0', false, '(?:[3469]\d|52|[78]0)\d{6}'),
  ('LU', '352', NULL, false, '35[013-9]\d{4,8}|6\d{8}|35\d{2,4}|(?:[2457-9]\d|3[0-46-9])\d{2,9}'),
  ('LV', '371', NULL, false, '(?:[268]\d|78|90)\d{6}'),
  ('LY', '218', '0', false, '[2-9]\d{8}'),
  ('MA', '212', '0', false, '[5-8]\d{8}'),
  ('MC', '377', '0', false, '(?:[3489]|[67]\d)\d{7}'),
  ('MD', '373', '0', false, '(?:[235-7]\d|[89]0)\d{6}'),
  ('ME', '382', '0', false, '(?:20|[3-79]\d)\d{6}|80\d{6,7}'),
  ('MF', '590', '0', false, '7090\d{5}|(?:[56]9|[89]\d)\d{7}'),
  ('MG', '261', '0', false, '[23]\d{8}'),
  ('MH', '692', '1', true, '329\d{4}|(?:[256]\d|45)\d{5}'),
  ('MK', '389', '0', false, '[2-578]\d{7}'),
  ('ML', '223', NULL, false, '[24-9]\d{7}'),
  ('MM', '95', '0', false, '1\d{5,7}|95\d{6}|(?:[4-7]|9[0-46-9])\d{6,8}|(?:2|8\d)\d{5,8}'),
  ('MN', '976', '0', false, '[12]\d{7,9}|[5-9]\d{7}'),
  ('MO', '853', NULL, false, '0800\d{3}|(?:28|[68]\d)\d{6}'),
  ('MP', '1', '1', true, '[58]\d{9}|(?:67|90)0\d{7}'),
  ('MQ', '596', '0', false, '7091\d{5}|(?:[56]9|[89]\d)\d{7}'),
  ('MR', '222', NULL, false, '(?:[2-4]\d\d|800)\d{5}'),
  ('MS', '1', '1', true, '(?:[58]\d\d|664|900)\d{7}'),
  ('MT', '356', NULL, false, '3550\d{4}|(?:[2579]\d\d|800)\d{5}'),
  ('MU', '230', NULL, false, '(?:[57]|8\d\d)\d{7}|[2-468]\d{6}'),
  ('MV', '960', NULL, false, '(?:800|9[0-57-9]\d)\d{7}|[34679]\d{6}'),
  ('MW', '265', '0', false, '(?:[1289]\d|31|77)\d{7}|1\d{6}'),
  ('MX', '52', NULL, false, '[2-9]\d{9}'),
  ('MY', '60', '0', false, '1\d{8,9}|(?:3\d|[4-9])\d{7}'),
  ('MZ', '258', NULL, false, '(?:2|8\d)\d{7}'),
  ('NA', '264', '0', false, '[68]\d{7,8}'),
  ('NC', '687', NULL, false, '(?:050|[2-57-9]\d\d)\d{3}'),
  ('NE', '227', NULL, false, '[027-9]\d{7}'),
  ('NF', '672', NULL, false, '[13]\d{5}'),
  ('NG', '234', '0', false, '(?:20|9\d)\d{8}|[78]\d{9,13}'),
  ('NI', '505', NULL, false, '(?:1800|[25-8]\d{3})\d{4}'),
  ('NL', '31', '0', false, '(?:[124-7]\d\d|3(?:[02-9]\d|1[0-8]))\d{6}|8\d{6,9}|9\d{6,10}|1\d{4,5}'),
  ('NO', '47', NULL, false, '(?:0|[2-9]\d{3})\d{4}'),
  ('NP', '977', '0', false, '(?:1\d|9)\d{9}|[1-9]\d{7}'),
  ('NR', '674', NULL, false, '(?:222|444|(?:55|8\d)\d|666|777|999)\d{4}'),
  ('NU', '683', NULL, false, '(?:[4-7]|888\d)\d{3}'),
  ('NZ', '64', '0', false, '[1289]\d{9}|50\d{5}(?:\d{2,3})?|[27-9]\d{7,8}|(?:[34]\d|6[0-35-9])\d{6}|8\d{4,6}'),
  ('OM', '968', NULL, false, '(?:1505|[279]\d{3}|500)\d{4}|800\d{5,6}'),
  ('PA', '507', NULL, false, '(?:00800|8\d{3})\d{6}|[68]\d{7}|[1-57-9]\d{6}'),
  ('PE', '51', '0', false, '(?:[14-8]|9\d)\d{7}'),
  ('PF', '689', NULL, false, '4\d{5}(?:\d{2})?|8\d{7,8}'),
  ('PG', '675', NULL, false, '(?:180|[78]\d{3})\d{4}|(?:[2-589]\d|64)\d{5}'),
  ('PH', '63', '0', false, '(?:[2-7]|9\d)\d{8}|2\d{5}|(?:1800|8)\d{7,9}'),
  ('PK', '92', '0', false, '122\d{6}|[24-8]\d{10,11}|9(?:[013-9]\d{8,10}|2(?:[01]\d\d|2(?:[06-8]\d|1[01]))\d{7})|(?:[2-8]\d{3}|92(?:[0-7]\d|8[1-9]))\d{6}|[24-9]\d{8}|[89]\d{7}'),
  ('PL', '48', NULL, false, '(?:6|8\d\d)\d{7}|[1-9]\d{6}(?:\d{2})?|[26]\d{5}'),
  ('PM', '508', '0', false, '[78]\d{8}|[2-9]\d{5}'),
  ('PR', '1', '1', true, '(?:[589]\d\d|787)\d{7}'),
  ('PS', '970', '0', false, '[2489]2\d{6}|(?:1\d|5)\d{8}'),
  ('PT', '351', NULL, false, '1693\d{5}|(?:[26-9]\d|30)\d{7}'),
  ('PW', '680', NULL, false, '(?:[24-8]\d\d|345|900)\d{4}'),
  ('PY', '595', '0', false, '[36-8]\d{5,8}|4\d{6,8}|59\d{6}|9\d{5,10}|(?:2\d|5[0-8])\d{6,7}'),
  ('QA', '974', NULL, false, '800\d{4}|(?:2|800)\d{6}|(?:0080|[3-7])\d{7}'),
  ('RE', '262', '0', false, '709\d{6}|(?:26|[689]\d)\d{7}'),
  ('RO', '40', '0', false, '(?:[236-8]\d|90)\d{7}|[23]\d{5}'),
  ('RS', '381', '0', false, '38[02-9]\d{6,9}|6\d{7,9}|90\d{4,8}|38\d{5,6}|(?:7\d\d|800)\d{3,9}|(?:[12]\d|3[0-79])\d{5,10}'),
  ('RU', '7', '8', false, '8\d{13}|[347-9]\d{9}'),
  ('RW', '250', '0', false, '(?:06|[27]\d\d|[89]00)\d{6}'),
  ('SA', '966', '0', false, '(?:[15]\d|800|92)\d{7}'),
  ('SB', '677', NULL, false, '[6-9]\d{6}|[1-6]\d{4}'),
  ('SC', '248', NULL, false, '(?:[2489]\d|64)\d{5}'),
  ('SD', '249', '0', false, '[19]\d{8}'),
  ('SE', '46', '0', false, '(?:[26]\d\d|9)\d{9}|[1-9]\d{8}|[1-689]\d{7}|[1-4689]\d{6}|2\d{5}'),
  ('SG', '65', NULL, false, '(?:(?:1\d|8)\d\d|7000)\d{7}|[3689]\d{7}'),
  ('SH', '290', NULL, false, '(?:[256]\d|8)\d{3}'),
  ('SI', '386', '0', false, '[1-7]\d{7}|8\d{4,7}|90\d{4,6}'),
  ('SJ', '47', NULL, false, '0\d{4}|(?:[489]\d|79)\d{6}'),
  ('SK', '421', '0', false, '[2-689]\d{8}|[2-59]\d{6}|[2-5]\d{5}'),
  ('SL', '232', '0', false, '(?:[237-9]\d|66)\d{6}'),
  ('SM', '378', NULL, false, '(?:0549|[5-7]\d)\d{6}'),
  ('SN', '221', NULL, false, '(?:[378]\d|93)\d{7}'),
  ('SO', '252', '0', false, '[346-9]\d{8}|[12679]\d{7}|[1-5]\d{6}|[1348]\d{5}'),
  ('SR', '597', NULL, false, '(?:[2-5]|[6-9]\d)\d{5}'),
  ('SS', '211', '0', false, '[19]\d{8}'),
  ('ST', '239', NULL, false, '(?:22|9\d)\d{5}'),
  ('SV', '503', NULL, false, '[25-7]\d{7}|(?:80\d|900)\d{4}(?:\d{4})?'),
  ('SX', '1', '1', true, '7215\d{6}|(?:[58]\d\d|900)\d{7}'),
  ('SY', '963', '0', false, '[1-359]\d{8}|[1-5]\d{7}'),
  ('SZ', '268', NULL, false, '0800\d{4}|(?:[237]\d|900)\d{6}'),
  ('TA', '290', NULL, false, '8\d{3}'),
  ('TC', '1', '1', true, '(?:[58]\d\d|649|900)\d{7}'),
  ('TD', '235', NULL, false, '(?:22|[3689]\d|77)\d{6}'),
  ('TG', '228', NULL, false, '[279]\d{7}'),
  ('TH', '66', '0', false, '(?:001800|[2-57]|[689]\d)\d{7}|1\d{7,9}'),
  ('TJ', '992', NULL, false, '(?:[0-57-9]\d|66)\d{7}'),
  ('TK', '690', NULL, false, '[2-47]\d{3,6}'),
  ('TL', '670', NULL, false, '7\d{7}|(?:[2-47]\d|[89]0)\d{5}'),
  ('TM', '993', '8', false, '[1-7]\d{7}'),
  ('TN', '216', NULL, false, '[2-57-9]\d{7}'),
  ('TO', '676', NULL, false, '(?:0800|(?:[5-8]\d\d|999)\d)\d{3}|[2-8]\d{4}'),
  ('TR', '90', '0', false, '4\d{6}|8\d{11,12}|(?:[2-58]\d\d|900)\d{7}'),
  ('TT', '1', '1', true, '(?:[58]\d\d|900)\d{7}'),
  ('TV', '688', NULL, false, '(?:2|7\d\d|90)\d{4}'),
  ('TW', '886', '0', false, '[2-689]\d{8}|7\d{9,10}|[2-8]\d{7}|2\d{6}'),
  ('TZ', '255', '0', false, '(?:[25-8]\d|41|90)\d{7}'),
  ('UA', '380', '0', false, '[89]\d{9}|[3-9]\d{8}'),
  ('UG', '256', '0', false, '800\d{6}|(?:[29]0|[347]\d)\d{7}'),
  ('US', '1', '1', true, '[2-9]\d{9}|3\d{6}'),
  ('UY', '598', '0', false, '0004\d{2,9}|[1249]\d{7}|2\d{3,4}|(?:[49]\d|80)\d{5}'),
  ('UZ', '998', NULL, false, '(?:20|33|[5-9]\d)\d{7}'),
  ('VA', '39', NULL, false, '0\d{5,10}|3[0-8]\d{7,10}|55\d{8}|8\d{5}(?:\d{2,4})?|(?:1\d|39)\d{7,8}'),
  ('VC', '1', '1', true, '(?:[58]\d\d|784|900)\d{7}'),
  ('VE', '58', '0', false, '[68]00\d{7}|(?:[24]\d|[59]0)\d{8}'),
  ('VG', '1', '1', true, '(?:284|[58]\d\d|900)\d{7}'),
  ('VI', '1', '1', true, '[58]\d{9}|(?:34|90)0\d{7}'),
  ('VN', '84', '0', false, '[12]\d{9}|[135-9]\d{8}|[16]\d{6,7}|7\d{6}'),
  ('VU', '678', NULL, false, '[57-9]\d{6}|(?:[238]\d|48)\d{3}'),
  ('WF', '681', NULL, false, '(?:40|72|8\d{4})\d{4}|[89]\d{5}'),
  ('WS', '685', NULL, false, '(?:[2-6]|8\d{5})\d{4}|[78]\d{6}|[68]\d{5}'),
  ('XK', '383', '0', false, '2\d{7,8}|3\d{7,11}|(?:4\d\d|[89]00)\d{5}'),
  ('YE', '967', '0', false, '(?:1|7\d)\d{7}|[1-7]\d{6}'),
  ('YT', '262', '0', false, '(?:639\d|7093)\d{5}|(?:26|80|9\d)\d{7}'),
  ('ZA', '27', '0', false, '[1-79]\d{8}|8\d{4,9}'),
  ('ZM', '260', '0', false, '800\d{6}|(?:21|[579]\d|63)\d{7}'),
  ('ZW', '263', '0', false, '(?:13|8\d{4})\d{5}|[235-8]\d{8}|[2-689]\d{6}')
ON CONFLICT (country_code) DO UPDATE SET
  calling_code     = EXCLUDED.calling_code,
  national_prefix  = EXCLUDED.national_prefix,
  idd_011          = EXCLUDED.idd_011,
  national_pattern = EXCLUDED.national_pattern;

-- ------------------------------------------------------------
-- 2) The rule itself — pure, so it can be tested with a SELECT
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_contact_phone(p_raw TEXT, p_country TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_trim     TEXT;
  v_had_plus BOOLEAN;
  v_digits   TEXT;
  v_rule     public.phone_country_rules%ROWTYPE;
  v_pattern  TEXT;
  v_national TEXT;
BEGIN
  IF p_raw IS NULL THEN
    RETURN NULL;
  END IF;

  v_trim := btrim(p_raw);

  -- Blank or punctuation only: nothing to work with.
  IF v_trim !~ '\d' THEN
    RETURN p_raw;
  END IF;

  -- Excel's "9.18319E+11": the low digits are gone for good. Expanding
  -- the notation would invent a well-formed number belonging to a
  -- stranger, so it is left for a human to re-enter.
  IF regexp_replace(v_trim, '\s', '', 'g') ~ '^\d(\.\d+)?[eE][+-]?\d+$' THEN
    RETURN p_raw;
  END IF;

  v_had_plus := left(v_trim, 1) = '+';
  v_digits   := regexp_replace(v_trim, '\D', '', 'g');

  -- Shorter than any subscriber number: a fragment, not a phone.
  IF length(v_digits) < 7 THEN
    RETURN p_raw;
  END IF;

  -- An explicit "+" means the country code is already there; only the
  -- spaces, dashes and brackets need to go.
  IF v_had_plus THEN
    RETURN '+' || v_digits;
  END IF;

  -- "00" is how most of the world dials out; "+" is how it is written.
  IF v_digits ~ '^00' AND length(v_digits) > 9 THEN
    RETURN '+' || substr(v_digits, 3);
  END IF;

  -- From here on we need to know which country a bare number is in.
  SELECT * INTO v_rule
  FROM public.phone_country_rules
  WHERE country_code = upper(p_country);

  IF NOT FOUND THEN
    RETURN p_raw;
  END IF;

  -- "011" is the North American way out; elsewhere it can be a real
  -- number (Delhi landlines start 011 when written with the trunk 0).
  IF v_rule.idd_011 AND v_digits ~ '^011' AND length(v_digits) > 10 THEN
    RETURN '+' || substr(v_digits, 4);
  END IF;

  v_pattern := '^(?:' || v_rule.national_pattern || ')$';

  -- A national number exactly as dialled locally: "9831023021".
  IF v_digits ~ v_pattern THEN
    RETURN '+' || v_rule.calling_code || v_digits;
  END IF;

  -- With the trunk prefix: "09831023021".
  IF v_rule.national_prefix IS NOT NULL
     AND left(v_digits, length(v_rule.national_prefix)) = v_rule.national_prefix THEN
    v_national := substr(v_digits, length(v_rule.national_prefix) + 1);
    IF v_national ~ v_pattern THEN
      RETURN '+' || v_rule.calling_code || v_national;
    END IF;
  END IF;

  -- Country code present but no "+": "919831023021". Tried last, like
  -- the app does, so a national number that happens to start with the
  -- dial code digits is read as national first.
  IF left(v_digits, length(v_rule.calling_code)) = v_rule.calling_code THEN
    v_national := substr(v_digits, length(v_rule.calling_code) + 1);
    IF v_national ~ v_pattern THEN
      RETURN '+' || v_digits;
    END IF;
  END IF;

  -- Not resolvable without guessing: leave it for the Validation page.
  RETURN p_raw;
END;
$$;

ALTER FUNCTION public.normalize_contact_phone(TEXT, TEXT) OWNER TO postgres;
COMMENT ON FUNCTION public.normalize_contact_phone(TEXT, TEXT) IS
  'Canonical +E.164 form of a contact number given an ISO 3166-1 alpha-2 default country, or the input unchanged when it cannot be resolved safely. Mirrors cleanPhone() in packages/shared.';

-- ------------------------------------------------------------
-- 3) Apply it on every write to contacts.phone
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wacrm_contact_phone_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_country TEXT;
BEGIN
  IF NEW.phone IS NULL THEN
    RETURN NEW;
  END IF;

  -- An UPDATE that names the phone column but leaves the value alone
  -- (the edit form always sends it) must not silently rewrite a number
  -- the operator did not touch — that can collide with another contact
  -- and fail an unrelated edit. Such rows stay for the Validation page.
  IF TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
    RETURN NEW;
  END IF;

  SELECT default_country_code INTO v_country
  FROM public.accounts
  WHERE id = NEW.account_id;

  NEW.phone := public.normalize_contact_phone(NEW.phone, v_country);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.wacrm_contact_phone_before_write() OWNER TO postgres;

-- "wacrm_a_…" so it runs before wacrm_z_contact_activation; the
-- generated phone_normalized column and the unique index see the
-- cleaned value because they are evaluated after BEFORE triggers.
DROP TRIGGER IF EXISTS wacrm_a_contact_phone_normalize ON public.contacts;
CREATE TRIGGER wacrm_a_contact_phone_normalize
  BEFORE INSERT OR UPDATE OF phone ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.wacrm_contact_phone_before_write();
