import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import type { AutomationLogStepResult, AutomationStepType } from '@wacrm/shared/types'
import { buildAutomationReport, type RawRun } from '@wacrm/shared/automations/report'

/**
 * Per-automation delivery report — the automation answer to the
 * broadcast detail page.
 *
 * Served from the API rather than queried straight from the browser
 * (which is what the old logs page did) for two reasons:
 *
 *   1. `automation_pending_executions` is service-role only by design
 *      (migration 006 exposes no user policy), so a run that is parked
 *      at a Wait step can only be reported on from here. Without it a
 *      drip campaign looks half-broken: the log row still says
 *      "partial" and nothing says the next touch is scheduled.
 *   2. Scoping is by `account_id`, so teammates see the same report.
 *      The sibling GET on the automation itself still filters by
 *      `user_id` — a pre-existing inconsistency, not one to copy.
 *
 * The aggregation itself is pure and lives in @wacrm/shared so it can
 * be unit-tested without a database.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let accountId: string
  try {
    ;({ accountId } = await getCurrentAccount())
  } catch (err) {
    return toErrorResponse(err)
  }

  const url = new URL(request.url)
  // Runs are capped so one very chatty automation can't time the page
  // out; the aggregate counts below are computed over the same window,
  // and the response says so via `runsTruncated`.
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 2000)

  const admin = supabaseAdmin()

  const { data: automation, error: autErr } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()

  if (autErr) return NextResponse.json({ error: autErr.message }, { status: 500 })
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: logs, error: logErr }, { data: pending, error: pendErr }] =
    await Promise.all([
      admin
        .from('automation_logs')
        .select('id, status, trigger_event, steps_executed, error_message, created_at, contact:contacts(id, name, phone)')
        .eq('automation_id', id)
        .order('created_at', { ascending: false })
        .limit(limit + 1),
      // Only rows still queued matter here — 'done' / 'failed' ones are
      // already reflected in the log they belong to.
      admin
        .from('automation_pending_executions')
        .select('id, contact_id, log_id, run_at, status')
        .eq('automation_id', id)
        .eq('status', 'pending'),
    ])

  if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 })
  if (pendErr) return NextResponse.json({ error: pendErr.message }, { status: 500 })

  const rows = (logs ?? []) as unknown as Array<{
    id: string
    status: RawRun['status']
    trigger_event: string
    steps_executed: AutomationLogStepResult[] | null
    error_message: string | null
    created_at: string
    // PostgREST returns an embedded to-one join as an object, but the
    // generated types widen it to an array — normalise below.
    contact: { id: string; name: string | null; phone: string } | { id: string; name: string | null; phone: string }[] | null
  }>

  const runsTruncated = rows.length > limit
  const capped = runsTruncated ? rows.slice(0, limit) : rows

  const nextRunByLogId = new Map<string, string>()
  for (const p of (pending ?? []) as Array<{ log_id: string | null; run_at: string }>) {
    if (!p.log_id) continue
    const seen = nextRunByLogId.get(p.log_id)
    if (!seen || p.run_at < seen) nextRunByLogId.set(p.log_id, p.run_at)
  }

  const runs: RawRun[] = capped.map((r) => {
    const contact = Array.isArray(r.contact) ? (r.contact[0] ?? null) : r.contact
    return {
      id: r.id,
      status: r.status,
      trigger_event: r.trigger_event,
      created_at: r.created_at,
      error_message: r.error_message,
      steps: (r.steps_executed ?? []) as {
        step_type: AutomationStepType
        status: 'success' | 'skipped' | 'failed'
        detail?: string
      }[],
      contact: contact
        ? { id: contact.id, name: contact.name, phone: contact.phone }
        : null,
      nextRunAt: nextRunByLogId.get(r.id) ?? null,
    }
  })

  const report = buildAutomationReport(runs, {
    queuedCount: (pending ?? []).length,
  })

  return NextResponse.json({
    automation,
    ...report,
    runsTruncated,
    runsLimit: limit,
  })
}
