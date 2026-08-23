# Phase 3 — Multi-Tenant Authorization and RLS

## What this phase delivers

The actual "Organization A cannot access Organization B" guarantee. Phase 2
made `organization_id` present and correct on every tenant table; Phase 3 is
what makes the database *enforce* tenant boundaries by it, and hardens the two
places the application resolves "who is the caller" so a request can never
proceed without a verified organization membership.

## Database

- **`supabase/migrations/044_organization_rls.sql`** — rewrites every
  `is_account_member(account_id, role)` RLS policy (and parent-join
  equivalent) to `is_organization_member(organization_id, role)`, across the
  24 tables with a direct `organization_id` column plus the 9 child tables
  scoped via a parent join. 93 policies rewritten. `accounts`/`profiles`/
  `account_invitations` (identity layer) and `notifications` (already
  identity-based) are untouched by design — see the migration's header
  comment for the full reasoning.
- **`supabase/migrations/045_organization_rpcs.sql`** — the 2 SECURITY
  DEFINER functions that bypass RLS and filter by an explicit parameter
  (`match_ai_knowledge_fts`, `match_ai_knowledge_semantic`) now take
  `p_organization_id`. A third candidate, `create_broadcast_with_recipients`,
  was audited and deliberately left alone — it only ever writes using
  `p_account_id`, and Phase 2's trigger already derives `organization_id`
  from that automatically; there was nothing to fix.
- **`supabase/ci/verify-tenant-isolation.sql`** — new, wired into
  `.github/workflows/migrations.yml` right after `verify-schema.sql`. Seeds
  two real, independent organizations and proves, under the real
  `authenticated` role: zero cross-tenant `SELECT` visibility across 10+
  tables, and zero-row cross-tenant `UPDATE`/`DELETE`. Verified twice locally
  — once as a positive control (passes against the real migrations) and once
  as a negative control (temporarily weakened a policy to `USING (true)` and
  confirmed the test catches it and fails loudly).

## An assumption that turned out to matter, verified before anything else

