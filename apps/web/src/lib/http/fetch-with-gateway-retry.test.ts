import { describe, expect, it, vi } from 'vitest'

import { fetchWithGatewayRetry } from './fetch-with-gateway-retry'

const ok = () => new Response('{"ok":true}', { status: 200 })
const gateway = (status: number) => new Response('<!DOCTYPE html>', { status })

describe('fetchWithGatewayRetry', () => {
  it('returns the first response when it is not a gateway failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    const sleep = vi.fn().mockResolvedValue(undefined)
    const res = await fetchWithGatewayRetry('/x', { method: 'POST' }, { fetchImpl, sleep })
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('does not retry a 4xx/5xx that came from the application', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"x"}', { status: 500 }))
    const res = await fetchWithGatewayRetry('/x', undefined, { fetchImpl, sleep: async () => {} })
    expect(res.status).toBe(500)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([502, 503, 504])('retries once after a %s and returns the second response', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(gateway(status)).mockResolvedValueOnce(ok())
    const sleep = vi.fn().mockResolvedValue(undefined)
    const res = await fetchWithGatewayRetry('/x', { method: 'POST' }, { fetchImpl, sleep, delayMs: 1234 })
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1234)
  })

  it('gives up after the single retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(gateway(502))
    const res = await fetchWithGatewayRetry('/x', undefined, { fetchImpl, sleep: async () => {} })
    expect(res.status).toBe(502)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry a Cloudflare 524 timeout (the request may have been processed)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(gateway(524))
    const res = await fetchWithGatewayRetry('/x', undefined, { fetchImpl, sleep: async () => {} })
    expect(res.status).toBe(524)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
