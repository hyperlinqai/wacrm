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

import { humanizeLeadValue, mapLeadAnswersToCustomFields } from './lead-fields'

describe('humanizeLeadValue', () => {
  it('turns option keys into readable text and leaves free text alone', () => {
    expect(humanizeLeadValue('badminton____')).toBe('Badminton')
    expect(humanizeLeadValue('within_30_days')).toBe('Within 30 days')
    expect(humanizeLeadValue('club_')).toBe('Club')
    expect(humanizeLeadValue('just_exploring')).toBe('Just exploring')
    expect(humanizeLeadValue('  Bangalore ')).toBe('Bangalore')
    expect(humanizeLeadValue('Mumbai, Maharashtra')).toBe('Mumbai, Maharashtra')
    expect(humanizeLeadValue('others')).toBe('Others')
    expect(humanizeLeadValue('school_/_college')).toBe('School / college')
    expect(humanizeLeadValue('+919116200492')).toBe('+919116200492')
    expect(humanizeLeadValue('')).toBe('')
  })
})

describe('mapLeadAnswersToCustomFields', () => {
  const FIELDS = [
    'Company Type',
    'Country',
    'State',
    'City',
    'Tournament Type interested in',
    'Sports interested in',
    'Features interested in',
    'Next tournament plan',
    'Campaign name',
    'Lead source',
  ]

  it('maps the SportsGenX lead form questions onto the matching custom fields', () => {
    const out = mapLeadAnswersToCustomFields(
      {
        full_name: 'Shravan Tiwari',
        phone_number: '+919116200492',
        email: 'x@example.com',
        'when_are_you_planning_to_organize_your_league?': 'within_30_days',
        city: 'Sultanpur',
        'please_select_your_sport_category:': 'badminton____',
        'please_select_the_category_that_best_describes_you:': 'academy___',
      },
      FIELDS,
    )
    expect(Object.fromEntries(out.map((m) => [m.fieldName, m.value]))).toEqual({
      'Next tournament plan': 'Within 30 days',
      City: 'Sultanpur',
      'Sports interested in': 'Badminton',
      'Company Type': 'Academy',
    })
  })

  it('matches by normalised name equality and by field-name words as fallbacks', () => {
    const out = mapLeadAnswersToCustomFields(
      {
        'Which sports are you most interested in?': 'Cricket, Football',
        'Lead Source': 'Referral',
        'What is your budget?': '50k',
      },
      ['Sports interested in', 'lead_source', 'Budget'],
    )
    expect(out.map((m) => [m.fieldName, m.value])).toEqual([
      ['Sports interested in', 'Cricket, Football'],
      ['lead_source', 'Referral'],
      ['Budget', '50k'],
    ])
  })

  it('never maps core contact questions and gives each field at most one answer', () => {
    const out = mapLeadAnswersToCustomFields(
      {
        full_name: 'A',
        'have_you_worked_in_sports_events/tournaments_before?': 'yes',
        'please_select_your_sport_category:': 'tennis',
        'which_sports_are_you_most_interested_in?': 'cricket',
      },
      ['Sports interested in', 'Name'],
    )
    expect(out).toEqual([
      { fieldName: 'Sports interested in', value: 'Tennis', question: 'please_select_your_sport_category:' },
    ])
  })

  it('returns nothing when the account has no matching fields', () => {
    expect(mapLeadAnswersToCustomFields({ city: 'Pune' }, [])).toEqual([])
    expect(mapLeadAnswersToCustomFields({ city: 'Pune' }, ['Plan'])).toEqual([])
  })
})
