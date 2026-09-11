// ============================================================
// Message-template lifecycle operations, decoupled from auth.
//
// The dashboard routes under /api/whatsapp/templates/* and the public
// API routes under /api/v1/templates/* both need to sync, submit, edit
// and delete templates. They differ only in how the caller is
// authenticated (cookie session vs API key), so the Meta + DB work
// lives here and each route resolves (supabase, accountId, userId)
// its own way before calling in.
//
// Every function throws `TemplateOpError` for expected failures
// (not configured, validation, Meta rejection) carrying an HTTP
// status the route can pass straight through.
// ============================================================

import type { SupabaseClient } from '@wacrm/shared/db'
import type { TemplateButton, TemplateSampleValues } from '@wacrm/shared/types'
import {
  deleteMessageTemplate,
  editMessageTemplate,
  submitMessageTemplate,
} from '@wacrm/shared/whatsapp/meta-api'
import {
  groupTemplateButtons,
  validateTemplatePayload,
  type TemplatePayload,
} from '@wacrm/shared/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@wacrm/shared/whatsapp/template-components'

import { decrypt } from '@/lib/whatsapp/encryption'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])

/** Columns exposed by the public API's template endpoints. */
export const TEMPLATE_SELECT =
  'id, name, category, language, status, header_type, header_content, header_media_url, body_text, footer_text, buttons, sample_values, meta_template_id, quality_score, rejection_reason, submission_error, last_submitted_at, created_at, updated_at'

export const TEMPLATE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class TemplateOpError extends Error {
  readonly status: number
  readonly extra?: Record<string, unknown>

  constructor(message: string, status: number, extra?: Record<string, unknown>) {
    super(message)
    this.name = 'TemplateOpError'
    this.status = status
    this.extra = extra
  }
}

export function isTemplatesDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  )
}

async function loadConfig(
  supabase: SupabaseClient,
  accountId: string,
  { requireWaba }: { requireWaba: boolean },
): Promise<{ wabaId: string; accessToken: string }> {
  const { data: config, error } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()
  if (error || !config) {
    throw new TemplateOpError(
      'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
      400,
    )
  }
  if (requireWaba && !config.waba_id) {
    throw new TemplateOpError(
      'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
      400,
    )
  }
  return { wabaId: config.waba_id, accessToken: decrypt(config.access_token) }
}

/** Group buttons + validate; throws a 400 TemplateOpError on failure. */
function preparePayload(payload: TemplatePayload, action: string) {
  if (!payload || typeof payload !== 'object') {
    throw new TemplateOpError('Invalid JSON body.', 400)
  }
  if (payload.category === 'Authentication') {
    throw new TemplateOpError(
      `AUTHENTICATION templates are not supported for ${action} here — manage them in Meta WhatsApp Manager and use "Sync from Meta".`,
      400,
    )
  }
  if (payload.buttons && Array.isArray(payload.buttons)) {
    payload.buttons = groupTemplateButtons(payload.buttons)
  }
  try {
    validateTemplatePayload(payload)
  } catch (e) {
    throw new TemplateOpError(
      e instanceof Error ? e.message : 'Validation failed.',
      400,
    )
  }
}

async function attachHeaderHandle(payload: TemplatePayload, accessToken: string) {
  try {
    await ensureImageHeaderHandle(payload, accessToken)
  } catch (e) {
    throw new TemplateOpError(
      e instanceof Error ? e.message : 'Header image upload failed.',
      400,
    )
  }
}

// ---------------------------------------------------------------
// Sync (Meta → local)
// ---------------------------------------------------------------

interface MetaButton {
  type: string
  text: string
  url?: string
  phone_number?: string
  example?: string[] | string
}

interface MetaTemplateComponent {
  type: string
  text?: string
  format?: string
  buttons?: MetaButton[]
  example?: {
    header_text?: string[]
    header_handle?: string[]
    body_text?: string[][]
  }
}

interface MetaTemplate {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: MetaTemplateComponent[]
  quality_score?: { score?: string } | string
}

function normalizeCategory(meta: string): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

function normalizeQualityScore(
  raw: MetaTemplate['quality_score'],
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score = typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null
  if (!score) return null
  const upper = score.toUpperCase()
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED'
    ? (upper as 'GREEN' | 'YELLOW' | 'RED')
    : null
}

function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return []
  const out: TemplateButton[] = []
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text })
        break
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        })
        break
      case 'PHONE_NUMBER':
        out.push({ type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number ?? '' })
        break
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example) ? b.example[0] ?? '' : b.example ?? '',
        })
        break
      // OTP, FLOW, etc — out of scope; drop silently.
    }
  }
  return out
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): TemplateSampleValues | null {
  // Meta returns body_text as a 2D array — one row per example set.
  const bodySample = body?.example?.body_text?.[0]
  const headerSample = header?.example?.header_text
  if (!bodySample?.length && !headerSample?.length) return null
  const sv: TemplateSampleValues = {}
  if (bodySample?.length) sv.body = bodySample
  if (headerSample?.length) sv.header = headerSample
  return sv
}

