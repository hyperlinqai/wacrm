import { makeAdminClient } from '@/lib/db/server-client'
import type { SupabaseClient } from '@wacrm/shared/db'

// Lazy, shared service-role client (RLS bypass via the service_role DB
// role). Same shape as automations/flows' own admin-client.ts, kept
// feature-local per this codebase's existing convention.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = makeAdminClient()
  }
  return _adminClient
}
