import {
  parsePhoneNumberFromString,
  isSupportedCountry,
  getCountries,
  getCountryCallingCode,
  type CountryCode,
} from 'libphonenumber-js';

// Turning what people actually paste into a list into something Meta
// will accept.
//
// The old pipeline only asked `isValidE164` — 7 to 15 digits starting
// non-zero. A bare national number like "9831023021" satisfies that, so
// it sailed through and reached Meta, which read the leading 9 as a
// country code and failed the send. Nothing surfaced why. Roughly three
// quarters of a real imported list looks like that, so "valid" has to
// mean "dialable from anywhere", not "plausibly numeric".
//
// Everything here is pure and runs identically in the browser (the
// campaign preview) and on the server (the send path), so the count a
// user is shown before sending is produced by the same code that
// decides what actually goes out.

/** Why a number cannot be messaged. Each maps to distinct user advice. */
export type PhoneRejection =
  /** Blank, or punctuation only. */
  | 'empty'
  /** Excel rewrote it as 9.18319E+11 and the low digits are gone forever. */
  | 'excel_scientific'
  /** No country code, and the account has not said which country to assume. */
  | 'no_country_code'
  /** Fewer digits than any real subscriber number. */
  | 'too_short'
  /** Parsed, but not a real number for its country (bad length, unassigned prefix). */
  | 'not_a_valid_number';

/** What had to be changed to make the number sendable. */
export type PhoneRepair =
  /** Spaces, dashes, brackets, dots removed. */
  | 'formatting'
  /** 00 / 011 international access prefix replaced with +. */
  | 'international_prefix'
  /** The account's default country was prefixed onto a national number. */
  | 'country_code';

export interface CleanPhoneResult {
  /** Exactly what came in, for showing beside the verdict. */
  input: string;
  ok: boolean;
  /** Digits only, country code included — the form Meta's API takes. */
  msisdn?: string;
  /** "+919831023021" — for display and for storing on the contact. */
  e164?: string;
  /** Empty when the number was already clean. */
  repairs: PhoneRepair[];
  rejection?: PhoneRejection;
}

export interface CleanPhoneOptions {
  /**
   * ISO 3166-1 alpha-2 region ("IN") to assume for numbers with no
   * country code. Undefined means do not assume one: such numbers are
   * rejected as `no_country_code` rather than guessed at, because a
   * wrong guess sends a real message to a real stranger.
   */
  defaultCountry?: string | null;
}

/** Excel turns long digit strings into 9.18319E+11 on CSV round-trip. */
const EXCEL_SCIENTIFIC = /^\d(?:\.\d+)?[eE][+-]?\d+$/;

/** Shortest plausible subscriber number, ignoring short codes. */
const MIN_DIGITS = 7;

/**
 * Clean one number and say whether it can be messaged.
 *
 * Never throws and never guesses: a number is either sendable, or it
 * comes back with a reason a support person can act on.
 */
export function cleanPhone(
  raw: string | null | undefined,
  { defaultCountry }: CleanPhoneOptions = {},
): CleanPhoneResult {
  const input = typeof raw === 'string' ? raw : '';
  const trimmed = input.trim();
  const repairs: PhoneRepair[] = [];

  if (!trimmed || !/\d/.test(trimmed)) {
    return { input, ok: false, repairs, rejection: 'empty' };
  }

  // Checked before anything strips the "." and "E": expanding the
  // notation would invent digits Excel already threw away, producing a
  // well-formed number belonging to somebody else.
  if (EXCEL_SCIENTIFIC.test(trimmed.replace(/\s/g, ''))) {
    return { input, ok: false, repairs, rejection: 'excel_scientific' };
  }

  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length !== trimmed.length - (hadPlus ? 1 : 0)) {
    repairs.push('formatting');
  }

  // 00 and 011 are how you dial out of a country; + is how you write it.
  if (!hadPlus && digits.startsWith('00') && digits.length > MIN_DIGITS + 2) {
    digits = digits.slice(2);
    repairs.push('international_prefix');
  } else if (!hadPlus && digits.startsWith('011') && digits.length > MIN_DIGITS + 3) {
    digits = digits.slice(3);
    repairs.push('international_prefix');
  }

  if (digits.length < MIN_DIGITS) {
    return { input, ok: false, repairs, rejection: 'too_short' };
  }

  const region =
    defaultCountry && isSupportedCountry(defaultCountry.toUpperCase())
      ? (defaultCountry.toUpperCase() as CountryCode)
      : undefined;

  // An explicit +, or an international access prefix we just stripped,
  // means the country code is already in the digits — parse it as
  // international and ignore the account default entirely.
  const isInternational = hadPlus || repairs.includes('international_prefix');

  if (isInternational) {
    const parsed = parsePhoneNumberFromString(`+${digits}`);
    if (!parsed) return { input, ok: false, repairs, rejection: 'not_a_valid_number' };
    if (!parsed.isValid()) {
      return { input, ok: false, repairs, rejection: 'not_a_valid_number' };
    }
    return finish(input, parsed.number, repairs);
  }

  // No country code in the string. If the account has a default country,
  // the digits are a national number there; otherwise we cannot say who
  // this is.
  if (!region) {
    return { input, ok: false, repairs, rejection: 'no_country_code' };
  }

  const national = parsePhoneNumberFromString(digits, region);
  if (national?.isValid()) {
    // Whether a country code was really *added* is decided by comparing
    // what we were given with the national part of what came back. A
    // parser given "919907275072" and region IN recognises the leading
    // 91 itself, so the digits were already complete — reporting that as
    // a repair would tell the user we changed a number we did not touch.
    const addedCountryCode = digits === national.nationalNumber;
    return finish(input, national.number, addedCountryCode ? [...repairs, 'country_code'] : repairs);
  }

  // Some lists store the country code without a +, so the "national"
  // reading fails while the international one succeeds ("919907275072").
  const international = parsePhoneNumberFromString(`+${digits}`);
  if (international?.isValid()) {
    return finish(input, international.number, repairs);
  }

  return {
    input,
    ok: false,
    repairs,
    rejection: national ? 'not_a_valid_number' : 'no_country_code',
  };
}