export interface SyncResult {
  success: boolean
  total: number
  inserted: number
  updated: number
  errors: { name: string; language: string; message: string }[]
  truncated: boolean
}

/**
 * Pull every template from Meta and upsert into message_templates.
 * Locally-created templates with no Meta counterpart are left alone.
 */
export async function syncTemplatesFromMeta(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<SyncResult> {
  const { wabaId, accessToken } = await loadConfig(supabase, accountId, {
    requireWaba: true,
  })

  const metaTemplates: MetaTemplate[] = []
  let nextUrl: string | null = `${META_API_BASE}/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`
  const PAGE_CAP = 20
  let pageCount = 0

  while (nextUrl && pageCount < PAGE_CAP) {
    pageCount++
    const metaRes: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!metaRes.ok) {
      let metaErr = `Meta API error: ${metaRes.status}`
      try {
        const body = await metaRes.json()
        if (body?.error?.message) metaErr = body.error.message
      } catch {
        // response wasn't JSON — keep the fallback
      }
      throw new TemplateOpError(metaErr, 400)
    }
    const metaBody: { data?: MetaTemplate[]; paging?: { next?: string } } =
      await metaRes.json()
    if (metaBody.data) metaTemplates.push(...metaBody.data)
    nextUrl = metaBody.paging?.next ?? null
  }

  let inserted = 0
  let updated = 0
  const errors: SyncResult['errors'] = []

  for (const t of metaTemplates) {
    const body = (t.components ?? []).find((c) => c.type === 'BODY')
    const header = (t.components ?? []).find((c) => c.type === 'HEADER')
    const footer = (t.components ?? []).find((c) => c.type === 'FOOTER')
    const buttons = (t.components ?? []).find((c) => c.type === 'BUTTONS')

    const parsedButtons = parseButtons(buttons?.buttons)
    const headerFormat = header?.format?.toUpperCase()
    const headerType =
      headerFormat === 'TEXT' ||
      headerFormat === 'IMAGE' ||
      headerFormat === 'VIDEO' ||
      headerFormat === 'DOCUMENT'
        ? headerFormat.toLowerCase()
        : null

    const row = {
      // account_id is NOT NULL on message_templates post-017.
      account_id: accountId,
      user_id: userId,
      name: t.name,
      category: normalizeCategory(t.category),
      language: t.language,
      header_type: headerType,
      header_content: header?.text ?? null,
      header_handle: header?.example?.header_handle?.[0] ?? null,
      body_text: body?.text ?? '',
      footer_text: footer?.text ?? null,
      buttons: parsedButtons.length ? parsedButtons : null,
      sample_values: extractSampleValues(body, header),
      status: normalizeStatus(t.status),
      meta_template_id: t.id,
      quality_score: normalizeQualityScore(t.quality_score),
      updated_at: new Date().toISOString(),
    }

    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', t.name)
      .eq('language', t.language)
      .maybeSingle()
    if (lookupErr) {
      errors.push({ name: t.name, language: t.language, message: lookupErr.message })
      continue
    }

    if (existing?.id) {
      const { error: updErr } = await supabase
        .from('message_templates')
        .update(row)
        .eq('id', existing.id)
      if (updErr) {
        errors.push({ name: t.name, language: t.language, message: updErr.message })
      } else {
        updated++
      }
    } else {
      const { error: insErr } = await supabase.from('message_templates').insert(row)
      if (insErr) {
        errors.push({ name: t.name, language: t.language, message: insErr.message })
      } else {
        inserted++
      }
    }
  }

  return {
    success: errors.length === 0,
    total: metaTemplates.length,
    inserted,
    updated,
    errors,
    truncated: pageCount >= PAGE_CAP && nextUrl !== null,
  }
}

// ---------------------------------------------------------------
// Submit (new template → Meta + local row)
// ---------------------------------------------------------------

function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: { status: string; metaTemplateId: string | null; submissionError: string | null },
) {
  return {
    account_id: accountId,
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    // Clear any stale rejection; the webhook sets it again if Meta rejects.
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  }
}

function upsertTemplateRow(
  supabase: SupabaseClient,
  row: ReturnType<typeof buildUpsertRow>,
) {
  // Conflict target is still the legacy (user_id, name, language)
  // index — see the TODO in the dashboard submit route.
  return supabase
    .from('message_templates')
    .upsert(row, { onConflict: 'user_id,name,language' })
    .select()
    .single()
}

