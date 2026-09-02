// ============================================================
// Facebook JS SDK loader — shared by WhatsApp Embedded Signup and the
// Meta Lead Ads "Connect with Facebook" button.
//
// The SDK is a global singleton (window.FB) that must be initialised
// exactly once per page with the app id; loading it twice throws.
// Both features previously would have carried their own copy of this
// loader, so it lives here with the minimal typing each needs — a full
// @types/facebook-js-sdk dependency isn't worth it for two methods.
// ============================================================

export interface FacebookAuthResponse {
  /** Set for response_type: 'code' (Embedded Signup). */
  code?: string
  /** Set for the default token response (Facebook Login). */
  accessToken?: string
  userID?: string
  expiresIn?: number
  grantedScopes?: string
}

export interface FacebookLoginResponse {
  status?: 'connected' | 'not_authorized' | 'unknown'
  authResponse?: FacebookAuthResponse | null
}

/** Options for Meta's Business Login (Embedded Signup) — code flow. */
export interface FacebookLoginConfigOptions {
  config_id: string
  response_type: 'code'
  override_default_response_type: true
  extras: { setup: Record<string, never> }
}

/** Options for classic Facebook Login — token flow with explicit scopes. */
export interface FacebookLoginScopeOptions {
  scope: string
  return_scopes?: boolean
  auth_type?: 'rerequest' | 'reauthenticate'
}

export interface FacebookSdk {
  init(config: { appId: string; version: string; xfbml?: boolean; cookie?: boolean }): void
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: FacebookLoginConfigOptions | FacebookLoginScopeOptions,
  ): void
}

declare global {
  interface Window {
    FB?: FacebookSdk
    fbAsyncInit?: () => void
  }
}

const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js'
// Kept in sync with meta-api.ts's META_API_VERSION rather than pinned
// independently — one number to bump if Meta deprecates a version.
export const FACEBOOK_GRAPH_VERSION = 'v21.0'

let sdkLoadPromise: Promise<void> | null = null

/** Load the Facebook JS SDK exactly once per page, however many callers ask. */
export function loadFacebookSdk(appId: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Facebook SDK can only load in the browser.'))
  if (window.FB) return Promise.resolve()
  if (sdkLoadPromise) return sdkLoadPromise

  sdkLoadPromise = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, version: FACEBOOK_GRAPH_VERSION, xfbml: false })
      resolve()
    }
    const script = document.createElement('script')
    script.src = SDK_SRC
    script.async = true
    script.defer = true
    script.crossOrigin = 'anonymous'
    script.onerror = () => {
      sdkLoadPromise = null
      reject(new Error('Failed to load the Facebook SDK script.'))
    }
    document.body.appendChild(script)
  })
  return sdkLoadPromise
}

/**
 * Run classic Facebook Login and resolve with the short-lived user
 * access token, or `null` if the person closed the dialog / declined.
 */
export function facebookLoginForToken(scopes: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    if (!window.FB) {
      resolve(null)
      return
    }
    window.FB.login(
      (response) => resolve(response.authResponse?.accessToken ?? null),
      { scope: scopes.join(','), return_scopes: true, auth_type: 'rerequest' },
    )
  })
}
