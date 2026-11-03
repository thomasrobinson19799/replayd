// T-03 runner: real Capacitor 8.6.0 native-bridge.js + emulated Android host, CapacitorHttp on/off.
import { chromium } from 'playwright';
import { startServer } from '../../server.mjs';
import { readFile } from 'node:fs/promises';
const dir = new URL('.', import.meta.url).pathname;
const [fake, bridge, patch] = await Promise.all(['fake-android.js', 'native-bridge-8.6.0.js', 'http-patch.js'].map((f) => readFile(dir + f, 'utf8')));
const { server, port } = await startServer(0);
const browser = await chromium.launch();
const expectEntries = ['GET /api/quotes?symbol=EURUSD 200', 'POST /api/orders 500', 'GET /api/missing 404', 'GET /api/quotes?symbol=XAUUSD 200', 'POST /api/orders 500', 'GET /api/quotes?symbol=GBPUSD 200', 'GET /api/quotes?symbol=REL 200'];
let failures = 0;
for (const caphttp of [0, 1]) for (const mode of ['naive', 'planned']) {
  const page = await browser.newPage();
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    let path = u.pathname + u.search;
    if (u.pathname === '/_capacitor_http_interceptor_') { const t = new URL(u.searchParams.get('u')); path = t.pathname + t.search; }
    if (path.startsWith('/api/quotes')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, q: path }) });
    if (path.startsWith('/api/orders')) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"margin"}' });
    if (path.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'nope' });
    return route.continue();
  });
  await page.addInitScript({ content: fake });
  await page.addInitScript({ content: `${bridge}` }); // document-start, like WebViewCompat.addDocumentStartJavaScript
  await page.addInitScript({ content: patch });
  await page.goto(`http://127.0.0.1:${port}/spikes/t03/t03.html?caphttp=${caphttp}`);
  const info = await page.evaluate((m) => window.__rpHttp.install(m), mode);
  const app = await page.evaluate(() => window.runApp());
  await page.waitForTimeout(300);
  const { log, nativeCalls, platform } = await page.evaluate(() => ({ log: window.__rpHttp.log, nativeCalls: window.__nativeCalls, platform: window.Capacitor.getPlatform() }));
  const got = log.map((e) => `${e.method} ${e.url.replace(/^https?:\/\/[^/]+/, '')} ${e.status}`);
  const missing = expectEntries.filter((e) => !got.includes(e) || got.filter((g) => g === e).length < expectEntries.filter((x) => x === e).length);
  const proxied = log.filter((e) => e.url.includes('_capacitor_http_interceptor_')).length;
  const appOk = app.f1[1] === true && app.f2[0] === 500 && app.f3 === 404 && app.x1.status === 200 && app.x2.status === 500 && app.x3.status === 200 && app.rel === true;
  const ok = missing.length === 0 && proxied === 0 && appOk;
  if (mode === 'planned' && !ok) failures++;
  if (process.env.V) console.log(JSON.stringify(nativeCalls), JSON.stringify(log.map((e) => [e.via, e.method, e.url.slice(-30), e.status])));
  console.log(`CapacitorHttp=${caphttp ? 'on ' : 'off'} patch=${mode.padEnd(7)} platform=${platform} bridgedXHR=${info.bridged} native calls=${nativeCalls.length} captured=${log.length}/${expectEntries.length} missing=${JSON.stringify(missing)} proxyUrlsLeaked=${proxied} appBehaviourOk=${appOk} => ${ok ? 'PASS' : 'FAIL'}`);
  await page.close();
}
await browser.close(); server.close();
process.exit(failures ? 1 : 0);
