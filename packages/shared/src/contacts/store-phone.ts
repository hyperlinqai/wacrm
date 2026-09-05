import { cleanPhone, type PhoneRejection } from '../whatsapp/phone-clean';

// What goes into `contacts.phone`.
//
// There are two different "clean phone number" jobs in this codebase and
// conflating them is what put un-messageable numbers in the database:
//
//   * the SEND payload — Meta's API wants bare digits, which is what
//     `sanitizePhoneForMeta` produces ("+91 98310 23021" → "918310 23021"
//     with the plus gone).
//   * the STORED value — must be canonical +E.164, because that is what
//     the Validation page, the broadcast preview, `phone_normalized` and
//     every human reading the contact list expect.
//
// Every create path used the send form for the stored value, so contacts
// landed as "918208103317". That still looks plausible and still passes
// the loose `isValidE164` check, so nothing complained — but a bare
// national number stored the same way ("9831023021") is indistinguishable
// from it, and Meta reads the leading 9 as a country code and fails the
// send. The two helpers below are the only sanctioned ways to produce a
// value for `contacts.phone`.
//
// Migration 053 enforces the same rule in the database as a backstop, so
// a future path that forgets to call these still cannot store a raw
// number. These exist so the value is already right on the way in — and
// so the app agrees with the trigger about what "right" means.

export interface StoredPhoneOk {
  ok: true;
  /** "+919831023021" — what to write to contacts.phone. */
  phone: string;
}

export interface StoredPhoneFailed {
  ok: false;
  rejection: PhoneRejection;
}

export type StoredPhoneResult = StoredPhoneOk | StoredPhoneFailed;

/**
 * Canonical stored form of a number a human typed, imported, or sent
 * through the public API.
 *
 * `defaultCountry` (the account's `default_country_code`) is what lets a
 * bare national number resolve; without one such a number is rejected
 * rather than guessed at, because a wrong guess messages a stranger.
 */
export function contactPhoneFromInput(
  raw: string | null | undefined,
  defaultCountry?: string | null,
): StoredPhoneResult {
  const cleaned = cleanPhone(raw ?? '', { defaultCountry: defaultCountry ?? null });
  if (!cleaned.ok || !cleaned.e164) {
    return { ok: false, rejection: cleaned.rejection ?? 'not_a_valid_number' };
  }
  return { ok: true, phone: cleaned.e164 };
}

/**
 * Canonical stored form of a WhatsApp `wa_id` (the `from` on an inbound
 * webhook message, or the `wa_id` on a contact echo).
 *
 * A wa_id is always the full international number in digits, so the only
 * thing missing is the "+". It must NOT go through
 * `contactPhoneFromInput`: with an Indian default country, the US wa_id
 * "14155550123" matches India's national pattern and would be rewritten
 * to "+9114155550123" — a real number belonging to someone else.
 */
export function contactPhoneFromWaId(waId: string | null | undefined): string | null {
  const digits = (waId ?? '').replace(/\D/g, '');
  // Same floor as cleanPhone's MIN_DIGITS — below this it is a fragment,
  // not a number, and prefixing "+" would only make it look valid.
  if (digits.length < 7) return null;
  return `+${digits}`;
}
