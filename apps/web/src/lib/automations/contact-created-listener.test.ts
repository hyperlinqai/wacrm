import { describe, expect, it, vi } from 'vitest'

import { claimContactCreatedDispatch, handleContactNotify } from './contact-created-listener'

describe('claimContactCreatedDispatch', () => {
  it('lets only the first claimant through, then expires the claim', () => {
    const id = 'c-' + Math.random()
    expect(claimContactCreatedDispatch(id, 1_000)).toBe(true)
    expect(claimContactCreatedDispatch(id, 2_000)).toBe(false)
    // After the TTL the id can be claimed again (e.g. re-created row).
    expect(claimContactCreatedDispatch(id, 1_000 + 61_000)).toBe(true)
  })
})

describe('handleContactNotify', () => {
  it('dispatches new_contact_created for a contacts INSERT', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const handled = await handleContactNotify(
      { table: 'contacts', op: 'INSERT', keys: { id: 'ct-1', account_id: 'acct', source: 'web_form' } },
      dispatch,
    )
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith({
      accountId: 'acct',
      triggerType: 'new_contact_created',
      contactId: 'ct-1',
      context: { vars: { contact_source: 'web_form' } },
    })
  })

  it('ignores other tables, updates/deletes, and rows missing keys', async () => {
    const dispatch = vi.fn()
    expect(await handleContactNotify({ table: 'messages', op: 'INSERT', keys: { id: 'x', account_id: 'a' } }, dispatch)).toBe(false)
    expect(await handleContactNotify({ table: 'contacts', op: 'UPDATE', keys: { id: 'ct-2', account_id: 'a' } }, dispatch)).toBe(false)
    expect(await handleContactNotify({ table: 'contacts', op: 'INSERT', keys: { id: 'ct-3' } }, dispatch)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch twice for the same contact (webhook already claimed it)', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    expect(claimContactCreatedDispatch('ct-4')).toBe(true) // the webhook got there first
    expect(await handleContactNotify({ table: 'contacts', op: 'INSERT', keys: { id: 'ct-4', account_id: 'a' } }, dispatch)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
