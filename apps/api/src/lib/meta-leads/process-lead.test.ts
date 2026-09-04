import { describe, expect, it } from 'vitest'

import { isSameLeadArrivingTwice } from './process-lead'

const T0 = Date.parse('2026-09-04T05:22:20.331Z')

describe('isSameLeadArrivingTwice', () => {
  it('always re-attributes a manually typed contact to the ad', () => {
    expect(isSameLeadArrivingTwice({ source: 'manual', created_at: '2026-01-01T00:00:00Z' }, null, T0)).toBe(true)
  })

  it('re-attributes an API contact created moments before the lead (the customer app won the race)', () => {
    const existing = { source: 'api', created_at: '2026-09-04T05:22:20.250Z' }
    expect(isSameLeadArrivingTwice(existing, '2026-09-04T05:22:20Z', T0)).toBe(true)
  })

  it('keeps the source of an API contact that predates the lead by more than the window', () => {
    const existing = { source: 'api', created_at: '2026-09-01T10:00:00Z' }
    expect(isSameLeadArrivingTwice(existing, '2026-09-04T05:22:20Z', T0)).toBe(false)
  })

  it('falls back to now when Meta sends no created_time', () => {
    const existing = { source: 'api', created_at: new Date(T0 - 60_000).toISOString() }
    expect(isSameLeadArrivingTwice(existing, undefined, T0)).toBe(true)
  })

  it('never touches import, web form or whatsapp contacts', () => {
    for (const source of ['import', 'web_form', 'whatsapp', 'meta_ads']) {
      expect(isSameLeadArrivingTwice({ source, created_at: new Date(T0).toISOString() }, null, T0)).toBe(false)
    }
  })
})
