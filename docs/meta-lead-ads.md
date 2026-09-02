# Meta Lead Ads → Contacts

Connect a Facebook Page and every lead submitted through your Facebook /
Instagram **Lead Ads** forms is created as a contact in this CRM the
moment Meta receives it. No Zapier, no CSV export.

What happens per lead:

1. Meta POSTs a `leadgen` event for the Page to this app's webhook.
2. The app fetches the lead's answers from the Graph API with the
   Page's stored (encrypted) access token.
3. The phone answer is cleaned (the account's **Phone format → default
   country** resolves bare national numbers) and the contact is
   found-or-created by phone — the same dedupe as WhatsApp / web forms.
4. Name, email and company fill in blank fields; `source = meta_ads`.
5. The contact gets the Page's segment tag (`Meta Ads · <Page name>`),
   so `tag_added` and `new_contact_created` automations fire — e.g. an
   instant WhatsApp template to every new ad lead.
6. The lead is logged under Settings → Meta Lead Ads → Recent leads
   with campaign / ad set / ad / form names. Leads that can't become a
   contact (no phone, unparseable phone) are logged with the reason
   instead of silently dropped.

**Migration required:** `supabase/migrations/052_meta_lead_ads.sql`.

## 1. Meta app setup (once per deployment)

Use the same Meta app as WhatsApp (`META_APP_ID` / `META_APP_SECRET`).

1. **Webhooks product** → *Page* object → **Edit subscription**:
   - Callback URL: `https://<your-domain>/api/meta/leads/webhook`
     (shown, with a copy button, in Settings → Meta Lead Ads).
     Pointing the Page object at the WhatsApp callback URL
     (`/api/whatsapp/webhook`) also works — that route forwards
     `object: "page"` deliveries to the same handler.
   - Verify token: the value of `META_LEADS_WEBHOOK_VERIFY_TOKEN`. If
     unset, the app accepts `WHATSAPP_WEBHOOK_VERIFY_TOKEN` or the
     verify token of any connected WhatsApp config, so an existing
     WhatsApp webhook token can be reused.
   - Subscribe to the **`leadgen`** field.
2. `META_APP_SECRET` must be set — every webhook POST is HMAC-verified
   against it (fail-closed, same as the WhatsApp webhook).
3. For the one-click **Connect with Facebook** button, also set
   `NEXT_PUBLIC_META_APP_ID` (build-time, `apps/web/env/next-public.production`)
   and add **Facebook Login** to the app with your domain in *Valid
   OAuth Redirect URIs* / *Allowed Domains for the JavaScript SDK*.
   The button asks for:
   `pages_show_list, pages_read_engagement, pages_manage_metadata, pages_manage_ads, leads_retrieval`.
4. **Permissions.** In *Development* mode these work for Pages owned by
   the app's admins/developers/testers — enough for your own business.
   To connect Pages owned by other businesses, request **Advanced
   Access** for `leads_retrieval`, `pages_manage_metadata`,
   `pages_manage_ads` and `pages_show_list` via App Review and switch
   the app to *Live*.

## 2. Connect a Page (per workspace, admin role)

Settings → **Meta Lead Ads**:

- **Connect with Facebook** → log in → pick the Page. The server
  exchanges the login for a long-lived token, derives a non-expiring
  Page token, installs the `leadgen` subscription on the Page
  (`POST /{page}/subscribed_apps`), stores the token encrypted and
  creates the segment tag.
- **Add Page manually** if Facebook Login isn't configured: paste the
  numeric Page ID and a Page access token that carries
  `leads_retrieval`, `pages_manage_metadata`, `pages_read_engagement`
  (Business Settings → System Users → *Generate token*, or Graph API
  Explorer). The token is validated against the Page before saving.

A Page can be connected to one workspace per deployment (it's the
webhook's tenant lookup key).

## 3. Test it

Open Meta's [Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing),
choose the Page + form, **Create lead**. Within seconds it appears in
*Recent leads* and in Contacts with the Page's tag. Delete the test
lead in the tool afterwards if you re-test — Meta only sends each
`leadgen_id` once, and the CRM dedupes on it.

## 4. Sync (backfill)

**Sync** on a connected Page walks every lead form on the Page and
imports leads from the last 90 days (Meta's retention) that the CRM
hasn't seen — useful right after connecting, after downtime, or while
the App-level webhook isn't set up yet. Bounded to 300 leads per form
per click; click again for larger backlogs. Safe to repeat.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Webhook not installed" badge after connecting | `POST /{page}/subscribed_apps` failed — usually the token lacks `pages_manage_metadata`. Click **Install webhook** after fixing the token, or rely on Sync. |
| Test lead never arrives, Sync works | App-level Webhooks (step 1) not subscribed to the Page object / `leadgen`, or the callback URL isn't reachable from the internet. Check Meta's Webhooks page for delivery errors. |
| 401 in server logs on webhook POST | `META_APP_SECRET` missing or belongs to a different app than the Webhooks subscription. |
| Lead shows **No phone** | The form has no phone question, or the person skipped it. Add a phone question to the Lead Ads form. |
| Lead shows **Invalid phone** | A custom "your number" question answered without a country code. Set Settings → Phone format → default country. |
| Leads have no campaign/ad names | The Page token lacks `pages_manage_ads`; the lead is still imported with form id only. |

## Data & security

- `meta_lead_pages.page_access_token` is AES-256-GCM encrypted with
  `ENCRYPTION_KEY` (same as `whatsapp_config.access_token`) and is never
  returned by any API route.
- `meta_leads` keeps the raw `field_data` for audit; RLS grants
  members read access to their own organization's rows only. Writes
  come exclusively from the webhook / sync routes' service-role client.
- Disconnecting a Page best-effort removes the app's subscription on
  the Page and deletes the row (its lead log cascades). Contacts stay.
