// T-14 acceptance bench (PRD §2.1): per-WebSocket-message overhead of the SDK's incoming-frame gate
// must be < 5 µs for unsampled messages at 4× CPU throttle.
//
// Builds @replayd/core, opens Chromium (Playwright) with CDP Emulation.setCPUThrottlingRate, creates two
// WebSockets to a Centrifugo-style URL — one before init() (no SDK listener = baseline) and one after
// (SDK gate listener) — each with an app-side no-op 'message' listener, and dispatches N synthetic
// MessageEvents (~300-char Centrifugo push) on each. Overhead = (t_sdk − t_baseline) / N, median of RUNS.
//
// Usage: pnpm --filter @replayd/bench run bench:ws      env: N=200000 RUNS=5 RATE=4 NO_BUILD=1
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';

const N = Number(process.env.N ?? 200_000), RUNS = Number(process.env.RUNS ?? 5), RATE = Number(process.env.RATE ?? 4);
const BUDGET_US = 5;
const sdkRoot = fileURLToPath(new URL('../../', import.meta.url));
const dist = fileURLToPath(new URL('../../packages/core/dist/', import.meta.url));
if (!process.env.NO_BUILD) execSync('pnpm --filter @replayd/core run build', { cwd: sdkRoot, stdio: 'inherit' });

const { server, port } = await startServer(0);
const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined});
const page = await browser.newPage();
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  if (u.pathname.startsWith('/sdk/')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(dist + u.pathname.slice(5)) });
  if (u.pathname === '/ws-gate.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>ws-gate</title>' });
  if (u.pathname.startsWith('/ingest/')) return route.fulfill({ status: u.pathname.endsWith('/config') ? 200 : 202, contentType: 'application/json', body: '{}' });
  return route.continue();
});
await page.goto(`http://127.0.0.1:${port}/ws-gate.html`);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });

const res = await page.evaluate(async ({ N, RUNS }) => {
  // nobody listens on port 9 → the sockets never receive real frames; events are dispatched synthetically
  const url = 'ws://127.0.0.1:9/connection/websocket';
  const noop = () => {};
  const base = new WebSocket(url); // created BEFORE init → native, no SDK listener
  base.addEventListener('message', noop);
  const m = await import('/sdk/index.js');
  m.loaders.replay = () => Promise.resolve({ startReplay: (i) => (window.__I = i) });
  m.init({ dsn: `http://pk@${location.host}/7` });
  const sdk = new WebSocket(url); // SDK gate listener installed (URL matches the default patterns)
  sdk.addEventListener('message', noop);
  await new Promise((r) => (function w() { window.__I ? r() : setTimeout(w, 20); })());
  const data = JSON.stringify({ push: { channel: 'quotes:EURUSD', pub: { data: { s: 'EURUSD', b: 1.08345, a: 1.08347, t: Date.now(), h: 1.0851, l: 1.0812, chg: -0.12, v: 123456, spread: 2, digits: 5, session: 'london', flags: ['tradable', 'quote'] }, offset: 123456789 } } }).padEnd(300, ' ');
  const run = (ws) => {
    const t = performance.now();
    for (let i = 0; i < N; i++) ws.dispatchEvent(new MessageEvent('message', { data }));
    return performance.now() - t;
  };
  run(base); run(sdk); // warm-up (JIT)
  window.__I.drain();
  const runs = [];
  for (let r = 0; r < RUNS; r++) {
    // alternate order to cancel drift (thermal, GC)
    const [b, s] = r % 2 ? [run(base), run(sdk)] : ((x) => [run(base), x])(run(sdk));
    runs.push({ baseMs: b, sdkMs: s, overheadUs: ((s - b) * 1000) / N });
  }
  const sampled = window.__I.drain().filter((e) => e.type === 'ws' && e.data.k === 'frame').length;
  return { runs, sampled, len: data.length };
}, { N, RUNS });

await browser.close();
server.close();
const ov = res.runs.map((r) => r.overheadUs).sort((a, b) => a - b);
const median = ov[Math.floor(ov.length / 2)];
for (const r of res.runs) console.log(`  baseline ${r.baseMs.toFixed(1)} ms  sdk ${r.sdkMs.toFixed(1)} ms  overhead ${r.overheadUs.toFixed(3)} µs/msg`);
console.log(`ws-gate @ ${RATE}× CPU throttle, N=${N}, ${res.len}-char frames, ${res.sampled} frames sampled: median overhead ${median.toFixed(3)} µs/msg (budget < ${BUDGET_US} µs) → ${median < BUDGET_US ? 'PASS' : 'FAIL'}`);
if (!res.sampled) {
  console.error('SDK gate listener did not capture any frame — bench is not measuring the SDK path');
  process.exit(1);
}
process.exit(median < BUDGET_US ? 0 : 1);
