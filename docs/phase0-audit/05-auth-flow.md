# Authentication Flow — Current State (Phase 0 Audit)

## Overview

WA-CRM is a Next.js app with a **hand-rolled auth layer** that mimics the `supabase-js` client API surface while running entirely against direct Postgres — no GoTrue, no PostgREST, no Supabase Realtime. The compatibility shim exists so the bulk of the app (written against `supabase.auth.*`, `supabase.from(...)`, RLS policies) didn't need to be rewritten (see `AGENTS.md` framing this as "not the Next.js you know" and the migration comment trail in `supabase/migrations/040_direct_postgres.sql`).

Two client implementations satisfy the same `SupabaseClient` interface (`src/lib/db/client-types.ts`):
- **Server**: `src/lib/supabase/server.ts` → `createClient()` → `src/lib/db/server-client.ts` (`makeServerClient`) — reads the session cookie directly via `next/headers`, executes SQL in-process against Postgres.
- **Browser**: `src/lib/supabase/client.ts` → `src/lib/db/browser-client.ts` (`makeBrowserClient`) — has no direct DB access; every `auth.*` call is a `fetch` to `/api/auth/*`, and every `from()/rpc()` call is POSTed to `/api/db` to run server-side under the caller's RLS context.

Sessions are **stateless HS256 JWTs** stored in an httpOnly cookie — there is no `auth.sessions` table and no server-side session store. "Session revocation" is emulated via a single `auth.users.sessions_revoked_at` timestamp column (added in migration `040_direct_postgres.sql`), checked against the token's `iat` on every authoritative request.

Row-level security (Postgres RLS) is preserved from the original Supabase schema and is the actual multi-tenancy enforcement mechanism today: every query runs inside a transaction where `SET LOCAL role <anon|authenticated|service_role>` and `request.jwt.claims` are set to mirror what PostgREST used to inject, so existing `auth.uid()` / `is_account_member(account_id, role)` policies behave unchanged (`src/lib/db/exec.ts`, `withRls`).

## Signup Flow (step by step)

1. Client: `src/app/(auth)/signup/page.tsx` calls `supabase.auth.signUp({ email, password, options: { data: { full_name } } })` via the browser client.
2. Browser client (`src/lib/db/browser-client.ts`) POSTs `{ email, password, data }` to `/api/auth/signup`.
3. `src/app/api/auth/[action]/route.ts` `POST` handler, `case 'signup'`, calls `signUp()` in `src/lib/db/auth-server.ts`.
4. `signUp()`:
   - Validates password length ≥ 6 and email regex (`AuthApiError` 422/400 on failure).
   - `INSERT INTO auth.users (... encrypted_password = crypt($3, gen_salt('bf')) ...)` — **bcrypt via Postgres `pgcrypto`**, `email_confirmed_at = now()` (auto-confirmed, no SMTP/GoTrue mailer in this deployment).
   - A Postgres trigger `on_auth_user_created` → `public.handle_new_user()` (defined in `supabase/migrations/017_account_sharing.sql`, `SECURITY DEFINER`) fires on the insert: creates a fresh `accounts` row (`owner_user_id = NEW.id`) and a `profiles` row with `account_id` set to that new account and `account_role = 'owner'`. Every new signup becomes the sole owner of a brand-new **personal account**.
   - `issueSession(user)` signs a JWT (see Session mechanics below) and returns `{ user, access_token, expires_at }`.
