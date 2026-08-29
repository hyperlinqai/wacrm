import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { makeAdminClient } from '@/lib/db/server-client'
import { exchangeEmbeddedSignupCode } from '@/lib/whatsapp/meta-api'
import { activateWhatsAppConfig, resolveAccountId } from '@/lib/whatsapp/activate-config'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = makeAdminClient()
  }
  return _adminClient
}

/** A random 6-digit string, left-padded — Meta's /register PIN format. */
function generatePin(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/**
 * POST /api/whatsapp/embedded-signup
 *
 * Completes Meta's WhatsApp Embedded Signup — the fully automatic
 * counterpart to the manual Settings form. The browser side
 * (EmbeddedSignupButton) runs Meta's hosted flow via the Facebook JS
 * SDK: the user logs into Facebook, picks their WhatsApp Business
 * Account and phone number entirely inside Meta's own UI (including
 * setting their 2-step-verification PIN there), and the SDK hands
 * back an OAuth `code` plus the chosen `phone_number_id` / `waba_id`
 * via a postMessage event. None of that involves the business ever
 * seeing or typing a token, WABA id, or PIN into this app.
 *
 * This route does the one step that has to happen server-side — code
 * exchange needs the App Secret, which must never reach the browser —
 * then hands off to the exact same `activateWhatsAppConfig` the manual
 * form uses (register for webhooks, subscribe the WABA, persist the
 * row). The one thing Embedded Signup doesn't give us that /register
 * still requires is a 2-step-verification PIN for *this app's* call
 * to Meta — Meta's popup already had the business confirm one during
 * signup, but doesn't hand it back to callers, so a fresh one is
 * generated here and sent to /register in the same request. It's an
 * internal registration parameter the app manages on the business's
 * behalf, not something the business needs to know or ever re-enter.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { code, phone_number_id, waba_id } = body as {
      code?: string
      phone_number_id?: string
      waba_id?: string
    }

    if (!code || !phone_number_id || !waba_id) {
      return NextResponse.json(
        {
          error:
            'code, phone_number_id and waba_id are required — Embedded Signup did not report a completed selection.',
        },
        { status: 400 },
      )
    }

    let accessToken: string
    try {
      ;({ accessToken } = await exchangeEmbeddedSignupCode({ code }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Embedded Signup code exchange failed:', message)
      return NextResponse.json(
        { error: `Could not complete sign-in with Meta: ${message}` },
        { status: 400 },
      )
    }

    const result = await activateWhatsAppConfig({
      supabase,
      supabaseAdmin: supabaseAdmin(),
      accountId,
      userId: user.id,
      phoneNumberId: phone_number_id,
      wabaId: waba_id,
      accessToken,
      // One webhook Callback URL serves every account on this
      // deployment (configured once, at the App level, in Meta's
      // dashboard) — there is no per-account value for the business
      // to set. If the operator configured one for the initial
      // handshake, reuse it here too so every row can satisfy it.
      verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? null,
      pin: generatePin(),
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    if (result.registrationError) {
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: result.registrationError,
        phone_info: result.phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: result.registered,
      registration_skipped: result.registrationSkipped,
      phone_info: result.phoneInfo,
    })
  } catch (error) {
    console.error('Error in WhatsApp embedded-signup POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
