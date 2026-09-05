// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Kept out of the route files so `GET/POST /api/v1/contacts` and
// `GET/PATCH /api/v1/contacts/{id}` share one serializer, one
// find-or-create (built on the same `findExistingContact` dedupe the
// webhook and send path use), and one tag-sync routine.
// ============================================================

import type { SupabaseClient } from '@wacrm/shared/db';

import { findExistingContact, isUniqueViolation } from '@wacrm/shared/contacts/dedupe';
import { resolveImportTagIds } from '@wacrm/shared/contacts/resolve-import-tags';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { contactPhoneFromInput } from '@wacrm/shared/contacts/store-phone';

/** Row select that embeds the contact's tags for serialization. */
export const CONTACT_SELECT = '*, contact_tags(tags(*))';

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

type RawTagJoin = { tags: { id: string; name: string; color: string } | null };

/** Flatten a `CONTACT_SELECT` row into the public contact shape. */
export function serializeContact(row: Record<string, unknown>): ApiContact {
  const joins = (row.contact_tags as RawTagJoin[] | undefined) ?? [];
  return {
    id: row.id as string,
    phone: row.phone as string,
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    company: (row.company as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    tags: joins
      .map((j) => j.tags)
      .filter((t): t is NonNullable<RawTagJoin['tags']> => t != null)
      .map((t) => ({ id: t.id, name: t.name, color: t.color })),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Resolve the audit `user_id` for API-created rows — the SINGLE source
 * of truth used by every public-API write (contacts, messages,
 * broadcasts, resolve-conversation), so the same key's writes are
 * always attributed to the same human. API callers have no logged-in
 * user, so — like the inbound webhook — we attribute writes to the
 * **WhatsApp config owner** (the webhook's own convention). Contacts
 * can be created before WhatsApp is connected, so we fall back to the
 * account owner when there's no config yet.
 */
export async function resolveAuditUserId(
  db: SupabaseClient,
  organizationId: string,
  accountId: string
): Promise<string> {
  const { data: config } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('organization_id', organizationId)
    .maybeSingle();
  const configOwner = config?.user_id as string | undefined;
  if (configOwner) return configOwner;

  // `accounts` has no organization_id (Phase 2 excluded the identity/
  // membership layer from the rollout) and organizations has no
  // owner_user_id — accountId is the only way to reach the owner, and
  // it's safe here: the caller already resolved it from the validated
  // API key / session, not from request input.
  const { data: account } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  const owner = account?.owner_user_id as string | undefined;
  if (!owner) {
    throw new ContactError('Account owner could not be resolved', 500);
  }
  return owner;
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  /** contacts.source to stamp on a *newly created* row (migration 046).
   *  Defaults to 'api'; existing contacts are never re-attributed here. */
  source?: 'manual' | 'whatsapp' | 'web_form' | 'import' | 'api' | 'meta_ads';
  /**
   * ISO 3166-1 alpha-2 country to assume for a number with no country
   * code. Callers that already hold the account row (the broadcast
   * resolver, the Meta Lead Ads processor) pass it so a batch does not
   * re-read `accounts` once per recipient; everyone else can omit it and
   * let the lookup below find it.
   */
  defaultCountry?: string | null;
}

/** Human-readable half of a cleanPhone rejection, for the 400 body. */
const PHONE_REJECTION_HELP: Record<string, string> = {
  empty: 'it is blank',
  excel_scientific:
    'a spreadsheet rewrote it as scientific notation (9.18E+11) and the last digits are gone',
  no_country_code:
    "it has no country code and this account has no default country set (Settings → set a default country, or send it as +E.164)",
  too_short: 'it has fewer digits than any real number',
  not_a_valid_number: 'it is not a real number for its country',
};

/**
 * Find (by fuzzy phone match) or create a contact in `accountId`.
 * Returns the contact id and whether it was created. Reuses the shared
 * `findExistingContact` dedupe + unique-violation race backstop so an
 * API-created contact is indistinguishable from a webhook-created one.
 */
export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  // Resolve to canonical +E.164 before anything else. Callers each used
  // to hand over whatever shape they had — Meta Lead Ads a clean "+91…",
  // the broadcast resolver bare digits, the web form whatever the
  // visitor typed — and this function stored the digits with the "+"
  // stripped, which is Meta's *send* format, not the storage format.
  // Doing it here is what makes all four agree without each remembering.
  //
  // The caller's own value is tried first: an already-international
  // number needs no country, so the `accounts` lookup below is skipped
  // for the common case and only runs for the one that needs it — a bare
  // national number from a caller that did not pass `defaultCountry`.
  let resolved = contactPhoneFromInput(input.phone, input.defaultCountry ?? null);
  if (!resolved.ok && resolved.rejection === 'no_country_code' && input.defaultCountry == null) {
    const { data: account } = await db
      .from('accounts')
      .select('default_country_code')
      .eq('id', accountId)
      .maybeSingle();
    const defaultCountry = (account?.default_country_code as string | null) ?? null;
    if (defaultCountry) resolved = contactPhoneFromInput(input.phone, defaultCountry);
  }
  if (!resolved.ok) {
    const why = PHONE_REJECTION_HELP[resolved.rejection] ?? 'it is not a valid number';
    throw new ContactError(
      `'phone' could not be resolved to an international number: ${why}`,
      400
    );
  }
  const phone = resolved.phone;

  const existing = await findExistingContact(db, accountId, phone);
  if (existing) return { id: existing.id, created: false };

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      phone,
      name: input.name ?? phone,
      email: input.email ?? null,
      company: input.company ?? null,
      source: input.source ?? 'api',
    })
    .select('id')
    .single();

  if (error || !created) {
    // Lost a race against a concurrent create — the unique index
    // rejected the duplicate. Re-resolve to the winner.
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, accountId, phone);
      if (raced) return { id: raced.id, created: false };
    }
    console.error('[api/v1/contacts] create error:', error);
    throw new ContactError('Failed to create contact', 500);
  }

  return { id: created.id, created: true };
}