5. Route handler wraps the session via `sessionResponse()`, sets the `wacrm-session` cookie, and returns `{ data: { user, session: { user, access_token: '', expires_at } }, error: null }` — **the raw token is never sent back in the JSON body**, only in the cookie.
6. Client (`signup/page.tsx`): since signups are always auto-confirmed on this deployment, `data.session` is always present, so it does a full-page `window.location.href` navigation to `/dashboard` (or `/join/<token>` if an invite token was in the query string) rather than a soft client-side route — explicitly to avoid a cookie race with the middleware (`proxy.ts`) on the very next request (documented as issue #365 in the comment).

Duplicate email → `AuthApiError('User already registered', 422, 'user_already_exists')` (mapped from Postgres unique-violation `23505`).

## Login Flow (step by step)

1. Client: `src/app/(auth)/login/page.tsx` calls `supabase.auth.signInWithPassword({ email, password })`.
2. Browser client POSTs to `/api/auth/login`.
3. `src/app/api/auth/[action]/route.ts`, `case 'login'` → `signInWithPassword()` in `src/lib/db/auth-server.ts`:
   ```sql
   SELECT id, email, ..., banned_until,
          (encrypted_password IS NOT NULL AND encrypted_password <> ''
           AND encrypted_password = crypt($2, encrypted_password)) AS password_ok
   FROM auth.users
   WHERE lower(email) = lower($1) AND deleted_at IS NULL
   ```
   Password check is done **in Postgres** via `pgcrypto`'s `crypt()` (bcrypt), not in Node.
   - No row or `password_ok = false` → `AuthApiError('Invalid login credentials', 400, 'invalid_credentials')` — same generic message regardless of whether the email exists, so login doesn't leak account existence.
   - `banned_until` in the future → `AuthApiError('User is banned', 403, 'user_banned')`.
4. On success, `issueSession()` signs a new JWT, cookie is set, response returned identically to signup.
5. Client does a full-page redirect to `/dashboard` or `/join/<token>` (same reasoning as signup).

**Notable gap**: there is no rate limiting on `/api/auth/login` or `/api/auth/signup` — no `checkRateLimit`/`RATE_LIMITS` usage in `src/app/api/auth/`, unlike the invitation endpoints (`src/lib/rate-limit.ts` defines `invitationPeek: 30/min`, `invitationRedeem: 10/min`, `adminAction: 30/min`, `publicApi: 120/min`, but nothing for auth). Login is brute-forceable at whatever rate the DB/Node process can sustain.

## Session / JWT mechanics

All defined in `src/lib/db/jwt.ts` (HS256, WebCrypto, no external JWT library — usable from both Node routes and the Edge-compatible `proxy.ts`):

- **Cookie name**: `SESSION_COOKIE = 'wacrm-session'`.
- **Claims** (`SessionClaims`): `sub` (user id), `email`, `role: 'authenticated'` (fixed constant, mirrors the PostgREST `authenticated` DB role — not the account role), optional `full_name`, plus standard `iat`/`exp`. **No `account_id` or `account_role` claim is ever embedded in the JWT** — account/role context is resolved server-side on every request via a fresh `profiles` table lookup (see Authorization model below).
- **Expiry**: `SESSION_MAX_AGE = 7 * 24 * 3600` (7 days).
- **Sliding renewal**: `SESSION_RENEW_AFTER = 24 * 3600` (1 day). `src/proxy.ts` verifies the token on every matched request and, if `claims.iat` is older than 24h, transparently re-signs a fresh 7-day token and sets it on the response (`response.cookies.set`), copying that cookie onto whatever downstream response is ultimately returned (`withCookies` helper — a fix for a prior bug, referenced as "issue #288").
- **Cookie flags** (`sessionCookieOptions()`): `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`, `maxAge: SESSION_MAX_AGE`. `secure` is conditionally `true` only if `NEXT_PUBLIC_SITE_URL` starts with `https://`, else `false` — the current documented deployment serves over plain HTTP (IP:port), so `secure` is currently off. **This is a real risk if the multi-tenant SaaS is served over HTTP anywhere** (session cookie sent in clear text); should be forced `true` behind TLS in production.
- **Verification is two-tier**:
  - `verifyJwt()` (`src/lib/db/jwt.ts`) — local, no DB round trip, checks HMAC signature + `exp`. Used by `proxy.ts` for cheap route gating (redirect logic only).
  - `getSessionUser()` (`src/lib/db/auth-server.ts`) — the **authoritative** check: calls `verifyJwt()`, then queries `auth.users` for the row, checking `deleted_at IS NULL`, `banned_until`, and critically:
    ```sql
    (sessions_revoked_at IS NOT NULL AND sessions_revoked_at > to_timestamp($2)) AS revoked
    ```
    where `$2` is the token's `iat`. This is what enforces global sign-out. Used by every data-touching path (`/api/auth/user`, `/api/auth/update`, `makeServerClient`'s `resolveUser()`, i.e. every `supabase.from()`/`supabase.rpc()` call on the server).
- The proxy's comment is explicit about this split: *"the authoritative check including global sign-out revocation happens in the data endpoints; here we only gate navigation."* — meaning a revoked token can still pass the proxy's page-redirect gate for a moment (since it only checks signature+exp, not `sessions_revoked_at`) but will be rejected by any real API/data call.

## Password Reset Flow