export async function submitTemplate(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  payload: TemplatePayload,
): Promise<{ template: Record<string, unknown>; dryRun: boolean }> {
  preparePayload(payload, 'submission')

  const dryRun = isTemplatesDryRun()
  let metaTemplateId: string
  let metaStatus: string

  if (dryRun) {
    metaTemplateId = `dry-run-${crypto.randomUUID()}`
    metaStatus = 'PENDING'
  } else {
    const { wabaId, accessToken } = await loadConfig(supabase, accountId, {
      requireWaba: true,
    })
    await attachHeaderHandle(payload, accessToken)
    try {
      const meta = await submitMessageTemplate({
        wabaId,
        accessToken,
        payload: buildMetaTemplatePayload(payload),
      })
      metaTemplateId = meta.id
      metaStatus = meta.status
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Meta submit failed.'
      // Persist as DRAFT so the user can fix and retry.
      await upsertTemplateRow(
        supabase,
        buildUpsertRow(accountId, userId, payload, {
          status: 'DRAFT',
          metaTemplateId: null,
          submissionError: message,
        }),
      )
      const isRateLimit = /\b429\b/.test(message)
      throw new TemplateOpError(
        isRateLimit
          ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
          : message,
        isRateLimit ? 429 : 400,
      )
    }
  }

  const { data: row, error: upsertErr } = await upsertTemplateRow(
    supabase,
    buildUpsertRow(accountId, userId, payload, {
      status: normalizeStatus(metaStatus),
      metaTemplateId,
      submissionError: null,
    }),
  )
  if (upsertErr) {
    throw new TemplateOpError(
      `Submitted to Meta but failed to save locally: ${upsertErr.message}. Run "Sync from Meta" to recover.`,
      500,
      { meta_template_id: metaTemplateId },
    )
  }
  return { template: row as Record<string, unknown>, dryRun }
}

// ---------------------------------------------------------------
// Edit (existing Meta template → re-submit)
// ---------------------------------------------------------------

export async function editTemplate(
  supabase: SupabaseClient,
  accountId: string,
  id: string,
  payload: TemplatePayload,
): Promise<{ template: Record<string, unknown>; dryRun: boolean }> {
  if (!TEMPLATE_UUID_RE.test(id)) {
    throw new TemplateOpError('Invalid template id.', 400)
  }

  const { data: existing, error: lookupErr } = await supabase
    .from('message_templates')
    .select('id, name, status, meta_template_id, language')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (lookupErr || !existing) {
    throw new TemplateOpError('Template not found.', 404)
  }
  if (!existing.meta_template_id) {
    throw new TemplateOpError(
      'This template was never submitted to Meta — submit it as a new template instead.',
      400,
    )
  }
  if (!EDITABLE_STATUSES.has(existing.status)) {
    throw new TemplateOpError(
      `Templates in status ${existing.status} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
      400,
    )
  }

  preparePayload(payload, 'editing')

  const dryRun = isTemplatesDryRun()
  if (!dryRun) {
    const { accessToken } = await loadConfig(supabase, accountId, { requireWaba: false })
    await attachHeaderHandle(payload, accessToken)
    const metaPayload = buildMetaTemplatePayload(payload)
    try {
      await editMessageTemplate({
        metaTemplateId: existing.meta_template_id,
        accessToken,
        components: metaPayload.components,
        category: metaPayload.category,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Meta edit failed.'
      await supabase
        .from('message_templates')
        .update({ submission_error: message, last_submitted_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', accountId)
      throw new TemplateOpError(message, 400)
    }
  }

  // Meta accepted the edit — status flips back to PENDING for review.
  const { data: row, error: updErr } = await supabase
    .from('message_templates')
    .update({
      category: payload.category,
      header_type: payload.header_type ?? null,
      header_content: payload.header_content ?? null,
      header_media_url: payload.header_media_url ?? null,
      header_handle: payload.header_handle ?? null,
      body_text: payload.body_text,
      footer_text: payload.footer_text ?? null,
      buttons: payload.buttons ?? null,
      sample_values: payload.sample_values ?? null,
      status: 'PENDING',
      submission_error: null,
      rejection_reason: null,
      last_submitted_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single()
  if (updErr) {
    throw new TemplateOpError(
      `Edited on Meta but failed to save locally: ${updErr.message}. Run "Sync from Meta" to recover.`,
      500,
    )
  }
  return { template: row as Record<string, unknown>, dryRun }
}

// ---------------------------------------------------------------
// Delete (Meta + local)
// ---------------------------------------------------------------

export async function deleteTemplate(
  supabase: SupabaseClient,
  accountId: string,
  id: string,
): Promise<{ dryRun: boolean }> {
  if (!TEMPLATE_UUID_RE.test(id)) {
    throw new TemplateOpError('Invalid template id.', 400)
  }

  const { data: existing, error: lookupErr } = await supabase
    .from('message_templates')
    .select('id, name, meta_template_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (lookupErr || !existing) {
    throw new TemplateOpError('Template not found.', 404)
  }

  const dryRun = isTemplatesDryRun()
  if (existing.meta_template_id && !dryRun) {
    const { wabaId, accessToken } = await loadConfig(supabase, accountId, {
      requireWaba: true,
    })
    try {
      await deleteMessageTemplate({
        wabaId,
        accessToken,
        name: existing.name,
        metaTemplateId: existing.meta_template_id,
      })
    } catch (e) {
      throw new TemplateOpError(e instanceof Error ? e.message : 'Meta delete failed.', 400)
    }
  }

  const { error: delErr } = await supabase
    .from('message_templates')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
  if (delErr) {
    throw new TemplateOpError(
      `Deleted on Meta but failed to delete locally: ${delErr.message}.`,
      500,
    )
  }
  return { dryRun }
}
