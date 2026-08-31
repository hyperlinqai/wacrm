import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health — liveness probe for the reverse proxy / uptime
 * monitors, and a cheap way to tell whether the Node process has
 * restarted (uptime resets), which is what a Cloudflare 502 on an
 * otherwise healthy site usually means.
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
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
