import type { SupabaseClient } from '@wacrm/shared/db'
import { encrypt } from './encryption'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
  type MetaPhoneInfo,
} from '@wacrm/shared/whatsapp/meta-api'

/**
 * Resolve the caller's account_id from their profile. Shared by every
 * WhatsApp onboarding route (manual save, Embedded Signup) — whichever
 * one runs, the account a config attaches to must be derived the same
 * way. Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
export async function resolveAccountId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * Shared "make this WhatsApp number live" logic — verify with Meta,
 * register for inbound webhooks, subscribe the WABA to this app, and
 * persist the row. Both onboarding paths funnel through this:
 *
 *   - The manual Settings form (POST /api/whatsapp/config): an admin
 *     types in credentials they generated themselves in Meta Business
 *     Settings, including a PIN they chose.
 *   - Embedded Signup (POST /api/whatsapp/embedded-signup): Meta's
 *     hosted flow hands back the phone/WABA id and an OAuth code we
 *     exchange for a token; there's no human to type a PIN, so the
 *     caller generates one and passes it here the same as any other
 *     PIN — this function doesn't know or care which flow it came
 *     from.
 *
 * One code path means a bug fix or behavior change (e.g. how a
 * "number already claimed by another account" conflict is reported)
 * automatically applies to both onboarding methods instead of only
 * whichever one someone remembered to update.
 */
export interface ActivateWhatsAppConfigArgs {
  /** User-context client — RLS (organization_admin) gates the actual write. */
  supabase: SupabaseClient
  /** Service-role client — needed only to see rows in *other* accounts for the ownership-conflict check. */
  supabaseAdmin: SupabaseClient
  accountId: string
  userId: string
  phoneNumberId: string
  wabaId: string | null
  accessToken: string
  verifyToken?: string | null
  /** 6-digit 2-step-verification PIN for /register. Required to actually go live; a missing PIN is treated as "save now, register later" (mirrors Meta test numbers, which expose no PIN to set). */
  pin?: string | null
}

export type ActivateWhatsAppConfigResult =
  | {
      ok: true
      registered: boolean
      registrationSkipped: boolean
      registrationError: string | null
      phoneInfo: MetaPhoneInfo
    }
  | { ok: false; error: string; status: number }

export async function activateWhatsAppConfig(
  args: ActivateWhatsAppConfigArgs,
): Promise<ActivateWhatsAppConfigResult> {
  const {
    supabase,
    supabaseAdmin,
    accountId,
    userId,
    phoneNumberId,
    wabaId,
    accessToken,
    verifyToken,
    pin,
  } = args

  if (pin !== undefined && pin !== null && pin !== '') {
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
      return { ok: false, error: 'PIN must be exactly 6 digits.', status: 400 }
    }
  }

  // Reject if another account has already claimed this phone_number_id.
  // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
  // bind the same number causes the webhook's `.single()` lookup to
  // throw PGRST116 ("multiple rows"), silently dropping every inbound
  // message. See issue #136.
  const { data: claimed, error: claimedError } = await supabaseAdmin
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phoneNumberId)
    .neq('account_id', accountId)
    .maybeSingle()

  if (claimedError) {
    console.error('Error checking phone_number_id ownership:', claimedError)
    return { ok: false, error: 'Failed to validate configuration', status: 500 }
  }
  if (claimed) {
    return {
      ok: false,
      status: 409,
      error:
        'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one HQ Intelligence account.',
    }
  }

  // Verify credentials with Meta BEFORE saving.
  let phoneInfo: MetaPhoneInfo
  try {
    phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    console.error('Meta API verification failed during save:', message)
    return { ok: false, error: `Meta API error: ${message}`, status: 400 }
  }

  let encryptedAccessToken: string
  let encryptedVerifyToken: string | null
  try {
    encryptedAccessToken = encrypt(accessToken)
    encryptedVerifyToken = verifyToken ? encrypt(verifyToken) : null
  } catch (err) {
    console.error('Encryption failed:', err instanceof Error ? err.message : err)
    return {
      ok: false,
      status: 500,
      error:
        'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
    }
  }

  // Look up any pre-existing row for this account so we know whether
  // this number is already registered with Meta — if so we can skip
  // /register when the caller didn't provide a PIN this time.
  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('id, registered_at, phone_number_id')
    .eq('account_id', accountId)
    .maybeSingle()

  const sameNumber =
    existing?.phone_number_id === phoneNumberId && existing?.registered_at != null

  // Step 1: register the phone number for inbound webhooks. Attempted
  // on first save AND whenever a fresh PIN is supplied (e.g. rotated
  // in Meta Manager). Skipped when the same number is already
  // registered and no PIN was supplied — re-registering an active
  // number with a stale PIN would undo the active subscription.
  let registeredAt: string | null = existing?.registered_at ?? null
  let registrationError: string | null = null
  let registrationSkipped = false

  const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
  if (needsRegistration) {
    if (!pin) {
      registrationSkipped = true
    } else {
      try {
        await registerPhoneNumber({ phoneNumberId, accessToken, pin })
        registeredAt = new Date().toISOString()
      } catch (err) {
        registrationError = err instanceof Error ? err.message : 'Unknown Meta API error'
        console.error('Phone number /register failed:', registrationError)
        // Fall through and still save the row so the caller can retry
        // without redoing everything.
      }
    }
  }

  // Step 2: subscribe the WABA to this app. Idempotent on Meta's side.
  let subscribedAppsAt: string | null = null
  if (wabaId) {
    try {
      await subscribeWabaToApp({ wabaId, accessToken })
      subscribedAppsAt = new Date().toISOString()
    } catch (err) {
      console.warn(
        'WABA subscribed_apps failed (non-fatal):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  const baseRow = {
    phone_number_id: phoneNumberId,
    waba_id: wabaId || null,
    access_token: encryptedAccessToken,
    verify_token: encryptedVerifyToken,
    status: registrationError ? 'disconnected' : 'connected',
    connected_at: registrationError ? null : new Date().toISOString(),
    registered_at: registrationError ? null : registeredAt,
    subscribed_apps_at: subscribedAppsAt ?? null,
    last_registration_error: registrationError,
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from('whatsapp_config')
      .update(baseRow)
      .eq('account_id', accountId)
    if (updateError) {
      console.error('Error updating whatsapp_config:', updateError)
      return { ok: false, error: 'Failed to update configuration', status: 500 }
    }
  } else {
    const { error: insertError } = await supabase.from('whatsapp_config').insert({
      account_id: accountId,
      user_id: userId,
      ...baseRow,
    })
    if (insertError) {
      console.error('Error inserting whatsapp_config:', insertError)
      return { ok: false, error: 'Failed to save configuration', status: 500 }
    }
  }

  return {
    ok: true,
    registered: registeredAt != null,
    registrationSkipped,
    registrationError,
    phoneInfo,
  }
}
