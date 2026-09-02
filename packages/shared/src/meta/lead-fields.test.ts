import { describe, it, expect } from 'vitest'

import { extractLeadFields } from './lead-fields'

describe('extractLeadFields', () => {
  it('maps Meta pre-filled question keys onto contact fields', () => {
    const out = extractLeadFields([
      { name: 'full_name', values: ['Asha Rao'] },
      { name: 'phone_number', values: ['+919831023021'] },
      { name: 'email', values: ['asha@example.com'] },
      { name: 'company_name', values: ['Rao Traders'] },
    ])
    expect(out.phone).toBe('+919831023021')
    expect(out.name).toBe('Asha Rao')
    expect(out.email).toBe('asha@example.com')
    expect(out.company).toBe('Rao Traders')
    expect(out.answers).toEqual({
      full_name: 'Asha Rao',
      phone_number: '+919831023021',
      email: 'asha@example.com',
      company_name: 'Rao Traders',
    })
  })

  it('joins first + last name when there is no full_name', () => {
    const out = extractLeadFields([
      { name: 'first_name', values: ['Asha'] },
      { name: 'last_name', values: ['Rao'] },
      { name: 'phone_number', values: ['+919831023021'] },
    ])
    expect(out.name).toBe('Asha Rao')
  })

  it('matches custom questions loosely', () => {
    const out = extractLeadFields([
      { name: 'Your WhatsApp number?', values: ['+44 7700 900123'] },
      { name: 'Your Name', values: ['Sam'] },
      { name: 'Work E-mail', values: ['sam@example.com'] },
      { name: 'Which plan?', values: ['Pro'] },
    ])
    expect(out.phone).toBe('+44 7700 900123')
    expect(out.name).toBe('Sam')
    expect(out.email).toBe('sam@example.com')
    expect(out.answers['Which plan?']).toBe('Pro')
  })

  it('prefers the exact phone key over a loose match', () => {
    const out = extractLeadFields([
      { name: 'Alternate phone', values: ['+1111'] },
      { name: 'phone_number', values: ['+2222'] },
    ])
    expect(out.phone).toBe('+2222')
  })

  it('returns nulls for missing / empty answers and skips malformed entries', () => {
    const out = extractLeadFields([
      { name: 'phone_number', values: [''] },
      { name: 'email' },
      // @ts-expect-error — malformed datum shape from a bad payload
      { values: ['x'] },
      null as unknown as { name: string },
    ])
    expect(out).toEqual({ phone: null, name: null, email: null, company: null, answers: {} })
    expect(extractLeadFields(undefined).phone).toBeNull()
  })

  it('does not mistake company_name for the person name', () => {
    const out = extractLeadFields([
      { name: 'company_name', values: ['Acme'] },
      { name: 'phone_number', values: ['+1'] },
    ])
    expect(out.name).toBeNull()
    expect(out.company).toBe('Acme')
  })
})
