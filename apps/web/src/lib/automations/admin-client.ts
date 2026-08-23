import { makeAdminClient } from '@/lib/db/server-client'
import type { SupabaseClient } from '@/lib/db'

// Lazy, shared service-role client (RLS bypass via the service_role DB
// role). Same shape across ai/, automations/ and flows/ so anyone reading
// one file picks up the convention immediately.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = makeAdminClient()
  }
  return _adminClient
}
