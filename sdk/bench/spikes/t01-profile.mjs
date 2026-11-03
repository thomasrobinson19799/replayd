// CPU-profile rrweb on the terminal mock; prints top self-time functions.
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';
const glue = process.argv[2] ?? 'spike-glue.js';
const query = process.argv[3] ?? '';
const { server, port } = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.goto(`http://127.0.0.1:${port}/pages/terminal.html?${query}`, { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.addScriptTag({ path: new URL(`../dist/${glue}`, import.meta.url).pathname });
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');
await page.evaluate((m) => window.__rpStart({ throttle: m }), process.env.MODE ?? 'hook');
await page.waitForTimeout(1500);
const snap = (await cdp.send('Profiler.stop')).profile;
await cdp.send('Profiler.start');
await page.waitForTimeout(8000);
const { profile } = await cdp.send('Profiler.stop');
function top(profile, label) {
  const self = new Map(); const dt = profile.timeDeltas; const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0)); });
  console.log(`--- ${label}`);
  [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).forEach(([k, v]) => console.log((v / 1000).toFixed(1).padStart(8), 'ms', k));
}
top(snap, 'snapshot phase'); top(profile, 'steady 8s');
await browser.close(); server.close();
