# Local development

```bash
npm install
cp apps/web/.env.local.example apps/web/.env.local   # fill in database + Meta creds
ln -s ../web/.env.local apps/api/.env.local          # both apps read one file
npm run dev
```

`npm run dev` starts both apps — the UI on 4310 and the API on 4311 —
and the UI forwards `/api/*` to the API via `API_ORIGIN` in
`.env.local`. Open <http://localhost:4310>; you should never need to
talk to 4311 directly.

## If pages 404 and the log fills with `Watchpack Error … EMFILE`

```
Watchpack Error (watcher): Error: EMFILE: too many open files, watch
```

This is a file-watcher shortage on the machine, not a problem with the
code. It matters because of *when* it happens: Next discovers routes at
startup, and a dev server whose watcher fails during that scan comes up
with an empty route table and serves 404 for everything. It never
recovers on its own — the log then shows fast 404s (`GET /login 404 in
42ms`) rather than a compile error, which is what makes it look like
broken code.

macOS is where this usually bites. Two things make it worse:

- **Other watchers on the machine.** Every editor, language server, MCP
  server and `--watch` dev server in another project draws from the same
  budget. Two IDEs plus another project's watcher is often enough on its
  own.
- **Two dev servers instead of one.** Each watches the whole monorepo:
  Turbopack roots itself where the lockfile is, because that is where the
  workspace packages (`@wacrm/shared`, `@wacrm/roles`) resolve from, so
  each server watches the root `node_modules` too. Whichever server loses
  the race is the one that 404s, so the symptom moves between the UI and
  the API from run to run.

### What the repo already does

The `dev` scripts raise their own file-descriptor limit before starting
Next (`ulimit -n 65536`). macOS gives a GUI-launched app — and therefore
its integrated terminal — a soft limit of 256, while the hard limit is
`unlimited`, so this needs no `sudo` and applies to every process the
script spawns. Check what you are getting with:

```bash
launchctl limit maxfiles          # the 256 your terminal starts from
npm run dev:web                   # the script raises it to 65536
```

That removes the one ceiling the repo controls. It is not the whole
story: a dev server has been observed failing with only 21 descriptors
open, far below any per-process limit, which means the shortage is also
system-wide and shared with everything else watching files on the
machine.

### Fixes, cheapest first

1. **Run one app at a time.** Usually you are only changing one side:

   ```bash
   npm run dev:web    # UI on 4310 — /api/* needs dev:api in another shell
   npm run dev:api    # API on 4311
   ```

   Working on the UI against an already-running API is the common case,
   and one server alone is comfortably within budget.

2. **Close what you are not using** — a second editor window, another
   project's watch-mode dev server, anything running Playwright.

3. **Raise the limit for everything, not just these scripts.** The npm
   scripts fix themselves, but your editor and its language servers still
   start at 256. To raise the machine-wide default:

   ```bash
   sudo launchctl limit maxfiles 65536 200000
   ```

   Restart the editor afterwards so its terminals inherit the new limit.
   To make it survive a reboot, create
   `/Library/LaunchDaemons/limit.maxfiles.plist` with the same values.

### Confirming it is the machine and not the code

Kill every watcher you can, then start one server:

```bash
pkill -f "next dev"
npm run dev:web
```

A clean start prints no `EMFILE` at all. If that works and adding the
second server breaks one of them, the budget is the constraint — not
anything in the repo.

A clean start looks like zero `EMFILE` lines in the log. If you see any,
the server that printed them is the one that will 404 — restart it once
the machine is quieter rather than trying to debug the routes.

## Ports

| Port | What |
| --- | --- |
| 4310 | UI (`apps/web`). Proxies `/api/*` to 4311 in development. |
| 4311 | API (`apps/api`). |

Both are off Next's 3000/3001 on purpose. Those two are taken on most
machines that run more than one Node project, and losing the race is
quiet rather than loud: Next picks the next free port and carries on,
while `API_ORIGIN` still points at the old one — so the UI comes up fine
and every `/api/*` call 404s.

### Changing them

Set `WEB_PORT` (and `API_ORIGIN`) in `apps/web/.env.local`:

```bash
WEB_PORT=5310
API_ORIGIN=http://localhost:5311
```

`API_PORT` is derived from `API_ORIGIN` unless you set it explicitly, so
the port the UI forwards to and the port the API listens on cannot drift
apart. For a one-off, export instead of editing:

```bash
WEB_PORT=5000 npm run dev:web
```

Next cannot read `PORT` from `.env.local` — its HTTP server binds before
any env file is loaded. `scripts/port.sh` reads these values and the npm
scripts pass the answer to Next as `--port`.

`API_ORIGIN` is read when the dev server boots, and Next bakes rewrites
into the build output — so changing it needs a restart, and setting it on
an already-built production container does nothing. In production a
reverse proxy routes `/api/*` instead; see [docker.md](./docker.md).
Container ports are unaffected by any of the above: the images listen on
3000/3001 internally and `docker-compose.yml` maps the host port through
`HOST_PORT`.
