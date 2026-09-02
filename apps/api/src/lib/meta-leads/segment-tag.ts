import type { SupabaseClient } from '@wacrm/shared/db'

// Every connected Page owns a "segment" tag (meta_lead_pages.tag_id,
// migration 052) applied to each contact its Lead Ads produce, so
// "everyone who came from our Facebook ads" is immediately a broadcast
// audience and a tag_added automation trigger. Same shape as
// web-forms/segment-tag.ts, kept separate because the row/table differ.

export const META_SEGMENT_TAG_COLOR = '#1877f2' // Meta blue

interface PageForTag {
  id: string
  page_name: string
  account_id: string
  tag_id?: string | null
}

/**
 * Return the Page's segment tag id, creating one named after the Page
 * (and persisting it on the row) when none is set yet.
 */
export async function ensureMetaPageTag(
  admin: SupabaseClient,
  page: PageForTag,
  ownerUserId: string,
): Promise<string> {
  if (page.tag_id) return page.tag_id

  const { data: tag, error: tagErr } = await admin
    .from('tags')
    .insert({
      user_id: ownerUserId,
      account_id: page.account_id,
      name: `Meta Ads · ${page.page_name}`,
      color: META_SEGMENT_TAG_COLOR,
    })
    .select('id')
    .single()
  if (tagErr || !tag) {
    throw new Error(`Could not create segment tag: ${tagErr?.message ?? 'insert failed'}`)
  }

  const { error: linkErr } = await admin
    .from('meta_lead_pages')
    .update({ tag_id: tag.id })
    .eq('id', page.id)
  if (linkErr) throw new Error(`Could not link segment tag: ${linkErr.message}`)

  return tag.id as string
}
