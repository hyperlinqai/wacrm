import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/web-forms/admin-client'
import { ensureLeadFormTag } from '@/lib/web-forms/segment-tag'

export async function POST(
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

  const admin = supabaseAdmin()
  const { data: original, error: origErr } = await admin
    .from('lead_forms')
    .select('*')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()
  if (origErr) return NextResponse.json({ error: origErr.message }, { status: 500 })
  if (!original) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: copy, error: copyErr } = await admin
    .from('lead_forms')
    .insert({
      account_id: original.account_id,
      created_by: ctx.userId,
      name: `${original.name} (Copy)`,
      fields: original.fields,
      style: original.style,
      allowed_domains: original.allowed_domains,
      // Deliberately paused, not copied from the original's status — a
      // duplicate should never start silently accepting real leads
      // before someone reviews it.
      status: 'paused',
      // The copy gets its own segment (created below), not the
      // original's — otherwise both forms' leads would pool into one
      // audience and the duplicate couldn't be targeted separately.
      tag_id: null,
    })
    .select()
    .single()

  if (copyErr || !copy) {
    return NextResponse.json({ error: copyErr?.message ?? 'copy failed' }, { status: 500 })
  }
  try {
    copy.tag_id = await ensureLeadFormTag(admin, copy, ctx.userId)
  } catch (err) {
    console.error('[web-forms] segment tag creation failed for copy:', err)
  }
  return NextResponse.json({ form: copy }, { status: 201 })
}
