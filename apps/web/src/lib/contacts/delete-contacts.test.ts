import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@wacrm/shared/db';
import { deleteContacts } from './delete-contacts';

function stubDb(opts: {
  convos?: { id: string }[];
  convErr?: { message: string; code: string; details: string; hint: string };
  dealErr?: { message: string; code: string; details: string; hint: string };
  deleteErr?: { message: string; code: string; details: string; hint: string };
  onDealsUpdate?: (ids: string[]) => void;
  onDelete?: (ids: string[]) => void;
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select: () => ({
            in: async () => ({
              data: opts.convos ?? [],
              error: opts.convErr ?? null,
            }),
          }),
        };
      }
      if (table === 'deals') {
        return {
          update: () => ({
            in: async (_col: string, ids: string[]) => {
              opts.onDealsUpdate?.(ids);
              return { error: opts.dealErr ?? null };
            },
          }),
        };
      }
      if (table === 'contacts') {
        return {
          delete: () => ({
            in: async (_col: string, ids: string[]) => {
              opts.onDelete?.(ids);
              return { error: opts.deleteErr ?? null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe('deleteContacts', () => {
  it('unlinks deals from threads before deleting the contact', async () => {
    const onDealsUpdate = vi.fn();
    const onDelete = vi.fn();
    const { error } = await deleteContacts(
      stubDb({
        convos: [{ id: 'conv-1' }, { id: 'conv-2' }],
        onDealsUpdate,
        onDelete,
      }),
      ['c1']
    );
    expect(error).toBeNull();
    expect(onDealsUpdate).toHaveBeenCalledWith(['conv-1', 'conv-2']);
    expect(onDelete).toHaveBeenCalledWith(['c1']);
  });

  it('skips the deals update when the contact has no threads', async () => {
    const onDealsUpdate = vi.fn();
    const { error } = await deleteContacts(
      stubDb({ convos: [], onDealsUpdate }),
      ['c1']
    );
    expect(error).toBeNull();
    expect(onDealsUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty id list', async () => {
    const { error } = await deleteContacts(stubDb({}), []);
    expect(error).toBeNull();
  });
});
