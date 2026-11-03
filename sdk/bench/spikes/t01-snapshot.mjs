// Full-snapshot cost vs DOM size (median of N runs). node spikes/t01-snapshot.mjs [rate=4] [runs=7]
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';
const RATE = Number(process.argv[2] ?? 4), RUNS = Number(process.argv[3] ?? 7);
const { server, port } = await startServer(0);
const browser = await chromium.launch();
for (const hist of [0, 60, 235]) {
  const t = []; let counts;
  for (let i = 0; i < RUNS; i++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
    await page.goto(`http://127.0.0.1:${port}/pages/terminal.html?ws=0&hist=${hist}`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    counts = await page.evaluate(() => window.__nodeCount());
    await page.addScriptTag({ path: new URL('../dist/spike-glue.js', import.meta.url).pathname });
    t.push(await page.evaluate(() => { window.__rpStart({ throttle: 'hook' }); return window.__rpT.snapshotMs; }));
    await page.close();
  }
  t.sort((a, b) => a - b);
  console.log(`rate ${RATE}x  elements ${counts.elements}  nodes ${counts.nodes}  snapshot median ${t[RUNS >> 1].toFixed(1)} ms  min ${t[0].toFixed(1)}  max ${t[RUNS - 1].toFixed(1)}`);
}
await browser.close(); server.close();
