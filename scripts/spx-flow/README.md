# SportsGenX — source → first WhatsApp sequence

Definitions and build scripts for the seven entry-source sequences
(Meta, Google, Website, App Organisation, App Tournament Created,
Referral, Instagram), the shared requirement-discovery chain, and the
nurture loop every unresponsive lead lands in.

```
templates.mjs    18 WhatsApp templates — welcome + 2 reminders per sequence, follow-up, nurture
automations.mjs  36 automations — routers, sequences, discovery chain, reply handlers
lib.mjs          env, token decryption, Meta client, pre-flight validation
create.mjs       the builder (only ever ADDS)
status.mjs       pull Meta approval status; --activate switches the graph on
retire.mjs       delete the previous "Stage 01–09" generation (needs --yes)
```

## Run it

```bash
node scripts/spx-flow/create.mjs --account <uuid> --dry-run
node scripts/spx-flow/create.mjs --account <uuid> --phase templates
node scripts/spx-flow/create.mjs --account <uuid> --phase automations
node scripts/spx-flow/retire.mjs --account <uuid> --dry-run      # then --yes
node scripts/spx-flow/status.mjs --account <uuid> --wait 30 --activate
```

`DATABASE_URL` and `ENCRYPTION_KEY` are read from `apps/api/.env.local`
when not already exported. Automations are created **paused** — a
template sits in `PENDING` at Meta for a while, and an automation firing
against an unapproved template only logs failures. `status.mjs
--activate` turns the graph on once every template is `APPROVED`.

Re-running `create.mjs` is safe: templates upsert on
`(user_id, name, language)` and automations are skipped by name.

## Source → sequence

| # | `contacts.source`        | Source tag                    | Sequence                              | Templates |
|---|--------------------------|-------------------------------|---------------------------------------|-----------|
| 1 | `meta_ads`               | Source · Meta                 | Meta → Lead Welcome                   | `lw_*`    |
| 2 | `google`                 | Source · Google               | Google → Lead Welcome                 | `lw_*`    |
| 3 | `web_form`               | Source · Website              | Website → Lead Welcome                | `lw_*`    |
| 4 | `app_organisation`       | Source · App Organisation     | Organisation → Onboarding             | `org_*`   |
| 5 | `app_tournament_created` | Source · Tournament Created   | Tournament Created → Setup Assistance | `tc_*`    |
| 6 | `referral`               | Source · Referral             | Referral → Qualification              | `ref_*`   |
| 7 | `instagram`              | Source · Instagram            | Instagram → Tournament Digitisation   | `ig_*`    |

The Source field is `contacts.source` (the CRM's existing column; the
Meta Lead Ads webhook already stamps `meta_ads`, web forms stamp
`web_form`, and the public API accepts the rest — see
`docs/public-api.md`). The sequence a contact went through is written to
the **WhatsApp Sequence** custom field by the sequence's first step.

Meta, Google and Website share one set of templates: the lead's intent
is the same, only the acquisition channel differs, and the channel is
already recorded on the contact.

## How the layers chain

**Router** (`new_contact_created`, one per source) — a single
`contact_field source == <value>` condition whose *yes* branch adds the
source tag. Imports and unknown sources match nothing.

**Sequence** (`tag_added` on the source tag) — writes the sequence name,
sends the welcome template, and while the lead has not engaged sends a
reminder on day 1 and day 3 before tagging Unresponsive + Nurture
Campaign. Because the trigger is a tag, a sequence can also be started
by hand (agent adds the tag) or by the SportsGenX app (`PATCH
/api/v1/contacts/{id}` with `tags`). That is how **Tournament Created**
is entered for a contact who already exists.

**Reply handler** (`interactive_reply`) — fires on the button the lead
tapped, adds the **Engaged** tag, records the answer, and asks the next
question as an *interactive* message (buttons or list). The tap opened
Meta's 24-hour service window, so those need no template and no review.
The discovery chain — format → sport → timing → assistance → organiser
type → agent — is shared by every sequence.

Two safety nets stop a reminder ever chasing someone who already
engaged, both on the sequence's `trigger_config`:

- `stop_on_reply: true` — any *typed* reply ends the parked run.
- `stop_tag_ids` — Engaged, Interested, Not Interested, Nurture.

Button taps are not "replies" to the engine (see `sequenceStopReason`),
which is why every handler adds Engaged and why the reminder fork is a
`tag_presence` check on that tag.

### Why button labels and ids are the routing key

Meta mirrors a template QUICK_REPLY button's **label** into
`button.payload` on the inbound webhook, and a reply-button / list-row
**id** into `button_reply.id` / `list_reply.id`; the webhook stores
either as `interactive_reply_id`. So a template label in `templates.mjs`
and an interactive id in `automations.mjs` are both `reply_ids` values.
`validateWiring()` fails the run if a `reply_id` matches nothing, if two
handlers claim the same id (the engine would run both), or if a button
has no handler at all.

### Where answers are stored

| Question                     | Custom field                           |
|------------------------------|----------------------------------------|
| What to organise (format)    | Tournament Type interested in          |
| Which sport                  | Sports interested in                   |
| When is the next tournament  | Next tournament plan                   |
| Self-managed / assistance    | Tournament management service needed   |
| Organiser type               | Company Type                           |
| Academy / tournament utility | Features interested in                 |

All are written with `{{message.text}}`, which resolves to the tapped
button's title.

## Retiring the previous generation

`retire.mjs` deletes the Stage 01–09 automations (cascading their
parked runs) and then the `s0N_*` templates on Meta and locally. It
refuses to run without `--yes`; deleting an approved template on Meta is
irreversible and the name is blocked for 30 days.
