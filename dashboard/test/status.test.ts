// T-31: status labels + actions
import { describe, expect, it } from 'vitest'
import { ignoreActions, resolveNextAction, statusText } from '../app/utils/status'

const fmt = (ms: number) => `@${ms}`
const base = { status: 'unresolved' as const, resolved_in_release: null, ignore_until: null, ignore_until_count: null, times_seen: 7, regressed_at: null }

describe('issue status', () => {
  it('describes every state', () => {
    expect(statusText(base, fmt)).toBe('Unresolved')
    expect(statusText({ ...base, regressed_at: 5 }, fmt)).toBe('Unresolved · regressed @5')
    expect(statusText({ ...base, status: 'resolved' }, fmt)).toBe('Resolved')
    expect(statusText({ ...base, status: 'resolved', resolved_in_release: '1.42.0' }, fmt)).toBe('Resolved in next release (after 1.42.0)')
    expect(statusText({ ...base, status: 'ignored' }, fmt)).toBe('Ignored')
    expect(statusText({ ...base, status: 'ignored', ignore_until: 9 }, fmt)).toBe('Ignored until @9')
    expect(statusText({ ...base, status: 'ignored', ignore_until_count: 17 }, fmt)).toBe('Ignored for 10 more events')
  })
  it('builds the PATCH bodies', () => {
    expect(resolveNextAction.change).toEqual({ status: 'resolved', in_next_release: true })
    const a = ignoreActions(1000)
    expect(a.map((x) => x.change)).toEqual([
      { status: 'ignored' },
      { status: 'ignored', ignore_until: 1000 + 3600e3 },
      { status: 'ignored', ignore_until: 1000 + 24 * 3600e3 },
      { status: 'ignored', ignore_until: 1000 + 168 * 3600e3 },
      { status: 'ignored', ignore_count: 10 },
      { status: 'ignored', ignore_count: 100 },
    ])
  })
})
