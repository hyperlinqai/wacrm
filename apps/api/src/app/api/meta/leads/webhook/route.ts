// ============================================================
// GET/POST /api/meta/leads/webhook — Meta Lead Ads (Page object) webhook
//
// Configure in Meta for Developers → your app → Webhooks → **Page**:
//   Callback URL:  https://<your-domain>/api/meta/leads/webhook
//   Verify token:  META_LEADS_WEBHOOK_VERIFY_TOKEN (falls back to
//                  WHATSAPP_WEBHOOK_VERIFY_TOKEN, then to any connected
//                  WhatsApp config's verify token — so an operator who
//                  already set one up for WhatsApp can reuse it)
//   Subscribed fields: leadgen
//
// The operator may instead point the Page object's Callback URL at the
// WhatsApp webhook (/api/whatsapp/webhook): that route detects
// `object: "page"` bodies and forwards them to the same handler.
//
// POST verification is the app-secret HMAC every Meta webhook carries
// (x-hub-signature-256) — same helper, same fail-closed contract as the
// WhatsApp route. Processing runs in `after()` so Meta is acked within
// its timeout; the Graph API round-trip per lead happens off the
// request path.
// ============================================================

import { NextResponse, after } from 'next/server'

import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/meta-leads/admin-client'
import { handleLeadgenWebhook, isPageWebhookBody } from '@/lib/meta-leads/webhook-handler'

export const maxDuration = 60

async function verifyTokenMatches(candidate: string): Promise<boolean> {
  const envTokens = [process.env.META_LEADS_WEBHOOK_VERIFY_TOKEN, process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN]
    .map((t) => t?.trim())
    .filter((t): t is string => !!t)
  if (envTokens.includes(candidate)) return true

  const { data: configs } = await supabaseAdmin().from('whatsapp_config').select('verify_token')
  for (const row of configs ?? []) {
    const enc = row.verify_token as string | null
    if (!enc) continue
    try {
      if (decrypt(enc) === candidate) return true
    } catch {
      // wrong-key / malformed row — keep looking
    }
  }
  return false
}

// GET — subscription verification handshake
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
    }
    if (!(await verifyTokenMatches(verifyToken))) {
      return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
    }
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  } catch (error) {
    console.error('[meta-leads/webhook] GET verification error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST — leadgen deliveries
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[meta-leads/webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!isPageWebhookBody(body)) {
    // Some other object type was pointed at this URL — ack so Meta
    // doesn't retry forever, but say so in the logs.
    console.warn('[meta-leads/webhook] ignoring non-page webhook object:', (body as { object?: unknown })?.object)
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  after(async () => {
    try {
      const result = await handleLeadgenWebhook(body)
      if (result.processed || result.skipped) {
        console.log(`[meta-leads/webhook] processed=${result.processed} skipped=${result.skipped}`)
      }
    } catch (error) {
      console.error('[meta-leads/webhook] processing error:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
