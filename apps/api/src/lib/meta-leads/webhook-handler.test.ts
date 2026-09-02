import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  fetchLeadgenLead: vi.fn(),
  processMetaLead: vi.fn(),
  state: {
    /** meta_lead_pages rows keyed by page_id. */
    pages: {} as Record<string, Record<string, unknown> | null>,
    lookups: 0,
  },
}))

vi.mock('@/lib/db/server-client', () => ({
  makeAdminClient: () => ({
    from(table: string) {
      if (table !== 'meta_lead_pages') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (_col: string, pageId: string) => ({
            maybeSingle: () => {
              h.state.lookups++
              return Promise.resolve({ data: h.state.pages[pageId] ?? null, error: null })
            },
          }),
        }),
      }
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v === 'bad') throw new Error('bad ciphertext')
    return `dec(${v})`
  },
}))

vi.mock('@wacrm/shared/meta/lead-ads-api', () => ({
  fetchLeadgenLead: h.fetchLeadgenLead,
  MetaGraphError: class MetaGraphError extends Error {
    code = 190
  },
}))

vi.mock('./process-lead', () => ({
  processMetaLead: h.processMetaLead,
}))

import { handleLeadgenWebhook, isPageWebhookBody } from './webhook-handler'

const pageRow = {
  id: 'row-1',
  organization_id: 'org-1',
  account_id: 'acc-1',
  page_id: '111',
  page_name: 'Test Page',
  status: 'active',
  tag_id: null,
  connected_by: 'user-1',
  page_access_token: 'enc-token',
}

function body(changes: Array<Record<string, unknown>>, entryId = '111') {
  return {
    object: 'page',
    entry: [{ id: entryId, time: 1, changes }],
  }
}

beforeEach(() => {
  h.fetchLeadgenLead.mockReset()
  h.processMetaLead.mockReset()
  h.state.pages = { '111': pageRow }
  h.state.lookups = 0
})

describe('isPageWebhookBody', () => {
  it('accepts object: page and rejects anything else', () => {
    expect(isPageWebhookBody({ object: 'page' })).toBe(true)
    expect(isPageWebhookBody({ object: 'whatsapp_business_account' })).toBe(false)
    expect(isPageWebhookBody(null)).toBe(false)
    expect(isPageWebhookBody('page')).toBe(false)
  })
})

describe('handleLeadgenWebhook', () => {
  it('fetches the lead with the decrypted Page token and processes it', async () => {
    h.fetchLeadgenLead.mockResolvedValue({ id: 'L1', field_data: [] })
    h.processMetaLead.mockResolvedValue({ kind: 'created', contactId: 'c1', leadRowId: 'ml1' })

    const result = await handleLeadgenWebhook(
      body([{ field: 'leadgen', value: { page_id: '111', leadgen_id: 'L1', form_id: 'F1' } }]),
    )

    expect(result).toEqual({ processed: 1, skipped: 0 })
    expect(h.fetchLeadgenLead).toHaveBeenCalledWith({ leadgenId: 'L1', pageAccessToken: 'dec(enc-token)' })
    expect(h.processMetaLead).toHaveBeenCalledTimes(1)
    const call = h.processMetaLead.mock.calls[0][0]
    expect(call.receivedVia).toBe('webhook')
    expect(call.page).toMatchObject({ id: 'row-1', page_id: '111', organization_id: 'org-1' })
    expect(call.page.token).toBeUndefined()
    expect(call.lead.id).toBe('L1')
  })

  it('looks a Page up once per delivery and counts duplicates as skipped', async () => {
    h.fetchLeadgenLead.mockResolvedValue({ id: 'L', field_data: [] })
    h.processMetaLead
      .mockResolvedValueOnce({ kind: 'created', contactId: 'c1', leadRowId: 'ml1' })
      .mockResolvedValueOnce({ kind: 'duplicate' })

    const result = await handleLeadgenWebhook(
      body([
        { field: 'leadgen', value: { page_id: '111', leadgen_id: 'L1' } },
        { field: 'leadgen', value: { page_id: '111', leadgen_id: 'L2' } },
      ]),
    )

    expect(result).toEqual({ processed: 1, skipped: 1 })
    expect(h.state.lookups).toBe(1)
  })

  it('ignores unknown Pages, paused Pages, non-leadgen fields and undecryptable tokens', async () => {
    h.state.pages = {
      '111': { ...pageRow, status: 'paused' },
      '222': { ...pageRow, id: 'row-2', page_id: '222', page_access_token: 'bad' },
    }
    const result = await handleLeadgenWebhook({
      object: 'page',
      entry: [
        { id: '111', changes: [{ field: 'leadgen', value: { page_id: '111', leadgen_id: 'L1' } }] },
        { id: '222', changes: [{ field: 'leadgen', value: { page_id: '222', leadgen_id: 'L2' } }] },
        { id: '999', changes: [{ field: 'leadgen', value: { page_id: '999', leadgen_id: 'L3' } }] },
        { id: '111', changes: [{ field: 'feed', value: { item: 'post' } }] },
        { id: '111', changes: [{ field: 'leadgen', value: { page_id: '111' } }] },
      ],
    })
    expect(result).toEqual({ processed: 0, skipped: 4 })
    expect(h.fetchLeadgenLead).not.toHaveBeenCalled()
    expect(h.processMetaLead).not.toHaveBeenCalled()
  })

  it('falls back to entry.id when value.page_id is absent', async () => {
    h.fetchLeadgenLead.mockResolvedValue({ id: 'L1', field_data: [] })
    h.processMetaLead.mockResolvedValue({ kind: 'matched', contactId: 'c1', leadRowId: 'ml1' })
    const result = await handleLeadgenWebhook(body([{ field: 'leadgen', value: { leadgen_id: 'L1' } }], '111'))
    expect(result).toEqual({ processed: 1, skipped: 0 })
  })

  it('keeps going when the Graph API fails for one lead', async () => {
    h.fetchLeadgenLead
      .mockRejectedValueOnce(new Error('(#190) token expired'))
      .mockResolvedValueOnce({ id: 'L2', field_data: [] })
    h.processMetaLead.mockResolvedValue({ kind: 'created', contactId: 'c2', leadRowId: 'ml2' })

    const result = await handleLeadgenWebhook(
      body([
        { field: 'leadgen', value: { page_id: '111', leadgen_id: 'L1' } },
        { field: 'leadgen', value: { page_id: '111', leadgen_id: 'L2' } },
      ]),
    )
    expect(result).toEqual({ processed: 1, skipped: 1 })
  })

  it('handles an empty / malformed body without throwing', async () => {
    expect(await handleLeadgenWebhook({ object: 'page' })).toEqual({ processed: 0, skipped: 0 })
    expect(await handleLeadgenWebhook({ object: 'page', entry: [{}] })).toEqual({ processed: 0, skipped: 0 })
  })
})
