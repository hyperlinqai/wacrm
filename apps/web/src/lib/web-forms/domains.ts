// Domain normalization shared by the lead-form builder (what gets saved
// into lead_forms.allowed_domains) and the public submit route (what an
// incoming Origin is compared against). Both sides MUST use the same
// rule: an operator types whatever their address bar shows, but the
// site may actually serve from the bare apex instead of "www." (or vice
// versa) — and a mismatch there silently rejected every real lead.

/**
 * Hostname only, lowercased, without scheme/port/path and without a
 * leading "www.". Returns "" for input that has no usable host.
 *
 *   "https://www.Example.com/contact" → "example.com"
 *   "www.example.com"                 → "example.com"
 *   "example.com:8080"                → "example.com"
 */
export function normalizeDomain(value: string): string {
  const raw = value.trim().toLowerCase()
  if (!raw) return ""
  let host: string
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname
  } catch {
    host = raw.replace(/^[a-z]+:\/\//, "").split(/[/:?#]/)[0]
  }
  return host.replace(/^www\./, "")
}

/** Parse the builder's comma-separated text into a deduplicated list of
 *  normalized hostnames; `null` when nothing usable was entered. */
export function parseAllowedDomains(text: string): string[] | null {
  const domains = Array.from(
    new Set(
      text
        .split(",")
        .map(normalizeDomain)
        .filter(Boolean),
    ),
  )
  return domains.length > 0 ? domains : null
}

/** Whether a request Origin is covered by a form's allow-list. An empty
 *  or missing list allows every origin. */
export function isOriginAllowed(origin: string | null, allowedDomains: string[] | null): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return true
  if (!origin) return false
  const originHost = normalizeDomain(origin)
  if (!originHost) return false
  return allowedDomains.some((d) => normalizeDomain(d) === originHost)
}
