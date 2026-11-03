/** "3m ago", "2h ago", "5d ago". */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { hour12: false })
}

export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function platformLabel(p: string): string {
  return p === 'capacitor-android' ? 'APK' : p === 'web' ? 'Web' : p
}

/** Best error message from an unknown thrown value (ofetch errors carry data.error). */
export function errorMessage(e: unknown): string {
  const any = e as { data?: { error?: string }, statusMessage?: string, message?: string }
  return any?.data?.error ?? any?.statusMessage ?? any?.message ?? 'Request failed'
}

/** 1h 02m / 4m 05s / 12s */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

/** Path + query of a URL, for compact display. */
export function shortUrl(u: string | null): string {
  if (!u) return ''
  try {
    const x = new URL(u)
    return x.pathname + x.search
  }
  catch {
    return u
  }
}
