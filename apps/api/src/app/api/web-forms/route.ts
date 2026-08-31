import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/web-forms/admin-client'
import { ensureLeadFormTag, tagBelongsToAccount } from '@/lib/web-forms/segment-tag'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // RLS-scoped client — lead_forms_select allows any organization member,
  // so this naturally returns only the caller's own organization's forms.
  const { data, error } = await supabase
    .from('lead_forms')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ forms: data ?? [] })
}

export async function POST(request: Request) {
  // Creating a form is a write — lead_forms_insert requires
  // organization_admin, but this route inserts via the service-role
  // client which bypasses RLS, so the role must be enforced here.
  // requireRole checks the legacy AccountRole ('admin'), which maps 1:1
  // onto organization_admin via account_role_to_organization_role
  // (migration 042) — every route in this codebase still gates on the
  // account-role helper, RLS is what moved to the organization layer.
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

  const { name, fields, style, allowed_domains, tag_id } = body as {
    name?: string
    fields?: unknown[]
    style?: Record<string, unknown>
    allowed_domains?: string[] | null
    /** Segment tag to apply to submitters; omitted/null = create one
     *  named after the form. */
    tag_id?: string | null
  }

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    return NextResponse.json({ error: 'At least one field is required' }, { status: 400 })
  }
  const hasPhoneField = fields.some(
    (f) => typeof f === 'object' && f !== null && (f as { type?: string }).type === 'phone',
  )
  if (!hasPhoneField) {
    return NextResponse.json(
      { error: 'A phone-type field is required so submissions can be matched to a contact' },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()

  if (tag_id && !(await tagBelongsToAccount(admin, tag_id, ctx.accountId))) {
    return NextResponse.json({ error: 'tag_id is not a tag of this account' }, { status: 400 })
  }

  const { data: form, error } = await admin
    .from('lead_forms')
    .insert({
      account_id: ctx.accountId,
      created_by: ctx.userId,
      name,
      fields,
      style: style ?? {},
      allowed_domains: allowed_domains ?? null,
      status: 'active',
      tag_id: tag_id ?? null,
    })
    .select()
    .single()

  if (error || !form) {
    return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 })
  }

  // No tag picked → create the form's own segment tag now, so the
  // audience exists (and is visible in Tags) before the first lead.
  try {
    form.tag_id = await ensureLeadFormTag(admin, form, ctx.userId)
  } catch (err) {
    console.error('[web-forms] segment tag creation failed:', err)
  }
  return NextResponse.json({ form }, { status: 201 })
}
