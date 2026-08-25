// fetch() that retries ONCE when the response is a gateway-level
// failure (502/503/504) — the reverse proxy could not reach the app at
// all, which is what a redeploy window looks like from the browser:
// Dokploy stops the old container and starts the new one, and for a
// few seconds Traefik answers 502 for every request. The request never
// reached the application, so replaying it is safe even for
// non-idempotent calls like "submit template to Meta". A 524 (Cloudflare
// timeout) is deliberately NOT retried: the app may still be processing
// the original request.

export const GATEWAY_RETRY_STATUSES = new Set([502, 503, 504])

export interface GatewayRetryOptions {
  /** Delay before the single retry. Default 4 s — long enough for a
   *  container to come up, short enough to feel like a slow request. */
  delayMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  fetchImpl?: typeof fetch
}

export async function fetchWithGatewayRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: GatewayRetryOptions = {},
): Promise<Response> {
  const {
    delayMs = 4000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchImpl = fetch,
  } = opts

  const first = await fetchImpl(input, init)
  if (!GATEWAY_RETRY_STATUSES.has(first.status)) return first

  await sleep(delayMs)
  return fetchImpl(input, init)
}
