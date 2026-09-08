#!/usr/bin/env node
// Pull the review status of this flow's templates from Meta into the
// local catalog, and optionally switch the graph on once every template
// is APPROVED.
//
//   node scripts/spx-flow/status.mjs --account <uuid> [--wait <minutes>] [--activate]
//
//   --wait N     keep polling (every 60s) up to N minutes while any
//                template is still PENDING
//   --activate   set is_active = true on every automation in
//                automations.mjs — only if all templates are APPROVED
//
// Meta decides approval; this script cannot force it. A REJECTED
// template shows its reason so the copy can be fixed and resubmitted.

import { connect, listMetaTemplates, parseArgs, resolveContext, sleep } from './lib.mjs'
import { TEMPLATE_NAMES } from './templates.mjs'
import { buildAutomations, REQUIRED_TAGS, REQUIRED_FIELDS } from './automations.mjs'

const { flag, opt, accountId } = parseArgs()
const waitMinutes = Number(opt('wait', '0'))
const activate = flag('activate')

if (!accountId) {
  console.error('Missing --account <uuid>.')
  process.exit(1)
}

const client = connect()
const q = (sql, params = []) => client.query(sql, params)

async function syncOnce(ctx) {
  const onMeta = new Map((await listMetaTemplates(ctx)).map((t) => [t.name, t]))
  const summary = { APPROVED: 0, PENDING: 0, REJECTED: 0, OTHER: 0, MISSING: 0 }
  for (const name of TEMPLATE_NAMES) {
    const t = onMeta.get(name)
    if (!t) {
      summary.MISSING++
      console.log(`  ??  ${name.padEnd(24)} not on Meta`)
      continue
    }
    const status = String(t.status).toUpperCase()
    summary[status in summary ? status : 'OTHER']++
    await q(
      `UPDATE message_templates SET status = $3, meta_template_id = $4, rejection_reason = $5, updated_at = NOW()
        WHERE account_id = $1 AND name = $2`,
      [accountId, name, status, String(t.id), t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null],
    )
    console.log(`  ${status === 'APPROVED' ? 'ok ' : status === 'PENDING' ? '.. ' : 'ERR'} ${name.padEnd(24)} ${status}${t.rejected_reason && t.rejected_reason !== 'NONE' ? ` — ${t.rejected_reason}` : ''}`)
  }
  return summary
}

async function activateGraph() {
  // Same name list create.mjs wrote; ids are irrelevant here.
  const stub = {
    tags: Object.fromEntries(REQUIRED_TAGS.map((t) => [t.key, 'x'])),
    fields: Object.fromEntries(REQUIRED_FIELDS.map((f) => [f.key, 'x'])),
  }
  const names = buildAutomations(stub).map((a) => a.name)
  const { rowCount } = await q(
    'UPDATE automations SET is_active = TRUE, updated_at = NOW() WHERE account_id = $1 AND name = ANY($2) AND is_active = FALSE',
    [accountId, names],
  )
  const { rows } = await q(
    'SELECT count(*)::int n FROM automations WHERE account_id = $1 AND name = ANY($2) AND is_active',
    [accountId, names],
  )
  console.log(`\nActivated ${rowCount} automation(s); ${rows[0].n}/${names.length} of the graph is now active.`)
}

async function main() {
  await client.connect()
  await q('SET ROLE service_role')
  try {
    const ctx = await resolveContext(q, accountId)
    if (!ctx.wabaId || !ctx.accessToken) throw new Error('WhatsApp is not connected for this account')
    const deadline = Date.now() + waitMinutes * 60_000
    let summary
    for (;;) {
      console.log(`\n=== TEMPLATE STATUS @ ${new Date().toISOString()} ===`)
      summary = await syncOnce(ctx)
      console.log(`  approved ${summary.APPROVED} · pending ${summary.PENDING} · rejected ${summary.REJECTED} · other ${summary.OTHER} · missing ${summary.MISSING}`)
      if (summary.PENDING === 0 || Date.now() >= deadline) break
      await sleep(60_000)
    }
    if (activate) {
      if (summary.APPROVED === TEMPLATE_NAMES.length) await activateGraph()
      else console.log('\nNot activating: not every template is APPROVED yet.')
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err.message)
  process.exitCode = 1
})
