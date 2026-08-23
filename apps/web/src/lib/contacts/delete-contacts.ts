import type { PostgrestError, SupabaseClient } from '@/lib/db';

/**
 * Delete contacts after detaching pipeline deals from their threads.
 *
 * Live Postgres still has deals.conversation_id → conversations(id)
 * with NO ACTION. Deleting a contact CASCADE-deletes conversations,
 * which then fails with 23503 if a deal still points at the thread.
 * Migration 041 SET NULLs that FK, but the app role cannot ALTER TABLE
 * on the hosted DB — so we unlink deals first.
 */
export async function deleteContacts(
  db: SupabaseClient,
  ids: string[]
): Promise<{ error: PostgrestError | null }> {
  if (ids.length === 0) return { error: null };

  const { data: convos, error: convErr } = await db
    .from('conversations')
    .select('id')
    .in('contact_id', ids);

  if (convErr) return { error: convErr };

  const conversationIds = (convos ?? [])
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string');

  if (conversationIds.length > 0) {
    const { error: dealErr } = await db
      .from('deals')
      .update({ conversation_id: null })
      .in('conversation_id', conversationIds);
    if (dealErr) return { error: dealErr };
  }

  const { error } = await db.from('contacts').delete().in('id', ids);
  return { error };
}
