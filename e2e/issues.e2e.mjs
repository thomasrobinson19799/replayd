// T-18 acceptance: an error thrown in a test app is visible in the dashboard issues list within 5 s.
// Prereqs: `make up` (stack on E2E_BASE, bootstrap admin) and `pnpm -C sdk build` (core IIFE).
// The test app is a plain page with the core IIFE until examples/nuxt exists (T-40), then E2E_APP_URL
// points at the Nuxt example instead.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { BASE, login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const BUDGET_MS = 5000;

const { cookies, api } = await login();
const app = await serve({
  routes: {
    '/replayd.min.js': `${process.env.E2E_SDK_DIST ?? `${root}sdk/packages/core/dist`}/replayd.min.js`,
    '/': () => `<!doctype html><html><head><meta charset="utf-8"><title>e2e app</title>
<script src="/replayd.min.js"></script>
<script>Replayd.init({ dsn: window.__DSN, release: 'e2e-1.0.0', environment: 'e2e' });</script></head>
<body><button id="boom">Buy</button>
<script>
  function placeOrder(order) { return order.price.toFixed(2); }
  document.getElementById('boom').addEventListener('click', () => { placeOrder(window.__NONCE_ORDER); });
</script></body></html>`,
  },
});

const slug = `e2e-${Date.now().toString(36)}`;
const project = await api('POST', '/projects', { slug, name: `E2E ${slug}`, allowed_origins: [app.origin] });
const nonce = Math.random().toString(36).slice(2, 8);

const browser = await chromium.launch();
let failed = false;
try {
  // dashboard tab, logged in, issues list open
  const dash = await browser.newContext();
  const u = new URL(BASE);
  await dash.addCookies(cookies.map((c) => ({ ...c, domain: u.hostname, path: c.name === 'rp_session' ? '/api' : '/', secure: false })));
  const dp = await dash.newPage();
  await dp.goto(`${BASE}/projects/${slug}/issues`);
  await dp.waitForSelector('text=No issues match.', { timeout: 15000 });

  // the app: throw a TypeError on click
  const ap = await (await browser.newContext()).newPage();
  await ap.addInitScript(([dsn, n]) => { window.__DSN = dsn; window.__NONCE_ORDER = undefined; window.__N = n; }, [project.dsn, nonce]);
  await ap.goto(app.origin);
  await ap.waitForFunction(() => !!window.Replayd);
  const t0 = Date.now();
  await ap.click('#boom');

  await dp.waitForSelector('[data-testid="issue-row"] >> text=TypeError', { timeout: 20000 });
  const elapsed = Date.now() - t0;
  console.log(JSON.stringify({ test: 'error visible in dashboard', elapsed_ms: elapsed, budget_ms: BUDGET_MS }));
  if (elapsed > BUDGET_MS) failed = true;

  // detail page renders the parsed stack, breadcrumbs and tags
  await dp.click('[data-testid="issue-row"] a');
  await dp.waitForSelector('[data-testid="issue-title"]');
  const title = await dp.textContent('[data-testid="issue-title"]');
  const body = await dp.textContent('main');
  const checks = {
    title: /TypeError/.test(title ?? ''),
    stackFrame: /placeOrder/.test(body ?? ''),
    release: /e2e-1\.0\.0/.test(body ?? ''),
    breadcrumbClick: /button#boom/.test(body ?? ''),
  };
  console.log(JSON.stringify({ test: 'issue detail', checks }));
  if (Object.values(checks).some((v) => !v)) failed = true;
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  app.server.close();
  await api('DELETE', `/projects/${project.id}`).catch(() => {});
}
console.log(failed ? 'E2E FAIL' : 'E2E PASS');
process.exit(failed ? 1 : 0);
