'use client';

import { makeBrowserClient } from '@/lib/db/browser-client';
import type { SupabaseClient } from '@wacrm/shared/db';

// Browser data client — direct-Postgres adapter (queries run server-side
// under RLS via /api/db; auth, storage and realtime ride app routes).
// Singleton so auth listeners and channels share one instance, as before.
let browserClient: SupabaseClient | undefined;

export function createClient(): SupabaseClient {
  if (browserClient) return browserClient;
  browserClient = makeBrowserClient();
  return browserClient;
}
