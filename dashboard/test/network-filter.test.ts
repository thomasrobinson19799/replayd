import { describe, expect, it } from 'vitest'
import { collect, emptyPanels, networkFilter, type NetworkItem } from '../app/utils/replay'

const row = (method: string, status: number, duration: number, type?: 'fetch' | 'xhr'): NetworkItem => ({ ts: 1, method, status, duration, type, url: '/api/orders', detail: {} })
const items = [row('GET', 200, 500, 'fetch'), row('POST', 500, 1500, 'xhr'), row('POST', 0, 6000, 'fetch'), row('HEAD', 304, 4000)]
describe('network filters', () => {
  it('combines each dropdown, text and failed-only with AND', () => {
    expect(networkFilter(items, { method: 'POST' })).toEqual(items.slice(1, 3))
    expect(networkFilter(items, { status: '3' })).toEqual([items[3]])
    expect(networkFilter(items, { status: 'failed' })).toEqual([items[2]])
    expect(networkFilter(items, { type: 'xhr' })).toEqual([items[1]])
    expect(networkFilter(items, { slower: 500 })).toEqual(items.slice(1))
    expect(networkFilter(items, { slower: 1000, failed: true, method: 'POST', status: '5', type: 'xhr', q: 'ORDERS' })).toEqual([items[1]])
    expect(networkFilter(items, { failed: true, q: 'missing' })).toEqual([])
    expect(networkFilter(items, { method: '', status: '', type: '', slower: 0 })).toEqual(items)
  })
  it('parses known request types and leaves older or unknown types under all only', () => {
    const panels = emptyPanels()
    collect(['fetch', 'xhr', undefined, 'unknown'].map(type => ({ type: 5, timestamp: 1, data: { tag: 'network', payload: { method: 'GET', type } } })), panels)
    expect(networkFilter(panels.network, {}).length).toBe(4)
    expect(networkFilter(panels.network, { type: 'fetch' }).length).toBe(1)
    expect(networkFilter(panels.network, { type: 'xhr' }).length).toBe(1)
  })
})
