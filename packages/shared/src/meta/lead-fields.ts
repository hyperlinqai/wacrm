// ============================================================
// Meta Lead Ads — field_data → contact fields
//
// A Lead Ads form answer comes back from the Graph API as
//   field_data: [{ name: 'full_name', values: ['Asha Rao'] },
//                { name: 'phone_number', values: ['+919831023021'] }, …]
// where `name` is whatever the advertiser typed when building the
// form. Meta's own pre-filled questions use stable snake_case keys
// (full_name, phone_number, email, company_name, …) but custom
// questions can be anything ("Your WhatsApp number?"), so matching is
// by normalised key first and by loose substring second.
//
// Pure — no I/O — so the webhook processor and Sync share one
// interpretation and it can be unit-tested without Meta.
// ============================================================

export interface MetaLeadFieldDatum {
  name: string
  values?: unknown[]
}

export interface ExtractedLeadFields {
  phone: string | null
  name: string | null
  email: string | null
  company: string | null
  /** Every answer as label → joined value, including the ones mapped above. */
  answers: Record<string, string>
}

const PHONE_KEYS = ['phone_number', 'phone', 'mobile', 'mobile_number', 'whatsapp', 'whatsapp_number', 'work_phone', 'cell', 'contact_number', 'telephone']
const EMAIL_KEYS = ['email', 'email_address', 'work_email']
const FULL_NAME_KEYS = ['full_name', 'name', 'your_name']
const FIRST_NAME_KEYS = ['first_name', 'given_name']
const LAST_NAME_KEYS = ['last_name', 'surname', 'family_name']
const COMPANY_KEYS = ['company_name', 'company', 'business_name', 'organisation', 'organization']

function normaliseKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function firstValue(values: unknown[] | undefined): string | null {
  if (!Array.isArray(values)) return null
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return null
}

function pick(
  entries: { key: string; value: string }[],
  exact: string[],
  loose?: (key: string) => boolean,
): string | null {
  for (const k of exact) {
    const hit = entries.find((e) => e.key === k)
    if (hit) return hit.value
  }
  if (loose) {
    const hit = entries.find((e) => loose(e.key))
    if (hit) return hit.value
  }
  return null
}

/**
 * Map a lead's `field_data` onto the contact columns this CRM has.
 * Unknown questions are kept in `answers` so nothing the person typed
 * is lost — the meta_leads row stores the raw field_data too.
 */
export function extractLeadFields(fieldData: MetaLeadFieldDatum[] | null | undefined): ExtractedLeadFields {
  const answers: Record<string, string> = {}
  const entries: { key: string; value: string }[] = []

  for (const datum of fieldData ?? []) {
    if (!datum || typeof datum.name !== 'string') continue
    const value = firstValue(datum.values)
    if (value === null) continue
    const all = (datum.values ?? [])
      .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
      .map(String)
      .filter((s) => s.trim())
    answers[datum.name] = all.join(', ')
    entries.push({ key: normaliseKey(datum.name), value })
  }

  const phone = pick(entries, PHONE_KEYS, (k) => /phone|mobile|whatsapp|cell/.test(k))
  const email = pick(entries, EMAIL_KEYS, (k) => k.includes('email') || k.includes('e_mail'))
  const company = pick(entries, COMPANY_KEYS, (k) => k.includes('company') || k.includes('business'))

  let name = pick(entries, FULL_NAME_KEYS)
  if (!name) {
    const first = pick(entries, FIRST_NAME_KEYS)
    const last = pick(entries, LAST_NAME_KEYS)
    const joined = [first, last].filter(Boolean).join(' ').trim()
    name = joined || null
  }
  if (!name) {
    // Custom question phrased like "Your name" / "Full Name:".
    name = pick(entries, [], (k) => k.includes('name') && !k.includes('company') && !k.includes('business'))
  }

  return { phone, name, email, company, answers }
}

// ============================================================
// Custom-field enrichment
//
// Beyond name / phone / email / company, a Lead Ads form usually asks
// the qualifying questions a sales team actually wants on the contact
// ("which sport?", "when are you planning?", "city"). Those answers
// used to survive only inside meta_leads.field_data — invisible to the
// Contacts page, to filters and to message variables. The helpers
// below map them onto the account's custom fields *by field name*, so
// an admin controls the mapping simply by naming fields sensibly.
//
// Matching, in order:
//   1. a rule whose question pattern matches the normalised question
//      key AND whose field pattern matches a custom field name;
//   2. the normalised question key equals the normalised field name;
//   3. every word of the field name appears in the question key.
// The first match wins; a field receives at most one answer.
// ============================================================

