# Schema Catalog

Source: live introspection of `wa-crm` on `157.10.99.50:5432` (PostgreSQL 18.4) on
2026-08-23, via `information_schema.columns` / `pg_constraint` / `pg_policies`
(role `service_role` for `public.*`, since the app's own `authenticator` login
role is intentionally `NOINHERIT` and has no direct grants on `public` — see
[07-backup-and-freeze.md](07-backup-and-freeze.md)), cross-referenced against
`supabase/migrations/001_initial_schema.sql` → `041_deals_conversation_delete_set_null.sql`
and `supabase/postgres-compat/000_bootstrap.sql`.

**37 tables in `public`** (36 with RLS enabled, `schema_migrations` is the one
exception) **+ `auth.users`** (identity table, self-hosted Supabase-compatible
schema, bootstrapped by `supabase/postgres-compat/000_bootstrap.sql` — not a
managed Supabase service). See [02-erd.md](02-erd.md) for the full FK graph and
a Mermaid diagram, [03-rls-policies.md](03-rls-policies.md) for every RLS policy.

Every business table below carries `account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`
— the tenant-isolation column — noted once per domain rather than repeated per table.

## 0. Identity & Tenancy

### `auth.users` (bootstrap DDL, not introspectable — see gap note in 07)
Self-hosted Supabase-compatible identity table (`supabase/postgres-compat/000_bootstrap.sql`).
Key columns: `id uuid PK`, `email varchar UNIQUE`, `encrypted_password varchar` (bcrypt via
pgcrypto), `email_confirmed_at`, `banned_until` *(referenced by app code; not in the bootstrap
snippet shown — likely added by a later compat migration)*, `raw_app_meta_data`/`raw_user_meta_data jsonb`,
`is_super_admin boolean`, `phone text`, `deleted_at`, `is_anonymous boolean`,
plus `sessions_revoked_at timestamptz` (added by `040_direct_postgres.sql` — backs global sign-out).

### `accounts` — one row per tenant
| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | `uuid_generate_v4()` |
| name | text | NO | |
| owner_user_id | uuid | NO | *(UNIQUE — one account per owner, see 05-auth-flow.md)* |
| default_currency | text | NO | `'USD'` |
| created_at / updated_at | timestamptz | NO | `now()` |

### `profiles` — one row per user, single account membership
| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | `uuid_generate_v4()` |
| user_id | uuid | NO | → `auth.users(id)` |
| account_id | uuid | NO | → `accounts(id)` |
| account_role | `account_role_enum` | NO | `owner \| admin \| agent \| viewer` |
| full_name, email | text | NO | |
| avatar_url | text | YES | |
| role | text | YES | `'user'` *(legacy/unused — superseded by account_role)* |
| beta_features | text[] | NO | `{}` |
| created_at / updated_at | timestamptz | YES | `now()` |

### `account_invitations`
| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | `uuid_generate_v4()` |
| account_id | uuid | NO | → `accounts` |
| token_hash | text | NO | SHA-256 of the invite token (plaintext never stored) |
| role | `account_role_enum` | NO | admin \| agent \| viewer (never owner) |
| created_by_user_id, accepted_by_user_id | uuid | YES | → `auth.users` |
| label | text | YES | |
| created_at, expires_at, accepted_at | timestamptz | NO/NO/YES | |

## 1. CRM Core

### `contacts`
`id, account_id, user_id(owner/audit), phone, phone_normalized, name, email, company, avatar_url, created_at, updated_at`.
Phone deduped per-account (migration 022).

### `tags` / `contact_tags`
`tags(id, account_id, user_id, name, color, created_at)`; `contact_tags(id, contact_id, tag_id, created_at)` — join table, no direct `account_id` (scoped transitively via `contacts`).

### `custom_fields` / `contact_custom_values`
`custom_fields(id, account_id, user_id, field_name, field_type, field_options jsonb, created_at)`;
`contact_custom_values(id, contact_id, custom_field_id, value, created_at)`.

### `contact_notes`
`id, account_id, contact_id, user_id, note_text, created_at`.

## 2. Conversations & Messaging

### `conversations`
`id, account_id, user_id, contact_id, status, assigned_agent_id, last_message_text, last_message_at, unread_count, ai_autoreply_disabled, ai_reply_count, ai_handoff_summary, created_at, updated_at`.

