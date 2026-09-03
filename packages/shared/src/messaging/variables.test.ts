import { describe, expect, it } from 'vitest'

import {
  buildVariableCatalog,
  hasVariables,
  insertAtSelection,
  nextTemplatePlaceholder,
  renderVariables,
  resolveVariable,
  templatePlaceholderIndices,
} from './variables'

const ctx = {
  contact: {
    name: 'Shoaib Khan',
    phone: '+919999999999',
    email: 'shoaib@example.com',
    company: 'Hyperlinq',
    custom: { 'Order ID': 'A-42', Plan: 'Pro' },
  },
  vars: { slot: '10:30', budget: 5000 },
  message_text: 'hello there',
}

describe('renderVariables', () => {
  it('resolves contact, custom, flow and message variables', () => {
    expect(
      renderVariables(
        'Hi {{contact.first_name}} ({{ contact.name }}), order {{custom.Order ID}} on {{contact.company}} plan {{custom.plan}}; slot {{vars.slot}}, budget {{vars.budget}}; you said "{{message.text}}"',
        ctx,
      ),
    ).toBe(
      'Hi Shoaib (Shoaib Khan), order A-42 on Hyperlinq plan Pro; slot 10:30, budget 5000; you said "hello there"',
    )
  })

  it('renders the "|fallback" literal when a variable is empty', () => {
    expect(renderVariables('Hi {{contact.first_name|there}}', ctx)).toBe('Hi Shoaib')
    expect(renderVariables('Hi {{contact.first_name|there}}', { contact: null })).toBe('Hi there')
    expect(renderVariables('{{custom.Missing|a|b}}', ctx)).toBe('a|b')
    expect(renderVariables('{{ contact.company | your company }}', { contact: { company: '' } })).toBe(
      'your company',
    )
  })

  it('exposes contacts.source raw and as a message-friendly label', () => {
    const c = { contact: { name: 'A', source: 'meta_ads' } }
    expect(renderVariables('{{contact.source}} / {{contact.source_label}}', c)).toBe(
      'meta_ads / Facebook / Instagram',
    )
    expect(renderVariables('{{contact.source_label}}', { contact: { source: 'api' } })).toBe('our app')
    expect(renderVariables('{{contact.source_label}}', { contact: { source: 'trade_show' } })).toBe(
      'trade show',
    )
    expect(renderVariables('{{contact.source_label|our website}}', { contact: { source: null } })).toBe(
      'our website',
    )
  })

  it('renders unknown or missing variables as empty, never as the raw token', () => {
    expect(renderVariables('a{{contact.nope}}b{{custom.Missing}}c{{vars.x}}d{{bogus}}e', ctx)).toBe('abcde')
    expect(renderVariables('Hi {{contact.name}}!', { contact: null })).toBe('Hi !')
    expect(renderVariables('', ctx)).toBe('')
  })

  it('leaves text without variables untouched, including WhatsApp {{1}} placeholders', () => {
    expect(renderVariables('plain text', ctx)).toBe('plain text')
    // Positional template placeholders are not message variables; they
    // fall through to "" only if someone renders a template body here —
    // callers never do, but document the behaviour.
    expect(resolveVariable('1', ctx)).toBe('')
  })

  it('hasVariables detects tokens and is re-entrant', () => {
    expect(hasVariables('x {{contact.name}}')).toBe(true)
    expect(hasVariables('x {{contact.name}}')).toBe(true)
    expect(hasVariables('nothing')).toBe(false)
  })
})

describe('buildVariableCatalog', () => {
  it('always offers contact fields and adds groups only when populated', () => {
    const groups = buildVariableCatalog()
    expect(groups.map((g) => g.id)).toEqual(['contact'])
    expect(groups[0].items.map((i) => i.token)).toContain('{{contact.name}}')
  })

  it('adds custom fields, flow vars and message text on request', () => {
    const groups = buildVariableCatalog({
      customFieldNames: [' Order ID ', '', 'Plan'],
      flowVarKeys: ['slot'],
      includeMessageText: true,
    })
    expect(groups.map((g) => g.id)).toEqual(['contact', 'custom', 'flow', 'message'])
    expect(groups[1].items.map((i) => i.token)).toEqual(['{{custom.Order ID}}', '{{custom.Plan}}'])
    expect(groups[2].items[0]).toMatchObject({ token: '{{vars.slot}}', label: 'slot' })
    expect(groups[3].items[0].token).toBe('{{message.text}}')
  })
})

describe('template placeholders', () => {
  it('lists indices and proposes the next one', () => {
    expect(templatePlaceholderIndices('Hi {{1}}, code {{ 2 }} and {{1}}')).toEqual([1, 2])
    expect(nextTemplatePlaceholder('Hi {{1}}, code {{2}}')).toBe('{{3}}')
    expect(nextTemplatePlaceholder('no vars')).toBe('{{1}}')
  })
})

describe('insertAtSelection', () => {
  it('inserts at the caret and replaces a selection', () => {
    expect(insertAtSelection('Hello world', '{{contact.name}}', { selectionStart: 6, selectionEnd: 11 })).toEqual({
      value: 'Hello {{contact.name}}',
      caret: 22,
    })
    expect(insertAtSelection('Hello ', 'X', { selectionStart: 6, selectionEnd: 6 })).toEqual({
      value: 'Hello X',
      caret: 7,
    })
  })

  it('appends when there is no element', () => {
    expect(insertAtSelection('Hi', ' {{1}}', null)).toEqual({ value: 'Hi {{1}}', caret: 8 })
  })
})
