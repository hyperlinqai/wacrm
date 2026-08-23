# Phase 0 — Freeze & Audit

Baseline audit of the single-tenant WA-CRM system, captured before the multi-tenant
SaaS conversion begins. Everything here reflects the system **as of the freeze
point** below — re-run the extraction queries in [07-backup-and-freeze.md](07-backup-and-freeze.md)
if this audit is consulted long after that date.

## Freeze point

- **Git tag:** `single-tenant-stable` → commit `3aefeba` (branch `main`)
- **Tagged:** 2026-08-23
- **Database:** `wa-crm` on `157.10.99.50:5432` (PostgreSQL 18.4), captured live via `pg_dump`

See [07-backup-and-freeze.md](07-backup-and-freeze.md) for exactly what was backed up, what wasn't, and why.

## Documents in this audit

| Doc | Contents |
|---|---|
| [01-schema-catalog.md](01-schema-catalog.md) | Every table, grouped by domain, with columns/types/defaults |
| [02-erd.md](02-erd.md) | Entity-relationship diagram + full FK list |
| [03-rls-policies.md](03-rls-policies.md) | Live RLS policies for all 36 RLS-enabled tables, and the tenancy model behind them |
| [04-api-map.md](04-api-map.md) | Every `route.ts` under `src/app/api`, grouped by area, with HTTP methods |
| [05-auth-flow.md](05-auth-flow.md) | Signup/login/session/JWT/invitation flow, code-grounded |
| [06-whatsapp-webhook-flow.md](06-whatsapp-webhook-flow.md) | Inbound webhook, outbound send, templates, broadcasts, code-grounded |
| [07-backup-and-freeze.md](07-backup-and-freeze.md) | What was tagged, what was backed up, artifact locations, known gaps |

## Headline finding for the SaaS conversion

This system is **not** starting from a single-tenant data model. `eea5a97 feat!:
replace Supabase entirely with a direct-Postgres data layer` kept Supabase's
Postgres schema conventions (`auth.users`, RLS, `anon`/`authenticated`/`service_role`)
while dropping the hosted platform. Multi-tenancy already exists at the data layer:

- Every business table carries an `account_id` (see `accounts` table, owner + members via `profiles.account_id` / `profiles.account_role`).
- Every one of the 36 business tables has RLS **enabled**, gated almost entirely
  through one helper, `public.is_account_member(account_id, min_role)`, which
  checks `profiles.account_id = target_account_id` and a role-hierarchy comparison
  (`owner(4) > admin(3) > agent(2) > viewer(1)`).
- WhatsApp config, API keys, webhook endpoints, AI config/knowledge, automations,
  flows — all scoped to `account_id`, not just contacts/conversations.

So "single-tenant" here describes the **product** (one account effectively runs
the whole deployment today, one WhatsApp number, one team), not the schema — the
schema is already account-partitioned. That materially changes the shape of a
"Phase 1+" SaaS conversion: the hard problems are likely elsewhere (billing,
account provisioning/isolation guarantees, per-account WhatsApp number limits,
subdomain/host routing, admin tooling for cross-account support) rather than
"add a tenant column to every table."