### `messages`
`id, conversation_id, sender_type, sender_id, content_type, content_text, media_url, media_type, template_name, message_id (Meta wamid), status, reply_to_message_id, interactive_reply_id, interactive_payload jsonb, ai_generated, created_at`.
No direct `account_id` column — scoped transitively via `conversations` (see RLS doc).

### `message_reactions`
`id, message_id, conversation_id, actor_type, actor_id, emoji, created_at`. Unique on `(message_id, actor_type, actor_id)`.

### `member_presence`
`user_id, account_id` (composite key, no `id`), `status, last_seen_at`.

## 3. Pipelines & Deals

### `pipelines` / `pipeline_stages`
`pipelines(id, account_id, user_id, name, created_at)`;
`pipeline_stages(id, pipeline_id, name, position, color, created_at)`.

### `deals`
`id, account_id, user_id, pipeline_id, stage_id, contact_id, conversation_id, title, value numeric, currency, notes, expected_close_date, status, assigned_to (→ profiles.id), created_at, updated_at`.

## 4. WhatsApp

### `whatsapp_config` — **one per account** (`UNIQUE(account_id)`), **phone_number_id globally unique**
`id, account_id, user_id, phone_number_id, waba_id, access_token (AES-256-GCM encrypted), verify_token (encrypted), status, connected_at, registered_at, subscribed_apps_at, last_registration_error, mirror_inbound_media (default true), created_at, updated_at`.
See [06-whatsapp-webhook-flow.md](06-whatsapp-webhook-flow.md) for the encryption/registration flow.

### `message_templates`
`id, account_id, user_id, name, category, language, header_type, header_content, header_handle, header_media_url, body_text, footer_text, buttons jsonb, status, sample_values jsonb, meta_template_id, rejection_reason, quality_score, submission_error, last_submitted_at, created_at, updated_at`.

## 5. Broadcasts

### `broadcasts`
`id, account_id, user_id, name, template_name, template_language, template_variables jsonb, audience_filter jsonb, scheduled_at, status, total/sent/delivered/read/replied/failed_count, delivery_locked_at (resume mutex), created_at, updated_at`.

### `broadcast_recipients`
`id, broadcast_id, contact_id, status, sent_at, delivered_at, read_at, replied_at, error_message, whatsapp_message_id, template_params jsonb (frozen at plan time), created_at`.

## 6. Automations

### `automations`
`id, account_id, user_id, name, description, trigger_type, trigger_config jsonb, is_active, execution_count, last_executed_at, created_at, updated_at`.

### `automation_steps`
`id, automation_id, parent_step_id (self-FK), branch, step_type, step_config jsonb, position, created_at`. No direct `account_id` — scoped via `automations`.

### `automation_logs`
`id, account_id, automation_id, user_id, contact_id, trigger_event, steps_executed jsonb, status, error_message, created_at`.

### `automation_pending_executions`
`id, account_id, automation_id, user_id, contact_id, log_id, parent_step_id, branch, next_step_position, context jsonb, status, run_at, created_at` — the "Wait step" scheduler queue, drained by `GET /api/automations/cron`.

## 7. Flows (visual chatbot builder)

### `flows`
`id, account_id, user_id, name, description, status, trigger_type, trigger_config jsonb, entry_node_id, fallback_policy jsonb (on_exhaust/max_reprompts/on_timeout_hours/on_unknown_reply), execution_count, last_executed_at, created_at, updated_at`.

### `flow_nodes`
`id, flow_id, node_key, node_type, config jsonb, position_x, position_y, created_at`. No direct `account_id` — scoped via `flows`.

### `flow_runs`
`id, account_id, flow_id, user_id, contact_id, conversation_id, status, current_node_key, last_prompt_message_id, vars jsonb, reprompt_count, started_at, last_advanced_at, ended_at, end_reason, created_at`.

### `flow_run_events`
`id, flow_run_id, event_type, node_key, payload jsonb, created_at`. No direct `account_id` — scoped via `flow_runs`.

## 8. AI Assistant

### `ai_configs`
`id, account_id, created_by, provider, model, api_key (encrypted, BYO-key), system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, embeddings_api_key, handoff_agent_id, created_at, updated_at`.

### `ai_knowledge_documents` / `ai_knowledge_chunks`
`ai_knowledge_documents(id, account_id, created_by, title, content, created_at, updated_at)`;
`ai_knowledge_chunks(id, document_id, account_id, chunk_index, content, fts tsvector, embedding text/vector, created_at)` — full-text search out of the box, optional `pgvector` semantic search.

