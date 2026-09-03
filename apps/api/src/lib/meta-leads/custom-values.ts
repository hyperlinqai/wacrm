import type { SupabaseClient } from '@wacrm/shared/db'

// Write Lead Ads answers onto the contact's custom fields — fill-blanks
// only, so a value an agent typed by hand is never overwritten by a
// later duplicate lead. Field names are matched case-insensitively
// against the account's custom_fields; names with no field are skipped
// (an admin creates the field, and the next lead fills it).

export interface CustomFieldRow {
  id: string
  field_name: string
}

export async function loadAccountCustomFields(
  admin: SupabaseClient,
  accountId: string,
): Promise<CustomFieldRow[]> {
  const { data } = await admin
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId)
  return (data ?? []) as CustomFieldRow[]
}

/**
 * Upsert `values` (custom field display name → value) for one contact.
 * Returns the number of fields written. Existing non-empty values win.
 */
export async function writeContactCustomValues(
  admin: SupabaseClient,
  contactId: string,
  fields: CustomFieldRow[],
  values: Record<string, string>,
): Promise<number> {
  const byName = new Map(fields.map((f) => [f.field_name.trim().toLowerCase(), f]))
  const targets: { custom_field_id: string; value: string }[] = []
  for (const [name, value] of Object.entries(values)) {
    const field = byName.get(name.trim().toLowerCase())
    const v = value?.trim()
    if (!field || !v) continue
    targets.push({ custom_field_id: field.id, value: v })
  }
  if (targets.length === 0) return 0

  const { data: existing } = await admin
    .from('contact_custom_values')
    .select('custom_field_id, value')
    .eq('contact_id', contactId)
    .in(
      'custom_field_id',
      targets.map((t) => t.custom_field_id),
    )
  const filled = new Set(
    ((existing ?? []) as { custom_field_id: string; value: string | null }[])
      .filter((r) => (r.value ?? '').trim() !== '')
      .map((r) => r.custom_field_id),
  )

  const rows = targets
    .filter((t) => !filled.has(t.custom_field_id))
    .map((t) => ({ contact_id: contactId, custom_field_id: t.custom_field_id, value: t.value }))
  if (rows.length === 0) return 0

  const { error } = await admin
    .from('contact_custom_values')
    .upsert(rows, { onConflict: 'contact_id,custom_field_id' })
  if (error) throw new Error(`custom values write failed: ${error.message}`)
  return rows.length
}
