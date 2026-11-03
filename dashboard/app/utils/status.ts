// Issue status actions (T-31, PRD §6.1) shared by the issue detail page and the list's bulk bar.
import type { Issue, StatusChange } from './types'

export interface StatusAction { key: string, label: string, change: StatusChange }

const H = 3600e3

/** ignore options: forever, until a time, until N more events */
export function ignoreActions(now = Date.now()): StatusAction[] {
  return [
    { key: 'ignore', label: 'Ignore forever', change: { status: 'ignored' } },
    { key: 'ignore-1h', label: 'Ignore for 1 hour', change: { status: 'ignored', ignore_until: now + H } },
    { key: 'ignore-24h', label: 'Ignore for 24 hours', change: { status: 'ignored', ignore_until: now + 24 * H } },
    { key: 'ignore-7d', label: 'Ignore for 7 days', change: { status: 'ignored', ignore_until: now + 168 * H } },
    { key: 'ignore-10', label: 'Ignore for the next 10 events', change: { status: 'ignored', ignore_count: 10 } },
    { key: 'ignore-100', label: 'Ignore for the next 100 events', change: { status: 'ignored', ignore_count: 100 } },
  ]
}

export const resolveAction: StatusAction = { key: 'resolve', label: 'Resolve', change: { status: 'resolved' } }
export const resolveNextAction: StatusAction = { key: 'resolve-next', label: 'Resolve in next release', change: { status: 'resolved', in_next_release: true } }
export const reopenAction: StatusAction = { key: 'reopen', label: 'Reopen', change: { status: 'unresolved' } }

/** one line describing the current status, e.g. "Resolved in next release (after 1.42.0)" */
export function statusText(i: Pick<Issue, 'status' | 'resolved_in_release' | 'ignore_until' | 'ignore_until_count' | 'times_seen' | 'regressed_at'>, fmt: (ms: number) => string): string {
  if (i.status === 'resolved') return i.resolved_in_release ? `Resolved in next release (after ${i.resolved_in_release})` : 'Resolved'
  if (i.status === 'ignored') {
    if (i.ignore_until) return `Ignored until ${fmt(i.ignore_until)}`
    if (i.ignore_until_count) return `Ignored for ${Math.max(0, i.ignore_until_count - i.times_seen)} more events`
    return 'Ignored'
  }
  return i.regressed_at ? `Unresolved · regressed ${fmt(i.regressed_at)}` : 'Unresolved'
}
