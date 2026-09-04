import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '../db/index';
import { resolveImportTagIds } from './resolve-import-tags';

// The account has three tags; a request names one of them plus one that
// does not exist yet. What comes back must be exactly those two — the
// public API's tag sync treats `tagIdByKey.values()` as "the tags this
// contact should have", and a map carrying every account tag turned
// each API-created contact into a contact with every tag.
function fakeClient(opts: { created?: { id: string; name: string }[] } = {}) {
  const inserted: unknown[] = [];
  const builder = () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      insert: (rows: unknown) => {
        inserted.push(rows);
        return b;
      },
      then: (onF: (v: unknown) => unknown) =>
        Promise.resolve({
          data: inserted.length > 0
            ? (opts.created ?? [])
            : [
                { id: 't-vip', name: 'VIP' },
                { id: 't-lead', name: 'Lead' },
                { id: 't-churn', name: 'Churned' },
              ],
          error: null,
        }).then(onF),
    };
    return b;
  };
  return { client: { from: () => builder() } as unknown as SupabaseClient, inserted };
}

describe('resolveImportTagIds', () => {
  it('returns only the requested tags, never the rest of the account', async () => {
    const { client } = fakeClient();
    const { tagIdByKey, skippedNames } = await resolveImportTagIds(client, {
      accountId: 'a',
      userId: 'u',
      tagNames: ['vip', ' Lead '],
      canCreateTags: false,
    });
    expect([...tagIdByKey.entries()].sort()).toEqual([
      ['lead', 't-lead'],
      ['vip', 't-vip'],
    ]);
    expect(skippedNames).toEqual([]);
  });

  it('creates missing names for admins and includes them in the result', async () => {
    const { client, inserted } = fakeClient({ created: [{ id: 't-new', name: 'Hot' }] });
    const { tagIdByKey } = await resolveImportTagIds(client, {
      accountId: 'a',
      userId: 'u',
      tagNames: ['Hot', 'VIP'],
      canCreateTags: true,
    });
    expect(inserted).toHaveLength(1);
    expect([...tagIdByKey.entries()].sort()).toEqual([
      ['hot', 't-new'],
      ['vip', 't-vip'],
    ]);
  });

  it('reports unknown names as skipped when it may not create', async () => {
    const { client, inserted } = fakeClient();
    const { tagIdByKey, skippedNames } = await resolveImportTagIds(client, {
      accountId: 'a',
      userId: 'u',
      tagNames: ['Hot'],
      canCreateTags: false,
    });
    expect(inserted).toHaveLength(0);
    expect(tagIdByKey.size).toBe(0);
    expect(skippedNames).toEqual(['Hot']);
  });

  it('is empty for an empty request without touching the database', async () => {
    const { client } = fakeClient();
    const { tagIdByKey } = await resolveImportTagIds(client, {
      accountId: 'a',
      userId: 'u',
      tagNames: ['', '  '],
      canCreateTags: true,
    });
    expect(tagIdByKey.size).toBe(0);
  });
});
