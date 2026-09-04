import { NextResponse } from 'next/server'

import { contactListenerStatus } from '@/lib/automations/contact-created-listener'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health — liveness probe for the reverse proxy / uptime
 * monitors, and a cheap way to tell whether the Node process has
 * restarted (uptime resets), which is what a Cloudflare 502 on an
 * otherwise healthy site usually means.
 *
 * `automations.new_contact_listener` says whether the database LISTEN
 * connection that fires new_contact_created is up — the first thing to
 * check when "automations don't run for new leads".
 */
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      uptime_s: Math.round(process.uptime()),
      pid: process.pid,
      node: process.version,
      memory_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      now: new Date().toISOString(),
      automations: { new_contact_listener: contactListenerStatus() },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