function finish(input: string, e164: string, repairs: PhoneRepair[]): CleanPhoneResult {
  return {
    input,
    ok: true,
    e164,
    msisdn: e164.replace(/\D/g, ''),
    // A number that was already correct reports no repairs, so the UI can
    // say "12 numbers were changed" and mean it.
    repairs: repairs.filter((r, i) => repairs.indexOf(r) === i),
  };
}

export interface PhoneAuditRow extends CleanPhoneResult {
  /** Caller's own handle for the row — a contact id, a CSV line number. */
  ref?: string;
}

export interface PhoneAudit {
  rows: PhoneAuditRow[];
  /** Sendable as-is, no change needed. */
  clean: PhoneAuditRow[];
  /** Sendable, but only after this cleaned them. */
  repaired: PhoneAuditRow[];
  /** Not sendable, grouped so the UI can explain each group once. */
  rejected: PhoneAuditRow[];
  rejectionCounts: Record<PhoneRejection, number>;
  /** Sendable numbers that collapse onto an earlier one after cleaning. */
  duplicates: PhoneAuditRow[];
}

/**
 * Clean a whole list and bucket the results, so a campaign can show what
 * it is about to do before it does it.
 *
 * Duplicates are detected *after* cleaning, which is the point: "9831023021"
 * and "+91 98310 23021" are the same person written two ways, and only
 * normalising first reveals it.
 */
export function auditPhones(
  entries: Array<{ phone: string | null | undefined; ref?: string }>,
  options: CleanPhoneOptions = {},
): PhoneAudit {
  const rows: PhoneAuditRow[] = [];
  const clean: PhoneAuditRow[] = [];
  const repaired: PhoneAuditRow[] = [];
  const rejected: PhoneAuditRow[] = [];
  const duplicates: PhoneAuditRow[] = [];
  const rejectionCounts = {
    empty: 0,
    excel_scientific: 0,
    no_country_code: 0,
    too_short: 0,
    not_a_valid_number: 0,
  } as Record<PhoneRejection, number>;
  const seen = new Set<string>();

  for (const entry of entries) {
    const row: PhoneAuditRow = { ...cleanPhone(entry.phone, options), ref: entry.ref };
    rows.push(row);

    if (!row.ok) {
      rejected.push(row);
      if (row.rejection) rejectionCounts[row.rejection] += 1;
      continue;
    }
    if (seen.has(row.msisdn!)) {
      duplicates.push(row);
      continue;
    }
    seen.add(row.msisdn!);
    (row.repairs.length > 0 ? repaired : clean).push(row);
  }

  return { rows, clean, repaired, rejected, rejectionCounts, duplicates };
}

export interface CountryOption {
  /** ISO 3166-1 alpha-2, the value stored on the account. */
  code: string;
  /** Localised country name, e.g. "India". */
  name: string;
  /** Display-only dial prefix, e.g. "+91". Several countries share one. */
  dialCode: string;
}

/**
 * Every country a number can be parsed for, for the account setting's
 * picker. Derived from the parser's own metadata rather than a
 * hand-kept list, so the picker cannot offer a country the parser
 * would then reject.
 *
 * Names come from Intl; where that is unavailable the ISO code stands
 * in, which is still selectable and still correct.
 */
export function listCountries(locale = 'en'): CountryOption[] {
  let display: Intl.DisplayNames | undefined;
  try {
    display = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    display = undefined;
  }
  return getCountries()
    .map((code) => ({
      code,
      name: display?.of(code) ?? code,
      dialCode: `+${getCountryCallingCode(code)}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}
