// ============================================================
// Meta Lead Ads — one lead in, one contact out.
//
// Shared by the webhook route (push) and the Sync route (pull) so a
// lead is interpreted identically however it arrived. Idempotent on
// Meta's leadgen id: the meta_leads row is inserted FIRST and a unique
// violation short-circuits, so a webhook retry or an overlapping Sync
// never double-creates a contact or double-fires automations.
//
// Failure posture: a lead that can't become a contact (no phone, or a
// phone that isn't a real number) is still recorded in meta_leads with
// a status the settings UI surfaces — an advertiser must be able to
// see "3 leads had no usable phone" rather than wondering where they
// went. Only a DB error propagates.
// ============================================================

import type { SupabaseClient } from '@wacrm/shared/db'
import { isUniqueViolation } from '@wacrm/shared/contacts/dedupe'
import { cleanPhone } from '@wacrm/shared/whatsapp/phone-clean'
import { extractLeadFields, mapLeadAnswersToCustomFields } from '@wacrm/shared/meta/lead-fields'
import type { MetaLead } from '@wacrm/shared/meta/lead-ads-api'

import { findOrCreateContact, resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import { ensureMetaPageTag } from './segment-tag'
import { loadAccountCustomFields, writeContactCustomValues } from './custom-values'

export interface MetaLeadPageRow {
  id: string
  organization_id: string
  account_id: string
  page_id: string
  page_name: string
  status: string
  tag_id: string | null
  connected_by: string | null
}

export interface ProcessLeadInput {
  admin: SupabaseClient
  page: MetaLeadPageRow
  lead: MetaLead
  receivedVia: 'webhook' | 'sync'
  /** Form name if the caller already looked it up (Sync does). */
  formName?: string | null
}

export type ProcessLeadOutcome =
  | { kind: 'created' | 'matched'; contactId: string; leadRowId: string }
  | { kind: 'duplicate' }
  | { kind: 'no_phone' | 'invalid_phone' | 'failed'; leadRowId: string | null; reason: string }

export async function processMetaLead(input: ProcessLeadInput): Promise<ProcessLeadOutcome> {
  const { admin, page, lead, receivedVia } = input
  const fields = extractLeadFields(lead.field_data)

  const baseRow = {
    page_row_id: page.id,
    organization_id: page.organization_id,
    leadgen_id: String(lead.id),
    form_id: lead.form_id ?? null,
    form_name: input.formName ?? null,
    ad_id: lead.ad_id ?? null,
    ad_name: lead.ad_name ?? null,
    adset_id: lead.adset_id ?? null,
    adset_name: lead.adset_name ?? null,
    campaign_id: lead.campaign_id ?? null,
    campaign_name: lead.campaign_name ?? null,
    platform: lead.platform ?? null,
    is_organic: typeof lead.is_organic === 'boolean' ? lead.is_organic : null,
    field_data: lead.field_data ?? [],
    full_name: fields.name,
    phone: fields.phone,
    email: fields.email,
    received_via: receivedVia,
    lead_created_at: lead.created_time ?? null,
  }

  // Claim the leadgen id before any side effects. status is patched
  // below once we know the outcome.
  const { data: leadRow, error: insertErr } = await admin
    .from('meta_leads')
    .insert({ ...baseRow, status: 'processed' })
    .select('id')
    .single()

  if (insertErr || !leadRow) {
    if (isUniqueViolation(insertErr)) return { kind: 'duplicate' }
    throw new Error(`meta_leads insert failed: ${insertErr?.message ?? 'no row'}`)
  }
  const leadRowId = leadRow.id as string

  const fail = async (status: 'no_phone' | 'invalid_phone' | 'failed', reason: string): Promise<ProcessLeadOutcome> => {
    await admin.from('meta_leads').update({ status, error: reason }).eq('id', leadRowId)
    await admin.rpc('increment_meta_lead_page_count', {
      p_page_row_id: page.id,
      p_lead_at: lead.created_time ?? new Date().toISOString(),
    })
    return { kind: status, leadRowId, reason }
  }

  if (!fields.phone) {
    return fail('no_phone', 'Lead form has no phone question, or the person left it blank')
  }

  // Lead Ads pre-fills phone numbers in E.164 from the person's profile,
  // but a custom "your number" question can be typed as a bare national
  // number — resolve it with the account's default country like a CSV
  // import would, rather than rejecting or (worse) guessing.
  const { data: account } = await admin
    .from('accounts')
    .select('default_country_code')
    .eq('id', page.account_id)
    .maybeSingle()
  const cleaned = cleanPhone(fields.phone, {
    defaultCountry: (account?.default_country_code as string | null | undefined) ?? null,
  })
  if (!cleaned.ok || !cleaned.e164) {
    return fail('invalid_phone', `Phone "${fields.phone}" could not be resolved (${cleaned.rejection ?? 'invalid'})`)
  }

  try {
    const auditUserId = await resolveAuditUserId(admin, page.organization_id, page.account_id)
    const { id: contactId, created } = await findOrCreateContact(admin, page.account_id, auditUserId, {
      phone: cleaned.e164,
      name: fields.name,
      email: fields.email,
      company: fields.company,
      source: 'meta_ads',
    })

    // Enrich a matched contact only where it's blank — never overwrite
    // what an agent already typed. First-touch source attribution.
    if (!created) {
      const { data: existing } = await admin
        .from('contacts')
        .select('name, email, company, phone, source')
        .eq('id', contactId)
        .maybeSingle()
      if (existing) {
        const patch: Record<string, unknown> = {}
        const nameIsPlaceholder = !existing.name || existing.name === existing.phone
        if (fields.name && nameIsPlaceholder) patch.name = fields.name
        if (fields.email && !existing.email) patch.email = fields.email
        if (fields.company && !existing.company) patch.company = fields.company
        if (existing.source === 'manual') patch.source = 'meta_ads'
        if (Object.keys(patch).length > 0) {
          await admin.from('contacts').update(patch).eq('id', contactId)
        }
      }
    }

    await admin.from('meta_leads').update({ contact_id: contactId }).eq('id', leadRowId)

    // Qualifying answers + campaign attribution → custom fields, so
    // they show on the contact, filter on the Contacts page, and feed
    // message variables ({{custom.Sports interested in}}). Fill-blanks
    // only; a failure here must not lose the lead — log and continue.
    try {
      const customFields = await loadAccountCustomFields(admin, page.account_id)
      if (customFields.length > 0) {
        const values: Record<string, string> = {}
        for (const m of mapLeadAnswersToCustomFields(fields.answers, customFields.map((f) => f.field_name))) {
          values[m.fieldName] = m.value
        }
        if (lead.campaign_name) values['Campaign name'] = lead.campaign_name
        values['Lead source'] = leadSourceLabel(lead.platform)
        await writeContactCustomValues(admin, contactId, customFields, values)
      }
    } catch (err) {
      console.error(`[meta-leads] custom field enrichment failed for lead ${lead.id}:`, err)
    }

    await admin.rpc('increment_meta_lead_page_count', {
      p_page_row_id: page.id,
      p_lead_at: lead.created_time ?? new Date().toISOString(),
    })

    // Segment tag → tag_added automations (auto-reply / drip to fresh
    // ad leads). A tagging failure must not turn a captured lead into
    // a failed one — log and continue.
    try {
      const tagId = await ensureMetaPageTag(admin, page, page.connected_by ?? auditUserId)
      await addContactTagAndDispatch({
        db: admin,
        accountId: page.account_id,
        contactId,
        tagId,
        context: {
          vars: {
            meta_page_id: page.page_id,
            meta_page_name: page.page_name,
            meta_form_id: lead.form_id ?? '',
            meta_campaign_name: lead.campaign_name ?? '',
            meta_ad_name: lead.ad_name ?? '',
          },
        },
      })
    } catch (err) {
      console.error(`[meta-leads] segment tagging failed for page ${page.page_id}:`, err)
    }

    return { kind: created ? 'created' : 'matched', contactId, leadRowId }
  } catch (err) {
    const reason = err instanceof ContactError ? err.message : err instanceof Error ? err.message : 'unknown error'
    console.error(`[meta-leads] contact create failed for lead ${lead.id}:`, err)
    return fail('failed', reason)
  }
}

/** "Lead source" custom-field value for a Meta lead, by platform. */
export function leadSourceLabel(platform: string | null | undefined): string {
  const p = (platform ?? '').toLowerCase()
  if (p === 'ig' || p === 'instagram') return 'Instagram Lead Ad'
  if (p === 'fb' || p === 'facebook') return 'Facebook Lead Ad'
  return 'Meta Lead Ad'
}
