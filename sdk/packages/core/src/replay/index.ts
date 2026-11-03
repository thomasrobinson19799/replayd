/**
 * Lazy replay chunk (PRD §4.4 step 3, §4.6, §4.10): rrweb record + worker bridge.
 *
 * Main thread only pushes rrweb events into an array; every 500 ms or 300 events the array is posted to the
 * worker (swapped, not copied). Segments are cut every 5 s, at 256 KB raw (worker asks), on page hide and on
 * every captured error. `data-rp-throttle` text coalescing and the 10k-node mutation guard run in a
 * MutationRecord prefilter inside rrweb (patches/@rrweb__record@2.2.0.patch, D-04; design: docs/spikes/T-01.md).
 *
 * Uses core only through `Internal` — a runtime import from a core module would make esbuild split a
 * shared chunk out of index.js.
 */
import type { Internal, RingEvent } from '../types';
import { record as rec0 } from '@rrweb/record';

interface Mirror {
  getId(n: Node): number;
  getNode(id: number): Node | null;
  has(id: number): boolean;
}
type Hook = (m: MutationRecord[]) => MutationRecord[];
interface Rec {
  (o: Record<string, unknown>): (() => void) | undefined;
  mirror: Mirror;
  takeFullSnapshot(checkout?: boolean): void;
  setMutationHook(f: Hook | null): void;
}
const R = rec0 as unknown as Rec;
const GUARD = 1e4, THR = '[data-rp-throttle]';

export function startReplay(I: Internal): void {
  try {
    run(I);
  } catch {
    /* never throw into the app */
  }
}

