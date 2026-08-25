// Parse a fetch() Response that is SUPPOSED to be JSON, and turn the
// "Unexpected token '<', \"<!DOCTYPE\"... is not valid JSON" failure
// mode into an error a human can act on.
//
// The app sits behind Cloudflare + a reverse proxy; when the upstream
// is slow (Cloudflare 524 after 100 s), restarting (502/520) or a
// request is challenged/blocked (403), the browser receives an HTML
// error page — with a perfectly valid-looking HTTP status — instead of
// our JSON. Surfacing the status and origin of that page is the
// difference between "it's broken" and "Cloudflare timed the request
// out after 100 s".

export class NonJsonResponseError extends Error {
  readonly status: number
  readonly contentType: string | null

  constructor(message: string, status: number, contentType: string | null) {
    super(message)
    this.name = 'NonJsonResponseError'
    this.status = status
    this.contentType = contentType
  }
}

function describeHtml(status: number, text: string): string {
  const cloudflare = /cloudflare/i.test(text)
  const cfCode = text.match(/Error code\s*(\d{3})|\b(52[0-9]|53[0-9])\b/)?.[1]
  const title = text.match(/<title>([^<]{1,120})<\/title>/i)?.[1]?.trim()

  if (cloudflare) {
    const code = cfCode ?? String(status)
    if (code === '524') {
      return 'Cloudflare timed the request out (error 524): the server took longer than 100 seconds to respond.'
    }
    if (code === '502' || code === '520' || code === '521' || code === '522') {
      return `Cloudflare could not reach the application server (error ${code}).`
    }
    if (status === 403) {
      return 'Cloudflare blocked this request (403). Check the WAF / firewall events in the Cloudflare dashboard.'
    }
    return `Cloudflare returned an error page (HTTP ${status}${title ? `: ${title}` : ''}).`
  }
  return `Server returned an HTML page instead of data (HTTP ${status}${title ? `: ${title}` : ''}).`
}

/**
 * `await readJsonResponse(res)` — like `res.json()`, but a non-JSON body
 * throws a NonJsonResponseError whose message says what actually came
 * back (status, and whether it was a Cloudflare/proxy error page).
 *
 * Defaults to `any`, exactly like `Response.json()`, so it is a drop-in
 * replacement at existing call sites; pass a type argument to narrow.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonResponse<T = any>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type')
  const text = await res.text()

  if (text.trim() === '') {
    if (res.ok) return {} as T
    throw new NonJsonResponseError(`Empty response (HTTP ${res.status}).`, res.status, contentType)
  }

  try {
    return JSON.parse(text) as T
  } catch {
    const looksHtml = /^\s*<(!doctype|html)/i.test(text) || /text\/html/i.test(contentType ?? '')
    const message = looksHtml
      ? describeHtml(res.status, text)
      : `Unexpected non-JSON response (HTTP ${res.status}${contentType ? `, ${contentType}` : ''}).`
    throw new NonJsonResponseError(message, res.status, contentType)
  }
}