**Not implemented on this deployment.** Both client shims — `src/lib/db/server-client.ts` (`auth.resetPasswordForEmail`) and `src/lib/db/browser-client.ts` (same method) — unconditionally return:
```
{ data: null, error: { message: 'Password reset emails are not available on this deployment. Ask a workspace owner to set a new password for you.', status: 501 } }
```
`src/app/(auth)/forgot-password/page.tsx` calls this method and will always render the error banner, never the "check your email" success card, in practice. The only real path to recover a lost password is an **owner/admin manually setting a new password for the user** via admin tooling (`updateUser()` in `auth-server.ts` supports setting `password` directly given a `userId`) — there is no self-service token-based reset flow, no email delivery, and no `recovery_token` usage despite the column existing on `auth.users` (legacy Supabase/GoTrue schema column, unused).

## Invitation-based signup flow

Tables/RPCs from `supabase/migrations/017_account_sharing.sql` and `019_invitation_rpcs.sql`:

1. **Creation** (admin+): `POST /api/account/invitations` (`src/app/api/account/invitations/route.ts`) — `requireRole("admin")`, rate-limited 30/min per user (`RATE_LIMITS.adminAction`). Generates a 32-byte random token (`generateInviteToken()` in `src/lib/auth/invitations.ts`), stores only `token_hash = SHA-256(token)` in `account_invitations.token_hash`; the **plaintext token is returned exactly once** in the POST response and embedded in a shareable `/join/<token>` URL. Role is constrained to `admin|agent|viewer` (never `owner`, enforced both client-side and by a DB `CHECK` constraint). Default expiry 7 days, max 365 (`DEFAULT_INVITE_EXPIRY_DAYS`, `MAX_INVITE_EXPIRY_DAYS`).
2. **Peek** (public, unauthenticated): `GET /api/invitations/[token]/peek` — rate-limited 30/min per IP, calls `SECURITY DEFINER` RPC `peek_invitation(token_hash)` which bypasses RLS to answer `{ok:true, account_name, role, expires_at}` or `{ok:false, reason: not_found|used|expired}` for the `/join/<token>` landing page.
3. **Redeem** (authenticated): `POST /api/invitations/[token]/redeem` — rate-limited 10/min per IP, calls `getSessionUser`-backed `supabase.auth.getUser()` first for a fast 401, then RPC `redeem_invitation(token_hash)` (`SECURITY DEFINER`, `supabase/migrations/019_invitation_rpcs.sql`). This RPC:
   - Locks the invite row `FOR UPDATE` (prevents double-redeem race).
   - Validates not-found / already-accepted / expired → SQLSTATE `22023` → HTTP 400.
   - Requires the caller be the **sole owner of their own account** and that account contain **zero domain rows** (contacts, conversations, broadcasts, etc.) — otherwise refuses with `23505` → HTTP 409, message telling them to sign up with a different email. This is a hard safety rail: an existing team member or an account with real data can never silently merge into another account.
   - On success: moves `profiles.account_id`/`account_role` to the invite's account+role, stamps `account_invitations.accepted_at`/`accepted_by_user_id`, and **deletes the caller's now-orphaned personal account**.
4. UI: `signup/page.tsx` and `login/page.tsx` both carry an `?invite=<token>` query param through to `emailRedirectTo`/post-auth destination, sending the user to `/join/<token>` instead of `/dashboard` after auth succeeds; `src/proxy.ts` also intercepts `/login`, `/signup`, `/forgot-password` for an already-authenticated user with an `invite` query param and redirects straight to `/join/<token>`.

**Important structural constraint for multi-tenancy**: this whole flow assumes **one account membership per user** — `profiles` has a single `account_id`/`account_role` column (not a many-to-many memberships table), and `accounts` enforces `UNIQUE(owner_user_id)` (`idx_accounts_one_per_owner`). A user cannot belong to two accounts simultaneously; joining a second account requires abandoning/deleting the first (empty) one. Any SaaS design that wants "one user, many workspaces" (org switcher) will need a `profiles`/`account_id` → `account_members` (many-to-many) refactor, plus rewriting `is_account_member()` and every RLS policy built on it.

## Authorization model (account_id / role scoping per request)

Two parallel authorization paths exist:

### A. Cookie-session (dashboard) requests
`src/lib/auth/account.ts`:
- `getCurrentAccount()` — calls `createClient()` (the RLS-scoped server Supabase shim), `supabase.auth.getUser()` (→ `getSessionUser`, the authoritative revocation-checked lookup), then does a **separate DB round trip** `SELECT account_id, account_role FROM profiles WHERE user_id = $1`, then a second lookup `SELECT id, name FROM accounts WHERE id = $1`. Throws `UnauthorizedError` (401) if no session, `ForbiddenError` (403) if the profile has no `account_id`/`account_role` (defensive — should be impossible post-migration-017) or the account row can't be read.
- `requireRole(min: AccountRole)` — wraps `getCurrentAccount()` and additionally checks `hasMinRole(ctx.role, min)` (`src/lib/auth/roles.ts`), throwing `ForbiddenError` if the caller's role is below the minimum.
- Every account-scoped API route (e.g. `src/app/api/account/invitations/route.ts`) does `const ctx = await requireRole("admin")` then explicitly filters every query by `.eq("account_id", ctx.accountId)` — **the app layer trusts and re-applies `accountId` scoping**, but the underlying Postgres RLS policies (`is_account_member(account_id, role)`, from migration `017_account_sharing.sql`) are the actual enforcement backstop: even if a route forgot the `.eq()`, RLS would still block cross-account rows because the query executes with `SET LOCAL role authenticated` and `request.jwt.claims = {sub: userId, ...}`, and every policy calls `auth.uid()` (reads `request.jwt.claims->>'sub'`) → `is_account_member()`.
- Role hierarchy (`src/lib/auth/roles.ts`): `owner(4) > admin(3) > agent(2) > viewer(1)`, mirrored exactly in the SQL `is_account_member` CASE expression so TS and RLS never drift. Capability predicates (`canManageMembers`, `canEditSettings`, `canSendMessages`, `canViewOnly`, `canDeleteAccount`, `canTransferOwnership`) are the single source of truth used by both server route guards and the client `<RequireRole min="...">` component (`src/components/auth/require-role.tsx`) and `useAuth()` hook (`src/hooks/use-auth.tsx`).
- Client-side, `src/hooks/use-auth.tsx` (`AuthProvider`) independently fetches the `profiles` row (and then the `accounts` row) after session resolution to populate `accountId`/`accountRole`/derived `isOwner`/`isAdmin`/etc. and an `accountStatus` state machine (`loading|ready|unlinked|error`) purely for UI gating — **this is advisory only**; the server-side RLS + `requireRole()` checks are what actually protect data.

### B. Public API-key requests (`/api/v1/*`)
`src/lib/auth/api-context.ts`:
- `requireApiKey(request, scope?)` extracts `Authorization: Bearer wacrm_live_…`, hashes it, looks up `findActiveKeyByHash()` (unknown/revoked/expired keys are all indistinguishable → generic 401, preventing key-existence probing), rate-limits per key (`RATE_LIMITS.publicApi`, 120/min) **before** the scope check, then optionally enforces a single `ApiScope`.
- Returns an `ApiKeyContext` with `accountId: row.account_id` fixed at key-lookup time and a **service-role Supabase client** (`supabaseAdmin()` — RLS-bypassing). Because there is no Supabase session/`auth.uid()` for an API-key caller, **every downstream query in a `/api/v1/*` route must manually filter by `ctx.accountId`** — RLS provides no backstop here since the service-role connection bypasses it (`service_role NOLOGIN BYPASSRLS` in `supabase/postgres-compat/000_bootstrap.sql`). This is a materially different (and weaker, defense-in-depth-wise) trust model than the cookie-session path — a route that forgets an `accountId` filter on this path has no RLS to catch the mistake. Worth flagging for the SaaS conversion: audit every `/api/v1/*` route for a missing `.eq('account_id', ctx.accountId)`.
- Example: `src/app/api/v1/me/route.ts` — no scope required, just returns `{ account: {id, name}, key: {id, scopes} }`.

## RLS mechanics underpinning both paths

- `supabase/postgres-compat/000_bootstrap.sql` defines Postgres roles `anon`, `authenticated`, `service_role` (`BYPASSRLS`) and recreates `auth.uid()`/`auth.role()` as SQL functions reading `current_setting('request.jwt.claims', true)::jsonb`, exactly replicating PostgREST/GoTrue semantics on stock Postgres.
- `src/lib/db/exec.ts`'s `withRls(ctx, fn)` wraps every query in `BEGIN; SET LOCAL role <role>; SELECT set_config('request.jwt.claims', '<json>', true); ...; COMMIT`, where `ctx` is either `ANON_CONTEXT`, `SERVICE_CONTEXT`, or `userContext(userId, email)` (built from the verified session). This is what makes the pre-existing Supabase RLS policies (`is_account_member(account_id, min_role)` from `017_account_sharing.sql`, applied across contacts/conversations/deals/broadcasts/automations/flows/etc.) continue to function as the tenant-isolation boundary post-migration.

## Logout / global sign-out

