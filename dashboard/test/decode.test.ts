import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { HEADER_LEN, FRAME_HEADER_LEN } from '../app/utils/rpl'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('follows a live recording using only new bytes, retaining partial frames and dedup state', async () => {
  const fixture = new Uint8Array(readFileSync(new URL('../../fixtures/wire/session.rpl', import.meta.url)))
  const length = new DataView(fixture.buffer).getUint32(HEADER_LEN, true) + FRAME_HEADER_LEN
  const first = fixture.slice(0, HEADER_LEN + length)
  const next = fixture.slice(HEADER_LEN, HEADER_LEN + length)
  new DataView(next.buffer).setUint32(4, 2, true)
  const messages: { type: string; seq?: number }[] = []
  const scope = { onmessage: null as null | ((e: { data: unknown }) => void), postMessage: (m: { type: string }) => messages.push(m) }
  vi.stubGlobal('self', scope)
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(first, { headers: { 'content-length': String(first.length) } }))
    .mockResolvedValueOnce(new Response(next.slice(0, 15), { status: 206, headers: { 'content-range': `bytes ${first.length}-${first.length+14}/${first.length+15}` } }))
    .mockResolvedValueOnce(new Response(next.slice(15), { status: 206, headers: { 'content-range': `bytes ${first.length+15}-${first.length+next.length-1}/${first.length+next.length}` } }))
    .mockResolvedValueOnce(new Response(null, { status: 416 }))
  vi.stubGlobal('fetch', fetch)
  await import('../app/workers/decode')
  scope.onmessage!({ data: { url: 'https://example.test/recording' } })
  scope.onmessage!({ data: { rewriteFrom: [], assetBase: null } })
  await vi.waitFor(() => expect(messages.filter(m => m.type === 'done')).toHaveLength(1))
  scope.onmessage!({ data: { type: 'poll' } })
  await vi.waitFor(() => expect(messages.filter(m => m.type === 'done')).toHaveLength(2))
  scope.onmessage!({ data: { type: 'poll' } })
  await vi.waitFor(() => expect(messages.filter(m => m.type === 'done')).toHaveLength(3))
  scope.onmessage!({ data: { type: 'poll' } })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
  expect(fetch.mock.calls[1]![1].headers.Range).toBe(`bytes=${first.length}-`)
  expect(fetch.mock.calls[2]![1].headers.Range).toBe(`bytes=${first.length+15}-`)
  expect(messages.filter(m => m.type === 'frame').map(m => m.seq)).toEqual([1, 2])
  expect(messages.filter(m => m.type === 'error')).toHaveLength(0)
})
