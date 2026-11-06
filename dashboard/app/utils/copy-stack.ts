import type { Frame, IssueEvent } from './types'

export const COPY_BREADCRUMBS = 30
export function visibleFrames(frames: Frame[], inAppOnly: boolean): Frame[] {
  return inAppOnly && frames.some(f => f.in_app) ? frames.filter(f => f.in_app) : frames
}

/** Explicit allowlist: identity, custom fields, tags and arbitrary context never enter the export. */
export function copyStack(event: IssueEvent, inAppOnly: boolean): string {
  const p = event.payload
  const lines = [`${p.type || 'Error'}: ${p.message}`, '']
  const frames = visibleFrames(p.frames ?? [], inAppOnly)
  if (frames.length) {
    for (const f of frames) {
      const o = f.orig
      const location = o ? `${o.file}:${o.line}:${o.col}` : f.path || f.url ? `${f.path || f.url}:${f.line}:${f.col}` : '[native code]'
      lines.push(`    at ${o?.function || f.function || '<anonymous>'} (${location})`)
      if (o?.context !== undefined) {
        for (const [i, text] of (o.pre ?? []).entries()) lines.push(`      ${o.line - (o.pre?.length ?? 0) + i} | ${text}`)
        lines.push(`    > ${o.line} | ${o.context}`)
        for (const [i, text] of (o.post ?? []).entries()) lines.push(`      ${o.line + i + 1} | ${text}`)
      }
    }
  } else if (p.stack) lines.push(p.stack)
  else lines.push('No stack trace recorded.')
  lines.push('')
  const app = p.ctx?.app
  const rows: [string, unknown][] = [
    ['Release', event.release], ['Environment', event.environment], ['Platform', event.platform],
    ['Browser', [event.browser, p.browser_ver].filter(Boolean).join(' ')], ['OS', event.os],
    ['Device', app?.device], ['WebView', app?.webview], ['App version', event.app_version], ['URL', event.url],
  ]
  for (const [key, value] of rows) if (typeof value === 'string' && value) lines.push(`${key}: ${value}`)
  for (const [name, keys] of [['http', ['method', 'url', 'status', 'ms']], ['ws', ['url', 'code', 'reconnects']]] as const) {
    const context = p.ctx?.[name]
    if (!context) continue
    const selected = Object.fromEntries(keys.filter(k => ['string', 'number', 'boolean'].includes(typeof context[k])).map(k => [k, context[k]]))
    lines.push(`${name.toUpperCase()}: ${JSON.stringify(selected)}`)
  }
  for (const key of ['component', 'info']) {
    const value: unknown = p.ctx?.[key]
    if (typeof value === 'string') lines.push(`${key}: ${value}`)
  }
  const crumbs = (p.breadcrumbs ?? []).slice(-COPY_BREADCRUMBS)
  if (crumbs.length) {
    lines.push('', `Recent breadcrumbs (${crumbs.length}):`)
    for (const b of crumbs) {
      const time = new Date(b.ts)
      lines.push(`${Number.isNaN(time.getTime()) ? 'Unknown time' : time.toISOString()} [${b.cat}] ${b.msg}`)
    }
  }
  return lines.join('\n')
}
