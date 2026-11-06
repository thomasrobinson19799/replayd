// T-51: replayd vs the terminals' current Sentry setup (PRD §4.3) on the terminal mock, same harness as
// perf/replay.mjs. Variants: none (baseline), replayd (IIFE + lazy replay), sentry (@sentry/browser 11 with replay,
// tracing, captureConsole, httpClient; one IIFE). Per variant and CPU rate (median of REPEAT runs):
//   bundle_gz      gzip bytes of the SDK code the page loads (replayd: core IIFE + replay chunk + worker)
//   batch p50/p95  main-thread SDK time per 500 ms window (top-level FunctionCalls into the SDK's scripts)
//   sdk_ms_per_s   average main-thread SDK time
//   long tasks     > 50 ms after the first 5 s · uplink KB/s · main heap Δ vs baseline
// Usage: node bench/perf/compare.mjs   env RATES=4,1 SECONDS=20 REPEAT=2 SCENARIO=hist=60&throttle=1000
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';

const RATES = (process.env.RATES ?? '4,1').split(',').map(Number);
const SECONDS = Number(process.env.SECONDS ?? 20);
const REPEAT = Number(process.env.REPEAT ?? 2);
const SCENARIO = process.env.SCENARIO ?? 'hist=60&throttle=1000';
const sdkRoot = fileURLToPath(new URL('../../', import.meta.url));
const dist = `${sdkRoot}packages/core/dist/`;
if (!process.env.NO_BUILD) execSync('pnpm --filter @replayd/core run build', { cwd: sdkRoot, stdio: 'inherit' });
const sentryJs = (await build({ entryPoints: [fileURLToPath(new URL('../lib/sentry-entry.js', import.meta.url))], bundle: true, minify: true, format: 'iife', target: 'es2022', write: false })).outputFiles[0].contents;
const gz = (b) => gzipSync(b, { level: 9 }).length;
const bundles = {
  replayd: { sync: gz(await readFile(`${dist}replayd.min.js`)), lazy: gz(await readFile(`${dist}replay.js`)) + gz(await readFile(`${dist}worker.js`)) },
  sentry: { sync: gz(sentryJs), lazy: 0 },
};

const isolate = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' };
let cur = null;
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const head = (v) => v === 'replayd'
  ? `<script src="/sdk/replayd.min.js"></script><script>Replayd.init({ dsn: 'http://pk@' + location.host + '/7', tunnel: '/_rp', release: 'bench', environment: 'bench' });</script>`
  : v === 'sentry' ? `<script src="/sentry.js"></script><script>__sentryInit('http://k@' + location.host + '/1');</script>` : '';
const { server, port } = await startServer(0, undefined, {
  headers: isolate,
  transform: (u, b) => (u.pathname.endsWith('/terminal.html') ? Buffer.from(String(b).replace('<head>', `<head><script>window.__lt=[];new PerformanceObserver((l)=>{for(const e of l.getEntries())window.__lt.push([e.startTime,e.duration])}).observe({type:'longtask',buffered:true});</script>${head(cur?.v)}`)) : b),
  async hook(req, res, u) {
    if (u.pathname.startsWith('/sdk/')) { res.writeHead(200, { 'content-type': 'text/javascript', ...isolate }); res.end(await readFile(dist + u.pathname.slice(5))); return true; }
    if (u.pathname === '/sentry.js') { res.writeHead(200, { 'content-type': 'text/javascript', ...isolate }); res.end(sentryJs); return true; }
    if (!u.pathname.startsWith('/_rp/') && !u.pathname.startsWith('/sentry')) return false;
    const b = await body(req);
    if (cur && cur.from && Date.now() >= cur.from) cur.bytes += b.length + (req.headers['content-length'] ? 0 : 0);
    res.writeHead(u.pathname.endsWith('/config') ? 200 : 202, { 'content-type': 'application/json', ...isolate, 'access-control-allow-origin': '*' });
    res.end('{}');
    return true;
  },
});
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const sdkUrl = { replayd: /\/sdk\/(replayd\.min|replay|index)\.js$/, sentry: /\/sentry\.js$/ };

function analyse(trace, v, from, to) {
  const ev = JSON.parse(trace).traceEvents;
  const main = ev.find(e => e.name === 'replayd-bench-anchor');
  if (!main) throw new Error('Benchmark clock anchor is missing');
  const calls = ev.filter((e) => e.ph === 'X' && e.pid === main.pid && e.tid === main.tid && e.name === 'FunctionCall').sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const nav = main.ts - from * 1000;
  const re = sdkUrl[v];
  const open = [];
  const win = new Map();
  for (const e of calls) {
    while (open.length && open.at(-1).ts + open.at(-1).dur <= e.ts) open.pop();
    const mine = re && re.test(e.args?.data?.url ?? '');
    if (mine && !open.some((o) => re.test(o.args?.data?.url ?? ''))) {
      const t = (e.ts - nav) / 1e3;
      if (t >= from && t < to) { const w = Math.floor((t - from) / 500); win.set(w, (win.get(w) ?? 0) + e.dur / 1e3); }
    }
    open.push(e);
  }
  const n = Math.floor((to - from) / 500), a = [];
  for (let i = 0; i < n; i++) a.push(win.get(i) ?? 0);
  a.sort((x, y) => x - y);
  return { p50: q(a, 0.5), p95: q(a, 0.95), msPerS: (a.reduce((x, y) => x + y, 0) / n) * 2 };
}

async function run(v, rate) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  cur = { v, bytes: 0, from: 0 };
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await browser.startTracing(page, { categories: ['devtools.timeline','blink.user_timing'] });
  await page.goto(`http://127.0.0.1:${port}/pages/terminal.html?${SCENARIO}`);
  await page.waitForTimeout(2500 + 1000 * rate);
  cur.from = Date.now();
  const t0 = await page.evaluate(() => {
    performance.mark('replayd-bench-anchor');
    return performance.getEntriesByName('replayd-bench-anchor')[0].startTime;
  });
  await page.waitForTimeout(SECONDS * 1000);
  const t1 = await page.evaluate(() => performance.now());
  const trace = String(await browser.stopTracing());
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  const lt = await page.evaluate(() => window.__lt);
  await ctx.close();
  const a = v === 'none' ? { p50: 0, p95: 0, msPerS: 0 } : analyse(trace, v, t0, t1);
  return { ...a, heap, long: lt.filter(([s, d]) => s > 5000 && d > 50).length, kbps: cur.bytes / 1024 / SECONDS };
}

try {
for (const rate of RATES) {
  const base = await run('none', rate);
  for (const v of ['replayd', 'sentry']) {
    const rs = [];
    for (let i = 0; i < REPEAT; i++) rs.push(await run(v, rate));
    const m = (k) => +med(rs.map((r) => r[k])).toFixed(2);
    console.log(JSON.stringify({
      variant: v, rate, bundle_gz_sync: bundles[v].sync, bundle_gz_lazy: bundles[v].lazy,
      batch_p50_ms: m('p50'), batch_p95_ms: m('p95'), sdk_ms_per_s: m('msPerS'), long_tasks: Math.max(...rs.map((r) => r.long)),
      uplink_kb_s: m('kbps'), heap_delta_mb: +((med(rs.map((r) => r.heap)) - base.heap) / 1048576).toFixed(2),
    }));
  }
}
} finally { await browser.close(); server.close(); }
