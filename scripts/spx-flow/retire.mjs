#!/usr/bin/env node
// Retire the PREVIOUS generation of the SportsGenX flow (the eight-stage
// "New Lead → Won" graph): delete its automations from the CRM and its
// templates from Meta and the local catalog.
//
//   node scripts/spx-flow/retire.mjs --account <uuid> [--dry-run] [--yes]
//
// Deleting an approved template on Meta is IRREVERSIBLE (and the name is
// blocked for 30 days), so nothing is touched without --yes. Deleting
// an automation cascades to its steps, logs and parked runs — every
// reminder still waiting in the old graph is dropped with it.
//
// Run create.mjs first so the new graph is already in place, and only
// retire the old templates after the old automations are gone —
// otherwise a parked old run could come due and try to send a template
// that no longer exists.

import { connect, deleteMetaTemplate, listMetaTemplates, parseArgs, resolveContext, sleep } from './lib.mjs'

/** Template names of the retired generation (s<NN>_ stage naming). */
export const PREVIOUS_TEMPLATES = [
  's01_new_lead_welcome_instant', 's01_new_lead_reminder1_2h', 's01_new_lead_reminder2_24h',
  's02_contact_attempt_message_d0', 's02_contact_attempt_reminder_d1',
  's03_qualification_customer_type_d0', 's03_qualification_reminder_d1',
  's04_discovery_tournament_type_d0', 's04_discovery_reminder_d1',
  's05_demo_invitation_d0', 's05_demo_reminder_d1', 's05_demo_scheduled_confirm_d0',
  's05_demo_self_explore_access_d0', 's05_demo_not_now_nurture_d0',
  's06_post_demo_followup_d0', 's06_post_demo_reminder_d1',
  's07_offer_proposal_d0', 's07_offer_reminder_d1',
  's08_won_payment_received_d0', 's08_won_onboarding_welcome_d1',
  's09_nurture_value_d03', 's09_nurture_social_proof_d07', 's09_nurture_reengage_d14',
]

/** Automation names of the retired generation. */
export const PREVIOUS_AUTOMATIONS = [
  'Stage 01 · New Lead — Welcome & Reminders',
  'Stage 02 · Contact Attempt — Message & Reminder',
  'Stage 03 · Qualification — Customer Type',
  'Stage 04 · Discovery — Tournament Type',
  'Stage 05 · Demo — Invitation & Reminder',
  'Stage 06 · Post-Demo — Outcome Follow-up',
  'Stage 07 · Offer & Negotiation — Proposal',
  'Stage 08 · Won & Payment — Confirmation & Onboarding',
  'Stage 09 · Nurture Campaign — Day 3 / 7 / 14 Drip',
  'Reply · Interested → Stage 02',
  'Reply · Not right now → Nurture',
  'Reply · Continue on WhatsApp → Stage 03',
  'Reply · Request a call back → Agent',
  'Reply · Not interested → Closed',
  'Reply · Customer type captured → Stage 04',
  'Reply · Tournament type captured → Stage 05',
  'Reply · Demo requested → Book slot',
  'Reply · Self-explore → Send access',
  'Reply · Post-demo outcome → Stage 07',
  'Reply · Ready to proceed → Agent closes',
  'Reply · Question or pricing → Agent',
  'Reply · Onboarding / support → Agent',
]

const { flag, dryRun, accountId } = parseArgs()
const yes = flag('yes')

if (!accountId) {
  console.error('Missing --account <uuid>.')
  process.exit(1)
}
if (!dryRun && !yes) {
  console.error('Refusing to delete without --yes (templates deleted on Meta cannot be restored). Use --dry-run to preview.')
  process.exit(1)
}

const client = connect()
const q = (sql, params = []) => client.query(sql, params)

async function retireAutomations() {
  const { rows } = await q(
    `SELECT a.id, a.name, a.is_active,
            (SELECT count(*) FROM automation_pending_executions p WHERE p.automation_id = a.id AND p.status = 'pending') parked
       FROM automations a WHERE a.account_id = $1 AND a.name = ANY($2) ORDER BY a.name`,
    [accountId, PREVIOUS_AUTOMATIONS],
  )
  console.log(`\n=== AUTOMATIONS to delete (${rows.length}) ===`)
  for (const r of rows) {
    console.log(`  ${dryRun ? '[dry-run] ' : ''}${r.name}  (${r.parked} parked run${r.parked === '1' ? '' : 's'})`)
    if (!dryRun) await q('DELETE FROM automations WHERE id = $1', [r.id])
  }
}

async function retireTemplates(ctx) {
  const onMeta = new Map((await listMetaTemplates(ctx)).map((t) => [t.name, t]))
  const { rows: local } = await q(
    'SELECT id, name, meta_template_id, status FROM message_templates WHERE account_id = $1 AND name = ANY($2) ORDER BY name',
    [accountId, PREVIOUS_TEMPLATES],
  )
  const localByName = new Map(local.map((r) => [r.name, r]))
  const names = [...new Set([...PREVIOUS_TEMPLATES.filter((n) => onMeta.has(n) || localByName.has(n))])]

  console.log(`\n=== TEMPLATES to delete (${names.length}) ===`)
  for (const name of names) {
    const meta = onMeta.get(name)
    const row = localByName.get(name)
    const where = [meta ? `Meta ${meta.status}` : null, row ? 'local' : null].filter(Boolean).join(' + ')
    if (dryRun) {
      console.log(`  [dry-run] ${name}  (${where})`)
      continue
    }
    let result = 'not on Meta'
    if (meta) {
      result = await deleteMetaTemplate(ctx, name, meta.id)
      await sleep(400)
    }
    if (row) await q('DELETE FROM message_templates WHERE id = $1', [row.id])
    console.log(`  ok  ${name}  (${result}${row ? ', local row removed' : ''})`)
  }
}

async function main() {
  await client.connect()
  await q('SET ROLE service_role')
  try {
    const ctx = await resolveContext(q, accountId)
    console.log(`Account ${accountId} - WABA ${ctx.wabaId ?? 'none'}`)
    if (dryRun) console.log('DRY RUN - nothing is deleted.')
    await retireAutomations()
    if (!ctx.wabaId || !ctx.accessToken) throw new Error('WhatsApp is not connected - cannot delete templates on Meta')
    await retireTemplates(ctx)
    console.log('\nDone.')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err.message)
  process.exitCode = 1
})
