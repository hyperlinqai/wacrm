// Fires the `new_contact_created` automation trigger for EVERY way a
// contact can come into existence — manual add, CSV import, web form,
// public API, inbound WhatsApp, even direct SQL — by listening to the
// database's own change notifications (migration 048) instead of
// hoping each code path remembers to dispatch.
//
// Started once per server process from instrumentation.ts.
//
// The connection is the whole feature: while it is down, no automation
// fires for new leads and nothing else notices. So it never gives up —
// a dropped connection, a database restart, or a failure at boot all
// schedule another attempt with capped backoff, forever, until the
// process is asked to stop. (It used to try exactly once, two seconds
// after a drop; when Postgres was still restarting at that moment the
// listener stayed dead until the next deploy, and a day of Meta leads
// went unnurtured.) /api/health reports the current state.

import { Client } from 'pg'

import { runAutomationsForTrigger } from './engine'

interface NotifyPayload {
  table: string
  op: 'INSERT' | 'UPDATE' | 'DELETE'
  keys: { id?: string; account_id?: string; source?: string }
}

// ── De-duplication with the webhook ──────────────────────────────────
// The WhatsApp webhook also dispatches new_contact_created (with the
// inbound message as context) when it auto-creates a contact. Both it
// and this listener claim the contact id first; whoever wins dispatches,
// the other stands down. Entries expire so the set can't grow forever.

const CLAIM_TTL_MS = 60_000
const claimed = new Map<string, number>()

export function claimContactCreatedDispatch(contactId: string, now = Date.now()): boolean {
  for (const [id, at] of claimed) if (now - at > CLAIM_TTL_MS) claimed.delete(id)
  if (claimed.has(contactId)) return false
  claimed.set(contactId, now)
  return true
}

/** Exported for tests: decide + dispatch for one notification. */
export async function handleContactNotify(
  payload: NotifyPayload,
  dispatch: typeof runAutomationsForTrigger = runAutomationsForTrigger,
): Promise<boolean> {
  if (payload.table !== 'contacts' || payload.op !== 'INSERT') return false
  const { id, account_id } = payload.keys ?? {}
  if (!id || !account_id) return false
  if (!claimContactCreatedDispatch(id)) return false
  await dispatch({
    accountId: account_id,
    triggerType: 'new_contact_created',
    contactId: id,
    context: { vars: { contact_source: payload.keys.source ?? 'manual' } },
  })
  return true
}

// ── Connection lifecycle ─────────────────────────────────────────────

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000

/**
 * Delay before reconnect attempt `attempt` (0-based): 2s, 4s, 8s … capped
 * at a minute, so a long outage is polled once a minute rather than
 * hammered or abandoned.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS)
}

export interface ContactListenerStatus {
  /** A LISTEN connection is open right now. */
  connected: boolean
  /** Reconnect attempts since the connection was last up. */
  reconnectAttempts: number
  /** When the connection was last established, if ever. */
  connectedAt: string | null
  /** Message of the most recent failure, if any. */
  lastError: string | null
}

let client: Client | null = null
let stopped = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let connectedAt: string | null = null
let lastError: string | null = null

/** For /api/health: is the new-contact trigger actually wired up? */
export function contactListenerStatus(): ContactListenerStatus {
  return { connected: client !== null, reconnectAttempts, connectedAt, lastError }
}

async function connect(): Promise<void> {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  try {
    await c.connect()
    await c.query('LISTEN wacrm_changes')
  } catch (err) {
    await c.end().catch(() => {})
    throw err
  }

  c.on('notification', (msg) => {
    if (msg.channel !== 'wacrm_changes' || !msg.payload) return
    let payload: NotifyPayload
    try {
      payload = JSON.parse(msg.payload) as NotifyPayload
    } catch {
      return
    }
    void handleContactNotify(payload).catch((err) =>
      console.error('[automations] new_contact_created dispatch failed:', err),
    )
  })

  // pg emits 'error' and then 'end' for one dropped connection; the
  // timer guard in scheduleReconnect collapses both into one attempt.
  const dropped = (reason: string) => {
    if (client !== c) return
    c.removeAllListeners()
    client = null
    lastError = reason
    if (stopped) return
    console.error(`[automations] contact listener dropped (${reason}); reconnecting`)
    scheduleReconnect()
  }
  c.on('error', (err) => dropped(err.message))
  c.on('end', () => dropped('connection ended'))

  client = c
  connectedAt = new Date().toISOString()
  reconnectAttempts = 0
  lastError = null
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer || client) return
  const delay = reconnectDelayMs(reconnectAttempts)
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (stopped || client) return
    connect()
      .then(() => console.log('[automations] contact listener reconnected'))
      .catch((err: Error) => {
        lastError = err.message
        console.error(
          `[automations] contact listener reconnect failed (attempt ${reconnectAttempts}, next in ${reconnectDelayMs(reconnectAttempts) / 1000}s):`,
          err.message,
        )
        scheduleReconnect()
      })
  }, delay)
  // Never keep a process alive just to retry.
  reconnectTimer.unref?.()
}

/**
 * Idempotent: safe to call more than once per process. Never throws —
 * a failure to connect at boot is retried in the background like any
 * later drop, so a database that comes up after the app does is fine.
 */
export async function startContactCreatedListener(): Promise<void> {
  if (client) return
  if (!process.env.DATABASE_URL) {
    console.warn('[automations] DATABASE_URL is not set; new_contact_created automations will not fire')
    return
  }
  stopped = false
  try {
    await connect()
    console.log('[automations] listening for new contacts')
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    console.error('[automations] contact listener failed to start; retrying in background:', lastError)
    scheduleReconnect()
  }
}

export async function stopContactCreatedListener(): Promise<void> {
  stopped = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const c = client
  client = null
  c?.removeAllListeners()
  await c?.end().catch(() => {})
}
