/**
 * Replay segment wire format (PRD §4.10) and `.rpl` reader (PRD §5.3). Little-endian.
 *
 *   body:  u16 meta_len | meta JSON | u32 events_len | events (gzip) | u16 asset_count | assets…
 *   asset: u32 asset_id | u8 type (1 = webp) | u32 len | bytes
 *   .rpl:  "RPL2" | u16 version | 16-byte sid, then frames:
 *          u32 len | u32 seq | u64 t0 | u64 t1 | u32 received_at | u8 flags | body-without-meta
 *
 * Mirrors server/crates/common/src/{wire,rpl}.rs; cross-checked by fixtures in /fixtures/wire.
 */

export const ASSET_WEBP = 1;
export const RPL_HEADER_LEN = 22;
export const RPL_FRAME_HEADER_LEN = 29;
export const RPL_FLAG_GAP = 1;
export const RPL_FLAG_HAS_ERROR = 2;
export const RPL_FLAG_REDACTED = 4;

export interface WireAsset {
  id: number;
  type: number;
  data: Uint8Array;
}

const te = /* @__PURE__ */ new TextEncoder();

/** Encodes a replay segment body. `metaJson` must be a JSON object string; `eventsGz` gzip bytes. */
export function encodeSegment(metaJson: string, eventsGz: Uint8Array, assets: WireAsset[] = []): Uint8Array {
  const meta = te.encode(metaJson);
  if (meta.length > 32 * 1024) throw new RangeError('meta too large');
  let size = 2 + meta.length + 4 + eventsGz.length + 2;
  for (const a of assets) size += 9 + a.data.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint16(p, meta.length, true); p += 2;
  out.set(meta, p); p += meta.length;
  dv.setUint32(p, eventsGz.length, true); p += 4;
  out.set(eventsGz, p); p += eventsGz.length;
  dv.setUint16(p, assets.length, true); p += 2;
  for (const a of assets) {
    dv.setUint32(p, a.id, true); p += 4;
    out[p++] = a.type;
    dv.setUint32(p, a.data.length, true); p += 4;
    out.set(a.data, p); p += a.data.length;
  }
  return out;
}

export interface StoredBody {
  events: Uint8Array;
  assets: WireAsset[];
}

/** Parses a body-without-meta (as stored in a `.rpl` frame). Throws on malformed input. */
export function parseStoredBody(b: Uint8Array): StoredBody {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const need = (p: number, n: number) => {
    if (p + n > b.length) throw new RangeError('truncated body');
  };
  let p = 0;
  need(p, 4);
  const el = dv.getUint32(p, true); p += 4;
  need(p, el);
  const events = b.subarray(p, p + el); p += el;
  need(p, 2);
  const n = dv.getUint16(p, true); p += 2;
  const assets: WireAsset[] = [];
  for (let i = 0; i < n; i++) {
    need(p, 9);
    const id = dv.getUint32(p, true);
    const type = b[p + 4]!;
    const len = dv.getUint32(p + 5, true);
    p += 9;
    need(p, len);
    assets.push({ id, type, data: b.subarray(p, p + len) });
    p += len;
  }
  if (p !== b.length) throw new RangeError('trailing bytes');
  return { events, assets };
}

/** Splits a full segment body into meta JSON text and the stored body. */
export function splitSegment(b: Uint8Array): { meta: string; body: Uint8Array } {
  if (b.length < 2) throw new RangeError('truncated');
  const ml = b[0]! | (b[1]! << 8);
  if (2 + ml > b.length) throw new RangeError('truncated meta');
  return { meta: new TextDecoder().decode(b.subarray(2, 2 + ml)), body: b.subarray(2 + ml) };
}

export interface RplFrame {
  seq: number;
  t0: number;
  t1: number;
  receivedAt: number;
  flags: number;
  body: Uint8Array;
}

export interface RplIndex {
  sid: string;
  frames: RplFrame[];
  validLen: number;
  duplicates: number;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Formats 16 raw bytes as a UUID string. */
export function uuidFromBytes(b: Uint8Array): string {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Indexes an `.rpl` buffer: ignores a truncated tail, keeps the first copy of each seq, sorts by seq.
 * Works on partial (streamed) buffers too: `validLen` tells how far complete frames go.
 */
export function indexRpl(buf: Uint8Array): RplIndex {
  if (buf.length < RPL_HEADER_LEN) throw new RangeError('short');
  if (buf[0] !== 0x52 || buf[1] !== 0x50 || buf[2] !== 0x4c || buf[3] !== 0x32) throw new Error('bad magic');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== 1) throw new Error(`unsupported version ${version}`);
  const sid = uuidFromBytes(buf.subarray(6, 22));
  const frames: RplFrame[] = [];
  let p = RPL_HEADER_LEN;
  while (p + RPL_FRAME_HEADER_LEN <= buf.length) {
    const len = dv.getUint32(p, true);
    const end = p + RPL_FRAME_HEADER_LEN + len;
    if (len > 4 * 1024 * 1024 || end > buf.length) break;
    frames.push({
      seq: dv.getUint32(p + 4, true),
      t0: Number(dv.getBigUint64(p + 8, true)),
      t1: Number(dv.getBigUint64(p + 16, true)),
      receivedAt: dv.getUint32(p + 24, true),
      flags: buf[p + 28]!,
      body: buf.subarray(p + RPL_FRAME_HEADER_LEN, end),
    });
    p = end;
  }
  frames.sort((a, b) => a.seq - b.seq); // stable: first copy of a seq stays first
  const out: RplFrame[] = [];
  for (const f of frames) if (out.length === 0 || out[out.length - 1]!.seq !== f.seq) out.push(f);
  return { sid, frames: out, validLen: p, duplicates: frames.length - out.length };
}
