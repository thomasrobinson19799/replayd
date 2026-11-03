// T-25: WebSocket tab data (channels, connections, filters), synced via lastAtOrBefore like the other tabs.
import { describe, expect, it } from 'vitest'
import { channelsOf, collect, emptyPanels, lastAtOrBefore, prettyFrame, wsChannels, wsConnections, wsFilter, type RrEvent } from '../app/utils/replay'

const push = (ch: string, v: number) => JSON.stringify({ push: { channel: ch, pub: { data: { v } } } })
const ev = (ts: number, payload: Record<string, unknown>): RrEvent => ({ type: 5, timestamp: ts, data: { tag: 'ws', payload } })
const events: RrEvent[] = [
  ev(1000, { k: 'open', id: 1, url: 'wss://ws.example/connection/websocket' }),
  ev(1100, { k: 'frame', id: 1, dir: 'out', raw: '{"id":1,"connect":{"token":"[Filtered]"}}' }),
  ev(1200, { k: 'frame', id: 1, dir: 'out', raw: '{"id":2,"subscribe":{"channel":"quotes:EURUSD"}}' }),
  ev(1300, { k: 'frame', id: 1, dir: 'in', raw: [push('quotes:EURUSD', 1), push('quotes:XAUUSD', 2)].join('\n') }),
  ev(2300, { k: 'frame', id: 1, dir: 'in', raw: push('quotes:EURUSD', 3) }),
  ev(2400, { k: 'frame', id: 1, dir: 'in', raw: '{"push":{"channel":"quotes:BTC' }), // truncated at maxFrameBytes
  ev(2500, { k: 'frame', id: 1, dir: 'in', binary: true, size: 120 }),
  ev(3000, { k: 'close', id: 1, code: 1006, reason: '', wasClean: false, reconnects: 0 }),
  ev(3900, { k: 'open', id: 2, url: 'wss://ws.example/connection/websocket' }),
  ev(4000, { k: 'frame', id: 2, dir: 'in', raw: push('orders', 9) }),
]

describe('WS tab', () => {
  const p = emptyPanels()
  collect(events, p)

  it('extracts Centrifugo channels from pushes and commands, tolerating truncated frames', () => {
    expect(channelsOf([push('a', 1), push('b', 2), push('a', 3)].join('\n'))).toEqual(['a', 'b'])
    expect(channelsOf('{"id":2,"subscribe":{"channel":"quotes:EURUSD"}}')).toEqual(['quotes:EURUSD'])
    expect(channelsOf('{"push":{"channel":"quotes:BTC')).toEqual([])
    expect(p.ws[3]!.ch).toEqual(['quotes:EURUSD', 'quotes:XAUUSD'])
  })

  it('lists connections with lifecycle and frame counts; abnormal close is a timeline marker', () => {
    expect(wsConnections(p.ws)).toEqual([
      { id: 1, url: 'wss://ws.example/connection/websocket', opened: 1000, closed: 3000, code: 1006, reason: '', reconnects: 0, frames: 6, sse: false },
      { id: 2, url: 'wss://ws.example/connection/websocket', opened: 3900, frames: 1, sse: false },
    ])
    expect(p.markers).toContainEqual({ ts: 3000, kind: 'ws', label: 'WS closed (1006)' })
  })

  it('groups frames by channel and filters by connection, channel, direction and search', () => {
    expect(wsChannels(p.ws)).toEqual([['quotes:EURUSD', 3], ['orders', 1], ['quotes:XAUUSD', 1]])
    expect(wsFilter(p.ws, {}).length).toBe(10)
    expect(wsFilter(p.ws, { conn: 2 }).map((x) => x.ts)).toEqual([3900, 4000])
    expect(wsFilter(p.ws, { channel: 'quotes:EURUSD' }).map((x) => x.ts)).toEqual([1200, 1300, 2300])
    expect(wsFilter(p.ws, { dir: 'out' }).map((x) => x.ts)).toEqual([1100, 1200])
    expect(wsFilter(p.ws, { q: 'xauusd' }).map((x) => x.ts)).toEqual([1300])
    expect(wsFilter(p.ws, { conn: 1, dir: 'in', channel: 'quotes:EURUSD' }).map((x) => x.ts)).toEqual([1300, 2300])
  })

  it('syncs to the playhead and pretty-prints batched frames line by line', () => {
    const l = wsFilter(p.ws, { channel: 'quotes:EURUSD' })
    expect(lastAtOrBefore(l, 2000)).toBe(1)
    expect(lastAtOrBefore(l, 999)).toBe(-1)
    expect(prettyFrame([push('a', 1), 'not json'].join('\n'))).toBe(`${JSON.stringify(JSON.parse(push('a', 1)), null, 2)}\nnot json`)
  })
})
