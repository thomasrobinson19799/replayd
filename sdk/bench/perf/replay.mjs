// T-20 replay perf suite (PRD §2.1): the real SDK (core + lazy replay chunk + worker) on the terminal mock.
//
// Per scenario and CPU rate (median of REPEAT runs):
//   snapshot   startReplay() incl. worker start + rrweb full snapshot (the index.js FunctionCall that runs it)
//   batch      main-thread SDK time per 500 ms window after the snapshot settled: sum of top-level JS entries
//              into replay.js (MutationObserver callbacks, emit, batching/flush/cut timers, listeners) on the
//              renderer main thread, from a devtools.timeline trace; core (index.js) time is reported apart.
//              Budget: < 2 ms p95 at 4× CPU.
//   long tasks PerformanceObserver('longtask') entries > 50 ms after the snapshot (budget: none)
//   uplink     replay segment bytes / s as POSTed by the worker (target ≤ 5 KB/s, canvas off here)
//   heap       main-thread JS heap after GC, SDK run minus a no-SDK run (worker heap not included)
// It also decodes every uploaded segment and checks it: full snapshot in seq 0, no password text, every
// throttled node emitted at most once per N ms.
//
// Usage: node bench/perf/replay.mjs   env: RATES=4,1 SECONDS=15 REPEAT=3 SCENARIOS=terminal-1000,… NO_BUILD=1
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';

const RATES = (process.env.RATES ?? '4,1').split(',').map(Number);
const SECONDS = Number(process.env.SECONDS ?? 15);
const REPEAT = Number(process.env.REPEAT ?? 3);
const ALL = {
  'terminal-1000': 'hist=60&throttle=1000', // recommended terminal config (D-06)
  'terminal-500': 'hist=60&throttle=500',
  'watchlist-1000': 'hist=60&throttle=1000&book=0', // lighter: watchlist only
  'textContent-1000': 'hist=60&throttle=1000&text=content', // Vue/React-style textContent swaps
  'no-throttle': 'hist=60', // no data-rp-throttle attribute at all
};
const SCEN = (process.env.SCENARIOS ?? Object.keys(ALL).join(',')).split(',');
const sdkRoot = fileURLToPath(new URL('../../', import.meta.url));
const dist = fileURLToPath(new URL('../../packages/core/dist/', import.meta.url));
if (!process.env.NO_BUILD) execSync('pnpm --filter @replayd/core run build', { cwd: sdkRoot, stdio: 'inherit' });

const isolate = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' };
/** uploads of the run in progress (runs are sequential) */
let cur = null;
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const { server, port } = await startServer(0, undefined, {
  headers: isolate,
  transform: (u, b) => (u.pathname.endsWith('/terminal.html') ? Buffer.from(String(b).replace('<head>', `<head>${inject(cur?.sdk)}`)) : b),
  async hook(req, res, u) {
    if (u.pathname.startsWith('/sdk/')) {
      res.writeHead(200, { 'content-type': 'text/javascript', ...isolate });
      res.end(await readFile(dist + u.pathname.slice(5)));
      return true;
    }
    if (!u.pathname.startsWith('/_rp/')) return false;
    const b = await body(req);
    if (cur && u.pathname.endsWith('/replay') && b.length) {
      cur.replay.push(b);
      if (cur.from && Date.now() >= cur.from) cur.bytes += b.length;
    } else if (cur) cur.events += b.length;
    res.writeHead(u.pathname.endsWith('/config') ? 200 : 202, { 'content-type': 'application/json', ...isolate });
    res.end('{}');
    return true;
  },
});
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
// the SDK goes first in <head> like in production (IIFE build, which lazy-loads replay.js + worker.js next to
// it), so the app's WebSocket is created through the patched constructor
const inject = (sdk) => `<script>window.__lt=[];new PerformanceObserver((l)=>{for(const e of l.getEntries())window.__lt.push([e.startTime,e.duration])}).observe({type:'longtask',buffered:true});</script>${sdk ? `<script src="/sdk/replayd.min.js"></script><script>Replayd.init({ dsn: 'http://pk@' + location.host + '/7', tunnel: '/_rp', release: 'bench', environment: 'bench', ${process.env.OPTS ?? ''} });</script>` : ''}`;

