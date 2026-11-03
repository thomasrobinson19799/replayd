/// <reference lib="webworker" />
/**
 * Player decode worker (PRD §6.2): streamed fetch of the `.rpl`, frame parsing, seq dedup, gunzip per frame
 * (DecompressionStream), asset-URL rewrite, JSON parse; events are posted progressively so playback can start
 * at the first full snapshot while the rest of a 60-minute session is still downloading.
 */
import { RplStream, rewriteAssets } from '../utils/rpl'

export interface DecodeStart {
  url: string
  rewriteFrom: string[]
  assetBase: string | null
}

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

self.onmessage = async (e: MessageEvent<DecodeStart>) => {
  const { url, rewriteFrom, assetBase } = e.data
  const t0 = performance.now()
  try {
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok || !res.body) throw new Error(`recording: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || null
    const reader = res.body.getReader()
    const rpl = new RplStream()
    let bytes = 0
    let frames = 0
    // frames are decoded in arrival order; gunzip of one frame overlaps the network read of the next
    let chain: Promise<void> = Promise.resolve()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      for (const f of rpl.push(value)) {
        frames++
        chain = chain.then(async () => {
          try {
            const text = rewriteAssets(await gunzipText(f.events), rewriteFrom, assetBase)
            post({ type: 'frame', seq: f.seq, t0: f.t0, t1: f.t1, flags: f.flags, events: JSON.parse(text) })
          }
          catch {
            post({ type: 'frame', seq: f.seq, t0: f.t0, t1: f.t1, flags: f.flags | 1, events: [] })
          }
        })
      }
      post({ type: 'progress', bytes, total })
    }
    await chain
    post({ type: 'done', frames, duplicates: rpl.duplicates, ms: Math.round(performance.now() - t0) })
  }
  catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
