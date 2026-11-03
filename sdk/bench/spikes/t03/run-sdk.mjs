// T-03 follow-up (T-13): the REAL built SDK (packages/core/dist/index.js) against the real Capacitor 8.6.0
// native-bridge.js + emulated Android host, CapacitorHttp on/off. Build core first (pnpm build).
// Checks: every app fetch/XHR captured with the app's URL, bodies captured + redacted, failed statuses become
// events, SDK's own requests neither recorded nor routed through the native bridge (D-07).
import { chromium } from 'playwright';
import { startServer } from '../../server.mjs';
import { readFile } from 'node:fs/promises';
const dir = new URL('.', import.meta.url).pathname;
const dist = new URL('../../../packages/core/dist/', import.meta.url).pathname;
const [fake, bridge] = await Promise.all(['fake-android.js', 'native-bridge-8.6.0.js'].map((f) => readFile(dir + f, 'utf8')));
const { server, port } = await startServer(0);
const browser = await chromium.launch();
const expectEntries = ['GET /api/quotes?symbol=EURUSD 200', 'POST /api/orders 500', 'GET /api/missing 404', 'GET /api/quotes?symbol=XAUUSD 200', 'POST /api/orders 500', 'GET /api/quotes?symbol=GBPUSD 200', 'GET /api/quotes?symbol=REL 200'];
let failures = 0;
for (const caphttp of [0, 1]) {
  const page = await browser.newPage();
  const ingest = [];
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    let path = u.pathname + u.search;
    if (u.pathname.startsWith('/sdk/')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(dist + u.pathname.slice(5)) });
    if (u.pathname.startsWith('/ingest/')) { ingest.push(u.pathname); return route.fulfill({ status: u.pathname.endsWith('/config') ? 200 : 202, contentType: 'application/json', body: '{}' }); }
    if (u.pathname === '/_capacitor_http_interceptor_') { const t = new URL(u.searchParams.get('u')); path = t.pathname + t.search; }
    if (path.startsWith('/api/quotes')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, q: path }) });
    if (path.startsWith('/api/orders')) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"margin","token":"t"}' });
    if (path.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'nope' });
    return route.continue();
  });
  await page.addInitScript({ content: fake });
  await page.addInitScript({ content: bridge });
  await page.goto(`http://127.0.0.1:${port}/spikes/t03/t03.html?caphttp=${caphttp}`);
  await page.evaluate(async () => {
    const m = await import('/sdk/index.js');
    m.loaders.capacitor = () => Promise.resolve({ startCapacitor() {} });
    m.loaders.replay = () => Promise.resolve({ startReplay: (i) => (window.__I = i) });
    window.__events = [];
    m.init({ dsn: `http://pk@${location.host}/7`, replay: { networkDetailAllowUrls: ['self'] }, beforeSend: (e) => (window.__events.push(e), e) });
  });
  const app = await page.evaluate(() => window.runApp());
  await page.waitForFunction(() => window.__I, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const { net, events, nativeCalls, platform } = await page.evaluate(() => ({
    net: window.__I.drain().filter((e) => e.type === 'network').map((e) => e.data),
    events: window.__events.map((e) => [e.source, e.message]),
    nativeCalls: window.__nativeCalls.map((c) => c.url),
    platform: window.__I.platform,
  }));
  const got = net.map((e) => `${e.method} ${e.url.replace(/^https?:\/\/[^/]+/, '')} ${e.status}`);
  const missing = expectEntries.filter((e) => got.filter((g) => g === e).length < expectEntries.filter((x) => x === e).length);
  const proxied = net.filter((e) => e.url.includes('_capacitor_http_interceptor_')).length;
  const own = net.filter((e) => e.url.includes('/ingest/')).length + nativeCalls.filter((u) => u.includes('/ingest/')).length;
  const post = net.find((e) => e.method === 'POST');
  const bodiesOk = !!post && JSON.parse(post.reqBody).password === '[Filtered]' && JSON.parse(post.resBody).token === '[Filtered]';
  const appOk = app.f1[1] === true && app.f2[0] === 500 && app.f3 === 404 && app.x1.status === 200 && app.x2.status === 500 && app.x3.status === 200 && app.rel === true;
  const evOk = events.filter((e) => e[0] === 'http').length === 2; // POST 500 (2nd one merged by flood control) + 404
  const ok = missing.length === 0 && proxied === 0 && own === 0 && appOk && bodiesOk && evOk && ingest.some((p) => p.endsWith('/config'));
  if (!ok) failures++;
  if (process.env.V) console.log(JSON.stringify({ got, events, nativeCalls, ingest }, null, 1));
  console.log(`CapacitorHttp=${caphttp ? 'on ' : 'off'} platform=${platform} captured=${got.length}/${expectEntries.length} missing=${JSON.stringify(missing)} proxyUrlsLeaked=${proxied} ownRequestsRecordedOrBridged=${own} bodiesRedacted=${bodiesOk} httpEvents=${evOk} appBehaviourOk=${appOk} => ${ok ? 'PASS' : 'FAIL'}`);
  await page.close();
}
await browser.close(); server.close();
process.exit(failures ? 1 : 0);
