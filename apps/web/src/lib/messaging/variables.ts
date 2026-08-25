// One vocabulary of message variables for every place text is drafted
// (automation steps, flow prompts, quick replies, the inbox composer)
// and one renderer that resolves them at send time. Isomorphic — no
// DB or DOM here; the server loads a ContactVariables snapshot with
// load-contact-variables.ts and the UI builds pickers from the catalog.
//
// Syntax: {{contact.name}} {{contact.first_name}} {{contact.phone}}
//         {{contact.email}} {{contact.company}}
//         {{custom.<Field name>}}   — a contact custom field, by name
//         {{vars.<key>}}            — a value captured earlier in a flow
//         {{message.text}}          — the inbound message that triggered
// Unknown or empty variables render as "" (never as the raw token).
//
// WhatsApp *templates* are different: Meta requires positional {{1}},
// {{2}} placeholders that are mapped to values per broadcast, so the
// template builder inserts those instead (see nextTemplatePlaceholder).

export interface ContactVariables {
  name?: string | null
  phone?: string | null
  email?: string | null
  company?: string | null
  /** Custom field values keyed by the field's display name. */
  custom?: Record<string, string | null | undefined>
}

export interface VariableContext {
  contact?: ContactVariables | null
  vars?: Record<string, unknown> | null
  message_text?: string | null
}

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? ''
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}

/** Resolve one dotted variable name against the context; "" if unknown. */
export function resolveVariable(name: string, ctx: VariableContext): string {
  const dot = name.indexOf('.')
  if (dot === -1) return ''
  const ns = name.slice(0, dot).trim().toLowerCase()
  const key = name.slice(dot + 1).trim()

  switch (ns) {
    case 'contact': {
      const c = ctx.contact
      if (!c) return ''
      switch (key.toLowerCase()) {
        case 'name':
          return str(c.name)
        case 'first_name':
        case 'firstname':
          return firstName(c.name)
        case 'phone':
          return str(c.phone)
        case 'email':
          return str(c.email)
        case 'company':
          return str(c.company)
        default:
          return ''
      }
    }
    case 'custom': {
      const custom = ctx.contact?.custom
      if (!custom) return ''
      if (key in custom) return str(custom[key])
      // Field names are user-typed; be forgiving about case.
      const hit = Object.keys(custom).find((k) => k.toLowerCase() === key.toLowerCase())
      return hit ? str(custom[hit]) : ''
    }
    case 'vars':
      return str(ctx.vars?.[key])
    case 'message':
      return key.toLowerCase() === 'text' ? str(ctx.message_text) : ''
    default:
      return ''
  }
}

/** Replace every {{…}} variable in `text` using `ctx`. */
export function renderVariables(text: string, ctx: VariableContext): string {
  if (!text) return ''
  return text.replace(TOKEN_RE, (_, name: string) => resolveVariable(name, ctx))
}

/** Does the text reference any {{…}} variable at all? */
export function hasVariables(text: string): boolean {
  TOKEN_RE.lastIndex = 0
  return TOKEN_RE.test(text)
}

// ── Picker catalog ────────────────────────────────────────────────────

export interface VariableItem {
  /** The literal token to insert, e.g. "{{contact.name}}". */
  token: string
  /** i18n key for the human label, resolved by the picker. */
  labelKey: string
  /** Free-text label (used for user-named items like custom fields / flow vars). */
  label?: string
}

export interface VariableGroup {
  id: 'contact' | 'custom' | 'flow' | 'message'
  items: VariableItem[]
}

export const CONTACT_VARIABLE_ITEMS: VariableItem[] = [
  { token: '{{contact.name}}', labelKey: 'contactName' },
  { token: '{{contact.first_name}}', labelKey: 'contactFirstName' },
  { token: '{{contact.phone}}', labelKey: 'contactPhone' },
  { token: '{{contact.email}}', labelKey: 'contactEmail' },
  { token: '{{contact.company}}', labelKey: 'contactCompany' },
]

export interface CatalogOptions {
  /** Custom field display names available on this account. */
  customFieldNames?: string[]
  /** Flow variable keys captured by earlier collect_input nodes. */
  flowVarKeys?: string[]
  /** Whether {{message.text}} is meaningful here (message-triggered). */
  includeMessageText?: boolean
}

/** Build the groups a VariablePicker shows for a given surface. */
export function buildVariableCatalog(opts: CatalogOptions = {}): VariableGroup[] {
  const groups: VariableGroup[] = [{ id: 'contact', items: CONTACT_VARIABLE_ITEMS }]
  const custom = (opts.customFieldNames ?? []).map((n) => n.trim()).filter(Boolean)
  if (custom.length) {
    groups.push({
      id: 'custom',
      items: custom.map((n) => ({ token: `{{custom.${n}}}`, labelKey: 'customField', label: n })),
    })
  }
  const flow = (opts.flowVarKeys ?? []).map((k) => k.trim()).filter(Boolean)
  if (flow.length) {
    groups.push({
      id: 'flow',
      items: flow.map((k) => ({ token: `{{vars.${k}}}`, labelKey: 'flowVar', label: k })),
    })
  }
  if (opts.includeMessageText) {
    groups.push({ id: 'message', items: [{ token: '{{message.text}}', labelKey: 'messageText' }] })
  }
  return groups
}

// ── WhatsApp template placeholders ───────────────────────────────────

/** Indices used by positional placeholders, e.g. "{{1}} {{3}}" → [1, 3]. */
export function templatePlaceholderIndices(text: string): number[] {
  const out = new Set<number>()
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) out.add(Number(m[1]))
  return [...out].sort((a, b) => a - b)
}

/** The next positional placeholder to insert: one past the highest in use. */
export function nextTemplatePlaceholder(text: string): string {
  const idx = templatePlaceholderIndices(text)
  const next = idx.length ? Math.max(...idx) + 1 : 1
  return `{{${next}}}`
}

// ── Cursor insertion ─────────────────────────────────────────────────

export interface InsertResult {
  value: string
  /** Caret position after the inserted token. */
  caret: number
}

/**
 * Insert `token` into `value` at the current selection of `el`
 * (replacing any selected text), or append when there is no element /
 * selection. Pure on the string — the caller sets state and restores
 * the caret with `caret`.
 */
export function insertAtSelection(
  value: string,
  token: string,
  // Both <textarea> and <input> — the latter reports null for some types.
  el?: { selectionStart: number | null; selectionEnd: number | null } | null,
): InsertResult {
  const start = el?.selectionStart ?? value.length
  const end = el?.selectionEnd ?? value.length
  const safeStart = Math.min(Math.max(0, start), value.length)
  const safeEnd = Math.min(Math.max(safeStart, end), value.length)
  const next = value.slice(0, safeStart) + token + value.slice(safeEnd)
  return { value: next, caret: safeStart + token.length }
}
