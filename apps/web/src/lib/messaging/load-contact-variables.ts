import type { SupabaseClient } from '@/lib/db'
import type { ContactVariables } from './variables'

/**
 * Snapshot the variables a contact can supply to message text:
 * the core fields plus every custom field value, keyed by the field's
 * display name (what users type in {{custom.<Field name>}}).
 *
 * Returns null when the contact cannot be read — callers render with
 * an empty contact rather than failing the send.
 */
export async function loadContactVariables(
  db: SupabaseClient,
  contactId: string,
): Promise<ContactVariables | null> {
  const { data: contact } = await db
    .from('contacts')
    .select('name, phone, email, company')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact) return null

  const custom: Record<string, string | null> = {}
  const { data: values } = await db
    .from('contact_custom_values')
    .select('value, custom_fields(field_name)')
    .eq('contact_id', contactId)
  for (const row of (values ?? []) as Array<{
    value: string | null
    custom_fields: { field_name?: string } | { field_name?: string }[] | null
  }>) {
    const cf = Array.isArray(row.custom_fields) ? row.custom_fields[0] : row.custom_fields
    const name = cf?.field_name
    if (name) custom[name] = row.value
  }

  return {
    name: contact.name as string | null,
    phone: contact.phone as string | null,
    email: contact.email as string | null,
    company: contact.company as string | null,
    custom,
  }
}
