import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { RplStream, rewriteAssets } from '../app/utils/rpl'

const dir = new URL('../../fixtures/wire/', import.meta.url)
const rpl = new Uint8Array(readFileSync(new URL('session.rpl', dir)))
const events = readFileSync(new URL('events.json', dir), 'utf8').trim()

describe('RplStream (cross-checked with the Rust writer fixture)', () => {
  it('parses the whole file at once', () => {
    const s = new RplStream()
    const frames = s.push(rpl)
    expect(s.sid).toBe('0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d')
    // arrival order 1, 0, (dup 1 skipped), truncated tail ignored
    expect(frames.map(f => f.seq)).toEqual([1, 0])
    expect(s.duplicates).toBe(1)
    expect(gunzipSync(frames[0]!.events).toString('utf8')).toBe(events)
    expect(frames[0]!.t0).toBe(1730620000123)
    expect(frames[1]!.flags & 2).toBe(2)
  })

  it('gives identical results when fed byte by byte', () => {
    const s = new RplStream()
    const out = []
    for (let i = 0; i < rpl.length; i += 7) out.push(...s.push(rpl.subarray(i, i + 7)))
    expect(out.map(f => f.seq)).toEqual([1, 0])
    expect(gunzipSync(out[1]!.events).toString('utf8')).toBe(events)
  })

  it('rejects other files', () => {
    expect(() => new RplStream().push(new Uint8Array(30))).toThrow()
  })
})

describe('rewriteAssets', () => {
  it('rewrites APK origins in plain and JSON-escaped form', () => {
    const t = '{"href":"https://localhost/_nuxt/a.css","css":"url(https:\\/\\/localhost\\/fonts\\/v.woff2)"}'
    const r = rewriteAssets(t, ['https://localhost'], 'https://terminal.fxglory.com')
    expect(r).toBe('{"href":"https://terminal.fxglory.com/_nuxt/a.css","css":"url(https:\\/\\/terminal.fxglory.com\\/fonts\\/v.woff2)"}')
    expect(rewriteAssets(t, ['https://localhost'], null)).toBe(t)
  })
})
