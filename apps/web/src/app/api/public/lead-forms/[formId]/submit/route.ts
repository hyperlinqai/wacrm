// ============================================================
// POST /api/public/lead-forms/[formId]/submit
//
// Public — no auth required, no CORS restriction by default. Called by
// the widget script (widget.js/route.ts) from an arbitrary landing-page
// origin. `formId` is a `lead_forms.id` UUID, treated as a non-secret
// public identifier — same trust model as a Google Forms/Typeform form
// id (it sits in plaintext in the embedding page's HTML source, visible
// to anyone via view-source). Protection against abuse is rate-limiting
// + a honeypot field, not unguessability. See migration
// 046_web_forms.sql's header comment for the full rationale.
//
// Every write here goes through the service-role client — there is no
// authenticated session on this route, so RLS is bypassed exactly like
// the WhatsApp webhook route.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/web-forms/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { resolveAuditUserId, findOrCreateContact, ContactError } from '@/lib/api/v1/contacts'

interface LeadFormField {
  id: string
  type: 'text' | 'email' | 'phone' | 'textarea' | 'select'
  label: string
  required?: boolean
}

/** Same best-effort client-IP extraction used by the invitation-peek route. */
function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

/** CORS headers for this request: wildcard unless the form restricts
 *  origins, in which case only a matching Origin is echoed back. */
function corsHeaders(request: Request, allowedDomains: string[] | null): Record<string, string> {
  const origin = request.headers.get('origin')
  if (!allowedDomains || allowedDomains.length === 0) {
    return { 'Access-Control-Allow-Origin': '*' }
  }
  if (origin && allowedDomains.some((d) => origin === d || origin.endsWith(`://${d}`))) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
  }
  return {}
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, null),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ formId: string }> },
) {
  const { formId } = await params

  // Rate-limit before any DB work, per IP then per form — bounds both a
  // single flooding client and a botnet spread across many IPs hitting
  // one popular form.
  const ip = getClientIp(request)
  const ipLimit = checkRateLimit(`formsubmit:ip:${ip}`, RATE_LIMITS.leadFormSubmit)
  if (!ipLimit.success) return rateLimitResponse(ipLimit)
  const formLimit = checkRateLimit(`formsubmit:form:${formId}`, RATE_LIMITS.leadFormSubmitByForm)
  if (!formLimit.success) return rateLimitResponse(formLimit)

  const admin = supabaseAdmin()

  const { data: form, error: formErr } = await admin
    .from('lead_forms')
    .select('id, organization_id, account_id, status, fields, style, allowed_domains')
    .eq('id', formId)
    .maybeSingle()

  // Unknown id, inactive form, or a DB error all collapse to the same
  // 404 — an inactive/nonexistent form should behave identically to a
  // still-live embed pointed at a form that no longer accepts leads,
  // without leaking which case it is.
  if (formErr || !form || form.status !== 'active') {
    return NextResponse.json({ ok: false, reason: 'not_found' }, { status: 404 })
  }

  const allowedDomains = (form.allowed_domains as string[] | null) ?? null
  const cors = corsHeaders(request, allowedDomains)
  if (allowedDomains && allowedDomains.length > 0 && !cors['Access-Control-Allow-Origin']) {
    // Origin didn't match the allow-list. Same non-leaking 404 posture
    // as an unknown form id.
    return NextResponse.json({ ok: false, reason: 'not_found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, reason: 'invalid_body' }, { status: 400, headers: cors })
  }

  const fields = (form.fields as LeadFormField[] | null) ?? []
  const values = (body as { values?: Record<string, unknown> }).values ?? {}

  // Honeypot: any field submitted that isn't one of the form's own
  // configured field ids is treated as a bot-filled trap. Real widget
  // markup only ever sends `values` keyed by configured field ids plus
  // the honeypot key itself, which is passed alongside `values`, not
  // inside it (see widget.js/route.ts) — so a non-empty honeypot value
  // in the top-level body is the tell.
  const honeypotValue = (body as Record<string, unknown>).hp
  if (typeof honeypotValue === 'string' && honeypotValue.length > 0) {
    return NextResponse.json({ ok: true }, { status: 201, headers: cors })
  }

  const errors: Record<string, string> = {}
  let phone: string | undefined
  let email: string | undefined
  let name: string | undefined
  let company: string | undefined

  for (const field of fields) {
    const raw = values[field.id]
    const value = typeof raw === 'string' ? raw.trim() : undefined

    if (field.required && !value) {
      errors[field.id] = 'required'
      continue
    }
    if (!value) continue

    if (field.type === 'phone') {
      const sanitized = sanitizePhoneForMeta(value)
      if (!isValidE164(sanitized)) {
        errors[field.id] = 'invalid_phone'
        continue
      }
      phone = sanitized
    } else if (field.type === 'email') {
      if (!EMAIL_RE.test(value)) {
        errors[field.id] = 'invalid_email'
        continue
      }
      email = value
    } else if (field.label.toLowerCase() === 'name' || field.id === 'name') {
      name = value
    } else if (field.label.toLowerCase() === 'company' || field.id === 'company') {
      company = value
    }
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ ok: false, errors }, { status: 400, headers: cors })
  }
  if (!phone) {
    // The dashboard builder enforces exactly one phone field per form —
    // a form with none is a builder bug, not a visitor error. Fail
    // loudly rather than silently dropping the submission.
    console.error(`[web-forms/submit] form ${formId} has no phone field configured`)
    return NextResponse.json({ ok: false, reason: 'misconfigured' }, { status: 500, headers: cors })
  }

  const organizationId = form.organization_id as string
  const accountId = form.account_id as string

  try {
    const auditUserId = await resolveAuditUserId(admin, organizationId, accountId)
    const { id: contactId } = await findOrCreateContact(admin, accountId, auditUserId, {
      phone,
      name,
      email,
      company,
    })

    // First-touch attribution only — don't overwrite a more meaningful
    // existing source (e.g. an already-WhatsApp-sourced contact) on a
    // resubmission.
    await admin
      .from('contacts')
      .update({ source: 'web_form', source_form_id: formId })
      .eq('id', contactId)
      .eq('source', 'manual')

    await admin.from('lead_form_submissions').insert({
      lead_form_id: formId,
      organization_id: organizationId,
      contact_id: contactId,
      payload: values,
      ip_address: ip,
      user_agent: request.headers.get('user-agent'),
      referrer: request.headers.get('referer'),
    })

    await admin.rpc('increment_lead_form_submit_count', { p_lead_form_id: formId })

    const style = (form.style as { successMessage?: string } | null) ?? {}
    return NextResponse.json(
      { ok: true, message: style.successMessage ?? "Thanks! We'll be in touch." },
      { status: 201, headers: cors },
    )
  } catch (err) {
    if (err instanceof ContactError) {
      return NextResponse.json({ ok: false, reason: err.message }, { status: err.status, headers: cors })
    }
    console.error('[web-forms/submit] error:', err)
    return NextResponse.json({ ok: false, reason: 'server_error' }, { status: 500, headers: cors })
  }
}
