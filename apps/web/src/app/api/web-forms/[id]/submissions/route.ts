import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const PAGE_SIZE = 50

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const page = Math.max(0, Number(new URL(request.url).searchParams.get('page') ?? '0') || 0)
  const from = page * PAGE_SIZE
  const to = from + PAGE_SIZE - 1

  // RLS-scoped client — lead_form_submissions_select allows any
  // organization member, and lead_form_id further narrows to this form.
  const { data, error } = await supabase
    .from('lead_form_submissions')
    .select('id, contact_id, payload, referrer, created_at')
    .eq('lead_form_id', id)
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ submissions: data ?? [], page })
}