The whole design depends on Postgres evaluating `INSERT ... WITH CHECK` RLS
policies *after* `BEFORE ROW` triggers run — i.e., that Phase 2's
auto-populate trigger fills `organization_id` in time for an
organization_id-only RLS policy to see it. This is documented Postgres
behavior, but Phase 2 never actually exercised it (its tests ran as
superuser, `BYPASSRLS`). Verified empirically first, under the real
`authenticated` role, before writing the 044 migration: an INSERT supplying
only `account_id` correctly gets `organization_id` populated by the trigger
and passes an organization_id-only `WITH CHECK` policy; a genuine
cross-tenant attempt (organization_id resolving to a different org than the
caller's own) is correctly rejected.

## Application — two chokepoints hardened

- **`src/lib/auth/account.ts`** (`getCurrentAccount`/`requireRole`, the
  cookie-session chokepoint, ~39 callers) — `organizationId`/`organizationRole`
  went from best-effort/nullable (Phase 2) to required: an unresolvable
  membership now throws `ForbiddenError`, the same treatment an unresolvable
  `account_id`/`account_role` already got.
- **`src/lib/auth/api-context.ts`** (`requireApiKey`, the public API
  chokepoint) — same hardening, `organizationId` required or the key is
  rejected. This is the one path where RLS is bypassed (`service_role`), so
  this check is the actual tenant boundary there, not a backstopped one.
- **`src/hooks/use-auth.tsx`** (client-side mirror) — `accountStatus` now
  folds in `organizationId`/`organizationRole`; a resolution failure flips it
  to `unlinked`, the same fail-closed state a missing `accountId` already
  produced, so every component already gating on `accountStatus === 'ready'`
  gets this protection automatically.

**Important**: hardening a chokepoint is global — every route that calls
`requireRole()`, including ones whose own query filters weren't touched this
phase, now requires a resolvable `organizationId` or gets a 403. One existing
test (`src/app/api/whatsapp/send/route.test.ts`) broke because its mocked
Supabase client didn't have an `organization_members` case — fixed by adding
one, not by weakening the chokepoint.

## Application — query cutover: `/api/v1/*` only (see "Scope decision" below)

Every route in the public API (`/api/v1/*`, 10 route files) now filters by
`organization_id` instead of `account_id`, along with the lib helpers that
are *exclusively* used by that path: `src/lib/api/v1/contacts.ts`,
`src/lib/api-keys/store.ts` (`getAccountName` → `getOrganizationName`, now
reading `organizations.name` instead of `accounts.name`), and
`src/lib/whatsapp/resolve-conversation.ts`.

**Two deliberate exceptions, both explained inline in the code:**

1. **`GET /api/v1/me`'s response shape is unchanged** — it still returns
   `account: { id: <accountId> }`. That's a wire contract external
   integrators already depend on; Phase 3 moves internal query filters, not
   the public API's response format. The name lookup internally now uses
   `organizationId`.
2. **Shared helpers used outside `/api/v1/*` were left on `account_id`**:
   `findExistingContact` (dedupe.ts, shared with the inbound webhook),
   `resolveImportTagIds`/`assignImportedContactTags` (shared with the CSV
   import UI), `addContactTagAndDispatch` (shared with the automations/flows
   engines), `sendMessageToConversation` and `createBroadcast`/
   `deliverBroadcast` (shared with cookie-session routes). Every one of
   these still filters correctly and securely by `account_id` — that column
   remains a real, NOT NULL, trigger-synced mirror of `organization_id`, so
   nothing here is a security gap. Renaming them would have meant reaching
   into files explicitly out of scope for this pass (see below).

## Scope decision: cookie-session routes and client components deferred

Mid-implementation, the actual scope turned out to be 51 files / 105
`.eq("account_id", ...)` occurrences — larger than the ~46 estimated in the
plan, because several are shared helper functions requiring careful
dual-parameter threading (`organizationId` for the read filter,
`accountId` kept for the write, since only a forward
account_id→organization_id trigger exists, not the reverse). Checked back in
with the user rather than either silently grinding through an
under-verified 51-file diff or silently narrowing scope: chose to finish
`/api/v1/*` completely and correctly, and defer the ~36 cookie-session routes
+ client-side components.

**This is not a security gap.** RLS (migration 044) already protects every
one of those routes and components regardless of which column — `account_id`
or `organization_id` — the application happens to filter by; both resolve to
the exact same tenant today. The deferred work is consistency/future-proofing
(preparing to eventually retire `accounts`/`profiles`), not a hole in
isolation. `verify-tenant-isolation.sql` proves the actual guarantee holds
independent of which application code path is exercised.

**Precise remainder**, for whoever picks this up: every file in the original
sweep except the `/api/v1/*` set above —
`src/app/api/{account,ai,quick-replies,whatsapp}/**/route.ts` (cookie-session),
`src/app/(dashboard)/**/*.tsx`, `src/components/**/*.tsx`,
`src/hooks/use-presence.ts`, `src/lib/{automations,flows}/*.ts`,
`src/lib/contacts/{dedupe,resolve-import-tags,tag-write}.ts`,
`src/lib/webhooks/deliver.ts`, `src/lib/whatsapp/{broadcast-core,
broadcast-resume,send-message,template-body}.ts`, and the WhatsApp webhook
route itself.

## Testing

- `verify-tenant-isolation.sql`: passes (positive control) against the real
  migration chain; correctly fails (negative control) when a policy is
  deliberately weakened — confirms the test has teeth, not just a green
  checkmark.
- `npm run typecheck`: clean.
- `npm run test`: 843/844 pass. The one failure
  (`src/i18n/messages.test.ts`) is pre-existing and unrelated — confirmed
  present on the commit before any Phase 1-3 work (`git stash` + re-run).
- Full `000 → 045` migration chain re-verified end to end on a disposable
  local Postgres, including `verify-schema.sql` and
  `verify-tenant-isolation.sql`, immediately before writing this report.

## Security summary

- **Tenant isolation**: enforced at the database layer (RLS,
  `organization_id`-based) for every cookie-session and dashboard code path,
  regardless of which column the application queries by. Enforced at the
  application layer for `/api/v1/*` (RLS-bypassed there), now on
  `organization_id`.
- **RLS status**: 33 tables cut over (93 policies), verified against a real
  two-tenant seed under the real `authenticated` role, with both a positive
  and a negative control.
- **Frontend-supplied `organization_id`**: no route in this codebase accepts
  `organization_id` as request input anywhere — it is always resolved
  server-side from the authenticated session/API key, never trusted from the
  client. Unchanged by this phase; true both before and after.
- **Residual risk, unchanged from Phase 0**: the WhatsApp webhook's
  `messages.status` mirror (matched by Meta's `message_id`, not scoped to any
  tenant column) and the WhatsApp media proxy route (derives tenancy from the
  *caller's* session, not from the requested `mediaId`) — both flagged in
  the Phase 0 audit, neither touched by Phases 1-3, both still theoretical/
  low-probability rather than exploitable in practice today.
