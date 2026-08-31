import type { SupabaseClient } from '@wacrm/shared/db'

// Every lead form owns a "segment" tag (lead_forms.tag_id, migration
// 047) that is applied to each submitting contact, so a form's leads
// are immediately targetable as a broadcast audience. This module is
// the single place that knows how that tag is created and applied;
// the form CRUD routes and the public submit route both go through it.

export const SEGMENT_TAG_COLOR = '#0ea5e9'

interface FormForTag {
  id: string
  name: string
  account_id: string
  created_by?: string | null
  tag_id?: string | null
}

/**
 * Return the form's segment tag id, creating a tag named after the
 * form (and persisting it on the form) when none is set yet. Runs with
 * the service-role client — callers have already authorized the write.
 */
export async function ensureLeadFormTag(
  admin: SupabaseClient,
  form: FormForTag,
  ownerUserId: string,
): Promise<string> {
  if (form.tag_id) return form.tag_id

  const { data: tag, error: tagErr } = await admin
    .from('tags')
    .insert({
      user_id: ownerUserId,
      account_id: form.account_id,
      name: form.name,
      color: SEGMENT_TAG_COLOR,
    })
    .select('id')
    .single()
  if (tagErr || !tag) {
    throw new Error(`Could not create segment tag: ${tagErr?.message ?? 'insert failed'}`)
  }

  const { error: linkErr } = await admin
    .from('lead_forms')
    .update({ tag_id: tag.id })
    .eq('id', form.id)
  if (linkErr) throw new Error(`Could not link segment tag: ${linkErr.message}`)

  return tag.id as string
}

/**
 * True when `tagId` is a tag of `accountId` — used to validate an
 * operator-picked segment tag before storing it on a form.
 */
export async function tagBelongsToAccount(
  admin: SupabaseClient,
  tagId: string,
  accountId: string,
): Promise<boolean> {
  const { data } = await admin
    .from('tags')
    .select('id')
    .eq('id', tagId)
    .eq('account_id', accountId)
    .maybeSingle()
  return !!data
}
