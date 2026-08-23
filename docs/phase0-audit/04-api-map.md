# API Map

Every `route.ts` under `src/app/api`, grouped by area, with the HTTP methods each
file exports (`grep -rnE "^export (async )?function (GET|POST|PUT|PATCH|DELETE)"`,
2026-08-23). Two trust models coexist — see [05-auth-flow.md](05-auth-flow.md):
**cookie-session** routes (dashboard, RLS-backed) and **API-key** routes under
`/api/v1/*` (public REST API, `service_role`/RLS-bypassing, manual `account_id`
filtering — the audit's top cross-tenant-leakage risk area).

## Auth
| Route | Methods |
|---|---|
| `/api/auth/[action]` | GET, POST — `login\|signup\|logout\|user\|update\|...` dispatched by the `[action]` segment |

## Account & team management (cookie-session, role-gated)
| Route | Methods |
|---|---|
| `/api/account` | GET, PATCH |
| `/api/account/members` | GET |
| `/api/account/members/[userId]` | PATCH, DELETE |
| `/api/account/invitations` | GET, POST |
| `/api/account/invitations/[id]` | DELETE |
| `/api/account/api-keys` | GET, POST |
| `/api/account/api-keys/[id]` | DELETE |
| `/api/account/transfer-ownership` | POST |
| `/api/invitations/[token]/peek` | GET *(public, unauthenticated)* |
| `/api/invitations/[token]/redeem` | POST |

## Contacts, tags, quick replies
| Route | Methods |
|---|---|
| `/api/contacts/[id]/tags` | POST, DELETE |
| `/api/quick-replies` | GET, POST |
| `/api/quick-replies/[id]` | PATCH, DELETE |

## WhatsApp
| Route | Methods |
|---|---|
| `/api/whatsapp/webhook` | GET *(Meta verification handshake)*, POST *(inbound events)* |
| `/api/whatsapp/send` | POST |
| `/api/whatsapp/config` | GET, POST, DELETE |
| `/api/whatsapp/config/verify-registration` | GET |
| `/api/whatsapp/react` | POST |
| `/api/whatsapp/media/[mediaId]` | GET |
| `/api/whatsapp/templates/[id]` | PATCH, DELETE |
| `/api/whatsapp/templates/submit` | POST |
| `/api/whatsapp/templates/sync` | POST |
| `/api/whatsapp/broadcast` | POST *(dashboard-driven, non-resumable — see 06)* |
| `/api/whatsapp/broadcast/[id]/resume` | POST *(resumable core)* |

## Automations & Flows
| Route | Methods |
|---|---|
| `/api/automations` | GET, POST |
| `/api/automations/[id]` | GET, PATCH, DELETE |
| `/api/automations/[id]/duplicate` | POST |
| `/api/automations/engine` | POST |
| `/api/automations/cron` | GET *(drains `automation_pending_executions`, needs `AUTOMATION_CRON_SECRET`)* |
| `/api/flows` | GET, POST |
| `/api/flows/[id]` | GET, PUT, DELETE |
| `/api/flows/[id]/activate` | POST |
| `/api/flows/[id]/runs` | GET |
| `/api/flows/templates` | GET |
| `/api/flows/cron` | GET |

## AI Assistant
| Route | Methods |
|---|---|
| `/api/ai/config` | GET, POST, DELETE |
| `/api/ai/draft` | POST |
| `/api/ai/playground` | POST |
| `/api/ai/test` | POST |
| `/api/ai/usage` | GET |
| `/api/ai/autoreply/[conversationId]` | POST |
| `/api/ai/knowledge` | GET, POST |
| `/api/ai/knowledge/[id]` | GET, PATCH, DELETE |
| `/api/ai/knowledge/reindex` | POST |

## Storage & realtime
| Route | Methods |
|---|---|
| `/api/storage/upload` | POST |
| `/api/storage/remove` | POST |
| `/api/storage/object/public/[bucket]/[...path]` | GET |
| `/api/realtime` | GET *(SSE stream, backs the `pg_notify`-based live-update mechanism from migration 040)* |
| `/api/db` | POST *(the browser client's generic `from()/rpc()` execution endpoint — see 05-auth-flow.md)* |

## Public REST API (`/api/v1/*` — API-key authenticated, `requireApiKey()`)
| Route | Methods |
|---|---|
| `/api/v1/me` | GET |
| `/api/v1/contacts` | GET, POST |
| `/api/v1/contacts/[id]` | GET, PATCH |
| `/api/v1/conversations` | GET |
| `/api/v1/conversations/[id]` | GET |
| `/api/v1/conversations/[id]/messages` | GET |
| `/api/v1/messages` | POST |
| `/api/v1/broadcasts` | POST |
| `/api/v1/broadcasts/[id]` | GET |
| `/api/v1/webhooks` | GET, POST |
| `/api/v1/webhooks/[id]` | GET, PATCH, DELETE |

**Total: 61 `route.ts` files, ~90 method handlers**, across 11 functional areas.

## Structural observations

- **`/api/db`** is the single most load-bearing route in the app — every
  `supabase.from()`/`.rpc()` call made by the *browser* client (`src/lib/db/browser-client.ts`)
  is a POST to this one endpoint, which then executes server-side under the
  caller's RLS context (`withRls`, see 05-auth-flow.md). Any request-smuggling or
  authorization bug here would be the single highest-leverage vulnerability in the
  app, since it's the one door all dashboard data traffic passes through.
- **Two independently-implemented broadcast send paths** (`/api/whatsapp/broadcast`
  vs. the `/api/v1/broadcasts` + resumable-core path) — flagged in 06 as worth
  unifying before broadcasts become a heavily-relied-on SaaS feature.
- **Cron-driven routes** (`/api/automations/cron`, `/api/flows/cron`) are the only
  ones authenticated by a shared secret rather than a session or API key — worth
  confirming `AUTOMATION_CRON_SECRET` (and whatever secret gates `/api/flows/cron`)
  is treated as sensitively as `ENCRYPTION_KEY`/`META_APP_SECRET` once this runs
  as multi-tenant SaaS with a real pager on it.
