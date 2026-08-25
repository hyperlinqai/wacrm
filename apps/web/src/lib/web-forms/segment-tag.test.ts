import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@/lib/db'

import { SEGMENT_TAG_COLOR, ensureLeadFormTag, tagBelongsToAccount } from './segment-tag'

/** Records every insert/update and answers the chains this module uses. */
function stubDb(opts: { tagExists?: boolean } = {}) {
  const writes: Array<{ table: string; op: string; values: unknown }> = []
  const from = (table: string) => {
    const b = {
      insert: (values: unknown) => {
        writes.push({ table, op: 'insert', values })
        return b
      },
      update: (values: unknown) => {
        writes.push({ table, op: 'update', values })
        return b
      },
      select: () => b,
      eq: () => b,
      single: () => Promise.resolve({ data: { id: 'tag-new' }, error: null }),
      maybeSingle: () =>
        Promise.resolve({ data: opts.tagExists ? { id: 'tag-1' } : null, error: null }),
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }
    return b
  }
  return { db: { from: vi.fn(from) } as unknown as SupabaseClient, writes }
}

describe('ensureLeadFormTag', () => {
  it('returns the existing tag without writing', async () => {
    const { db, writes } = stubDb()
    const id = await ensureLeadFormTag(
      db,
      { id: 'f1', name: 'Contact us', account_id: 'acct', tag_id: 'tag-existing' },
      'user-1',
    )
    expect(id).toBe('tag-existing')
    expect(writes).toEqual([])
  })

  it('creates a tag named after the form and links it', async () => {
    const { db, writes } = stubDb()
    const id = await ensureLeadFormTag(
      db,
      { id: 'f1', name: 'Contact us', account_id: 'acct', tag_id: null },
      'user-1',
    )
    expect(id).toBe('tag-new')
    expect(writes).toEqual([
      {
        table: 'tags',
        op: 'insert',
        values: { user_id: 'user-1', account_id: 'acct', name: 'Contact us', color: SEGMENT_TAG_COLOR },
      },
      { table: 'lead_forms', op: 'update', values: { tag_id: 'tag-new' } },
    ])
  })
})

describe('tagBelongsToAccount', () => {
  it('is true only when the lookup finds the tag in the account', async () => {
    expect(await tagBelongsToAccount(stubDb({ tagExists: true }).db, 't', 'acct')).toBe(true)
    expect(await tagBelongsToAccount(stubDb({ tagExists: false }).db, 't', 'acct')).toBe(false)
  })
})
