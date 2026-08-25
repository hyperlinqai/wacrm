// Fires the `new_contact_created` automation trigger for EVERY way a
// contact can come into existence — manual add, CSV import, web form,
// public API, inbound WhatsApp, even direct SQL — by listening to the
// database's own change notifications (migration 048) instead of
// hoping each code path remembers to dispatch.
//
// Started once per server process from instrumentation.ts.

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

let client: Client | null = null
let stopped = false

async function connect(): Promise<void> {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  await c.query('LISTEN wacrm_changes')
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
  const reconnect = () => {
    c.removeAllListeners()
    client = null
    if (stopped) return
    setTimeout(() => {
      startContactCreatedListener().catch((err) =>
        console.error('[automations] contact listener reconnect failed:', err.message),
      )
    }, 2000)
  }
  c.on('error', (err) => {
    console.error('[automations] contact listener error, reconnecting:', err.message)
    reconnect()
  })
  c.on('end', reconnect)
  client = c
}

/** Idempotent: safe to call more than once per process. */
export async function startContactCreatedListener(): Promise<void> {
  if (client || !process.env.DATABASE_URL) return
  stopped = false
  await connect()
  console.log('[automations] listening for new contacts')
}

export async function stopContactCreatedListener(): Promise<void> {
  stopped = true
  const c = client
  client = null
  await c?.end().catch(() => {})
}
