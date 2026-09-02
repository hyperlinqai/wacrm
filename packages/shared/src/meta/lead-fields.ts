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
