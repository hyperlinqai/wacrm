import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { drainPendingExecutions } from '@/lib/automations/pending-drain'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The same drain also runs from an in-process ticker (see
 * lib/automations/pending-drain.ts), so this endpoint is optional on a
 * single-instance deployment. Both share the claim-step lock, so
 * overlapping invocations never double-process a row.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { processed } = await drainPendingExecutions(50)
    return NextResponse.json({ processed })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'drain failed' },
      { status: 500 },
    )
  }
}
