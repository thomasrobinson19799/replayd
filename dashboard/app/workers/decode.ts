/// <reference lib="webworker" />
/**
 * Player decode worker (PRD §6.2): streamed fetch of the `.rpl`, frame parsing, seq dedup, gunzip per frame
 * (DecompressionStream), asset-URL rewrite, JSON parse; events are posted progressively so playback can start
 * at the first full snapshot while the rest of a 60-minute session is still downloading.
 */
import { RplStream, rewriteAssets } from '../utils/rpl'

/** First message: start the download right away (in parallel with the session API call). */
export interface DecodeStart {
  url: string
}
/** Second message: asset rewrite settings from the session API; decoding waits for it. */
export interface DecodeConfig {
  rewriteFrom: string[]
  assetBase: string | null
}
export interface DecodePoll { type: 'poll' }

export type DecodeMsg =
  | { type: 'frame', seq: number, t0: number, t1: number, flags: number, events: unknown[] }
  | { type: 'progress', bytes: number, total: number | null }
  | { type: 'done', frames: number, duplicates: number, ms: number }
  | { type: 'error', message: string }

const post = (m: DecodeMsg) => (self as unknown as Worker).postMessage(m)

async function gunzipText(b: Uint8Array): Promise<string> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(s).text()
}

let setCfg: (c: DecodeConfig) => void = () => {}
const cfg = new Promise<DecodeConfig>((r) => {
  setCfg = r
})

let recordingUrl = ''
let busy = false
let pollPending = false
let bytes = 0
let frames = 0
const rpl = new RplStream()
self.onmessage = (e: MessageEvent<DecodeStart | DecodeConfig | DecodePoll>) => {
  if ('url' in e.data) { recordingUrl = e.data.url; void run() }
  else if ('type' in e.data) { if (busy) pollPending = true; else void run() }
  else setCfg(e.data)
}

async function run() {
  if (busy || !recordingUrl) return
  busy = true
  const t0 = performance.now()
  try {
    const res = await fetch(recordingUrl, { credentials: 'include', headers: bytes ? { Range: `bytes=${bytes}-` } : {} })
    if (res.status === 416) return // no new bytes yet
    if (!res.ok || !res.body) throw new Error(`recording: HTTP ${res.status}`)
    if (bytes && res.status !== 206) throw new Error('Recording changed; reload to continue playback.')
    const total = Number(res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length')) || null
    const reader = res.body.getReader()
    // Decode one frame at a time: backpressure bounds pending compressed frames.
    const { rewriteFrom, assetBase } = await cfg
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      for (const f of rpl.push(value)) {
        frames++
        try {
            const text = rewriteAssets(await gunzipText(f.events), rewriteFrom, assetBase)
            post({ type: 'frame', seq: f.seq, t0: f.t0, t1: f.t1, flags: f.flags, events: JSON.parse(text) })
        }
        catch {
            post({ type: 'frame', seq: f.seq, t0: f.t0, t1: f.t1, flags: f.flags | 1, events: [] })
        }
      }
      post({ type: 'progress', bytes, total })
    }
    post({ type: 'done', frames, duplicates: rpl.duplicates, ms: Math.round(performance.now() - t0) })
  }
  catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
  finally {
    busy = false
    if (pollPending) { pollPending = false; void run() }
  }
}
