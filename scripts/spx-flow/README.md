# SportsGenX — New Lead → Won WhatsApp flow

Definitions and a build script for the eight-stage lead journey
(New Lead → Contact Attempt → Qualification → Discovery → Demo →
Post-Demo → Offer → Won), plus the nurture loop every dead end feeds
into.

```
templates.mjs    23 WhatsApp templates — copy, buttons, Meta category
automations.mjs  22 automations — the stage drips and the reply handlers
lib.mjs          env, token decryption, Meta client, pre-flight validation
create.mjs       the runner (only ever ADDS; see "Retiring" below)
```

## Run it

```bash
node scripts/spx-flow/create.mjs --account <uuid> --dry-run
node scripts/spx-flow/create.mjs --account <uuid> --phase automations
node scripts/spx-flow/create.mjs --account <uuid> --phase templates
```

`DATABASE_URL` and `ENCRYPTION_KEY` are read from `apps/api/.env.local`
when not already exported. Automations are created **paused** — a
template sits in `PENDING` at Meta for a while, and an automation firing
against an unapproved template only logs failures.

There is no unique constraint on `automations.name`: running the
automations phase twice creates a second copy of all 22. Templates are
safe to re-run — they upsert on `(user_id, name, language)`.

## Naming

Meta only allows `[a-z0-9_]` in a template name, so the stage, purpose
and timing are encoded into the slug:

```
s<NN>_<stage>_<purpose>_<timing>
s01_new_lead_reminder1_2h   →  Stage 01 · New Lead · Reminder 1 · +2h
s09_nurture_reengage_d14    →  Stage 09 · Nurture · Re-engage · Day 14
```

`templates.mjs` carries a human `label` next to each one; it is
documentation only and never reaches Meta.

## How the stages chain

Two kinds of automation, and one tag per stage joining them:

**Stage drip** (`tag_added` on that stage's tag) — sends the stage
message, waits, and on no reply sends a reminder before parking the lead
in the nurture campaign. The `condition` step is the diagram's
"Wait for Reply → Reply / No Reply" fork, expressed as a yes/no branch on
whether the *next* stage's tag has appeared yet.

**Reply handler** (`interactive_reply`) — fires on the exact button
label the lead tapped, records the answer, and adds the next stage's tag.
Adding that tag is what starts the next drip, so the stages chain
themselves.

Two safety nets stop a reminder ever chasing someone who already
answered, both on `trigger_config`:

- `stop_on_reply: true` — any typed reply ends the parked run.
- `stop_tag_ids` — the next stage's tag plus every terminal tag
  (Unresponsive, Not Interested, Nurture, Lost) ends it too.

They are re-checked at the moment a parked run comes due, so they also
cover replies that arrived while the API was down and tags an agent
added by hand.

### Why button labels are the routing key

Meta mirrors a template QUICK_REPLY button's **label** into
`button.payload` on the inbound webhook, and the webhook stores that as
`interactive_reply_id`. So the label in `templates.mjs` *is* the
`reply_ids` value in `automations.mjs`. `validateWiring()` fails the run
if the two ever drift apart — change a label and the matching
`reply_ids` entry must change with it.

### Where answers are stored

- Stage 03 customer type → `Company Type` custom field
- Stage 04 tournament format → `Tournament Type interested in` custom field

Both are written with `{{message.text}}`, which resolves to the tapped
button's label.

## Two things that are deliberately manual

**Stage 08 is not entered automatically.** An agent adds the
`Stage 08 · Won & Payment` tag once payment actually lands; that
`tag_added` is what sends the payment confirmation, opens a Won deal and
starts onboarding. Nothing in the flow can decide payment arrived.

**Bulk imports are skipped.** Stage 01 triggers on `new_contact_created`,
which fires for CSV/Excel imports too. Its first step is a
`contact_field source == import` condition whose *yes* branch is empty —
without it, a 900-row import would WhatsApp every single row.

## Retiring the previous generation

`create.mjs` only adds. Removing the old `spx_*` templates from Meta and
the old automations from the CRM is a separate, deliberate step —
deleting an approved template on Meta is irreversible and it would need
fresh review to come back. Do it from the UI (Settings → Templates,
and the Automations list) or with an explicitly-approved one-off.
