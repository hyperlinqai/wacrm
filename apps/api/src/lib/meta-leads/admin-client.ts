import { makeAdminClient } from '@/lib/db/server-client'
import type { SupabaseClient } from '@wacrm/shared/db'

// Lazy, shared service-role client (RLS bypass). Feature-local per the
// codebase convention (web-forms/automations/flows each carry one).
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = makeAdminClient()
  }
  return _adminClient
}