### `ai_usage_log`
`id, account_id, conversation_id, mode, provider, model, prompt_tokens, completion_tokens, total_tokens, created_at`.

## 9. Account Access & Misc

### `api_keys`
`id, account_id, created_by, name, key_prefix, key_hash, scopes text[], last_used_at, expires_at, revoked_at, created_at`. Public-API bearer tokens (`wacrm_live_…`), see 05-auth-flow.md §B.

### `webhook_endpoints`
`id, account_id, created_by, url, secret, events text[], is_active, last_delivery_at, failure_count, created_at` — outbound webhook fan-out subscriptions (`message.received`, `message.status_updated`, `conversation.created`, etc.).

### `notifications`
`id, account_id, user_id, type, conversation_id, contact_id, actor_user_id, title, body, read_at, created_at`.

### `quick_replies`
`id, account_id, user_id, title, kind, content_text, interactive_payload jsonb, created_at, updated_at`.

### `schema_migrations` — the one table without RLS
`version text PK, applied_at timestamptz` — tracks which of the 41 migrations + 4 postgres-compat scripts have been applied (`scripts/apply-postgres.sh`).

## Migration history (41 files)

| # | File | Purpose |
|---|---|---|
| 001 | initial_schema | Base schema (Supabase-native): users/contacts/conversations/messages/pipelines/deals/broadcasts/automations, all `user_id`-scoped |
| 002 | pipelines_enhancements | |
| 003 | broadcast_recipient_wamid | `whatsapp_message_id` + status trigger |
| 004 | contact_delete_set_null | FK delete-rule fix |
| 005 | broadcast_counts_incremental | Trigger-maintained aggregate counts |
| 006 | automations | |
| 007 | automations_increment_counter | |
| 008 | profile_avatars_storage | |
| 009 | message_actions | Notes `message_id` (wamid) not globally unique |
| 010 | flows | Visual chatbot builder tables |
| 011 | profile_beta_features | |
| 012 | flows_increment_counter | |
| 013 | whatsapp_config_phone_number_id_unique | **Hard 1:1 number↔account constraint** |
| 014 | message_templates_meta_integration | |
| 015 | whatsapp_config_registration | |
| 016 | flow_media | |
| 017 | account_sharing | **Multi-user-per-account**: `accounts`, `profiles.account_id/account_role`, `is_account_member()`, RLS rewrite from `user_id` to `account_id` across the board |
| 018 | account_member_rpcs | |
| 019 | invitation_rpcs | `peek_invitation` / `redeem_invitation` SECURITY DEFINER RPCs |
| 020 | account_sharing_followups | |
| 021 | account_default_currency | |
| 022 | contact_phone_dedup | |
| 023 | chat_media | Storage bucket + path-based RLS |
| 024 | member_presence | |
| 025 | filter_contacts_by_tags | |
| 026 | api_keys | Public API bearer tokens |
| 027 | notifications | |
| 028 | webhook_endpoints | Outbound webhook subscriptions |
| 029 | ai_reply | |
| 030 | ai_knowledge | pgvector-optional knowledge base |
| 031 | ai_reply_slot_grant | |
| 032 | fix_ai_knowledge_membership | |
| 033 | ai_reply_polish | |
| 034 | fix_profiles_update_rls | |
| 035 | interactive_messages | Button/list replies |
| 036 | conversation_contact_dedup | |
| 037 | webhook_broadcast_reliability | Idempotent message upsert, atomic unread-bump RPC |
| 038 | broadcast_resume | Atomic broadcast+recipients creation, frozen `template_params`, `delivery_locked_at` mutex |
| 039 | inbound_media_mirror | Durable media mirroring into Storage (Meta deletes media ~30 days) |
| 040 | direct_postgres | **Supabase-js → direct-Postgres cutover**: `sessions_revoked_at`, `pg_notify` triggers replacing Realtime |
| 041 | deals_conversation_delete_set_null | FK delete-rule fix |

Plus 4 `supabase/postgres-compat/*.sql` scripts (`000_bootstrap`, `010_service_roles`,
`020_storage_object_policies`, `999_seed`) that stand up the Supabase-compatible
`auth`/`storage` schemas and roles on stock Postgres — not numbered as app migrations
since they're infrastructure, applied once by `scripts/apply-postgres.sh`.
