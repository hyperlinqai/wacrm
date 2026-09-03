#!/usr/bin/env node
// Backfill contact custom fields from Meta Lead Ads answers already
// stored in meta_leads.field_data (leads captured before the webhook
// started writing custom values — see apps/api/src/lib/meta-leads/
// process-lead.ts). Fill-blanks only: values an agent typed stay.
//
//   DATABASE_URL=postgresql://… node scripts/backfill-meta-lead-custom-values.mjs [--dry-run] [--account <uuid>]
//
// Plain Node + pg so it runs without a build step. The question →
// field matching mirrors mapLeadAnswersToCustomFields in
// packages/shared/src/meta/lead-fields.ts (kept in sync by hand).

import pg from 'pg'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const accountFilter = args.includes('--account') ? args[args.indexOf('--account') + 1] : null

const MAPPING_RULES = [
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
const CORE = /^(full_name|first_name|last_name|name|your_name|phone|phone_number|mobile|mobile_number|whatsapp|whatsapp_number|email|email_address|work_email|company_name|company|business_name)$/

const norm = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
function humanize(value) {
  const v = String(value ?? '').trim()
  if (!v) return ''
  if (!/^[^\sA-Z]+$/.test(v)) return v
  const words = v.replace(/_+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
function mapAnswers(answers, fieldNames) {
  const fields = fieldNames.map((name) => ({ name, key: norm(name) })).filter((f) => f.key)
  const taken = new Set()
  const out = {}
  for (const [question, raw] of Object.entries(answers)) {
    const qKey = norm(question)
    if (!qKey || CORE.test(qKey)) continue
    const value = humanize(raw)
    if (!value) continue
    let target
    for (const rule of MAPPING_RULES) {
      if (!rule.question.test(qKey)) continue
      target = fields.find((f) => !taken.has(f.name) && rule.field.test(f.key))
      if (target) break
    }
    if (!target) target = fields.find((f) => !taken.has(f.name) && f.key === qKey)
    if (!target) {
      const qTokens = new Set(qKey.split('_'))
      target = fields.find((f) => {
        if (taken.has(f.name)) return false
        const words = f.key.split('_').filter((w) => w.length > 2)
        return words.length > 0 && words.every((w) => qTokens.has(w))
      })
    }
    if (!target) continue
    taken.add(target.name)
    out[target.name] = value
  }
  return out
}
function leadSourceLabel(platform) {
  const p = (platform ?? '').toLowerCase()
  if (p === 'ig' || p === 'instagram') return 'Instagram Lead Ad'
  if (p === 'fb' || p === 'facebook') return 'Facebook Lead Ad'
  return 'Meta Lead Ad'
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
await client.query('set role service_role')

const { rows: leads } = await client.query(
  `select l.id, l.contact_id, l.field_data, l.campaign_name, l.platform, p.account_id
     from meta_leads l join meta_lead_pages p on p.id = l.page_row_id
    where l.contact_id is not null ${accountFilter ? 'and p.account_id = $1' : ''}
    order by l.lead_created_at asc nulls last, l.created_at asc`,
  accountFilter ? [accountFilter] : [],
)

const fieldsByAccount = new Map()
async function fieldsFor(accountId) {
  if (!fieldsByAccount.has(accountId)) {
    const { rows } = await client.query('select id, field_name from custom_fields where account_id = $1', [accountId])
    fieldsByAccount.set(accountId, rows)
  }
  return fieldsByAccount.get(accountId)
}

let leadsSeen = 0
let written = 0
const perField = {}
for (const lead of leads) {
  leadsSeen++
  const fields = await fieldsFor(lead.account_id)
  if (fields.length === 0) continue
  const answers = {}
  for (const d of lead.field_data ?? []) {
    if (!d || typeof d.name !== 'string') continue
    const vals = (d.values ?? []).filter((v) => typeof v === 'string' || typeof v === 'number').map(String).filter((s) => s.trim())
    if (vals.length) answers[d.name] = vals.join(', ')
  }
  const values = mapAnswers(answers, fields.map((f) => f.field_name))
  if (lead.campaign_name) values['Campaign name'] = lead.campaign_name
  values['Lead source'] = leadSourceLabel(lead.platform)

  const byName = new Map(fields.map((f) => [f.field_name.trim().toLowerCase(), f]))
  for (const [name, value] of Object.entries(values)) {
    const field = byName.get(name.trim().toLowerCase())
    if (!field || !value) continue
    if (dryRun) {
      perField[name] = (perField[name] ?? 0) + 1
      continue
    }
    const res = await client.query(
      `insert into contact_custom_values (contact_id, custom_field_id, value)
       values ($1, $2, $3)
       on conflict (contact_id, custom_field_id) do update
         set value = excluded.value
         where coalesce(contact_custom_values.value, '') = ''`,
      [lead.contact_id, field.id, value],
    )
    if (res.rowCount > 0) {
      written++
      perField[name] = (perField[name] ?? 0) + 1
    }
  }
}
await client.end()
console.log(JSON.stringify({ dryRun, leadsSeen, valuesWritten: dryRun ? 'n/a' : written, perField }, null, 2))
