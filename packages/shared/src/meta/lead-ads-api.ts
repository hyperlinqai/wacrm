// ============================================================
// Meta Graph API helpers for Lead Ads (Facebook / Instagram lead forms).
//
// Same conventions as whatsapp/meta-api.ts: one options object per
// function (no positional token/id args — the swapped-argument bug
// that motivated that file applies here too), a bounded fetch timeout,
// and Meta's `{ error: { message, code } }` envelope surfaced as a
// plain Error whose message a settings UI can show verbatim.
//
// Graph version is pinned separately from META_API_VERSION in
// meta-api.ts on purpose: Lead Ads and the WhatsApp Cloud API are
// different products that deprecate on different schedules. Bump here
// when Meta retires this version.
// ============================================================

export const META_LEADS_GRAPH_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${META_LEADS_GRAPH_VERSION}`

const FETCH_TIMEOUT_MS = 30_000

/**
 * Permissions the Facebook Login dialog must grant for the whole flow
 * to work. Exported so the browser button and the docs read from one
 * list.
 *   pages_show_list       — enumerate the user's Pages (discover step)
 *   pages_read_engagement — read Page metadata (name) with the Page token
 *   pages_manage_metadata — POST /{page}/subscribed_apps (webhook install)
 *   pages_manage_ads      — read ad/adset/campaign names on a lead
 *   leads_retrieval       — read the lead's field_data
 */
export const META_LEADS_LOGIN_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_manage_ads',
  'leads_retrieval',
] as const

export class MetaGraphError extends Error {
  readonly code: number | null
  readonly subcode: number | null
  readonly httpStatus: number
  constructor(message: string, opts: { code?: number | null; subcode?: number | null; httpStatus: number }) {
    super(message)
    this.name = 'MetaGraphError'
    this.code = opts.code ?? null
    this.subcode = opts.subcode ?? null
    this.httpStatus = opts.httpStatus
  }
}

interface GraphErrorEnvelope {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string }
}

async function graphFetch<T>(url: URL, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new MetaGraphError(`Meta API did not respond within ${Math.round(FETCH_TIMEOUT_MS / 1000)} s. Please try again.`, {
        httpStatus: 0,
      })
    }
    throw err
  }

  const text = await response.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }

  if (!response.ok) {
    const env = (json ?? {}) as GraphErrorEnvelope
    const message = env.error?.message ?? `Meta API error: HTTP ${response.status}`
    throw new MetaGraphError(message, {
      code: env.error?.code ?? null,
      subcode: env.error?.error_subcode ?? null,
      httpStatus: response.status,
    })
  }
  return json as T
}

function graphUrl(path: string, params: Record<string, string | number | undefined>): URL {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\/+/, '')}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }
  return url
}

// ============================================================
// Tokens & pages
// ============================================================

export interface ExchangeLongLivedUserTokenArgs {
  /** Short-lived user token from FB.login() in the browser (~1–2 h). */
  shortLivedToken: string
  appId: string
  appSecret: string
}

/**
 * Trade a short-lived user token for a ~60-day one. Page tokens minted
 * from a long-lived user token do not expire, which is what lets a
 * connected Page keep receiving leads without anyone re-logging in.
 */
export async function exchangeLongLivedUserToken(args: ExchangeLongLivedUserTokenArgs): Promise<{ accessToken: string; expiresIn: number | null }> {
  const json = await graphFetch<{ access_token?: string; expires_in?: number }>(
    graphUrl('oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: args.appId,
      client_secret: args.appSecret,
      fb_exchange_token: args.shortLivedToken,
    }),
  )
  if (!json.access_token) throw new MetaGraphError('Meta did not return a long-lived access token.', { httpStatus: 200 })
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? null }
}

export interface MetaUserPage {
  id: string
  name: string
  /** Page access token — long-lived when derived from a long-lived user token. */
  access_token: string
  /** Meta's per-page task list for this user (e.g. MANAGE, ADVERTISE). */
  tasks?: string[]
}

/** Every Page the user can act on, with a Page token for each. */
export async function listUserPages(args: { userAccessToken: string }): Promise<MetaUserPage[]> {
  const pages: MetaUserPage[] = []
  let url: URL | null = graphUrl('me/accounts', {
    fields: 'id,name,access_token,tasks',
    limit: 100,
    access_token: args.userAccessToken,
  })
  // Follow paging.next for users who manage > 100 Pages.
  for (let hops = 0; url && hops < 10; hops++) {
    const json: { data?: MetaUserPage[]; paging?: { next?: string } } = await graphFetch(url)
    for (const p of json.data ?? []) {
      if (p?.id && p?.access_token) pages.push({ id: String(p.id), name: p.name ?? String(p.id), access_token: p.access_token, tasks: p.tasks })
    }
    url = json.paging?.next ? new URL(json.paging.next) : null
  }
  return pages
}

/** Confirm a Page token is valid for `pageId` and fetch the Page's display name. */
export async function getPageInfo(args: { pageId: string; pageAccessToken: string }): Promise<{ id: string; name: string }> {
  const json = await graphFetch<{ id?: string; name?: string }>(
    graphUrl(args.pageId, { fields: 'id,name', access_token: args.pageAccessToken }),
  )
  if (!json.id) throw new MetaGraphError('Meta did not return a Page for that id.', { httpStatus: 200 })
  return { id: String(json.id), name: json.name ?? String(json.id) }
}

/**
 * Install this app's webhook on the Page for the `leadgen` field. This
 * is per-Page: the App-level Webhooks subscription (Meta dashboard →
 * Webhooks → Page → leadgen) says *where* to POST; this call says
 * *which Pages* should POST there.
 */
export async function subscribePageToLeadgen(args: { pageId: string; pageAccessToken: string }): Promise<boolean> {
  const url = graphUrl(`${args.pageId}/subscribed_apps`, {})
  const body = new URLSearchParams({ subscribed_fields: 'leadgen', access_token: args.pageAccessToken })
  const json = await graphFetch<{ success?: boolean }>(url, { method: 'POST', body })
  return json.success === true
}

/** Remove this app from the Page's subscribed apps. Best-effort on disconnect. */
export async function unsubscribePageApp(args: { pageId: string; pageAccessToken: string }): Promise<boolean> {
  const url = graphUrl(`${args.pageId}/subscribed_apps`, { access_token: args.pageAccessToken })
  const json = await graphFetch<{ success?: boolean }>(url, { method: 'DELETE' })
  return json.success === true
}

// ============================================================
// Leads
// ============================================================

export interface MetaLeadFieldDatum {
  name: string
  values?: unknown[]
}

export interface MetaLead {
  id: string
  created_time?: string
  field_data?: MetaLeadFieldDatum[]
  form_id?: string
  ad_id?: string
  ad_name?: string
  adset_id?: string
  adset_name?: string
  campaign_id?: string
  campaign_name?: string
  platform?: string
  is_organic?: boolean
}

const LEAD_FIELDS_FULL = 'id,created_time,field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,platform,is_organic'
// Ad/adset/campaign names need ads permissions; a token without them
// still gets the lead itself with this reduced set.
const LEAD_FIELDS_BASIC = 'id,created_time,field_data,form_id,ad_id,platform,is_organic'

/**
 * Fetch one lead by its leadgen id (the id the webhook carries). Tries
 * the full field set first and falls back to the basic set if Meta
 * rejects the ads-scoped fields — a lead should never be lost because
 * campaign *names* were unreadable.
 */
export async function fetchLeadgenLead(args: { leadgenId: string; pageAccessToken: string }): Promise<MetaLead> {
  try {
    return await graphFetch<MetaLead>(graphUrl(args.leadgenId, { fields: LEAD_FIELDS_FULL, access_token: args.pageAccessToken }))
  } catch (err) {
    if (err instanceof MetaGraphError && err.httpStatus >= 400 && err.httpStatus < 500) {
      return await graphFetch<MetaLead>(graphUrl(args.leadgenId, { fields: LEAD_FIELDS_BASIC, access_token: args.pageAccessToken }))
    }
    throw err
  }
}

export interface MetaLeadForm {
  id: string
  name?: string
  status?: string
  leads_count?: number
}

/** Lead forms that belong to the Page (for Sync and for showing form names). */
export async function listPageLeadForms(args: { pageId: string; pageAccessToken: string }): Promise<MetaLeadForm[]> {
  const forms: MetaLeadForm[] = []
  let url: URL | null = graphUrl(`${args.pageId}/leadgen_forms`, {
    fields: 'id,name,status,leads_count',
    limit: 100,
    access_token: args.pageAccessToken,
  })
  for (let hops = 0; url && hops < 10; hops++) {
    const json: { data?: MetaLeadForm[]; paging?: { next?: string } } = await graphFetch(url)
    for (const f of json.data ?? []) if (f?.id) forms.push({ ...f, id: String(f.id) })
    url = json.paging?.next ? new URL(json.paging.next) : null
  }
  return forms
}

export interface ListFormLeadsArgs {
  formId: string
  pageAccessToken: string
  /** Only leads created after this unix-seconds timestamp. */
  sinceUnix?: number
  /** Hard cap across pages of results. Default 500. */
  max?: number
}

/**
 * Pull leads for one form, newest first, following pagination up to
 * `max`. Used by Sync to backfill leads that arrived before the Page
 * was connected or while the webhook was down (Meta keeps 90 days).
 */
export async function listFormLeads(args: ListFormLeadsArgs): Promise<MetaLead[]> {
  const max = args.max ?? 500
  const leads: MetaLead[] = []
  const params: Record<string, string | number | undefined> = {
    fields: LEAD_FIELDS_FULL,
    limit: 100,
    access_token: args.pageAccessToken,
  }
  if (args.sinceUnix) {
    params.filtering = JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: args.sinceUnix }])
  }
  let url: URL | null = graphUrl(`${args.formId}/leads`, params)
  let useBasic = false
  for (let hops = 0; url && hops < 50 && leads.length < max; hops++) {
    let json: { data?: MetaLead[]; paging?: { next?: string } }
    try {
      json = await graphFetch(url)
    } catch (err) {
      if (!useBasic && err instanceof MetaGraphError && err.httpStatus >= 400 && err.httpStatus < 500) {
        useBasic = true
        url.searchParams.set('fields', LEAD_FIELDS_BASIC)
        json = await graphFetch(url)
      } else {
        throw err
      }
    }
    for (const l of json.data ?? []) if (l?.id) leads.push({ ...l, id: String(l.id) })
    url = json.paging?.next ? new URL(json.paging.next) : null
  }
  return leads.slice(0, max)
}
