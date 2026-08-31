# @wacrm/shared

Domain logic both wacrm apps need, and neither owns.

Everything here is pure: no database pool, no `server-only` module, no
browser client, no environment beyond what a caller passes in. That is
the rule that keeps the package importable from an API route handler and
a React client component alike — the WhatsApp template validators run
against a draft in the composer and against the payload the send route
builds, and they must agree.

Subpaths mirror the source layout, so `src/whatsapp/meta-api.ts` is
`@wacrm/shared/whatsapp/meta-api`. The one exception is the type barrel
at `src/db/index.ts`, reachable as `@wacrm/shared/db`.

If something here starts needing a connection, a request or a window, it
belongs in `apps/api` or `apps/web` instead.
