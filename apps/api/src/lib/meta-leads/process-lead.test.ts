import { describe, expect, it } from 'vitest'

import { isEarlier, isSameLeadArrivingTwice, leadCreatedAt } from './process-lead'

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

describe('leadCreatedAt', () => {
  it("normalises Graph's +0000 offset form to ISO", () => {
    expect(leadCreatedAt('2026-06-04T18:30:00+0000')).toBe('2026-06-04T18:30:00.000Z')
  })

  it('passes a plain ISO timestamp through', () => {
    expect(leadCreatedAt('2026-09-08T15:24:17Z')).toBe('2026-09-08T15:24:17.000Z')
  })

  it('returns null for a missing or unparseable created_time (insert default applies)', () => {
    expect(leadCreatedAt(undefined)).toBeNull()
    expect(leadCreatedAt(null)).toBeNull()
    expect(leadCreatedAt('')).toBeNull()
    expect(leadCreatedAt('not a date')).toBeNull()
  })
})

describe('isEarlier', () => {
  it('is true only when the candidate strictly precedes the reference', () => {
    expect(isEarlier('2026-06-04T18:30:00.000Z', '2026-09-02T04:10:00Z')).toBe(true)
    expect(isEarlier('2026-09-02T04:10:00.000Z', '2026-09-02T04:10:00Z')).toBe(false)
    expect(isEarlier('2026-09-03T00:00:00.000Z', '2026-09-02T04:10:00Z')).toBe(false)
  })

  it('is false when the reference is missing or unparseable', () => {
    expect(isEarlier('2026-06-04T18:30:00.000Z', null)).toBe(false)
    expect(isEarlier('2026-06-04T18:30:00.000Z', 'garbage')).toBe(false)
  })
})
