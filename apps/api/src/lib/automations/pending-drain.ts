import { supabaseAdmin } from './admin-client'
import { resumePendingExecution } from './engine'
import type { AutomationContext } from './engine'

// ------------------------------------------------------------
// Drain due `automation_pending_executions` rows — the wait-step
// resume path. Shared by the cron endpoint (external scheduler) and
// the in-process ticker started from instrumentation.ts, so a
// deployment with no external cron still resumes parked sequences.
//
// The claim step (status pending → running, conditional on the row
// still being pending) is the lock: two overlapping drains — cron and
// ticker, or two API instances — can both SELECT the same row, but
// only one UPDATE wins and only that one resumes it.
// ------------------------------------------------------------

export async function drainPendingExecutions(limit = 50): Promise<{ processed: number }> {
  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(limit)

  if (error) throw new Error(error.message)
  if (!due || due.length === 0) return { processed: 0 }

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
      created_at: (row.created_at as string | null) ?? null,
    })
    processed++
  }

  return { processed }
}

// ── In-process ticker ────────────────────────────────────────────────
// docs/docker.md: "nothing inside the container is scheduled". That
// left wait steps dead on any deployment without an external pinger.
// The ticker makes the default deployment self-sufficient; set
// AUTOMATION_INTERNAL_SCHEDULER=false to rely on the cron endpoint
// alone (e.g. many API replicas where one scheduler is preferred).

const TICK_MS = 60_000
let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

export function startPendingExecutionsTicker(): void {
  if (timer) return
  if (process.env.AUTOMATION_INTERNAL_SCHEDULER === 'false') return
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      const { processed } = await drainPendingExecutions()
      if (processed > 0) console.log(`[automations] ticker resumed ${processed} parked run(s)`)
    } catch (err) {
      console.error('[automations] ticker drain failed:', err instanceof Error ? err.message : err)
    } finally {
      ticking = false
    }
  }
  timer = setInterval(() => void tick(), TICK_MS)
  // Don't keep a shutting-down process alive just for the next tick.
  timer.unref?.()
  console.log('[automations] in-process wait-step scheduler started')
}

export function stopPendingExecutionsTicker(): void {
  if (timer) clearInterval(timer)
  timer = null
}
