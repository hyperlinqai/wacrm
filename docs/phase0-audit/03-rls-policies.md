# Row-Level Security — Live Policy Inventory

Captured live from `pg_class`/`pg_policies` on `wa-crm` (157.10.99.50), 2026-08-23, as `service_role`.

## RLS enablement status

All **36 of 37** `public` tables have `relrowsecurity = true`. The single exception is
`schema_migrations` (an internal bookkeeping table, correctly excluded — it holds no
tenant data and is never queried through the app's RLS-scoped clients).

`relforcerowsecurity = false` everywhere, which is expected/correct: `FORCE ROW LEVEL SECURITY`
only matters for table owners, and the app never connects as the table owner — it connects as
`authenticator` → `SET LOCAL role anon|authenticated|service_role` (see 05-auth-flow.md), and
RLS always applies to non-owner roles regardless of the FORCE flag.

## The tenancy gate: `public.is_account_member()`

Every business-table policy (with 3 named exceptions below) reduces to a call to this one
`SECURITY DEFINER` SQL function:

```sql
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id uuid,
  min_role account_role_enum DEFAULT 'viewer'::account_role_enum
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4 WHEN 'admin' THEN 3
            WHEN 'agent'  THEN 2 WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4 WHEN 'admin' THEN 3
            WHEN 'agent'  THEN 2 WHEN 'viewer' THEN 1
          END
  );
$function$
```

`auth.uid()` reads `current_setting('request.jwt.claims', true)::jsonb ->> 'sub'` — populated per-request
by `src/lib/db/exec.ts`'s `withRls()` wrapper (see 05-auth-flow.md), which is how the app's own
Postgres-only session model still drives policies written for PostgREST/GoTrue.

Role hierarchy: **owner(4) > admin(3) > agent(2) > viewer(1)**, mirrored exactly in
`src/lib/auth/roles.ts` so the TypeScript capability checks (`canManageMembers`, `canEditSettings`, …)
and the SQL policies never drift apart.

## Policy pattern per table

Almost every table follows one of two shapes:

**A. Direct `account_id` column** (contacts, conversations, deals, pipelines, automations, flows,
broadcasts, tags, custom_fields, contact_notes, api_keys, webhook_endpoints, ai_configs,
ai_knowledge_documents, ai_knowledge_chunks, ai_usage_log, automation_logs, flow_runs,
member_presence, message_templates, quick_replies, whatsapp_config, accounts, account_invitations):

```sql
-- SELECT: any member
USING (is_account_member(account_id))
-- INSERT/UPDATE/DELETE: role-gated (viewer < agent < admin, varies by table's risk level)
USING (is_account_member(account_id, 'agent'::account_role_enum))   -- e.g. contacts, conversations, deals
USING (is_account_member(account_id, 'admin'::account_role_enum))   -- e.g. tags, custom_fields, api_keys,
                                                                     --      webhook_endpoints, pipelines,
                                                                     --      whatsapp_config, message_templates
```

**B. No direct `account_id` — scoped via an `EXISTS` join to a parent table's `account_id`**
(automation_steps → automations, broadcast_recipients → broadcasts, contact_tags/contact_custom_values → contacts,
flow_nodes → flows, flow_run_events → flow_runs, message_reactions → messages → conversations, messages → conversations):

```sql
-- example: messages
USING (EXISTS (SELECT 1 FROM conversations c
               WHERE c.id = messages.conversation_id AND is_account_member(c.account_id)))
```

**C. Special-cased (not `is_account_member`)** — 3 tables:

| Table | Policy | Logic |
|---|---|---|
| `notifications` | `notifications_select` / `notifications_update` | `auth.uid() = user_id` — **per-user, not per-account**: a member only sees/marks-read their *own* notifications, even though `account_id` is also stored (used only for the app-layer query filter, not RLS enforcement) |
| `profiles` | `profiles_select` | `(auth.uid() = user_id) OR is_account_member(account_id)` — a user always sees their own profile row (needed before account_id can even be resolved) *plus* every profile in their account (teammate list) |
| `profiles` | `profiles_insert` / `profiles_update` | `auth.uid() = user_id` only — a user can only ever write their own profile row, never a teammate's (role changes go through the `account_member_rpcs`/admin routes instead, which run as `service_role`) |

## Full policy list (102 policies across 36 tables)

| Table | Policy | Cmd | Role check |
|---|---|---|---|
| account_invitations | account_invitations_select | SELECT | admin |
| account_invitations | account_invitations_modify | ALL | admin |
| accounts | accounts_select | SELECT | viewer (member) |
| accounts | accounts_update | UPDATE | admin |
| ai_configs | ai_configs_select | SELECT | viewer |
| ai_configs | ai_configs_insert/update/delete | I/U/D | admin |
| ai_knowledge_documents | *_select | SELECT | viewer |
| ai_knowledge_documents | *_insert/update/delete | I/U/D | admin |
| ai_knowledge_chunks | *_select | SELECT | viewer |
| ai_knowledge_chunks | *_insert/update/delete | I/U/D | admin |
| ai_usage_log | ai_usage_log_select | SELECT | **admin** (usage/cost data restricted above viewer) |
| api_keys | api_keys_select | SELECT | viewer |
| api_keys | api_keys_insert/update/delete | I/U/D | admin |
| automation_logs | automation_logs_select | SELECT | viewer |
| automation_steps | automation_steps_select | SELECT | via automations, viewer |
| automation_steps | automation_steps_modify | ALL | via automations, agent |
| automations | automations_select | SELECT | viewer |
| automations | automations_insert/update/delete | I/U/D | agent |
| broadcast_recipients | *_select | SELECT | via broadcasts, viewer |
| broadcast_recipients | *_modify | ALL | via broadcasts, agent |
| broadcasts | broadcasts_select | SELECT | viewer |
| broadcasts | broadcasts_insert/update/delete | I/U/D | agent |
| contact_custom_values | *_select | SELECT | via contacts, viewer |
| contact_custom_values | *_modify | ALL | via contacts, agent |
| contact_notes | *_select | SELECT | viewer |
| contact_notes | *_insert/update/delete | I/U/D | agent |
| contact_tags | *_select | SELECT | via contacts, viewer |
| contact_tags | *_modify | ALL | via contacts, agent |
| contacts | contacts_select | SELECT | viewer |
| contacts | contacts_insert/update/delete | I/U/D | agent |
| conversations | conversations_select | SELECT | viewer |
| conversations | conversations_insert/update/delete | I/U/D | agent |
| custom_fields | *_select | SELECT | viewer |
| custom_fields | *_insert/update/delete | I/U/D | admin |
| deals | deals_select | SELECT | viewer |
| deals | deals_insert/update/delete | I/U/D | agent |
| flow_nodes | *_select | SELECT | via flows, viewer |
| flow_nodes | *_modify | ALL | via flows, agent |
| flow_run_events | *_select | SELECT | via flow_runs, viewer |
| flow_runs | flow_runs_select | SELECT | viewer |
| flows | flows_select | SELECT | viewer |
| flows | flows_insert/update/delete | I/U/D | agent |
| member_presence | member_presence_select | SELECT | viewer |
| message_reactions | *_select | SELECT | via messages→conversations, viewer |
| message_reactions | *_modify | ALL | via messages→conversations, agent |
| message_templates | *_select | SELECT | viewer |
| message_templates | *_insert/update/delete | I/U/D | admin |
| messages | messages_select | SELECT | via conversations, viewer |
| messages | messages_modify | ALL | via conversations, agent |
| notifications | notifications_select/update | SELECT/UPDATE | **`auth.uid() = user_id`** (not role-based) |
| pipelines | pipelines_select | SELECT | viewer |
| pipelines | pipelines_insert/update/delete | I/U/D | admin |
| pipeline_stages | *_select | SELECT | via pipelines, viewer |
| pipeline_stages | *_modify | ALL | via pipelines, admin |
| profiles | profiles_select | SELECT | **self OR account member** |
| profiles | profiles_insert/update | I/U | **self only** |
| quick_replies | quick_replies_select | SELECT | viewer |
| quick_replies | quick_replies_insert/update/delete | I/U/D | agent |
| tags | tags_select | SELECT | viewer |
| tags | tags_insert/update/delete | I/U/D | admin |
| webhook_endpoints | *_select | SELECT | viewer |
| webhook_endpoints | *_insert/update/delete | I/U/D | admin |
| whatsapp_config | *_select | SELECT | viewer |
| whatsapp_config | *_insert/update/delete | I/U/D | admin |

*(102 policies total; the table above collapses per-verb variants of an identical role-check
onto one row for readability — the raw `pg_policies` dump is preserved in the backup artifacts,
see 07-backup-and-freeze.md.)*

## Cross-cutting observations for the SaaS conversion

1. **The account-partition boundary is real and load-bearing, not cosmetic.** Every policy
   ultimately gates on `profiles.account_id = target_account_id AND profiles.user_id = auth.uid()`.
   As long as `auth.uid()` continues to resolve correctly per request (see 05-auth-flow.md's
   `withRls()`/`request.jwt.claims` mechanism), this is genuine multi-tenant row isolation at the
   database layer — not just application-level filtering.
2. **The public API-key path (`/api/v1/*`) bypasses all of this** — it authenticates via
   `service_role` (`BYPASSRLS`), so these 102 policies provide **zero protection** for that path.
   See 05-auth-flow.md, "Multi-tenancy notes," point 4 — this is the single highest-priority area
   to audit/harden for cross-tenant leakage risk before/during the SaaS conversion.
3. **`ai_usage_log` is deliberately admin-only for SELECT** — the only "read" policy anywhere in
   the schema that requires more than `viewer`. Worth confirming this is intentional (cost/usage
   data as an owner/admin-only concern) rather than an oversight, since every other read-only
   list view in the app is viewer-accessible.
4. **`notifications` is the only table using an identity check (`auth.uid() = user_id`) instead
   of the account-role helper** — correct for "my inbox of alerts," but means a future
   "admin can see all account notifications" feature would need a new policy, not a role bump.
5. **INSERT policies never carry a `USING` clause, only `WITH CHECK`** (standard Postgres RLS
   behavior — `USING` doesn't apply to rows that don't exist yet) — verified consistent across
   all 36 tables in the raw dump; no anomalies found.
6. **No table uses `PERMISSIVE`-vs-`RESTRICTIVE` mixing** — every single policy is `PERMISSIVE`
   (Postgres default). If a future requirement needs a hard global override (e.g. "suspended
   accounts can never write, no matter the role"), that would be a good use of a `RESTRICTIVE`
   policy layered on top, rather than threading a suspended-check into every existing policy.
