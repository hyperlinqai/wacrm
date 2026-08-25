import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/web-forms/admin-client'
import { ensureLeadFormTag, tagBelongsToAccount } from '@/lib/web-forms/segment-tag'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { data: form, error } = await supabaseAdmin()
    .from('lead_forms')
    .select('*')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!form) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ form })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // lead_forms_update requires organization_admin; the service-role
  // client below bypasses RLS, so enforce the role here.
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const { data: existing } = await admin
    .from('lead_forms')
    .select('id')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const update: Record<string, unknown> = {}
  for (const k of ['name', 'status', 'fields', 'style', 'allowed_domains', 'tag_id'] as const) {
    if (k in body) update[k] = (body as Record<string, unknown>)[k]
  }

  if (typeof update.tag_id === 'string') {
    if (!(await tagBelongsToAccount(admin, update.tag_id, ctx.accountId))) {
      return NextResponse.json({ error: 'tag_id is not a tag of this account' }, { status: 400 })
    }
  } else if ('tag_id' in update && update.tag_id !== null) {
    return NextResponse.json({ error: 'tag_id must be a tag id or null' }, { status: 400 })
  }

  if (Array.isArray(update.fields)) {
    const hasPhoneField = (update.fields as unknown[]).some(
      (f) => typeof f === 'object' && f !== null && (f as { type?: string }).type === 'phone',
    )
    if (!hasPhoneField) {
      return NextResponse.json(
        { error: 'A phone-type field is required so submissions can be matched to a contact' },
        { status: 400 },
      )
    }
  }

  if (Object.keys(update).length > 0) {
    const { error } = await admin.from('lead_forms').update(update).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // tag_id: null means "give this form its own new segment tag" — mint
  // it now (named after the form's current name) rather than lazily on
  // the first submission, so the audience is visible immediately.
  if (update.tag_id === null) {
    const { data: fresh } = await admin
      .from('lead_forms')
      .select('id, name, account_id, created_by, tag_id')
      .eq('id', id)
      .single()
    if (fresh) {
      try {
        await ensureLeadFormTag(admin, fresh, (fresh.created_by as string | null) ?? ctx.userId)
      } catch (err) {
        console.error('[web-forms] segment tag creation failed:', err)
      }
    }
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { error } = await supabaseAdmin()
    .from('lead_forms')
    .delete()
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
