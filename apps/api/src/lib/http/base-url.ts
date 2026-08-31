// ============================================================
// Derives this deployment's canonical public origin from an incoming
// request — see NEXT_PUBLIC_SITE_URL / ALLOWED_INVITE_HOSTS in
// .env.local.example for the full rationale.
//
// Any route that needs a self-referential absolute URL (an invite
// link, a public widget script's own submit URL, ...) must use this
// rather than `new URL(request.url).origin`: behind a reverse proxy —
// the normal deployment shape per docs/dokploy.md — that reflects the
// app's internal listen address (e.g. http://127.0.0.1:3000), not the
// public domain the proxy actually terminates on.
//
// Extracted from the private getBaseUrl()/parseAllowedHosts()/
// isHostAllowed() trio in api/account/invitations/route.ts, which
// predates this module and is left as its own private copy rather
// than migrated — this is for new call sites, not a behavior change
// to that already-working route.
// ============================================================

function parseAllowedHosts(): readonly string[] | null {
  const raw = process.env.ALLOWED_INVITE_HOSTS?.trim();
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function isHostAllowed(hostname: string, allowList: readonly string[] | null): boolean {
  if (!allowList) return true; // No allow-list → permissive (legacy behavior).
  return allowList.includes(hostname.toLowerCase());
}

export interface GetBaseUrlOptions {
  /** Prefix for the console.warn on a derivation failure, e.g. "[widget.js]". */
  logPrefix?: string;
  /** Returned when no usable host can be derived. Default: https://wacrm.tech. */
  fallbackUrl?: string;
}

/** Origin only — no trailing slash, no path (e.g. "https://crm.example.com"). */
export function getBaseUrl(request: Request, opts: GetBaseUrlOptions = {}): string {
  const { logPrefix = '[getBaseUrl]', fallbackUrl = 'https://wacrm.tech' } = opts;

  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const allowList = parseAllowedHosts();
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwardedHost && isHostAllowed(forwardedHost, allowList)) {
    return `${forwardedProto || 'https'}://${forwardedHost}`;
  }

  const host = request.headers.get('host')?.trim();
  if (host && isHostAllowed(host, allowList)) {
    // The protocol on `request.url` is whatever the framework saw —
    // reliable for bare deployments where no proxy is rewriting it.
    const reqProto = new URL(request.url).protocol.replace(':', '');
    return `${reqProto}://${host}`;
  }

  if (allowList && (forwardedHost || host)) {
    console.warn(`${logPrefix} rejected non-allow-listed host:`, { forwardedHost, host, allowList });
  } else {
    console.warn(`${logPrefix} could not derive base URL from request; falling back to ${fallbackUrl}`);
  }
  return fallbackUrl;
}
