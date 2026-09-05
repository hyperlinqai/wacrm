#!/usr/bin/env node
// Build the SportsGenX "New Lead -> Won" flow for one account:
// ensure the stage tags exist, submit the 25 stage templates to Meta
// for approval, and create the automation graph that drives them.
//
//   node scripts/spx-flow/create.mjs --account <uuid> [--phase ...] [--dry-run]
//
//   --phase templates | automations | all   (default: all)
//   --dry-run                               print the plan, write nothing
//
// This script only ADDS. Retiring the previous generation of templates
// and automations is a separate, explicitly-approved step - see
// README.md in this directory.
//
// Automations are created PAUSED (is_active = false): templates sit in
// PENDING at Meta for a while, and an automation firing against an
// unapproved template only logs failures. Turn them on from the
// Automations page once Meta approves.

import {
  buildMetaPayload,
  connect,
  flattenSteps,
  metaErrorMessage,
  metaFetch,
  META_API,
  parseArgs,
  resolveContext,
  sleep,
  validateTemplates,
  validateWiring,
} from './lib.mjs'
import { TEMPLATES, LANGUAGE } from './templates.mjs'
import { buildAutomations, REQUIRED_TAGS } from './automations.mjs'

const { opt, dryRun, accountId } = parseArgs()
const phase = opt('phase', 'all')

if (!accountId) {
  console.error('Missing --account <uuid>. Refusing to guess which tenant to build.')
  process.exit(1)
}
if (!['all', 'templates', 'automations'].includes(phase)) {
  console.error(`Unknown --phase "${phase}" (expected all | templates | automations)`)
  process.exit(1)
}

const client = connect()
const q = (sql, params = []) => client.query(sql, params)

// ------------------------------------------------------------
// Templates
// ------------------------------------------------------------
async function submitTemplates(ctx) {
  console.log(`\n=== TEMPLATES (${TEMPLATES.length}) ===`)
  const failures = []

  for (const t of TEMPLATES) {
    if (dryRun) {
      console.log(`  [dry-run] ${t.name.padEnd(36)} ${t.category.padEnd(9)} ${t.buttons?.length ?? 0} buttons`)
      continue
    }
    const res = await metaFetch(`${META_API}/${ctx.wabaId}/message_templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.accessToken}`,
      },
      body: JSON.stringify(buildMetaPayload(t)),
    })

    const ok = res.ok && res.json?.id
    const status = ok ? String(res.json.status ?? 'PENDING').toUpperCase() : 'DRAFT'
    const metaId = ok ? String(res.json.id) : null
    const error = ok ? null : metaErrorMessage(res)
    if (!ok) failures.push({ name: t.name, error })

    // Persist either way: a rejected template stays as a DRAFT row so
    // the copy is not lost and can be fixed and resubmitted from the UI.
    await q(
      `INSERT INTO message_templates
         (account_id, organization_id, user_id, name, category, language,
          body_text, footer_text, buttons, sample_values, status,
          meta_template_id, submission_error, last_submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (user_id, name, language) DO UPDATE SET
         category = EXCLUDED.category,
         body_text = EXCLUDED.body_text,
         footer_text = EXCLUDED.footer_text,
         buttons = EXCLUDED.buttons,
         sample_values = EXCLUDED.sample_values,
         status = EXCLUDED.status,
         meta_template_id = EXCLUDED.meta_template_id,
         submission_error = EXCLUDED.submission_error,
         last_submitted_at = NOW()`,
      [
        accountId, ctx.organizationId, ctx.userId, t.name, t.category, LANGUAGE,
        t.body_text, t.footer_text ?? null,
        JSON.stringify(t.buttons ?? null),
        JSON.stringify(t.sample_values ?? null),
        status, metaId, error,
      ],
    )
    console.log(ok ? `  ok  ${t.name} -> ${status}` : `  ERR ${t.name}: ${error}`)
    // Meta caps template creates at 100/hour per WABA; pace the batch.
    await sleep(700)
  }

  if (failures.length) {
    console.log(`\n${failures.length} template(s) refused by Meta, kept locally as DRAFT:`)
    for (const f of failures) console.log(`   ${f.name}: ${f.error}`)
  }
}

