// Shared plumbing for the spx-flow scripts: env loading, WhatsApp token
// decryption, the Meta Graph client, and the pre-flight validators that
// catch what Meta would otherwise reject hours later as an opaque
// rejection_reason.
//
// Plain Node + pg, no build step (same pattern as
// scripts/backfill-meta-lead-custom-values.mjs).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import { TEMPLATES, LANGUAGE } from './templates.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '../..')
export const META_API = 'https://graph.facebook.com/v21.0'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------
// args + env
// ------------------------------------------------------------
export function parseArgs(argv = process.argv.slice(2)) {
  const flag = (name) => argv.includes(`--${name}`)
  const opt = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  return { flag, opt, dryRun: flag('dry-run'), accountId: opt('account') }
}

/** Env var, falling back to the app's .env.local files. */
export function envFromFile(key) {
  if (process.env[key]) return process.env[key]
  for (const file of ['apps/api/.env.local', 'apps/web/.env.local']) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) continue
    const line = fs
      .readFileSync(full, 'utf8')
      .split('\n')
      .reverse()
      .find((l) => l.startsWith(`${key}=`))
    if (line) return line.slice(key.length + 1).trim()
  }
  return null
}

// ------------------------------------------------------------
// WhatsApp token decryption - mirrors
// apps/api/src/lib/whatsapp/encryption.ts (GCM `iv:ct:tag`, plus the
// legacy CBC `iv:ct` form still present on older rows).
// ------------------------------------------------------------
export function decrypt(encrypted, encryptionKey) {
  if (!encryptionKey) throw new Error('ENCRYPTION_KEY is required to read the WhatsApp token')
  const parts = encrypted.split(':')
  const key = Buffer.from(encryptionKey, 'hex')
  if (parts.length === 3) {
    const [ivHex, ctHex, tagHex] = parts
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
    d.setAuthTag(Buffer.from(tagHex, 'hex'))
    return d.update(ctHex, 'hex', 'utf8') + d.final('utf8')
  }
  if (parts.length === 2) {
    const [ivHex, ctHex] = parts
    const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
    return d.update(ctHex, 'hex', 'utf8') + d.final('utf8')
  }
  throw new Error(`Unrecognised token format (${parts.length - 1} colons)`)
}