- **Local** (`scope: 'local'` or default): `POST /api/auth/logout` with no/local scope body just clears the cookie (`res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 })`). The JWT itself is **not** invalidated server-side — if the token were captured/replayed before this, it would remain valid until `exp` (7 days out, or up to 8 with sliding renewal at the edge) since local logout doesn't touch `sessions_revoked_at`.
- **Global** (`scope: 'global'`, exposed as "Sign out everywhere" in `src/components/settings/sessions-card.tsx` and reached via `supabase.auth.signOut({ scope: 'global' })`): route handler resolves the current session, then calls `revokeAllSessions(userId)`:
  ```sql
  UPDATE auth.users SET sessions_revoked_at = now(), updated_at = now() WHERE id = $1
  ```
  Every subsequently-checked token for that user (any device/tab) fails `getSessionUser()`'s `revoked` check (`sessions_revoked_at > to_timestamp(claims.iat)`) and is treated as signed out. Because there's no session table, this is an **all-or-nothing** kill switch — there is no way to revoke a single device/session while leaving others active (no per-session id in the JWT, no `auth.sessions` row to target individually). Note also the earlier caveat: `proxy.ts`'s page-gating check (`verifyJwt` only) does **not** consult `sessions_revoked_at`, so a globally-signed-out user could still be waved past route-level redirects for one more navigation until they hit an actual data call that runs `getSessionUser()`.

## Multi-tenancy notes (relevant to the SaaS conversion)

1. **Auth is already account-scoped at the data layer** — RLS policies keyed off `is_account_member(account_id, role)` are the real isolation boundary today, and they're driven by a per-request Postgres session variable (`request.jwt.claims`), not baked into the JWT. This is actually a decent foundation to build on for multi-tenant SaaS, since account resolution is already dynamic (a DB lookup per request) rather than cached in a long-lived token.
2. **One-account-per-user is hard-coded** in three places: `accounts.owner_user_id UNIQUE` index, `profiles.account_id`/`account_role` as single scalar columns (not a memberships table), and the `redeem_invitation` RPC's "must be sole owner of an empty personal account" guard. Any SaaS feature like "belong to multiple workspaces" / org switcher requires a genuine schema migration (memberships table) plus a rewrite of `is_account_member()`, `getCurrentAccount()`, and the client `useAuth()` profile-fetch logic — this is probably the single biggest structural blocker to multi-tenant SaaS, more than the auth mechanism itself.
3. **JWT carries no account_id** — good for multi-tenancy flexibility (switching workspace doesn't require re-issuing a token with different claims, since account is resolved fresh each request via `profiles`), but it also means **every single request pays a `profiles` + `accounts` round trip** (`getCurrentAccount()`) — a caching/perf concern at SaaS scale, not a leakage risk per se.
4. **Public API key path bypasses RLS entirely** (`service_role` + `supabaseAdmin()`), relying solely on hand-written `accountId` filters in each `/api/v1/*` route. This is the highest cross-tenant-leakage risk surface in the codebase — a single forgotten `.eq('account_id', ...)` in a new v1 route would leak data across tenants with no RLS backstop, unlike every cookie-session route.
5. **No brute-force protection on `/api/auth/login`/`signup`** — should be rate-limited before going multi-tenant/public, both to protect individual tenants' user accounts and to avoid one tenant's traffic/abuse pattern degrading the shared auth endpoint for all tenants.
6. **Cookie `secure` flag is conditional on `NEXT_PUBLIC_SITE_URL` starting with `https://`**, currently `false` in the documented deployment (plain HTTP). Must be forced true (and `sameSite` possibly reconsidered) for any multi-tenant production deployment.
7. **Password reset is non-functional** (always 501) — needs a real transactional-email-backed flow before onboarding self-serve SaaS customers, since "ask a workspace owner to reset your password" doesn't scale past single-tenant/internal usage and is a support burden per tenant.
8. **Global sign-out is per-user, not per-account** — there's no "revoke all sessions for everyone in this tenant" primitive (e.g. for a compromised-tenant incident response), which a SaaS operator will likely want; would need either an account-level revocation timestamp checked alongside `auth.users.sessions_revoked_at`, or an `account_id` claim + comparison against `accounts.sessions_revoked_at`.
9. **Session revocation check is split** between cheap edge-only signature verification (`proxy.ts`, no revocation check) and authoritative DB-backed verification (`getSessionUser()`, used on all real data paths) — worth confirming this split is intentional and acceptable post-SaaS-conversion, since a small window exists where a revoked/kicked-out tenant user can still navigate (but not read/write data) until the next `getSessionUser()` call.
