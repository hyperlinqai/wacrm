import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  debugAccessToken,
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'

const META_API_BASE = 'https://graph.facebook.com/v21.0'

/**
 * Is `META_APP_SECRET` actually the App Secret for `appId` on Meta's
 * side? An app access token (`{app-id}|{app-secret}`) is only valid
 * for the app whose secret it was built from — Meta rejects the
 * combination outright otherwise. This is the single most dangerous
 * misconfiguration to leave undetected: `verifyMetaWebhookSignature`
 * fails closed, so a wrong secret means the webhook route 401s every
 * genuine call from Meta before any of your code runs. Inbound
 * messages, delivery receipts and read receipts all go silent at
 * once, with nothing in this app's own logs pointing at the cause —
 * exactly the failure mode this check exists to catch.
 *
 * Returns null (not false) when there's no appId to check against —
 * the UI must render that as "unknown", not "invalid".
 */
async function checkAppSecretValid(
  appId: string | null,
  appSecret: string,
): Promise<boolean | null> {
  if (!appId) return null
  const url = `${META_API_BASE}/${appId}?access_token=${encodeURIComponent(`${appId}|${appSecret}`)}&fields=name`
  try {
    const res = await fetch(url)
    return res.ok
  } catch {
    return null
  }
}

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side AND that Meta's webhook calls can
 * actually get through. Solves two failure modes:
 *
 *   1. "UI says Connected but Meta isn't delivering events" (the
 *      original multi-number bug this endpoint was built for).
 *   2. A silent signature-secret mismatch — outbound sends and Meta
 *      API registration calls all succeed (they don't depend on
 *      META_APP_SECRET at all), so nothing about the UI looks broken,
 *      while every inbound webhook call is quietly 401'd.
 *
 * Checks run independently so the UI can show which step passes and
 * which fails:
 *
 *   1. phone_metadata_ok   — GET /{phone_number_id} succeeds
 *   2. app_secret_configured — META_APP_SECRET is set on this server
 *   3. app_secret_valid    — that secret is actually valid for the
 *                            Meta app our access token belongs to
 *   4. our_app_subscribed  — our app (by id, not just "some app") is
 *                            in GET /{waba_id}/subscribed_apps
 *   5. locally_marked_registered — local timestamp set by POST
 *                            /config when /register last succeeded
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // whatsapp_config is one-row-per-account post-017. Resolve the
  // caller's account_id so a teammate who joined an existing account
  // sees the same registration state as the admin who set it up.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'Your profile is not linked to an account.',
    })
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'No WhatsApp configuration saved yet.',
    })
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        'Stored access token can\'t be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.',
    })
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    app_secret_configured: boolean
    app_secret_valid: boolean | null
    our_app_subscribed: boolean | null
    waba_subscribed_to_app: boolean | null
    locally_marked_registered: boolean
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    app_secret_configured: !!process.env.META_APP_SECRET,
    app_secret_valid: null,
    our_app_subscribed: null,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registered_at != null,
  }
  const errors: string[] = []
  let ourApp: { id: string; name: string | null } | null = null
  let subscribedApps: { id: string; name: string | null }[] = []

  // 1. Phone metadata
  try {
    await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    checks.phone_metadata_ok = true
  } catch (err) {
    errors.push(
      `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 2. Which Meta app does our token belong to? Needed both to label
  //    "you are using app X" in the UI and to check the app-secret
  //    and subscription-match dimensions below.
  try {
    const debug = await debugAccessToken({ accessToken })
    if (debug.appId) {
      ourApp = { id: debug.appId, name: debug.appName }
    }
  } catch (err) {
    errors.push(
      `Could not identify the Meta app for this token: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 3. App secret — configured, AND actually valid for our app. See
  //    checkAppSecretValid's comment for why this check exists.
  if (!checks.app_secret_configured) {
    errors.push(
      'META_APP_SECRET is not set on the server. Meta\'s webhook calls are rejected with an invalid-signature error before your code ever runs — inbound messages, delivery receipts and read receipts all go silent. Set it in your deployment\'s environment variables (Meta App Dashboard → App Settings → Basic → App Secret) and redeploy.',
    )
  } else if (ourApp) {
    checks.app_secret_valid = await checkAppSecretValid(
      ourApp.id,
      process.env.META_APP_SECRET!,
    )
    if (checks.app_secret_valid === false) {
      errors.push(
        `META_APP_SECRET does not match app "${ourApp.name ?? ourApp.id}" on Meta's side. Every webhook call from Meta will fail signature verification and be rejected — this silently blocks inbound messages and all delivery/read status updates. Copy the exact App Secret from Meta App Dashboard → App Settings → Basic (for app "${ourApp.name ?? ourApp.id}") into META_APP_SECRET and redeploy.`,
      )
    }
  }

  // 4. WABA subscription — only meaningful if we have a waba_id.
  //    Match by app id, not just "the list is non-empty": Meta often
  //    auto-subscribes its own default app alongside yours, so an
  //    empty check here would have reported false confidence.
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      })
      subscribedApps = subs.map((s) => ({
        id: s.whatsapp_business_api_data?.id ?? '',
        name: s.whatsapp_business_api_data?.name ?? null,
      }))
      checks.waba_subscribed_to_app = subs.length > 0
      checks.our_app_subscribed = ourApp
        ? subscribedApps.some((s) => s.id === ourApp!.id)
        : null

      if (subscribedApps.length === 0) {
        errors.push(
          'WABA has no subscribed apps. Re-save the configuration to subscribe.',
        )
      } else if (checks.our_app_subscribed === false && ourApp) {
        const others = subscribedApps.map((s) => s.name ?? s.id).join(', ')
        errors.push(
          `Your app "${ourApp.name ?? ourApp.id}" is not among the apps subscribed to receive events for this number. Currently subscribed: ${others}. Re-save your WhatsApp configuration to resubscribe your app.`,
        )
      }
    } catch (err) {
      errors.push(
        `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    errors.push(
      'No WABA ID on file — webhooks can\'t be wired without it. Add it in the form and re-save.',
    )
  }

  const live =
    checks.phone_metadata_ok &&
    checks.app_secret_configured &&
    checks.app_secret_valid !== false &&
    (checks.our_app_subscribed ?? checks.waba_subscribed_to_app ?? false) &&
    checks.locally_marked_registered

  return NextResponse.json({
    live,
    checks,
    our_app: ourApp,
    subscribed_apps: subscribedApps,
    errors,
    last_registration_error: config.last_registration_error ?? null,
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
  })
}