const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** sums top-level FunctionCall time per script on the main thread, bucketed into 500 ms windows */
function analyse(trace, from, to) {
  const ev = JSON.parse(trace).traceEvents;
  const main = ev.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && ev.some((x) => x.pid === e.pid && x.name === 'FunctionCall' && /\/pages\/terminal/.test(x.args?.data?.url ?? '')));
  const calls = ev.filter((e) => e.ph === 'X' && e.pid === main.pid && e.tid === main.tid && e.name === 'FunctionCall').sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const nav = ev.find((e) => e.name === 'navigationStart' && e.pid === main.pid)?.ts ?? calls[0].ts;
  const kind = (e) => { const u = e.args?.data?.url ?? ''; return u.endsWith('/sdk/replay.js') ? 'r' : /\/sdk\/(index|replayd\.min)\.js$/.test(u) ? 'c' : ''; };
  // top-level per kind: skip events nested in an open event of the same kind
  const open = [];
  const top = [];
  for (const e of calls) {
    while (open.length && open.at(-1).ts + open.at(-1).dur <= e.ts) open.pop();
    const k = kind(e);
    if (k && !open.some((o) => kind(o) === k)) top.push({ k, t: (e.ts - nav) / 1e3, d: e.dur / 1e3 });
    open.push(e);
  }
  // snapshot: the main-thread task that evaluates replay.js and runs startReplay() (worker + rrweb record +
  // full snapshot): the first v8.evaluateModule after core's load+idle callback, measured as its RunTask
  const idle = ev.find((e) => e.name === 'FireIdleCallback' && e.pid === main.pid && e.tid === main.tid);
  const evm = idle && ev.filter((e) => e.name === 'v8.evaluateModule' && e.pid === main.pid && e.tid === main.tid && e.ts > idle.ts).sort((a, b) => a.ts - b.ts)[0];
  const task = evm && ev.find((e) => e.name === 'RunTask' && e.pid === main.pid && e.tid === main.tid && e.ts <= evm.ts && e.ts + e.dur >= evm.ts + evm.dur);
  const snap = task && { t: (task.ts - nav) / 1e3, d: task.dur / 1e3 };
  const t0 = Math.max(from, snap ? snap.t + snap.d + 1000 : from);
  const win = new Map();
  for (const x of top) {
    if (x.t < t0 || x.t >= to) continue;
    const w = Math.floor((x.t - t0) / 500);
    const v = win.get(w) ?? { r: 0, c: 0 };
    v[x.k] += x.d;
    win.set(w, v);
  }
  const n = Math.floor((to - t0) / 500);
  const r = [], rc = [];
  for (let i = 0; i < n; i++) { const v = win.get(i) ?? { r: 0, c: 0 }; r.push(v.r); rc.push(v.r + v.c); }
  r.sort((a, b) => a - b);
  rc.sort((a, b) => a - b);
  return { snapshot: snap?.d ?? NaN, snapEnd: snap ? snap.t + snap.d : 0, p50: q(r, 0.5), p95: q(r, 0.95), max: r.at(-1), p95core: q(rc, 0.95), windows: n, msPerS: (r.reduce((a, b) => a + b, 0) / n) * 2 };
}

/** decodes the uploaded segments and checks invariants */
function check(segs, thr) {
  const out = { segments: segs.length, bad: [], textsEmitted: 0, maxRatePerNode: 0, fullSnapshots: 0 };
  const last = new Map();
  let minGap = Infinity;
  const all = [];
  for (const b of segs) {
    const ml = b.readUInt16LE(0), meta = JSON.parse(b.subarray(2, 2 + ml)), el = b.readUInt32LE(2 + ml);
    const events = JSON.parse(gunzipSync(b.subarray(6 + ml, 6 + ml + el)));
    if (b.readUInt16LE(6 + ml + el) !== 0) out.bad.push('asset_count != 0');
    if (meta.n !== events.length) out.bad.push(`meta.n ${meta.n} != ${events.length}`);
    all.push({ meta, events });
  }
  all.sort((a, b) => a.meta.seq - b.meta.seq);
  if (!all[0]?.events.some((e) => e.type === 2)) out.bad.push('seq 0 has no full snapshot');
  if (!all[0]?.meta.init?.ua) out.bad.push('seq 0 has no init');
  out.kinds = {};
  for (const { events } of all)
    for (const e of events) {
      const kk = e.type === 5 ? `5:${e.data.tag}` : e.type === 3 ? `3:${e.data.source}` : String(e.type);
      out.kinds[kk] = (out.kinds[kk] ?? 0) + 1;
      if (e.type === 2) out.fullSnapshots++;
      const s = JSON.stringify(e);
      if (s.includes('secret-jwt')) out.bad.push('Centrifugo token not redacted');
      // synthetic coalesced mutations carry texts only; measure per-node spacing
      if (e.type === 3 && e.data.source === 0 && e.data.texts?.length && !e.data.adds.length && !e.data.attributes.length && !e.data.removes.length) {
        for (const t of e.data.texts) {
          out.textsEmitted++;
          const p = last.get(t.id);
          if (p !== undefined) minGap = Math.min(minGap, e.timestamp - p);
          last.set(t.id, e.timestamp);
        }
      }
    }
  out.minGapMs = minGap === Infinity ? null : minGap;
  // the flush keeps a per-node last-emit time: spacing ≥ N - 50 ms
  if (thr && minGap < thr - 50) out.bad.push(`throttled node emitted after ${minGap} ms (< ${thr})`);
  return out;
}

