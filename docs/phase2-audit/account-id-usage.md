# account_id Usage Inventory (Phase 2, Step 9)

Every location in `src/` that touches account/tenant identity, captured before
Phase 2's app-layer changes so the two chokepoints (and everything downstream of
them) can be told apart from special cases needing individual attention in a
later phase. See [../phase2-audit](.) for the migration itself
(`supabase/migrations/043_organization_id.sql`) and
[../phase0-audit/05-auth-flow.md](../phase0-audit/05-auth-flow.md) for the
original account_id authorization model this builds on.

## The two chokepoints (fixed this phase)

Fixing these two is what makes `organizationId` available everywhere else
without touching the ~60 leaf files below.

1. **`src/lib/auth/account.ts`** — `getCurrentAccount()` / `requireRole()`.
   39 direct callers (effectively every cookie-session API route). Now also
   resolves `organizationId`/`organizationRole` via `organization_members`,
   best-effort (see the doc comment on `AccountContext.organizationId` in that
   file for why a resolution failure doesn't fail the whole request).
2. **`src/hooks/use-auth.tsx`** — `AuthProvider`/`useAuth()`. 38 direct callers
   (client components). Independently duplicates the `profiles`→`accounts`
   resolution logic from #1 (existing pattern, not introduced by Phase 2) — now
   also independently resolves `organizationId`/`organizationRole` the same
   best-effort way.

A third, structurally separate resolution point exists for the public API:

3. **`src/lib/auth/api-context.ts`** — `requireApiKey()`. Resolves `accountId`
   from `api_keys.account_id` (not `profiles`), returns a service-role
   (RLS-bypassing) client. Now also resolves `organizationId` via
   `organizations.legacy_account_id`, independently of #1/#2 since there's no
   user session to look up an `organization_members` row by.

A secondary client-side chokepoint sits on top of #2:

4. **`src/hooks/use-can.ts`** — `useCan()`, derives permission booleans from
   `accountRole`. Most permission-gated components call this rather than
   reading `accountRole` directly, so it's covered transitively — not modified
   this phase (nothing yet needs an organization-role equivalent).

## Leaf consumers (unmodified — inherit `organizationId` automatically if a
## later phase starts reading it from the context)

**~36 API routes** filter a query by `.eq("account_id", ctx.accountId)`,
spanning every feature area: contacts/conversations (`/api/v1/*`),
automations (`.../automations/*`), flows (`.../flows/*`), WhatsApp
(`.../whatsapp/broadcast`, `config`, `send`, `templates/*`, `webhook`),
broadcasts, api-keys, AI (`.../ai/*`), invitations, quick-replies. Representative
sample, not exhaustive — the pattern is identical across all of them: resolve
context once via `requireRole()`/`getCurrentAccount()`, then scope every query.

**~25 client components/hooks** read `accountId`/`accountRole` from `useAuth()`:
`use-can.ts`, `use-broadcast-sending.ts` (writes `account_id` into new rows),
`use-presence.ts` (realtime channel keyed by account), `require-role.tsx`, and
components across contacts, inbox, pipelines, settings (6 files), agents, and
several dashboard pages that query Supabase directly client-side (bypassing an
API route entirely, relying on RLS + an explicit `accountId` filter).

**3 explicit `p_account_id` RPC calls** (the migration 018/019 SECURITY DEFINER
functions that take it as a parameter rather than resolving it via `auth.uid()`
internally):
- `src/lib/ai/knowledge.ts` → `match_ai_knowledge_semantic`, `match_ai_knowledge_fts`
- `src/lib/whatsapp/broadcast-core.ts` → `create_broadcast_with_recipients`

These would need their own SQL signature + call-site change if a later phase
wants them to accept `p_organization_id` instead — not fixed automatically by
the chokepoint changes, since the parameter is explicit, not context-resolved.

## Special cases requiring individual attention in a later phase

- **`contact_tags` has no `account_id` column at all** — tenant-scoped via an
  ownership guard through its parent `contacts` row, not a column filter
  (`src/lib/automations/engine.ts`, several call sites). Consistent with why
  `contact_tags` was excluded from migration 043's `organization_id` rollout
  (see that migration's header comment) — same pattern, not a gap.
- **`src/lib/auth/api-context.ts` resolves tenancy from a different source**
  (`api_keys.account_id`, not `profiles.account_id`) and returns a
  service-role/RLS-bypassing client — every `/api/v1/*` route's manual
  `.eq('account_id', ...)` filter is the *only* isolation boundary on that
  path (Phase 0 finding, unchanged by Phase 2). Highest-priority area for a
  careful audit before any `organization_id`-based query cutover.
- **`src/app/api/whatsapp/config/route.ts`** bakes in a "one WhatsApp number
  per account" invariant via a `.single()` lookup and an explicit pre-check —
  mirrored in migration 043 as `whatsapp_config`'s `UNIQUE(organization_id)`.
  Any future move to multiple numbers per organization needs this route
  revisited, not just the schema.
- **`src/hooks/use-auth.tsx` duplicates resolution logic from `account.ts`**
  (pre-existing, not introduced this phase) — the Phase 2 `organizationId`
  addition had to be threaded through both independently for the same reason;
  worth remembering that any *future* account/organization resolution change
  needs both files touched, not one.

## Not modified this phase, by design

Per the agreed Phase 2 scope: none of the ~36 routes, ~25 components, or 3 RPC
call sites above were touched. `organizationId`/`organizationRole` are now
resolvable from the two chokepoints, correctly backfilled and kept in sync at
the database layer (migration 043's trigger), but nothing reads or trusts them
yet. The gradual, route-by-route cutover to actually using `organization_id`
for query scoping and authorization is later-phase work — see
[../phase0-audit/README.md](../phase0-audit/README.md)'s headline finding for
why that's a bigger structural change than "swap one column name."