/** worker from the chunk's own directory; cross-origin script base → blob bootstrap with importScripts */
const mkWorker = () => {
  const src = new URL('./worker.js', import.meta.url).href;
  try {
    return new Worker(src);
  } catch {
    return new Worker(URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(src)})`], { type: 'text/javascript' })));
  }
};

function run(I: Internal) {
  const o = I.o(), r = o.replay, W = window, D = document, mirror = R.mirror;
  const w = mkWorker();
  const mask = `.rr-mask,${r.maskSelector ?? '[data-rp-mask]'}`;

  // ---- batching (PRD §4.10)
  let B: unknown[] = [], dirty = 0;
  const post = () => {
    if (B.length) {
      w.postMessage([1, B]);
      B = [];
      dirty = 1;
    }
  };
  const push = (e: unknown) => {
    if (B.push(e) >= 300) post();
  };
  const custom = (e: RingEvent) => push({ type: 5, timestamp: e.ts, data: { tag: e.type, payload: e.data } });

  // ---- data-rp-throttle (D-04)
  /** throttle state of a node: `n` Text node (characterData) or element whose text child is swapped (`s`),
   *  `id` mirror id the replay shows (-2 = not resolved yet), `i` container ms (negative = masked, 0 = not
   *  throttled), `q` queued for the next flush */
  interface P {
    n: Node;
    id: number;
    i: number;
    s: boolean;
    q: boolean;
    /** last emitted (ms): the stagger is tick-based, this keeps "≤ 1 per N ms" exact under timer jitter */
    e: number;
  }
  const NO: P = { n: D, id: -1, i: 0, s: false, q: false, e: 0 };
  /** pending nodes by stagger slot (id % (N/500)): a flush only walks the slot that is due */
  let slots: P[][] = [];
  let pendN = 0;
  /** parent element → container ms. Node → its P lives in a symbol property on the node itself (NO = not
   *  throttled): ~2× cheaper than a WeakMap lookup on the per-record path. `gen` invalidates both on every
   *  full snapshot. */
  let info = new WeakMap<Node, number>(), gen = 0;
  const K = Symbol();
  type N = Node & { [K]?: P & { g: number } };
  const get = (n: Node) => {
    const p = (n as N)[K];
    return p && p.g == gen ? p : undefined;
  };
  const set = (n: Node, p: P) => ((n as N)[K] = p == NO ? { ...NO, g: gen } : Object.assign(p, { g: gen }));
  const inf = (p: Element) => {
    let v = info.get(p);
    if (v === undefined) {
      const h = p.closest?.(THR);
      v = h ? +h.getAttribute('data-rp-throttle')! || 0 : 0;
      if (v && (r.maskAllText || p.closest(mask))) v = -v;
      info.set(p, v);
    }
    return v;
  };
  const txt = (l: NodeList) => {
    for (let i = 0; i < l.length; i++) if (l[i]!.nodeType != 3) return false;
    return true;
  };
  const queue = (p: P) => {
    if (!p.q) {
      p.q = true;
      pendN++;
      // unresolved ids (-2) go to slot 0: resolved at the next flush
      const q = ((p.i < 0 ? -p.i : p.i) / 500) | 0, k = p.id < 0 || q < 2 ? 0 : p.id % q;
      (slots[k] ??= []).push(p);
    }
  };

  /** MutationRecord prefilter: drops throttled text changes (emitted later, coalesced) + mutation guard */
  const hook: Hook = (ms) => {
    let out: MutationRecord[] | null = null, added = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]!, t = m.target;
      let drop = false;
      if (m.type == 'characterData') {
        // steady state: one WeakMap lookup per record; the parent lookup runs once per node
        let p = get(t);
        if (!p) {
          const e = t.parentNode as Element | null, v = e ? inf(e) : 0;
          p = set(t, v ? { n: t, id: -2, i: v, s: false, q: false, e: 0 } : NO);
        }
        if (p.i) {
          queue(p);
          drop = true;
        }
      } else if (m.type == 'childList') {
        const a = m.addedNodes;
        let p = get(t);
        if (p ? p.s : t.nodeType == 1 && inf(t as Element)) {
          if (t.childNodes.length <= 1 && txt(a) && txt(m.removedNodes)) {
            if (!p) {
              // the replay keeps showing the ORIGINAL text node: coalesced updates are emitted against its id
              const x = m.removedNodes[0], id = x ? mirror.getId(x) : -1;
              if (id > 0) p = set(t, { n: t, id, i: inf(t as Element), s: true, q: false, e: 0 });
            }
            if (p) {
              queue(p);
              drop = true;
            }
          }
        }
        if (!drop && added <= GUARD)
          for (let k = 0; k < a.length; k++) added += 1 + ((a[k] as Element).getElementsByTagName?.('*').length ?? 0);
      }
      if (drop) out ??= ms.slice(0, i);
      else if (out) out.push(m);
    }
    // PRD §4.6: > 10,000 added nodes in one batch → a new full snapshot instead (it re-reads the whole DOM)
    if (added > GUARD) {
      R.takeFullSnapshot(true);
      return [];
    }
    return out ?? ms;
  };

  /** emits the latest value of pending throttled texts; a node with N > 500 is staggered over N/500 ticks */
  let tick = 0;
  const ft = () => {
    tick++;
    if (!pendN) return;
    // slot k is due on ticks ≡ k (mod q) of its own q; slot 0 holds every q (and unresolved ids)
    const ids = new Int32Array(pendN);
    let k = 0, v = '';
    const keep: P[][] = [], now = Date.now();
    for (let s = 0; s < slots.length; s++) {
      const l = slots[s];
      if (!l?.length) continue;
      const out: P[] = [];
      for (const p of l) {
        const i = p.i, ms = i < 0 ? -i : i, q = (ms / 500) | 0;
        if ((q > 1 && p.id >= 0 && tick % q != p.id % q) || now - p.e < ms - 50) {
          out.push(p); // not due yet
          continue;
        }
        p.q = false;
        pendN--;
        const n = p.n;
        if (p.id < 0) {
          // first flush of this node: resolve its id. removeNodeFromMap keeps nodeMetaMap, so getId() still
          // answers for removed nodes → also check getNode(). Not (yet) recorded / blocked → next change.
          const id = mirror.getId(n);
          if (id < 0 || mirror.getNode(id) !== n) continue;
          p.id = id;
          if (q > 1 && tick % q != id % q) {
            queue(p); // into its real slot
            continue;
          }
        } else if (!n.isConnected) continue;
        p.e = now;
        const x = (p.s ? n.textContent : n.nodeValue) ?? '';
        v += (k ? '\0' : '') + (i < 0 ? x.replace(/\S/g, '*') : x);
        ids[k++] = p.id;
      }
      keep[s] = out;
    }
    for (let s = 0; s < keep.length; s++) if (keep[s]) slots[s] = keep[s]!;
    if (!k) return;
    // one message: pending events first (order), then the coalesced texts
    const sub = k == ids.length ? ids : ids.slice(0, k);
    w.postMessage([2, sub, v, Date.now(), B], [sub.buffer]);
    B = [];
    dirty = 1;
  };
  /** the 500 ms batch tick: coalesced texts + events in one postMessage */
  const tickF = () => {
    ft();
    post();
  };

  // ---- segments
  let sid = '', seq = -1, init = 0, wsd = 0, stopped = 0;
  const N = navigator;
  const im = () => {
    const x = I.m(), a = (x.ctx.app ?? {}) as Record<string, string | undefined>;
    return {
      url: location.href, ref: D.referrer, ua: N.userAgent, vw: W.innerWidth, vh: W.innerHeight, lang: N.language,
      release: o.release, env: o.environment, platform: I.platform, user: x.user, tags: x.tags,
      // Capacitor (T-26): filled by the capacitor chunk from App/Device.getInfo()
      app_ver: a.version, device: a.device, os_ver: a.os, wv_ver: a.webview,
    };
  };
  const cut = (hide?: boolean) => {
    if (stopped) return;
    if (!I.en()) return end();
    post();
    if (!dirty) return;
    dirty = 0;
    const s = I.sess(), roll = sid && s.id != sid;
    // session rollover (idle > 15 min / > 60 min): what was buffered closes the old session, then a new
    // full snapshot starts the new one
    const q = roll ? seq + 1 : ((sid = s.id), I.seq());
    const c = I.c.ws_disc, d = c >= wsd ? c - wsd : c;
    wsd = c;
    w.postMessage([3, { sid, seq: q, ws_disc: d, ie: I.ie(), ...(init ? {} : { init: im() }) }, o.redact, !!hide]);
    seq = q;
    init = 1;
    if (roll) {
      sid = s.id;
      seq = -1;
      init = 0;
      R.takeFullSnapshot(true);
    }
  };

  const hid = () => {
    tickF();
    cut(true);
  };
  const vis = () => D.visibilityState == 'hidden' && hid();
  // outbox drain on reconnect / app resume (the capacitor chunk dispatches replayd:resume / replayd:flush)
  const dr = () => w.postMessage([4]);
  const L: [EventTarget, string, () => void][] = [[W, 'pagehide', hid], [D, 'visibilitychange', vis], [W, 'online', dr], [W, 'replayd:resume', dr], [W, 'replayd:flush', hid]];
  const T = [setInterval(tickF, 500), setInterval(cut, 5e3)];
  const end = () => {
    stopped = 1;
    for (const t of T) clearInterval(t);
    R.setMutationHook(null);
    I.sink(null);
    I.onError(() => {});
    for (const [t, k, f] of L) t.removeEventListener(k, f);
    try {
      stop?.();
    } catch {
      /* ignore */
    }
    w.terminate();
  };

  w.postMessage([0, new URL(I.url('replay'), location.href).href, o.redact, (o.websocket.channelOf ?? 'centrifugo-json') == 'centrifugo-json' ? 1 : 0, o.websocket.sample.perChannelPerSec, I.platform != 'web' || !!o.offlineQueue]);
  // [0] = raw events ≥ 256 KB → cut now; [1, s] = X-Replayd-Disable → stop recording on this page
  w.onmessage = (e: MessageEvent) => (e.data[0] ? end() : cut());
  w.onerror = end;
  for (const [t, k, f] of L) t.addEventListener(k, f);
  I.onError(() => cut());

  R.setMutationHook(hook);
  const stop = R({
    emit: (e: { type: number }) => {
      if (e.type == 2) {
        info = new WeakMap();
        gen++;
        for (const l of slots) for (const p of l ?? []) p.q = false;
        slots = [];
        pendN = 0;
      }
      push(e);
    },
    checkoutEveryNms: 6e5,
    sampling: { mousemove: 50, mouseInteraction: true, scroll: 150, media: 800, input: 'last' },
    blockSelector: r.blockSelector ?? '[data-rp-block]',
    maskTextSelector: r.maskAllText ? '*' : (r.maskSelector ?? '[data-rp-mask]'),
    maskAllInputs: !!r.maskAllInputs,
    maskInputOptions: { password: true },
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    inlineStylesheet: true,
    slimDOMOptions: 'all',
    recordCrossOriginIframes: false,
  });
  // pre-replay activity with its original timestamps, then live custom events
  for (const e of I.drain()) custom(e);
  I.sink(custom);
}
