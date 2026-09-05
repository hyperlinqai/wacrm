import type { AutomationStepType } from '../types';

// Aggregation behind the per-automation report page — the automation
// equivalent of a broadcast's delivery stats.
//
// Pure on purpose: the route hands it rows and it hands back numbers,
// so the interesting cases (a run parked mid-drip, a branch that never
// flips off "partial") are unit-testable without a database.

/** Step types that actually put a message on someone's phone. */
const MESSAGE_STEPS: ReadonlySet<string> = new Set<AutomationStepType>([
  'send_message',
  'send_buttons',
  'send_list',
  'send_template',
]);

export interface RawRunStep {
  step_type: AutomationStepType;
  status: 'success' | 'skipped' | 'failed';
  detail?: string;
}

export interface RawRunContact {
  id: string;
  name: string | null;
  phone: string;
}

export interface RawRun {
  id: string;
  status: 'success' | 'partial' | 'failed';
  trigger_event: string;
  created_at: string;
  error_message: string | null;
  steps: RawRunStep[];
  contact: RawRunContact | null;
  /** Earliest queued resume for this run, when it is parked at a Wait. */
  nextRunAt: string | null;
}

/**
 * What a run is actually doing, which the stored `status` alone cannot
 * say.
 *
 * The engine writes `partial` when it parks at a Wait step, and only
 * rewrites the status when the OUTERMOST scope finishes — a run that
 * resumes inside a condition branch appends its steps with a null
 * status and stays `partial` for good. So `partial` on its own means
 * either "still waiting" or "finished, inside a branch". The queued
 * `automation_pending_executions` row is what separates them, and
 * showing that difference is the point of this report: a drip that is
 * working normally should not read as half-failed.
 */
export type RunOutcome = 'completed' | 'waiting' | 'failed';

export interface ReportRun extends RawRun {
  outcome: RunOutcome;
  /** Messages this run actually sent. */
  messagesSent: number;
  /** First step that failed, for the table's error column. */
  failedStep: string | null;
}

export interface AutomationReportStats {
  totalRuns: number;
  completed: number;
  waiting: number;
  failed: number;
  /** Distinct contacts this automation has run for. */
  contactsReached: number;
  /** Messages sent across every run. */
  messagesSent: number;
  /**
   * Completed / (completed + failed), as a percentage. Runs still
   * waiting are excluded — counting a drip that is mid-sequence as a
   * failure would make every healthy campaign look broken.
   */
  successRate: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  /** Runs queued to resume at a Wait step, from the pending table. */
  queued: number;
  /** Earliest scheduled resume across all runs. */
  nextRunAt: string | null;
}

export interface ErrorTally {
  message: string;
  count: number;
  /** Most recent run that hit it, for a jump-to link. */
  lastSeenAt: string;
}

export interface StepTally {
  stepType: AutomationStepType;
  success: number;
  failed: number;
  skipped: number;
}

export interface AutomationReport {
  stats: AutomationReportStats;
  runs: ReportRun[];
  /** Failure reasons, most frequent first — the actionable half. */
  topErrors: ErrorTally[];
  /** Per-step-type outcomes, so a single bad step is easy to spot. */
  stepBreakdown: StepTally[];
  /** Runs per day, oldest first, for the activity sparkline. */
  daily: { date: string; total: number; failed: number }[];
}

function outcomeOf(run: RawRun): RunOutcome {
  if (run.status === 'failed') return 'failed';
  if (run.status === 'success') return 'completed';
  // partial: waiting only while a resume is actually queued for it.
  return run.nextRunAt ? 'waiting' : 'completed';
}

export function buildAutomationReport(
  rawRuns: RawRun[],
  opts: { queuedCount?: number } = {},
): AutomationReport {
  const runs: ReportRun[] = rawRuns.map((r) => {
    let messagesSent = 0;
    let failedStep: string | null = null;
    for (const s of r.steps) {
      if (s.status === 'success' && MESSAGE_STEPS.has(s.step_type)) messagesSent++;
      if (s.status === 'failed' && failedStep === null) failedStep = s.step_type;
    }
    return { ...r, outcome: outcomeOf(r), messagesSent, failedStep };
  });

  const contacts = new Set<string>();
  const errors = new Map<string, ErrorTally>();
  const steps = new Map<AutomationStepType, StepTally>();
  const days = new Map<string, { total: number; failed: number }>();

  let completed = 0;
  let waiting = 0;
  let failed = 0;
  let messagesSent = 0;
  let nextRunAt: string | null = null;

  for (const run of runs) {
    if (run.outcome === 'completed') completed++;
    else if (run.outcome === 'waiting') waiting++;
    else failed++;

    messagesSent += run.messagesSent;
    if (run.contact) contacts.add(run.contact.id);
    if (run.nextRunAt && (!nextRunAt || run.nextRunAt < nextRunAt)) {
      nextRunAt = run.nextRunAt;
    }

    // Prefer the step's own detail over the run-level message: "add_tag
    // needs contact + tag_id" names the broken step, where the run-level
    // copy is often the same string with no context.
    const reason =
      run.steps.find((s) => s.status === 'failed')?.detail ?? run.error_message;
    if (run.outcome === 'failed' && reason) {
      const seen = errors.get(reason);
      if (seen) {
        seen.count++;
        if (run.created_at > seen.lastSeenAt) seen.lastSeenAt = run.created_at;
      } else {
        errors.set(reason, { message: reason, count: 1, lastSeenAt: run.created_at });
      }
    }

    for (const s of run.steps) {
      const tally =
        steps.get(s.step_type) ??
        { stepType: s.step_type, success: 0, failed: 0, skipped: 0 };
      if (s.status === 'success') tally.success++;
      else if (s.status === 'failed') tally.failed++;
      else tally.skipped++;
      steps.set(s.step_type, tally);
    }

    const day = run.created_at.slice(0, 10);
    const bucket = days.get(day) ?? { total: 0, failed: 0 };
    bucket.total++;
    if (run.outcome === 'failed') bucket.failed++;
    days.set(day, bucket);
  }

  const decided = completed + failed;
  const timestamps = runs.map((r) => r.created_at).sort();

  return {
    stats: {
      totalRuns: runs.length,
      completed,
      waiting,
      failed,
      contactsReached: contacts.size,
      messagesSent,
      successRate: decided > 0 ? Math.round((completed / decided) * 100) : 0,
      firstRunAt: timestamps[0] ?? null,
      lastRunAt: timestamps[timestamps.length - 1] ?? null,
      queued: opts.queuedCount ?? 0,
      nextRunAt,
    },
    runs,
    topErrors: [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    stepBreakdown: [...steps.values()].sort(
      (a, b) => b.failed - a.failed || b.success - a.success,
    ),
    daily: [...days.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}
