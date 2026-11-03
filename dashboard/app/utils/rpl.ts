/**
 * Streaming `.rpl` reader (PRD §5.3) for the player's decode worker. Mirrors sdk/packages/core/src/wire.ts and
 * server/crates/common/src/rpl.rs (cross-checked against /fixtures/wire in test/rpl.test.ts).
 *
 *   header: "RPL2" | u16 version | 16-byte sid
 *   frame:  u32 len | u32 seq | u64 t0 | u64 t1 | u32 received_at | u8 flags | body
 *   body:   u32 events_len | events (gzip JSON) | u16 asset_count | { u32 id | u8 type | u32 len | bytes }…
 */

export const HEADER_LEN = 22
export const FRAME_HEADER_LEN = 29
export const FLAG_GAP = 1
export const FLAG_HAS_ERROR = 2
const MAX_FRAME = 4 * 1024 * 1024

export interface RplFrame {
  seq: number
  t0: number
  t1: number
  receivedAt: number
  flags: number
  events: Uint8Array
  assets: { id: number, type: number, data: Uint8Array }[]
}

function uuid(b: Uint8Array): string {
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function parseBody(b: Uint8Array): Pick<RplFrame, 'events' | 'assets'> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const need = (p: number, n: number) => {
    if (p + n > b.length) throw new RangeError('truncated body')
  }
  let p = 0
  need(p, 4)
  const el = dv.getUint32(p, true)
  p += 4
  need(p, el)
  const events = b.slice(p, p + el)
  p += el
  need(p, 2)
  const n = dv.getUint16(p, true)
  p += 2
  const assets: RplFrame['assets'] = []
  for (let i = 0; i < n; i++) {
    need(p, 9)
    const id = dv.getUint32(p, true)
    const type = b[p + 4]!
    const len = dv.getUint32(p + 5, true)
    p += 9
    need(p, len)
    assets.push({ id, type, data: b.slice(p, p + len) })
    p += len
  }
  return { events, assets }
}

/** Incremental parser: feed network chunks, get complete frames back. Memory stays ~ one frame + one chunk. */
export class RplStream {
  sid: string | null = null
  private buf = new Uint8Array(256 * 1024)
  private len = 0
  private pos = 0
  private seen = new Set<number>()
  duplicates = 0

  push(chunk: Uint8Array): RplFrame[] {
    this.append(chunk)
    const out: RplFrame[] = []
    if (this.sid === null) {
      if (this.len - this.pos < HEADER_LEN) return out
      const b = this.buf
      if (b[0] !== 0x52 || b[1] !== 0x50 || b[2] !== 0x4c || b[3] !== 0x32) throw new Error('not an .rpl file')
      const v = b[4]! | (b[5]! << 8)
      if (v !== 1) throw new Error(`unsupported .rpl version ${v}`)
      this.sid = uuid(b.subarray(6, 22))
      this.pos = HEADER_LEN
    }
    const dv = new DataView(this.buf.buffer)
    while (this.len - this.pos >= FRAME_HEADER_LEN) {
      const p = this.pos
      const len = dv.getUint32(p, true)
      if (len > MAX_FRAME) throw new Error('corrupt frame')
      if (this.len - p < FRAME_HEADER_LEN + len) break
      const seq = dv.getUint32(p + 4, true)
      const body = this.buf.subarray(p + FRAME_HEADER_LEN, p + FRAME_HEADER_LEN + len)
      this.pos = p + FRAME_HEADER_LEN + len
      if (this.seen.has(seq)) {
        this.duplicates++
        continue
      }
      this.seen.add(seq)
      out.push({
        seq,
        t0: Number(dv.getBigUint64(p + 8, true)),
        t1: Number(dv.getBigUint64(p + 16, true)),
        receivedAt: dv.getUint32(p + 24, true),
        flags: this.buf[p + 28]!,
        ...parseBody(body),
      })
    }
    return out
  }

  private append(c: Uint8Array) {
    // compact consumed bytes first
    if (this.pos > 0 && this.pos === this.len) {
      this.len = this.pos = 0
    }
    else if (this.pos > this.buf.length / 2) {
      this.buf.copyWithin(0, this.pos, this.len)
      this.len -= this.pos
      this.pos = 0
    }
    if (this.len + c.length > this.buf.length) {
      let n = this.buf.length
      while (n < this.len + c.length) n *= 2
      const nb = new Uint8Array(n)
      nb.set(this.buf.subarray(0, this.len))
      this.buf = nb
    }
    this.buf.set(c, this.len)
    this.len += c.length
  }
}

/** Rewrites build-time origins (e.g. `https://localhost/` inside the APK) to the asset base URL (§5.3). */
export function rewriteAssets(text: string, from: string[], base: string | null): string {
  if (!base) return text
  const b = base.endsWith('/') ? base : `${base}/`
  let t = text
  for (const f of from) {
    const o = f.endsWith('/') ? f : `${f}/`
    if (o !== b && t.includes(o)) t = t.split(o).join(b)
    // JSON-escaped form (`https:\/\/localhost\/`)
    const esc = o.replaceAll('/', '\\/')
    if (t.includes(esc)) t = t.split(esc).join(b.replaceAll('/', '\\/'))
  }
  return t
}
