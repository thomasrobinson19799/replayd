// Turns recorded rrweb events into the player's side-panel lists and timeline markers.

export interface RrEvent {
  type: number
  timestamp: number
  data: Record<string, unknown> & { tag?: string, payload?: Record<string, unknown>, href?: string, source?: number }
}

export interface ConsoleItem { ts: number, level: string, text: string }
export interface NetworkItem {
  ts: number
  method: string
  url: string
  status: number
  duration: number
  type?: 'fetch' | 'xhr'
  detail: Record<string, unknown>
}
export interface ErrorItem { ts: number, level: string, title: string, issueId?: number }
export interface CrumbItem { ts: number, cat: string, msg: string }
export interface FieldChange { ts: number, field: 'user' | 'custom_fields', text: string }
export interface WsItem { ts: number, k: string, id: number, url?: string, dir?: string, raw?: string, binary?: boolean, size?: number, code?: number, ch: string[], data: Record<string, unknown> }
export type MarkerKind = 'error' | 'warning' | 'ws' | 'nav' | 'app' | 'gap'
export interface Marker { ts: number, kind: MarkerKind, label: string }

export interface Panels {
  console: ConsoleItem[]
  network: NetworkItem[]
  errors: ErrorItem[]
  crumbs: CrumbItem[]
  ws: WsItem[]
  markers: Marker[]
  fields: FieldChange[]
}

export const emptyPanels = (): Panels => ({ console: [], network: [], errors: [], crumbs: [], ws: [], markers: [], fields: [] })

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))

/** Appends the panel items found in `events` (any order) into `p`. */
export function collect(events: RrEvent[], p: Panels): void {
  for (const e of events) {
    if (e.type === 4 && typeof e.data.href === 'string') {
      p.crumbs.push({ ts: e.timestamp, cat: 'nav', msg: e.data.href })
      continue
    }
    if (e.type !== 5) continue
    const tag = e.data.tag
    const d = (e.data.payload ?? {}) as Record<string, unknown>
    const ts = e.timestamp
    switch (tag) {
      case 'fields':
        if (d.field === 'user' || d.field === 'custom_fields') p.fields.push({ ts, field: d.field, text: str(d.value) })
        break
      case 'console': {
        const args = Array.isArray(d.args) ? d.args.map(str).join(' ') : str(d.args)
        p.console.push({ ts, level: str(d.level) || 'log', text: args })
        break
      }
      case 'network': {
        const { method, url, status, duration, type, ...rest } = d
        p.network.push({ ts: typeof d.start === 'number' ? d.start : ts, method: str(method), url: str(url), status: Number(status ?? 0), duration: Number(duration ?? 0), type: type === 'fetch' || type === 'xhr' ? type : undefined, detail: rest })
        break
      }
      case 'error': {
        const level = str(d.level) || 'error'
        const title = `${d.type ? `${str(d.type)}: ` : ''}${str(d.message)}`
        p.errors.push({ ts, level, title })
        p.markers.push({ ts, kind: level === 'warning' ? 'warning' : 'error', label: title })
        break
      }
      case 'nav':
        p.crumbs.push({ ts, cat: 'nav', msg: `${str(d.from)} → ${str(d.to)}` })
        p.markers.push({ ts, kind: 'nav', label: str(d.to) })
        break
      case 'breadcrumb':
        p.crumbs.push({ ts, cat: str(d.cat) || 'custom', msg: str(d.msg) })
        break
      case 'app':
        p.crumbs.push({ ts, cat: 'app', msg: str(d.event ?? d.k ?? d.state) })
        p.markers.push({ ts, kind: 'app', label: str(d.event ?? d.k ?? d.state) })
        break
      case 'gap':
        p.markers.push({ ts, kind: 'gap', label: `data dropped${d.reason ? `: ${str(d.reason)}` : ''}` })
        break
      case 'ws': {
        const item: WsItem = { ts, k: str(d.k), id: Number(d.id ?? 0), ch: [], data: d }
        if (typeof d.url === 'string') item.url = d.url
        if (typeof d.dir === 'string') item.dir = d.dir
        if (typeof d.raw === 'string') {
          item.raw = d.raw
          item.ch = channelsOf(d.raw)
        }
        if (d.binary) {
          item.binary = true
          item.size = Number(d.size ?? 0)
        }
        if (typeof d.code === 'number') item.code = d.code
        p.ws.push(item)
        if (item.k === 'close' && item.code !== 1000 && item.code !== 1001) {
          p.markers.push({ ts, kind: 'ws', label: `WS closed (${item.code ?? '?'})` })
        }
        break
      }
    }
  }
}