// ------------------------------------------------------------
// Tags, ids, automations
// ------------------------------------------------------------
async function ensureTags(ctx) {
  const ids = {}
  for (const t of REQUIRED_TAGS) {
    const { rows } = await q(
      'SELECT id FROM tags WHERE account_id = $1 AND name = $2 LIMIT 1',
      [accountId, t.name],
    )
    if (rows[0]) {
      ids[t.key] = rows[0].id
      continue
    }
    if (dryRun) {
      console.log(`  [dry-run] + tag "${t.name}"`)
      ids[t.key] = '00000000-0000-4000-8000-000000000000'
      continue
    }
    const { rows: created } = await q(
      `INSERT INTO tags (account_id, organization_id, user_id, name, color)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [accountId, ctx.organizationId, ctx.userId, t.name, t.color],
    )
    ids[t.key] = created[0].id
    console.log(`  + tag "${t.name}"`)
  }
  return ids
}

async function resolveIds(ctx) {
  const tags = await ensureTags(ctx)

  const fieldByName = async (name) => {
    const { rows } = await q(
      'SELECT id FROM custom_fields WHERE account_id = $1 AND field_name = $2 LIMIT 1',
      [accountId, name],
    )
    if (!rows[0]) throw new Error(`Custom field "${name}" not found on this account`)
    return rows[0].id
  }

  const { rows: pipes } = await q(
    'SELECT id FROM pipelines WHERE account_id = $1 ORDER BY created_at LIMIT 1',
    [accountId],
  )
  if (!pipes[0]) throw new Error('No pipeline found on this account')
  const { rows: stages } = await q(
    'SELECT id, name FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position',
    [pipes[0].id],
  )
  if (!stages.length) throw new Error('Pipeline has no stages')
  const won = stages.find((s) => /won/i.test(s.name)) ?? stages[stages.length - 1]

  return {
    tags,
    fields: {
      companyType: await fieldByName('Company Type'),
      tournamentType: await fieldByName('Tournament Type interested in'),
    },
    pipeline: { id: pipes[0].id, wonStageId: won.id },
  }
}

async function createAutomations(ctx) {
  console.log('\n=== TAGS ===')
  const ids = await resolveIds(ctx)
  const automations = buildAutomations(ids)

  const problems = validateWiring(automations)
  if (problems.length) {
    console.error('\nAutomation wiring problems:')
    for (const p of problems) console.error(`  x ${p}`)
    throw new Error('Refusing to write automations with broken wiring')
  }

  console.log(`\n=== AUTOMATIONS (${automations.length}, all paused) ===`)
  for (const a of automations) {
    const stepCount = flattenSteps('preview', a.steps).length
    if (dryRun) {
      console.log(`  [dry-run] ${a.name}`)
      console.log(`            ${a.trigger_type} - ${stepCount} steps`)
      continue
    }
    const { rows } = await q(
      `INSERT INTO automations
         (account_id, organization_id, user_id, name, description,
          trigger_type, trigger_config, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE) RETURNING id`,
      [
        accountId, ctx.organizationId, ctx.userId, a.name, a.description,
        a.trigger_type, JSON.stringify(a.trigger_config ?? {}),
      ],
    )
    const automationId = rows[0].id
    for (const r of flattenSteps(automationId, a.steps)) {
      await q(
        `INSERT INTO automation_steps
           (id, automation_id, parent_step_id, branch, step_type, step_config, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          r.id, r.automation_id, r.parent_step_id, r.branch,
          r.step_type, JSON.stringify(r.step_config), r.position,
        ],
      )
    }
    console.log(`  ok  ${a.name}  (${a.trigger_type}, ${stepCount} steps)`)
  }
}

// ------------------------------------------------------------
async function main() {
  const problems = validateTemplates()
  if (problems.length) {
    console.error('Template definitions are invalid:')
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`Template definitions valid (${TEMPLATES.length}).`)

  await client.connect()
  await q('SET ROLE service_role')
  try {
    const ctx = await resolveContext(q, accountId)
    console.log(`Account ${accountId} - org ${ctx.organizationId} - WABA ${ctx.wabaId ?? 'none'}`)
    if (dryRun) console.log('DRY RUN - nothing is written and nothing is sent to Meta.')

    if (phase === 'all' || phase === 'templates') {
      if (!ctx.wabaId || !ctx.accessToken) {
        throw new Error('WhatsApp is not connected for this account - cannot submit templates')
      }
      await submitTemplates(ctx)
    }
    if (phase === 'all' || phase === 'automations') await createAutomations(ctx)

    console.log('\nDone.')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err.message)
  process.exitCode = 1
})
