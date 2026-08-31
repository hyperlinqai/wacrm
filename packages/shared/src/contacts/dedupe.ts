import type { SupabaseClient } from '../db/index';
import { normalizePhone, phonesMatch } from "../whatsapp/phone-utils";

/**
 * Contact de-duplication helpers, shared by the WhatsApp webhook, the
 * manual contact form, and CSV import so all paths agree on what
 * "same number" means (issue #212).
 *
 * The canonical key is `normalizePhone` (digits-only) — the same form
 * the DB stores in the generated `contacts.phone_normalized` column
 * and enforces unique per account. `phonesMatch` adds trunk-prefix
 * tolerance (last-8-digit match) for the softer "possible duplicate"
 * surfaces.
 */

/** Canonical de-dup key for a phone string (digits only). */
export function normalizeKey(phone: string): string {
  return normalizePhone(phone);
}

/** Minimal shape we need back from a contacts lookup. */
export interface ExistingContact {
  id: string;
  phone: string;
  name?: string | null;
  [key: string]: unknown;
}

/**
 * Find an existing contact in `accountId` whose phone matches `phone`,
 * or null. Pre-filters in SQL by the last-8-digit suffix (so we don't
 * pull every contact), then applies the strict `phonesMatch` in JS on
 * the small candidate set — the exact approach the webhook has used.
 */
export async function findExistingContact(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("account_id", accountId)
    .like("phone", `%${suffix}`);

  if (error || !data) return null;

  return (
    (data as ExistingContact[]).find((c) => phonesMatch(c.phone, phone)) ?? null
  );
}

/**
 * True when an existing contact is an *exact* normalized match for
 * `phone` (vs only a fuzzy trunk-variant match). The form hard-blocks
 * exact matches but only warns on fuzzy ones.
 */
export function isExactMatch(existing: ExistingContact, phone: string): boolean {
  return normalizeKey(existing.phone) === normalizeKey(phone);
}

/** Canonical de-dup key for an email (trimmed, lowercased); "" if blank. */
export function normalizeEmailKey(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Find an existing contact in `accountId` with the same email
 * (case-insensitive), or null. Unlike phone there is no DB unique index
 * on email — this is purely the in-app heads-up. `excludeId` skips the
 * contact being edited so it never collides with itself.
 */
export async function findContactByEmail(
  db: SupabaseClient,
  accountId: string,
  email: string,
  excludeId?: string,
): Promise<ExistingContact | null> {
  const key = normalizeEmailKey(email);
  if (!key) return null;

  // ilike with no wildcards is a case-insensitive equality; escape the
  // pattern metacharacters so "a_b@x.com" doesn't match "aXb@x.com".
  const pattern = key.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("account_id", accountId)
    .ilike("email", pattern)
    .limit(5);

  if (error || !data) return null;
  return (
    (data as ExistingContact[]).find(
      (c) => c.id !== excludeId && normalizeEmailKey(c.email as string | null) === key,
    ) ?? null
  );
}

export interface DuplicateMatches {
  /** Contact sharing this phone (exact or trunk-variant), if any. */
  phone: ExistingContact | null;
  /** Whether the phone match is exact (blocked by the DB unique index). */
  phoneExact: boolean;
  /** Contact sharing this email (case-insensitive), if any. */
  email: ExistingContact | null;
}

/**
 * One call the contact form makes before saving: which existing
 * contacts would this entry duplicate, by phone and/or by email? Both
 * qualifiers are checked independently; the caller decides what to
 * offer (view / update existing / create anyway) from the combination.
 */
export async function findDuplicateContacts(
  db: SupabaseClient,
  accountId: string,
  input: { phone: string; email?: string | null },
  excludeId?: string,
): Promise<DuplicateMatches> {
  const [byPhone, byEmail] = await Promise.all([
    findExistingContact(db, accountId, input.phone),
    findContactByEmail(db, accountId, input.email ?? "", excludeId),
  ]);
  const phone = byPhone && byPhone.id !== excludeId ? byPhone : null;
  return {
    phone,
    phoneExact: phone ? isExactMatch(phone, input.phone) : false,
    email: byEmail,
  };
}

/** True when there is anything to alert the user about. */
export function hasDuplicates(m: DuplicateMatches): boolean {
  return m.phone !== null || m.email !== null;
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505).
 * Used as the backstop when the DB unique index rejects a racing or
 * format-equal insert that slipped past the in-app check.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: string }).code === "23505";
}

/**
 * De-duplicate parsed CSV rows by normalized phone, keeping the first
 * occurrence of each. Rows with an empty normalized phone are dropped
 * (they can't be a valid contact). Returns the unique rows plus the
 * count removed as in-file duplicates.
 */
export function dedupeByPhone<T extends { phone: string }>(
  rows: T[],
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;

  for (const row of rows) {
    const key = normalizeKey(row.phone);
    if (!key) {
      duplicates++;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicates };
}