/**
 * Replace a contact's tags to exactly match `tagNames` (case-
 * insensitive; missing tags are created). A no-op when `tagNames` is
 * undefined — pass `[]` to clear all tags. Reuses `resolveImportTagIds`
 * so API and CSV-import tag handling stay consistent.
 */
export async function setContactTags(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  contactId: string,
  tagNames: string[]
): Promise<void> {
  const { tagIdByKey } = await resolveImportTagIds(db, {
    accountId,
    userId: auditUserId,
    tagNames,
    canCreateTags: true,
  });
  const desired = new Set(tagIdByKey.values());

  // Diff against the current joins rather than delete-all-then-insert:
  // a diff only touches tags that actually change, so a mid-operation
  // failure can never wipe tags that were meant to stay. Every write
  // is error-checked and surfaced as a ContactError (→ 500) instead of
  // being swallowed behind a misleading 200.
  const { data: current, error: readErr } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId);
  if (readErr) {
    throw new ContactError('Failed to read contact tags', 500);
  }
  const existing = new Set(
    (current ?? []).map((r) => r.tag_id as string)
  );

  const toAdd = [...desired].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !desired.has(id));

  if (toRemove.length > 0) {
    const { error } = await db
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .in('tag_id', toRemove);
    if (error) throw new ContactError('Failed to update contact tags', 500);
  }
  if (toAdd.length > 0) {
    for (const tagId of toAdd) {
      try {
        await addContactTagAndDispatch({
          db,
          accountId,
          contactId,
          tagId,
        });
      } catch (error) {
        console.error('[api/v1/contacts] tag add failed:', error);
        throw new ContactError('Failed to update contact tags', 500);
      }
    }
  }
}

/** Fetch + serialize a single contact scoped to the organization, or null. */
export async function getContactById(
  db: SupabaseClient,
  organizationId: string,
  contactId: string
): Promise<ApiContact | null> {
  const { data, error } = await db
    .from('contacts')
    .select(CONTACT_SELECT)
    .eq('id', contactId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error || !data) return null;
  return serializeContact(data as Record<string, unknown>);
}