// ------------------------------------------------------------
// Meta Graph
// ------------------------------------------------------------
export async function metaFetch(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

export function metaErrorMessage(res) {
  return (
    res.json?.error?.error_user_msg ?? res.json?.error?.message ?? `HTTP ${res.status}`
  )
}

const CATEGORY_TO_META = { Marketing: 'MARKETING', Utility: 'UTILITY' }

/**
 * Local template row -> Meta `components` payload. Mirrors
 * packages/shared/src/whatsapp/template-components.ts, restricted to
 * the shapes this flow uses (BODY -> FOOTER -> BUTTONS, no media header).
 */
export function buildMetaPayload(t) {
  const components = [{ type: 'BODY', text: t.body_text }]
  if (t.sample_values?.body?.length) {
    components[0].example = { body_text: [t.sample_values.body] }
  }
  if (t.footer_text) components.push({ type: 'FOOTER', text: t.footer_text })
  if (t.buttons?.length) {
    components.push({
      type: 'BUTTONS',
      buttons: t.buttons.map((b) =>
        b.type === 'URL'
          ? { type: 'URL', text: b.text, url: b.url }
          : { type: 'QUICK_REPLY', text: b.text },
      ),
    })
  }
  return {
    name: t.name,
    category: CATEGORY_TO_META[t.category],
    language: LANGUAGE,
    components,
  }
}

// ------------------------------------------------------------
// Pre-flight validation
// ------------------------------------------------------------

/** Meta's published limits, checked before the network call. */
export function validateTemplates() {
  const problems = []
  const seen = new Set()
  for (const t of TEMPLATES) {
    const where = t.name
    if (!/^[a-z0-9_]{1,512}$/.test(t.name)) problems.push(`${where}: invalid Meta template name`)
    if (seen.has(t.name)) problems.push(`${where}: duplicate template name`)
    seen.add(t.name)
    if (t.body_text.length > 1024) problems.push(`${where}: body ${t.body_text.length} > 1024`)
    if ((t.footer_text ?? '').length > 60) problems.push(`${where}: footer > 60`)

    const vars = [...t.body_text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
    const uniq = [...new Set(vars)].sort((a, b) => a - b)
    uniq.forEach((n, i) => {
      if (n !== i + 1) problems.push(`${where}: body variables must be contiguous from {{1}}`)
    })
    if (uniq.length !== (t.sample_values?.body?.length ?? 0)) {
      problems.push(`${where}: sample_values.body needs one example per body variable`)
    }

    const buttons = t.buttons ?? []
    if (buttons.length > 10) problems.push(`${where}: ${buttons.length} buttons > 10`)
    if (buttons.filter((b) => b.type === 'URL').length > 2) {
      problems.push(`${where}: more than 2 URL buttons`)
    }
    // Meta rule: quick replies cannot be interleaved with CTA buttons.
    let sawNonQr = false
    for (const [i, b] of buttons.entries()) {
      if (b.text.length > 25) problems.push(`${where}: button #${i + 1} text > 25 chars`)
      if (b.type === 'QUICK_REPLY') {
        if (sawNonQr) problems.push(`${where}: QUICK_REPLY buttons must come before URL buttons`)
      } else sawNonQr = true
    }
  }
  return problems
}

/**
 * Every reply_id an automation listens for must be a real QUICK_REPLY
 * label on some template, and every send_template must name a template
 * that exists. A typo in either silently kills a whole branch of the
 * flow and nothing at runtime would tell you.
 */
export function validateWiring(automations) {
  const labels = new Set(
    TEMPLATES.flatMap((t) =>
      (t.buttons ?? []).filter((b) => b.type === 'QUICK_REPLY').map((b) => b.text),
    ),
  )
  const problems = []
  for (const a of automations) {
    for (const id of a.trigger_config?.reply_ids ?? []) {
      if (!labels.has(id)) problems.push(`${a.name}: reply_id "${id}" matches no template button`)
    }
    const walk = (steps) => {
      for (const s of steps ?? []) {
        if (s.step_type === 'send_template') {
          const name = s.step_config.template_name
          if (!TEMPLATES.some((t) => t.name === name)) {
            problems.push(`${a.name}: send_template names unknown template "${name}"`)
          }
        }
        for (const cfg of Object.values(s.step_config ?? {})) {
          if (cfg === undefined || cfg === null || cfg === '') {
            problems.push(`${a.name}: ${s.step_type} has an unresolved config value`)
          }
        }
        if (s.branches) {
          walk(s.branches.yes)
          walk(s.branches.no)
        }
      }
    }
    walk(a.steps)
  }
  return problems
}

// ------------------------------------------------------------
// Database
// ------------------------------------------------------------
export function connect() {
  const url = envFromFile('DATABASE_URL')
  if (!url) throw new Error('DATABASE_URL is not set and was not found in apps/*/.env.local')
  const client = new pg.Client({ connectionString: url })
  return client
}

/**
 * Tenancy + credentials for one account: the author to attribute rows
 * to, the organization_id every table requires NOT NULL, and the
 * decrypted WABA credentials for template management.
 */
export async function resolveContext(q, accountId) {
  const { rows: cfg } = await q(
    'SELECT user_id, waba_id, access_token FROM whatsapp_config WHERE account_id = $1',
    [accountId],
  )
  const { rows: org } = await q(
    'SELECT organization_id FROM contacts WHERE account_id = $1 LIMIT 1',
    [accountId],
  )
  const { rows: prof } = await q(
    'SELECT user_id FROM profiles WHERE account_id = $1 ORDER BY created_at LIMIT 1',
    [accountId],
  )
  const userId = prof[0]?.user_id ?? cfg[0]?.user_id
  const organizationId = org[0]?.organization_id
  if (!userId) throw new Error(`No profile found for account ${accountId}`)
  if (!organizationId) throw new Error(`Cannot resolve organization_id for account ${accountId}`)
  return {
    userId,
    organizationId,
    wabaId: cfg[0]?.waba_id ?? null,
    accessToken: cfg[0]?.access_token
      ? decrypt(cfg[0].access_token, envFromFile('ENCRYPTION_KEY'))
      : null,
  }
}

/** Flatten the nested builder shape into automation_steps rows. */
export function flattenSteps(automationId, steps) {
  const rows = []
  const walk = (list, parentId, branch) => {
    list.forEach((s, position) => {
      const id = crypto.randomUUID()
      rows.push({
        id,
        automation_id: automationId,
        parent_step_id: parentId,
        branch,
        step_type: s.step_type,
        step_config: s.step_config ?? {},
        position,
      })
      if (s.step_type === 'condition' && s.branches) {
        walk(s.branches.yes ?? [], id, 'yes')
        walk(s.branches.no ?? [], id, 'no')
      }
    })
  }
  walk(steps, null, null)
  return rows
}