const MAPPING_RULES: { question: RegExp; field: RegExp }[] = [
  // "which sport…" / "select your sport category" — not "have you worked in sports events before?"
  { question: /(which|select|choose|prefer|interest|favou?rite|main|primary).*sport|sport.*(categor|interest|prefer)/, field: /sport/ },
  { question: /categor.*describ|describes_you|type_of_organi|organi[sz]ation_type|company_type|you_are_a|i_am_a/, field: /company.?type|organi[sz]ation.?type|category/ },
  { question: /(^|_)city($|_)/, field: /^city$/ },
  { question: /(^|_)state($|_)/, field: /^state$/ },
  { question: /(^|_)country($|_)/, field: /^country$/ },
  { question: /when.*(plan|organi|host|conduct)|timeline|how_soon|planning_to/, field: /next.*(tournament|event|league).*plan|timeline|when/ },
  { question: /tournament.*type|type.*tournament|league.*type|event.*type/, field: /tournament.?type|event.?type/ },
  { question: /feature/, field: /feature/ },
  { question: /service/, field: /service/ },
  { question: /budget/, field: /budget/ },
]

function normaliseFieldName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Turn a Lead Ads option key into something a person can read in a
 * message: "badminton____" → "Badminton", "within_30_days" →
 * "Within 30 days", "club_" → "Club". Free-text answers (with spaces
 * or capitals) are only trimmed — the person typed them on purpose.
 */
export function humanizeLeadValue(value: string): string {
  const v = value.trim()
  if (!v) return ''
  // Option keys: no spaces, no capitals — "badminton____", "school_/_college",
  // "within_30_days", "others". Anything with a space or a capital was typed.
  const looksLikeOptionKey = /^[^\sA-Z]+$/.test(v)
  if (!looksLikeOptionKey) return v
  const words = v.replace(/_+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export interface LeadCustomFieldMapping {
  /** Custom field display name (as stored in custom_fields.field_name). */
  fieldName: string
  /** The human-readable answer to store. */
  value: string
  /** The raw question label the answer came from. */
  question: string
}

/**
 * Map raw form answers (question label → joined value) onto the
 * account's custom field names. `fieldNames` is the account's
 * custom_fields.field_name list; questions already consumed as contact
 * columns (name / phone / email / company) are skipped.
 */
export function mapLeadAnswersToCustomFields(
  answers: Record<string, string>,
  fieldNames: string[],
): LeadCustomFieldMapping[] {
  const fields = fieldNames
    .map((name) => ({ name, key: normaliseFieldName(name) }))
    .filter((f) => f.key)
  const taken = new Set<string>()
  const out: LeadCustomFieldMapping[] = []

  const CORE = /^(full_name|first_name|last_name|name|your_name|phone|phone_number|mobile|mobile_number|whatsapp|whatsapp_number|email|email_address|work_email|company_name|company|business_name)$/

  for (const [question, raw] of Object.entries(answers)) {
    const qKey = normaliseKey(question)
    if (!qKey || CORE.test(qKey)) continue
    const value = humanizeLeadValue(raw)
    if (!value) continue

    let target: { name: string; key: string } | undefined
    for (const rule of MAPPING_RULES) {
      if (!rule.question.test(qKey)) continue
      target = fields.find((f) => !taken.has(f.name) && rule.field.test(f.key))
      if (target) break
    }
    if (!target) target = fields.find((f) => !taken.has(f.name) && f.key === qKey)
    if (!target) {
      // Whole-token match, not substring: "name" must not hit "tournaments".
      const qTokens = new Set(qKey.split('_'))
      target = fields.find((f) => {
        if (taken.has(f.name)) return false
        const words = f.key.split('_').filter((w) => w.length > 2)
        return words.length > 0 && words.every((w) => qTokens.has(w))
      })
    }
    if (!target) continue

    taken.add(target.name)
    out.push({ fieldName: target.name, value, question })
  }
  return out
}
