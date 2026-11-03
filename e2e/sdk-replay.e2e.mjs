// T-20 + T-23 end to end: a real SDK recording (IIFE + lazy replay chunk + worker → /ingest → shard writer →
// .rpl) is played back in the dashboard player, with its console / network / errors / WS tabs filled.
// Prereqs: `make up`, `pnpm -C sdk build`.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../sdk/bench/node_modules/ws/wrapper.mjs';
import { BASE, login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = process.env.E2E_SDK_DIST ?? `${root}sdk/packages/core/dist`;
const RECORD_MS = Number(process.env.RECORD_MS ?? 12000);
const { cookies, api } = await login();
const files = Object.fromEntries(['replayd.min.js', 'replay.js', 'worker.js'].map((f) => [`/${f}`, `${dist}/${f}`]));
const app = await serve({
  routes: {
    ...files,
    '/api/quote': () => JSON.stringify({ s: 'EURUSD', b: 1.0851 }),
    '/': () => `<!doctype html><html><head><meta charset="utf-8"><title>sdk replay e2e</title>
<script src="/replayd.min.js"></script>
<script>Replayd.init({ dsn: window.__DSN, release: 'e2e-replay-1', environment: 'e2e', replay: { networkDetailAllowUrls: ['self'] } });</script></head>
<body><h1>Terminal</h1>
<table id="wl" data-rp-throttle="1000"><tbody>${Array.from({ length: 20 }, (_, i) => `<tr><td>SYM${i}</td><td class="b">1.0000</td></tr>`).join('')}</tbody></table>
<form><input name="login" value="10023451"><input type="password" value="hunter2"></form>
<button id="buy">Buy</button><div id="log"></div>
<script>
  const cells = [...document.querySelectorAll('#wl .b')];
  setInterval(() => { for (const c of cells) c.firstChild.nodeValue = (1 + Math.random() / 100).toFixed(4); }, 100);
  const ws = new WebSocket('ws://' + location.hostname + ':' + window.__WSPORT + '/connection/websocket');
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, connect: { token: 'secret-jwt' } }));
  document.getElementById('buy').onclick = async () => {
    console.log('placing order', { symbol: 'EURUSD' });
    const r = await fetch('/api/quote'); await r.json();
    const li = document.createElement('p'); li.textContent = 'order placed'; document.getElementById('log').append(li);
    setTimeout(() => { null.price; }, 200);
  };
</script></body></html>`,
  },
});
// Centrifugo-like pushes
const wss = new WebSocketServer({ port: 0, path: '/connection/websocket' });
await new Promise((r) => wss.on('listening', r));
wss.on('connection', (s) => {
  const t = setInterval(() => s.send(JSON.stringify({ push: { channel: 'quotes:EURUSD', pub: { data: { b: Math.random() } } } })), 50);
  s.on('close', () => clearInterval(t));
});

const slug = `rec-${Date.now().toString(36)}`;
const project = await api('POST', '/projects', { slug, name: `Rec ${slug}`, allowed_origins: [app.origin] });
const browser = await chromium.launch();
let failed = false;
try {
  const ap = await (await browser.newContext()).newPage();
  await ap.addInitScript(([dsn, port]) => { window.__DSN = dsn; window.__WSPORT = port; }, [project.dsn, wss.address().port]);
  await ap.goto(app.origin);
  await ap.waitForTimeout(3500); // load + idle → replay chunk + snapshot
  await ap.mouse.move(100, 100);
  await ap.click('#buy');
  await ap.waitForTimeout(RECORD_MS);
  await ap.close(); // pagehide → final segment (keepalive)

  // the session row appears (aggregator flushes every 3 s)
  let s = null;
  for (let i = 0; i < 30 && !s; i++) {
    s = (await api('GET', `/projects/${slug}/sessions`)).sessions[0] ?? null;
    if (!s || s.segments < 2) { s = null; await new Promise((r) => setTimeout(r, 1000)); }
  }
  console.log(JSON.stringify({ step: 'session', id: s?.id, segments: s?.segments, errors: s?.error_count, bytes: s?.bytes }));
  if (!s) throw new Error('no session');

  const dash = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const u = new URL(BASE);
  await dash.addCookies(cookies.map((c) => ({ ...c, domain: u.hostname, path: c.name === 'rp_session' ? '/api' : '/', secure: false })));
  const dp = await dash.newPage();
  await dp.goto(`${BASE}/replay/${s.id}`);
  await dp.waitForFunction(() => window.__rpFirstFrameMs !== undefined && window.__rpDoneMs !== undefined, null, { timeout: 30000 });
  const frame = dp.frameLocator('.replayer-wrapper iframe');
  const rows = await frame.locator('#wl tr').count();
  const pw = await frame.locator('input[type=password]').getAttribute('value');
  const counts = await dp.evaluate(() => Object.fromEntries([...document.querySelectorAll('aside nav button')].map((b) => [b.textContent.trim().split(/\s+/)[0], Number(b.textContent.trim().split(/\s+/)[1] ?? 0)])));
  // play to the end at 8× and check the DOM change made after the click
  await dp.selectOption('select', '8');
  await dp.waitForTimeout(3500);
  const placed = await frame.locator('#log p').count();
  const r = { first_frame_ms: await dp.evaluate(() => window.__rpFirstFrameMs), rows, password_masked: pw !== 'hunter2', tabs: counts, order_placed_rendered: placed };
  console.log(JSON.stringify(r));
  if (rows !== 20 || !r.password_masked || !(counts.console >= 1) || !(counts.network >= 1) || !(counts.Errors >= 1 || counts.errors >= 1) || !(counts.WS >= 1)) failed = true;
  await dash.close();
} finally {
  await browser.close();
  app.server.close();
  wss.close();
}
console.log(JSON.stringify({ test: 'real SDK recording plays in the player', pass: !failed }));
if (failed) process.exit(1);
