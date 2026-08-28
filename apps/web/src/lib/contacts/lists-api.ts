// ============================================================
// Contact lists — thin data helpers shared by the Contacts page, the
// import modal and the contact detail sheet (migration 049).
// ============================================================

import type { SupabaseClient } from '@/lib/db';

import type { ContactActivationOverride, ContactList } from '@/types';

const CHUNK = 500;

export interface ContactListWithCount extends ContactList {
  member_count: number;
}

/** Every list visible to the caller, with member counts, sorted by name. */
export async function fetchListsWithCounts(
  supabase: SupabaseClient
): Promise<ContactListWithCount[]> {
  const [{ data: lists, error }, { data: counts }] = await Promise.all([
    supabase.from('contact_lists').select('*').order('name'),
    supabase.rpc('contact_list_counts'),
  ]);
  if (error) throw error;
  const countById = new Map<string, number>();
  for (const row of (counts ?? []) as { list_id: string; member_count: number }[]) {
    countById.set(row.list_id, Number(row.member_count));
  }
  return ((lists ?? []) as ContactList[]).map((l) => ({
    ...l,
    member_count: countById.get(l.id) ?? 0,
  }));
}

export async function createList(
  supabase: SupabaseClient,
  input: { userId: string; accountId: string; name: string; color?: string; description?: string | null }
): Promise<ContactList> {
  const { data, error } = await supabase
    .from('contact_lists')
    .insert({
      user_id: input.userId,
      account_id: input.accountId,
      name: input.name.trim(),
      color: input.color ?? '#8b5cf6',
      description: input.description ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as ContactList;
}

/**
 * Find a list by (case-insensitive) name or create it. Used by the
 * import modal's "new list" path; the unique index on
 * (organization_id, lower(name)) makes the race harmless — a 23505
 * just means someone else created it first, so re-read.
 */
export async function findOrCreateListByName(
  supabase: SupabaseClient,
  input: { userId: string; accountId: string; name: string }
): Promise<ContactList> {
  const name = input.name.trim();
  const { data: existing } = await supabase
    .from('contact_lists')
    .select('*')
    .ilike('name', name)
    .limit(1)
    .maybeSingle();
  if (existing) return existing as ContactList;
  try {
    return await createList(supabase, input);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== '23505') throw err;
    const { data: again, error } = await supabase
      .from('contact_lists')
      .select('*')
      .ilike('name', name)
      .limit(1)
      .single();
    if (error) throw error;
    return again as ContactList;
  }
}

/** Add contacts to a list; already-present pairs are ignored. */
export async function addContactsToList(
  supabase: SupabaseClient,
  listId: string,
  contactIds: string[]
): Promise<void> {
  const ids = [...new Set(contactIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = ids.slice(i, i + CHUNK).map((contact_id) => ({ list_id: listId, contact_id }));
    const { error } = await supabase
      .from('contact_list_members')
      .upsert(rows, { onConflict: 'list_id,contact_id', ignoreDuplicates: true });
    if (error) throw error;
  }
}

export async function removeContactsFromList(
  supabase: SupabaseClient,
  listId: string,
  contactIds: string[]
): Promise<void> {
  const ids = [...new Set(contactIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error } = await supabase
      .from('contact_list_members')
      .delete()
      .eq('list_id', listId)
      .in('contact_id', ids.slice(i, i + CHUNK));
    if (error) throw error;
  }
}

/** List ids a single contact belongs to. */
export async function fetchContactListIds(
  supabase: SupabaseClient,
  contactId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('contact_list_members')
    .select('list_id')
    .eq('contact_id', contactId);
  if (error) throw error;
  return (data ?? []).map((r) => r.list_id as string);
}

/**
 * Pin contacts active/inactive, or clear the pin (null) so they follow
 * the organization rule again. The DB trigger recomputes `is_active`.
 */
export async function setActivationOverride(
  supabase: SupabaseClient,
  contactIds: string[],
  override: ContactActivationOverride | null
): Promise<void> {
  const ids = [...new Set(contactIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error } = await supabase
      .from('contacts')
      .update({ activation_override: override })
      .in('id', ids.slice(i, i + CHUNK));
    if (error) throw error;
  }
}
