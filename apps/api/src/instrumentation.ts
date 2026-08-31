// Runs once when a Next.js server instance starts (Node runtime only).
// Boots the always-on database listener that fires the
// "New Contact Created" automation trigger for every creation path.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // Skip during `next build` page-data collection and in tests.
  if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.VITEST) return
  const { startContactCreatedListener } = await import('@/lib/automations/contact-created-listener')
  startContactCreatedListener().catch((err) => {
    console.error('[instrumentation] contact listener failed to start:', err)
  })
}
