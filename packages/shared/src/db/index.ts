// Type-only barrel for the direct-Postgres data layer — the codemod
// target for every `import type { … } from './index'`.
// Keep this file free of runtime exports: it is imported from both
// server and browser modules.

export type { SupabaseClient, AuthClient, StorageClient, StorageBucketApi } from './client-types';
export type {
  User,
  Session,
  PostgrestError,
  AuthError,
  RealtimeChannel,
  PostgresChangePayload,
  QueryDescriptor,
  QueryResult,
} from './types';