/** Sort all lists by time (call after each batch; cheap for append-mostly data). */
export function sortPanels(p: Panels): void {
  for (const k of ['console', 'network', 'errors', 'crumbs', 'ws', 'markers', 'fields'] as const) {
    const a = p[k] as { ts: number }[]
    for (let i = 1; i < a.length; i++) {
      if (a[i - 1]!.ts > a[i]!.ts) {
        a.sort((x, y) => x.ts - y.ts)
        break
      }
    }
  }
}

/** Index of the last item with ts ≤ t (binary search), -1 if none. */
export function lastAtOrBefore(items: { ts: number }[], t: number): number {
  let lo = 0
  let hi = items.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid]!.ts <= t) {
      ans = mid
      lo = mid + 1
    }
    else hi = mid - 1
  }
  return ans
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export interface NetworkFilter { method?: string, status?: string, type?: string, slower?: number, q?: string, failed?: boolean }
export function networkFilter(items: NetworkItem[], f: NetworkFilter): NetworkItem[] {
  const q = f.q?.trim().toLowerCase()
  return items.filter(it =>
    (!f.method || it.method.toUpperCase() === f.method) &&
    (!f.status || (f.status === 'failed' ? it.status === 0 : Math.floor(it.status / 100) === Number(f.status))) &&
    (!f.type || it.type === f.type) &&
    (!f.slower || it.duration > f.slower) &&
    (!f.failed || it.status === 0 || it.status >= 400) &&
    (!q || `${it.method} ${it.url} ${it.status}`.toLowerCase().includes(q)),
  )
}

/**
 * Centrifugo channels of a (possibly newline-batched) JSON frame: `push.channel` of incoming pushes,
 * `subscribe/unsubscribe/publish.channel` of outgoing commands. Truncated / non-JSON lines are skipped.
 */
export function channelsOf(raw: string): string[] {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    let m: Record<string, { channel?: unknown } | undefined>
    try {
      m = JSON.parse(line)
    }
    catch {
      continue
    }
    if (!m || typeof m !== 'object') continue
    for (const k of ['push', 'subscribe', 'unsubscribe', 'publish', 'presence', 'history']) {
      const c = m[k]?.channel
      if (typeof c === 'string' && !out.includes(c)) out.push(c)
    }
  }
  return out
}

export interface WsConn { id: number, url: string, opened?: number, closed?: number, code?: number, reason?: string, reconnects?: number, frames: number, sse: boolean }

/** one row per socket id with its lifecycle (open / close code / duration) and frame count */
export function wsConnections(items: WsItem[]): WsConn[] {
  const m = new Map<number, WsConn>()
  for (const it of items) {
    let c = m.get(it.id)
    if (!c) m.set(it.id, (c = { id: it.id, url: it.url ?? '', frames: 0, sse: !!it.data.sse }))
    if (it.url && !c.url) c.url = it.url
    if (it.k === 'open') c.opened = it.ts
    else if (it.k === 'close') {
      c.closed = it.ts
      c.code = it.code
      c.reason = typeof it.data.reason === 'string' ? it.data.reason : undefined
      c.reconnects = typeof it.data.reconnects === 'number' ? it.data.reconnects : undefined
    }
    else if (it.k === 'frame') c.frames++
  }
  return [...m.values()].sort((a, b) => a.id - b.id)
}

export interface WsFilter { conn?: number | null, channel?: string, dir?: '' | 'in' | 'out', q?: string, framesOnly?: boolean }

/** WS tab list: lifecycle + frames filtered by connection, channel, direction and a case-insensitive search */
export function wsFilter(items: WsItem[], f: WsFilter): WsItem[] {
  const q = f.q?.trim().toLowerCase()
  return items.filter((it) => {
    if (f.conn != null && it.id !== f.conn) return false
    if (it.k !== 'frame') return !f.framesOnly && !f.channel && !f.dir && !q
    if (f.dir && it.dir !== f.dir) return false
    if (f.channel && !it.ch.includes(f.channel)) return false
    if (q && !(it.raw ?? '').toLowerCase().includes(q)) return false
    return true
  })
}

/** channel → frame count, most frequent first */
export function wsChannels(items: WsItem[]): [string, number][] {
  const m = new Map<string, number>()
  for (const it of items) for (const c of it.ch) m.set(c, (m.get(c) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** pretty-prints each JSON line of a frame (newline-batched Centrifugo frames stay one per line) */
export function prettyFrame(raw: string): string {
  return raw.split('\n').map((l) => {
    try {
      return JSON.stringify(JSON.parse(l), null, 2)
    }
    catch {
      return l
    }
  }).join('\n')
}
