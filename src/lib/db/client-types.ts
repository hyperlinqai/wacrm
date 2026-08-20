// The client interface the whole app is typed against — a drop-in for
// the subset of @supabase/supabase-js it used. Row data is `any` by
// design: the app was written against an untyped Supabase client and
// annotates results at the call sites.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { QueryBuilder } from './query-builder';
import type {
  AuthError,
  AuthResult,
  RealtimeChannel,
  Session,
  User,
} from './types';

export interface AuthClient {
  getUser(): Promise<{ data: { user: User | null }; error: AuthError | null }>;
  getSession(): Promise<{ data: { session: Session | null }; error: AuthError | null }>;
  signInWithPassword(credentials: { email: string; password: string }): Promise<AuthResult>;
  signUp(credentials: {
    email: string;
    password: string;
    options?: { data?: Record<string, unknown>; emailRedirectTo?: string };
  }): Promise<AuthResult>;
  signOut(options?: { scope?: 'global' | 'local' | 'others' }): Promise<{ error: AuthError | null }>;
  updateUser(attrs: {
    password?: string;
    email?: string;
    data?: Record<string, unknown>;
  }): Promise<{ data: { user: User | null }; error: AuthError | null }>;
  resetPasswordForEmail(
    email: string,
    options?: { redirectTo?: string },
  ): Promise<{ data: object | null; error: AuthError | null }>;
  onAuthStateChange(
    callback: (event: string, session: Session | null) => void,
  ): { data: { subscription: { unsubscribe: () => void } } };
}

export interface StorageBucketApi {
  upload(
    path: string,
    body: Blob | ArrayBuffer | Uint8Array | Buffer | File,
    opts?: { contentType?: string; upsert?: boolean; cacheControl?: string },
  ): Promise<{ data: { path: string } | null; error: { message: string; statusCode?: string } | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
  remove(
    paths: string[],
  ): Promise<{ data: { name: string }[] | null; error: { message: string; statusCode?: string } | null }>;
}

export interface StorageClient {
  from(bucket: string): StorageBucketApi;
}

export interface SupabaseClient {
  from(table: string): QueryBuilder<any, any[]>;
  rpc(fn: string, args?: Record<string, unknown>): QueryBuilder<any, any>;
  auth: AuthClient;
  storage: StorageClient;
  channel(name: string): RealtimeChannel;
  removeChannel(channel: RealtimeChannel): Promise<'ok' | 'error'>;
}
