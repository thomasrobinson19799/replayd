// T-34 acceptance: a remote config change made in the dashboard reaches a running APK within 10 min (config TTL)
// without a new build. Emulated APK (Capacitor stub). Time travel = ageing the SDK's cached config (`rp_cfg.t`).
// Canvas fps is out of scope (D-01); the WS frame gate (`ws.maxFramesPerSec`) is used instead.
// Prereqs: `make up`, `pnpm -C sdk build`.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { BASE, login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}sdk/packages/core/dist`;
const { cookies, api } = await login();
const app = await serve({
  routes: {
    ...Object.fromEntries(['replayd.min.js', 'replay.js', 'worker.js', 'capacitor.js'].map((f) => [`/${f}`, `${dist}/${f}`])),
    '/': () => `<!doctype html><html><head><meta charset="utf-8">
<script>window.Capacitor = { isNativePlatform: () => true, Plugins: {} };</script>
<script src="/replayd.min.js"></script><script>Replayd.init({ dsn: window.__DSN, replay: { sampleRate: 0 } });</script></head><body>apk</body></html>`,
  },
});
const slug = `rc-${Date.now().toString(36)}`;
const project = await api('POST', '/projects', { slug, name: `RC ${slug}`, allowed_origins: [app.origin, 'https://localhost'] });
const browser = await chromium.launch();
const checks = {};
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let configFetches = 0;
  page.on('request', (r) => r.url().includes('/config?key=') && configFetches++);
  if (process.env.DEBUG) { page.on('console', (m) => console.log('console', m.text())); page.on('response', (r) => console.log('resp', r.status(), r.url())); }
  await page.addInitScript((d) => { window.__DSN = d; }, project.dsn);
  const cfg = () => page.evaluate(() => JSON.parse(localStorage.getItem('rp_cfg') ?? 'null'));
  const age = (s) => page.evaluate((s) => { const c = JSON.parse(localStorage.getItem('rp_cfg')); c.t -= s * 1000; localStorage.setItem('rp_cfg', JSON.stringify(c)); }, s);
  await page.goto(app.origin);
  await page.waitForFunction(() => !!localStorage.getItem('rp_cfg'), null, { timeout: 15000 });
  const c0 = await cfg();
  checks.initial = c0.c.ws.maxFramesPerSec === 20 && c0.c.v === 1;

  // dashboard: change the WS frame gate
  const dash = await browser.newContext();
  const u = new URL(BASE);
  await dash.addCookies(cookies.map((c) => ({ ...c, domain: u.hostname, path: c.name === 'rp_session' ? '/api' : '/', secure: false })));
  const dp = await dash.newPage();
  await dp.goto(`${BASE}/projects/${slug}/settings?tab=remote`);
  await dp.fill('[data-testid="rc-max-frames"]', '5');
  await dp.click('[data-testid="rc-save"]');
  await dp.waitForSelector('text=Saved (v2)');
  const tSaved = Date.now();
  // the ingest config endpoint serves it after the project cache refresh (≤ 10 s)
  let served = null;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/ingest/${slug}/config?key=${project.public_key}`, { headers: { origin: app.origin } });
    if (!r.ok) { await new Promise((res) => setTimeout(res, 500)); continue; }
    served = await r.json();
    if (served.ws?.maxFramesPerSec === 5) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  checks.served = served?.ws?.maxFramesPerSec === 5 && served?.v === 2;
  const servedAfterMs = Date.now() - tSaved;

  // within the TTL the APK keeps its cached config (no request) …
  await age(5 * 60);
  const before = configFetches;
  await page.reload();
  await page.waitForTimeout(3500);
  checks.cached_within_ttl = configFetches === before && (await cfg()).c.ws.maxFramesPerSec === 20;
  // … once 10 min have passed it fetches and applies the new one
  await age(6 * 60);
  await page.reload();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_cfg')).c.ws.maxFramesPerSec === 5, null, { timeout: 15000 });
  const c2 = await cfg();
  checks.applied_after_ttl = c2.c.ws.maxFramesPerSec === 5 && c2.c.v === 2 && configFetches === before + 1;
  console.log(JSON.stringify({ checks, served_after_ms: servedAfterMs }));
} finally {
  await browser.close();
  app.server.close();
}
const pass = Object.values(checks).every(Boolean) && Object.keys(checks).length === 4;
console.log(JSON.stringify({ test: 'remote config reaches the APK within the TTL', pass }));
if (!pass) process.exit(1);
