// T-01 spike glue: prototype of the replay chunk. Bench-only (instrumented rrweb build).
// throttle modes: 'none' | 'emit' (filter rrweb output, PRD v2 idea) | 'hook' (prefilter MutationRecords before rrweb).
import { record } from '@rrweb/record';

const T = (globalThis.__rpT = { mo: [], flush: [], snapshotMs: 0, events: 0, rawBytes: 0, gzBytes: 0, segments: 0, droppedTexts: 0, coalescedEmitted: 0, guardSnapshots: 0 });
const MASK_SEL = '.rr-mask,[data-rp-mask]';

const workerSrc = `
let buf = [];
onmessage = async (e) => {
  if (e.data === 'flush') {
    const json = JSON.stringify(buf); buf = [];
    const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    postMessage({ raw: json.length, gz: gz.byteLength });
    return;
  }
  if (e.data.ids) {
    const { ids, vals, ts } = e.data; const parts = vals.split('\\u0000'); const texts = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) texts[i] = { id: ids[i], value: parts[i] };
    buf.push({ type: 3, data: { source: 0, texts, attributes: [], removes: [], adds: [] }, timestamp: ts });
    return;
  }
  for (const ev of e.data) buf.push(ev);
};`;

export function start({ throttle = 'none', guard = 10_000 } = {}) {
  if (throttle === true) throttle = 'hook';
  if (throttle === false) throttle = 'none';
  const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
  worker.onmessage = (e) => { T.rawBytes += e.data.raw; T.gzBytes += e.data.gz; T.segments++; };
  let buf = [];
  const mirror = record.mirror; globalThis.__rpMirror = mirror;

  // --- throttle state
  let parentInfo = new WeakMap(); // parent element -> 0 (not throttled) | ms (negative = masked)
  let replayTextId = new WeakMap(); // parent element -> mirror id of the text node the replayer still shows
  const pendingText = new Map(); // Text node -> parent info (characterData changes)
  const pendingParent = new Set(); // parents whose single text child was swapped (childList)
  const infoOf = (p) => {
    let v = parentInfo.get(p);
    if (v === undefined) {
      const host = p.closest?.('[data-rp-throttle]');
      v = host ? (+host.getAttribute('data-rp-throttle') || 0) : 0;
      if (v && p.closest(MASK_SEL)) v = -v;
      parentInfo.set(p, v);
    }
    return v;
  };
  const allText = (list) => { for (let i = 0; i < list.length; i++) if (list[i].nodeType !== 3) return false; return true; };

  if (throttle === 'hook') globalThis.__rpMutationHook = (muts) => {
    let out = null;
    if (guard) {
      let added = 0;
      for (let i = 0; i < muts.length; i++) if (muts[i].type === 'childList') added += muts[i].addedNodes.length;
      if (added > guard) { T.guardSnapshots++; record.takeFullSnapshot(true); return []; }
    }
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      let drop = false;
      if (m.type === 'characterData') {
        const p = m.target.parentNode;
        if (p) { const info = infoOf(p); if (info) { pendingText.set(m.target, info); drop = true; } }
      } else if (m.type === 'childList') {
        const p = m.target;
        if (p.nodeType === 1 && infoOf(p) && p.childNodes.length <= 1 && allText(m.addedNodes) && allText(m.removedNodes)) {
          if (!replayTextId.has(p)) {
            const r = m.removedNodes[0]; const id = r ? mirror.getId(r) : -1;
            if (id < 0) drop = false; else { replayTextId.set(p, id); drop = true; }
          } else drop = true;
          if (drop) pendingParent.add(p);
        }
      }
      if (drop) { T.droppedTexts++; if (out === null) out = muts.slice(0, i); }
      else if (out !== null) out.push(m);
    }
    return out ?? muts;
  };

  let tick = 0;
  const flushThrottled = () => {
    tick++;
    const total = pendingText.size + pendingParent.size;
    if (!total) return;
    const ids = new Int32Array(total); let n = 0; let vals = '';
    for (const [t, info] of pendingText) {
      const id = mirror.getId(t); // -1 once rrweb processed the node's removal
      if (id < 0) { pendingText.delete(t); continue; }
      const k = (info < 0 ? -info : info) / 500 | 0;
      if (k > 1 && id % k !== tick % k) continue; // staggered: each node at most once per N ms
      pendingText.delete(t);
      const v = t.nodeValue;
      vals += (n ? '\u0000' : '') + (info < 0 ? v.replace(/\S/g, '*') : v); ids[n++] = id;
    }
    for (const p of pendingParent) {
      const id = replayTextId.get(p);
      if (id === undefined || !p.isConnected) { pendingParent.delete(p); continue; }
      const info = infoOf(p); const k = Math.abs(info) / 500 | 0;
      if (k > 1 && id % k !== tick % k) continue;
      pendingParent.delete(p);
      const v = p.textContent;
      vals += (n ? '\u0000' : '') + (info < 0 ? v.replace(/\S/g, '*') : v); ids[n++] = id;
    }
    T.coalescedEmitted += n;
    if (!n) return;
    const pm0 = performance.now();
    if (buf.length) { const b = buf; buf = []; worker.postMessage(b); } // keep event order
    const sub = n === total ? ids : ids.slice(0, n);
    worker.postMessage({ ids: sub, vals, ts: Date.now() }, [sub.buffer]);
    (T.pm ??= []).push([performance.now() - pm0, n]);
  };

  // --- 'emit' mode (post-filter) state
  const emitCache = new Map(); const emitPending = new Map();

  const emit = (ev, isCheckout) => {
    if (ev.type === 2) { parentInfo = new WeakMap(); replayTextId = new WeakMap(); emitCache.clear(); pendingText.clear(); pendingParent.clear(); }
    if (throttle === 'emit' && ev.type === 3 && ev.data.source === 0 && ev.data.texts.length) {
      const texts = ev.data.texts; let w = 0;
      for (const t of texts) {
        let ms = emitCache.get(t.id);
        if (ms === undefined) { const n = mirror.getNode(t.id); const h = n && (n.parentElement ?? n).closest?.('[data-rp-throttle]'); ms = h ? 1 : 0; emitCache.set(t.id, ms); }
        if (ms) { emitPending.set(t.id, t.value); T.droppedTexts++; } else texts[w++] = t;
      }
      texts.length = w;
      const d = ev.data;
      if (!w && !d.adds.length && !d.removes.length && !d.attributes.length) return;
    }
    T.events++;
    buf.push(ev);
  };
  const t0 = performance.now();
  record({
    emit,
    checkoutEveryNms: 10 * 60_000,
    sampling: { mousemove: 50, mouseInteraction: true, scroll: 150, media: 800, input: 'last' },
    maskInputOptions: { password: true },
    recordCanvas: false, collectFonts: false, inlineImages: false,
    inlineStylesheet: true, slimDOMOptions: 'all', recordCrossOriginIframes: false,
  });
  T.snapshotMs = performance.now() - t0;
  setInterval(() => {
    const s = performance.now();
    flushThrottled();
    if (emitPending.size) {
      const texts = []; for (const [id, value] of emitPending) if (mirror.has(id)) texts.push({ id, value });
      emitPending.clear(); T.coalescedEmitted += texts.length;
      buf.push({ type: 3, data: { source: 0, texts, attributes: [], removes: [], adds: [] }, timestamp: Date.now() });
    }
    if (buf.length) { const b = buf; buf = []; worker.postMessage(b); }
    T.flush.push([s, performance.now() - s]);
  }, 500);
  setInterval(() => worker.postMessage('flush'), 5000);
}
