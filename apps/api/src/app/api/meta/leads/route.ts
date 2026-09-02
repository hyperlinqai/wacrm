// ============================================================
// GET /api/meta/leads?page=<page_row_id>&limit=50
//
// Recent Lead Ads leads for the caller's organization, newest first,
// with the resolved contact's name/phone embedded so the settings panel
// can link straight to it. RLS-scoped (meta_leads_select: any member).
// ============================================================

import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'

const MAX_LIMIT = 200

export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const pageRowId = searchParams.get('page')
  const rawLimit = Number(searchParams.get('limit') ?? 50)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT) : 50

  let query = supabase
    .from('meta_leads')
    .select(
      'id, page_row_id, contact_id, leadgen_id, form_id, form_name, ad_name, adset_name, campaign_name, platform, is_organic, full_name, phone, email, status, error, received_via, lead_created_at, created_at, field_data, contacts(id, name, phone)',
    )
    .order('created_at', { ascending: false })
    .limit(limit)
  if (pageRowId) query = query.eq('page_row_id', pageRowId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ leads: data ?? [] })
}
