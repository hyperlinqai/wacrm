/** meta_lead_pages columns safe to return to the browser — everything
 *  except the encrypted page_access_token. Shared by every pages route. */
export const PAGE_PUBLIC_COLUMNS =
  'id, organization_id, account_id, page_id, page_name, status, webhook_subscribed, tag_id, lead_count, last_lead_at, last_synced_at, connected_by, created_at, updated_at'
