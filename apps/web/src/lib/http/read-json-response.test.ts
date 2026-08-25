import { describe, expect, it } from 'vitest'

import { NonJsonResponseError, readJsonResponse } from './read-json-response'

function mk(body: string, init: { status?: number; contentType?: string } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.contentType ? { 'content-type': init.contentType } : {},
  })
}

/** Resolve with the thrown error (typed) instead of the value. */
async function failure(p: Promise<unknown>): Promise<NonJsonResponseError> {
  try {
    await p
  } catch (e) {
    return e as NonJsonResponseError
  }
  throw new Error('expected the promise to reject')
}

describe('readJsonResponse', () => {
  it('parses JSON like res.json()', async () => {
    await expect(readJsonResponse(mk('{"ok":true}', { contentType: 'application/json' }))).resolves.toEqual({
      ok: true,
    })
  })

  it('treats an empty 2xx body as {}', async () => {
    await expect(readJsonResponse(mk('', { status: 200 }))).resolves.toEqual({})
  })

  it('names a Cloudflare 524 timeout page', async () => {
    const html =
      '<!DOCTYPE html><html><head><title>crm.hyperlinq.in | 524: A timeout occurred</title></head><body>cloudflare Error code 524</body></html>'
    const err = await failure(readJsonResponse(mk(html, { status: 524, contentType: 'text/html' })))
    expect(err).toBeInstanceOf(NonJsonResponseError)
    expect(err.status).toBe(524)
    expect(err.message).toMatch(/Cloudflare timed the request out \(error 524\)/)
  })

  it('names a Cloudflare block page', async () => {
    const html = '<!DOCTYPE html><title>Attention Required! | Cloudflare</title><p>Sorry, you have been blocked</p>'
    const err = await failure(readJsonResponse(mk(html, { status: 403, contentType: 'text/html' })))
    expect(err.message).toMatch(/Cloudflare blocked this request \(403\)/)
  })

  it('describes a generic HTML error page with its status and title', async () => {
    const html = '<!DOCTYPE html><html><head><title>Internal Server Error</title></head></html>'
    const err = await failure(readJsonResponse(mk(html, { status: 500, contentType: 'text/html' })))
    expect(err.message).toBe('Server returned an HTML page instead of data (HTTP 500: Internal Server Error).')
  })

  it('reports other non-JSON bodies with status and content type', async () => {
    const err = await failure(readJsonResponse(mk('gateway down', { status: 502, contentType: 'text/plain' })))
    expect(err.message).toBe('Unexpected non-JSON response (HTTP 502, text/plain).')
  })
})
