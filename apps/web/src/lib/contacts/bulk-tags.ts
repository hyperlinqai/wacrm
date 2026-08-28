// ============================================================
// Bulk tag add/remove for the Contacts page's bulk-action bar.
//
// Goes through the same per-contact API route (addContactTag /
// deleteContactTag) as the single-contact Tags tab, not a direct
// contact_tags insert/delete — tag changes fire automation dispatch
// (tag-triggered automations, migration 006/047) and that dispatch
// only happens on the API route. A bulk write straight to the table
// would silently skip automations for every contact in the batch.
// Concurrency is capped so selecting hundreds of contacts doesn't fire
// hundreds of simultaneous fetches at once.
// ============================================================

import { addContactTag, deleteContactTag } from './tag-api';

const CONCURRENCY = 8;

/** Run `fn` over every item, at most `limit` in flight at once. */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        await fn(item);
        succeeded++;
      } catch {
        failed++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { succeeded, failed };
}

export interface BulkTagResult {
  /** Successful (contact, tag) writes — duplicates/no-ops count as success. */
  succeeded: number;
  /** (contact, tag) pairs that errored (network, ownership, max automation depth, …). */
  failed: number;
}

export async function bulkAddTags(
  contactIds: string[],
  tagIds: string[]
): Promise<BulkTagResult> {
  const pairs = contactIds.flatMap((contactId) => tagIds.map((tagId) => ({ contactId, tagId })));
  return runWithConcurrency(pairs, CONCURRENCY, async ({ contactId, tagId }) => {
    await addContactTag(contactId, tagId);
  });
}

export async function bulkRemoveTags(
  contactIds: string[],
  tagIds: string[]
): Promise<BulkTagResult> {
  const pairs = contactIds.flatMap((contactId) => tagIds.map((tagId) => ({ contactId, tagId })));
  return runWithConcurrency(pairs, CONCURRENCY, async ({ contactId, tagId }) => {
    await deleteContactTag(contactId, tagId);
  });
}
