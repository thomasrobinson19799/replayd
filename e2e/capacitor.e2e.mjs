// T-26 acceptance (emulated device): offline → online drains the Capacitor queues.
// A page with a fake Capacitor runtime (isNativePlatform, App + Device plugins) runs the IIFE SDK against the stack.
// While the context is offline it records replay segments (worker IndexedDB outbox) and throws an error (event
// body handed to the Capacitor IndexedDB queue after the transport gives up). Back online + App `resume` → both
// queues drain: the issue appears and the session's recording holds the segments recorded offline.
// Prereqs: `make up`, `pnpm -C sdk build`. A real-device run of the same steps is in the T-51 APK checklist.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { BASE, login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = process.env.E2E_SDK_DIST ?? `${root}sdk/packages/core/dist`;
const { cookies, api } = await login();
const files = Object.fromEntries(['replayd.min.js', 'replay.js', 'worker.js', 'capacitor.js'].map((f) => [`/${f}`, `${dist}/${f}`]));
const app = await serve({
  routes: {
    ...files,
    '/': () => `<!doctype html><html><head><meta charset="utf-8"><title>apk</title>
<script>
  window.__ls = {};
  window.Capacitor = { isNativePlatform: () => true, Plugins: {
    App: { getInfo: async () => ({ version: '1.42.0', build: '142' }), addListener: (ev, f) => ((window.__ls[ev] ??= []).push(f), Promise.resolve({ remove() {} })) },
    Device: { getInfo: async () => ({ model: 'SM-A525F', osVersion: '14', webViewVersion: '130.0' }) } } };
  window.__fire = (ev, e) => (window.__ls[ev] || []).forEach((f) => f(e));
</script>
<script src="/replayd.min.js"></script>
<script>Replayd.init({ dsn: window.__DSN, tunnel: '/_rp', release: 'apk-1.42.0', environment: 'e2e' });</script></head>
<body><h1 id="t">0</h1><button id="boom">Buy</button>
<script>
  let n = 0; setInterval(() => { document.getElementById('t').textContent = String(++n); }, 200);
  document.getElementById('boom').onclick = () => { null.price; };
</script></body></html>`,
  },
});
const slug = `apk-${Date.now().toString(36)}`;
const project = await api('POST', '/projects', { slug, name: `APK ${slug}`, allowed_origins: [app.origin] });
const nonce = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch();
let failed = false;
const t0 = Date.now();
const log = (o) => console.log(JSON.stringify({ t: Date.now() - t0, ...o }));
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript((dsn) => { window.__DSN = dsn; }, project.dsn);
  await page.goto(app.origin);
  // load + idle → capacitor + replay chunks; first segment after ≤ 5 s
  await page.waitForTimeout(7000);
  const idb = () => page.evaluate(() => new Promise((ok) => {
    const r = indexedDB.open('replayd', 1);
    r.onsuccess = () => {
      const t = r.result.transaction(['q', 'e']);
      const a = t.objectStore('q').count(), b = t.objectStore('e').count();
      t.oncomplete = () => ok({ segments: a.result, events: b.result });
    };
    r.onerror = () => ok(null);
  }));
  await ctx.setOffline(true);
  log({ step: 'offline' });
  await page.evaluate((n) => { window.__nonce = n; document.title = n; }, nonce);
  await page.click('#boom');
  await page.evaluate(() => window.__fire('pause'));
  // core events: 5 attempts with backoff (≈ 15 s) before the body goes to the IndexedDB queue
  await page.waitForTimeout(20000);
  const stored = await idb();
  log({ step: 'stored while offline', ...stored });
  if (!(stored?.segments > 0 && stored?.events > 0)) failed = true;
  await ctx.setOffline(false);
  await page.evaluate(() => window.__fire('resume'));
  const tOn = Date.now();
  log({ step: 'online + resume' });
  // the issue arrives
  let issue = null;
  for (let i = 0; i < 40 && !issue; i++) {
    const list = await api('GET', `/projects/${slug}/issues`);
    issue = (list.issues ?? list.items ?? []).find((x) => /price/.test(x.title)) ?? null;
    if (!issue) await new Promise((r) => setTimeout(r, 500));
  }
  log({ step: 'issue visible', ok: !!issue, ms_after_online: Date.now() - tOn });
  if (!issue) failed = true;
  await page.waitForTimeout(4000);
  const left = await idb();
  log({ step: 'queues after drain', ...left });
  if (left?.segments !== 0 || left?.events !== 0) failed = true;
  // session: APK platform + device meta, recording covers the offline period
  const sessions = await api('GET', `/projects/${slug}/sessions`);
  const s = sessions.sessions[0];
  const d = s && (await api('GET', `/sessions/${s.id}`));
  log({ step: 'session', platform: d?.platform, app_version: d?.app_version, device: d?.device_model, segments: d?.segments, has_gap: d?.has_gap });
  if (d?.platform !== 'capacitor-android' || d?.device_model !== 'SM-A525F' || !(d?.segments >= 5)) failed = true;
  await ctx.close();
} finally {
  await browser.close();
  app.server.close();
}
console.log(JSON.stringify({ test: 'capacitor offline → online drain', pass: !failed }));
if (failed) process.exit(1);
