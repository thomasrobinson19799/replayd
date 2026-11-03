// init() cost (PRD §4.4: synchronous, < 1 ms), cold: a fresh page per sample, so lazy function compilation
// and first-use costs are included. The page is cross-origin isolated (COOP/COEP) for 5 µs timer resolution.
// Usage: pnpm --filter @replayd/bench run bench:init     env: SAMPLES=15 RATES=1,4 NO_BUILD=1
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';

const SAMPLES = Number(process.env.SAMPLES ?? 15), RATES = (process.env.RATES ?? '1,4').split(',').map(Number);
const sdkRoot = new URL('../../', import.meta.url).pathname;
const dist = new URL('../../packages/core/dist/', import.meta.url).pathname;
if (!process.env.NO_BUILD) execSync('pnpm --filter @replayd/core run build', { cwd: sdkRoot, stdio: 'inherit' });

const { server, port } = await startServer(0);
const browser = await chromium.launch();
for (const rate of RATES) {
  const ts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const page = await browser.newPage();
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      const h = { 'cross-origin-resource-policy': 'same-origin' };
      if (u.pathname.startsWith('/sdk/')) return route.fulfill({ status: 200, contentType: 'text/javascript', headers: h, body: await readFile(dist + u.pathname.slice(5)) });
      if (u.pathname === '/init.html')
        return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }, body: '<!doctype html><title>init</title>' });
      return route.fulfill({ status: 202, headers: h, body: '{}' });
    });
    await page.goto(`http://127.0.0.1:${port}/init.html`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    ts.push(await page.evaluate(async () => {
      const m = await import('/sdk/index.js');
      const t = performance.now();
      m.init({ dsn: `http://pk@${location.host}/7`, tunnel: '/_rp', release: '1.0.0', environment: 'production' });
      return performance.now() - t;
    }));
    await page.close();
  }
  ts.sort((a, b) => a - b);
  const q = (p) => ts[Math.min(ts.length - 1, Math.floor(p * ts.length))].toFixed(3);
  console.log(`init() cold @ ${rate}× CPU: median ${q(0.5)} ms  p90 ${q(0.9)} ms  min ${ts[0].toFixed(3)} ms  (n=${SAMPLES})`);
}
await browser.close();
server.close();