async function run(scenario, rate, sdk) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const up = cur = { replay: [], bytes: 0, events: 0, from: 0, sdk };
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await browser.startTracing(page, { categories: (process.env.CATS ?? 'devtools.timeline').split(',') });
  await page.goto(`http://127.0.0.1:${port}/pages/terminal.html?${ALL[scenario]}`);
  const navAt = Date.now();
  // load → idle (≤ 2 s) → replay chunk → snapshot; then 1 s settle and SECONDS of steady state
  const settle = 2500 + 1000 * rate;
  await page.waitForTimeout(settle);
  const tStart = (up.from = Date.now());
  if (process.env.PROFILE && sdk) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
  }
  await page.waitForTimeout(SECONDS * 1000);
  if (process.env.PROFILE && sdk) {
    const { profile } = await cdp.send('Profiler.stop');
    (await import('node:fs')).writeFileSync(process.env.PROFILE, JSON.stringify(profile));
  }
  const tEnd = Date.now();
  const trace = String(await browser.stopTracing());
  if (process.env.DUMP && sdk) (await import('node:fs')).writeFileSync(process.env.DUMP, trace);
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  const lt = await page.evaluate(() => window.__lt);
  const msgs = await page.evaluate(() => window.__msgs());
  await ctx.close();
  if (!sdk) return { heap };
  const a = analyse(trace, tStart - navAt, tEnd - navAt);
  // long tasks after the snapshot task (time bases differ slightly: trace vs timeOrigin)
  const longAfter = lt.filter(([s, d]) => s > a.snapEnd - a.snapshot + 30 && d > 50);
  const thr = Number(new URLSearchParams(ALL[scenario]).get('throttle') ?? 0);
  return { ...a, msgs, longTasks: longAfter.length, longTaskMax: Math.max(0, ...longAfter.map((x) => x[1])), kbPerS: up.bytes / 1024 / SECONDS, heap, check: check(up.replay, thr) };
}

const results = [];
for (const rate of RATES) {
  for (const sc of SCEN) {
    const runs = [];
    const base = [];
    for (let i = 0; i < REPEAT; i++) {
      runs.push(await run(sc, rate, true));
      if (i === 0) base.push(await run(sc, rate, false));
    }
    const m = (k) => +med(runs.map((r) => r[k])).toFixed(2);
    const r = {
      scenario: sc, rate, snapshot_ms: m('snapshot'), batch_p50_ms: m('p50'), batch_p95_ms: m('p95'), batch_max_ms: m('max'),
      batch_p95_incl_core_ms: m('p95core'), replay_ms_per_s: m('msPerS'), long_tasks_after_snapshot: Math.max(...runs.map((x) => x.longTasks)),
      long_task_max_ms: Math.max(...runs.map((x) => x.longTaskMax)), uplink_kb_s: m('kbPerS'), heap_delta_mb: +((med(runs.map((x) => x.heap)) - base[0].heap) / 1048576).toFixed(2),
      ws_msgs: med(runs.map((x) => x.msgs)), p95_runs: runs.map((x) => +x.p95.toFixed(2)), check: runs[0].check,
    };
    results.push(r);
    console.log(JSON.stringify(r));
  }
}
await browser.close();
server.close();
const bad = results.filter((r) => r.check.bad.length);
if (bad.length) {
  console.error('segment checks failed:', JSON.stringify(bad.map((r) => [r.scenario, r.check.bad])));
  process.exit(1);
}
