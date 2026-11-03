// T-01 spike runner: rrweb record cost on the terminal mock.
// node spikes/t01-rrweb-cost.mjs [seconds=20] [cpuRate=4]
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';

const SECONDS = Number(process.argv[2] ?? 20);
const RATE = Number(process.argv[3] ?? 4);
const { server, port } = await startServer(0);
const base = `http://127.0.0.1:${port}/pages/terminal.html`;
const browser = await chromium.launch();

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r2 = (x) => Math.round(x * 100) / 100;

async function run(name, { sdk, throttle, query = '', ms = 500 }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
  await page.goto(`${base}?${throttle && throttle !== 'none' ? `throttle=${ms}&` : ''}${query}`, { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  const counts = await page.evaluate(() => window.__nodeCount());
  let startAt = await page.evaluate(() => performance.now());
  if (sdk) {
    await page.addScriptTag({ path: new URL('../dist/spike-glue.js', import.meta.url).pathname });
    startAt = await page.evaluate((t) => { const s = performance.now(); window.__rpStart({ throttle: t }); return s; }, throttle);
  }
  await page.waitForTimeout(1500); // let initial snapshot + iframe snapshot settle
  const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const tStart = await page.evaluate(() => performance.now());
  await page.waitForTimeout(SECONDS * 1000);
  const tEnd = await page.evaluate(() => performance.now());
  const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const data = await page.evaluate(() => ({ T: window.__rpT ?? null, long: window.__long, msgs: window.__msgs(), heap: performance.memory?.usedJSHeapSize }));
  await ctx.close();

  const res = { name, elements: counts.elements, nodes: counts.nodes, wsMsgPerSec: r2(data.msgs / ((tEnd) / 1000)) };
  res.taskMsPerSec = r2(((m1.TaskDuration - m0.TaskDuration) * 1000) / SECONDS);
  res.scriptMsPerSec = r2(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / SECONDS);
  res.heapMB = r2(m1.JSHeapUsedSize / 1048576);
  const longAfter = data.long.filter(([s]) => s > startAt + 1000 && s >= tStart - 1500);
  res.longTasksAfterSnapshot = longAfter.length;
  res.longTaskMaxMs = r2(Math.max(0, ...longAfter.map((l) => l[1])));
  if (data.T) {
    const T = data.T;
    res.snapshotMs = r2(T.snapshotMs);
    const windows = new Map();
    const add = (t, d) => { if (t < tStart || t > tEnd) return; const k = Math.floor((t - tStart) / 500); windows.set(k, (windows.get(k) ?? 0) + d); };
    for (const [t, d] of T.mo) add(t, d);
    for (const [t, d] of T.flush) add(t, d);
    const w = [...windows.values()];
    const moD = T.mo.filter(([t]) => t >= tStart && t <= tEnd).map((x) => x[1]);
    const flD = T.flush.filter(([t]) => t >= tStart && t <= tEnd).map((x) => x[1]);
    res.moCallP50 = r2(pct(moD, 50)); res.moCallP95 = r2(pct(moD, 95)); res.moCallMax = r2(Math.max(...moD));
    res.flushP50 = r2(pct(flD, 50)); res.flushP95 = r2(pct(flD, 95)); res.flushMax = r2(Math.max(...flD));
    res.mutationsPerCall = r2(T.mo.reduce((a, x) => a + x[2], 0) / T.mo.length);
    res.batchMsP50 = r2(pct(w, 50)); res.batchMsP95 = r2(pct(w, 95)); res.batchMsMax = r2(Math.max(...w));
    res.moCallbacksPerSec = r2(T.mo.filter(([t]) => t >= tStart && t <= tEnd).length / SECONDS);
    res.eventsTotal = T.events; res.droppedTexts = T.droppedTexts; res.coalescedTexts = T.coalescedEmitted;
    res.gzKB = r2(T.gzBytes / 1024); res.rawKB = r2(T.rawBytes / 1024); res.segments = T.segments;
  }
  return res;
}

const REPEAT = Number(process.env.REPEAT ?? 1);
const scenarios = [
  ['baseline (no SDK)', { sdk: false }],
  ['rrweb (PRD config)', { sdk: true, throttle: 'none' }],
  ['rrweb + throttle via emit filter', { sdk: true, throttle: 'emit' }],
  ['rrweb + throttle via mutation hook', { sdk: true, throttle: 'hook' }],
  ['rrweb + hook, throttle=1000', { sdk: true, throttle: 'hook', ms: 1000 }],
  ['rrweb, textContent updates', { sdk: true, throttle: 'none', query: 'text=content' }],
  ['rrweb + hook, textContent updates', { sdk: true, throttle: 'hook', query: 'text=content' }],
  ['rrweb + hook=1000, textContent', { sdk: true, throttle: 'hook', query: 'text=content', ms: 1000 }],
].filter(([n]) => !process.env.ONLY || n.includes(process.env.ONLY));
const results = [];
for (const [name, opts] of scenarios) {
  const runs = [];
  for (let i = 0; i < REPEAT; i++) runs.push(await run(name, opts));
  // median of each numeric field across repeats
  const med = {};
  for (const k of Object.keys(runs[0])) {
    const v = runs.map((r) => r[k]);
    med[k] = typeof v[0] === 'number' ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : v[0];
  }
  results.push(med);
}
console.log(JSON.stringify({ cpuThrottle: RATE, seconds: SECONDS, results }, null, 2));
await browser.close();
server.close();
