// T-31 acceptance: resolve an issue in the dashboard; the same error arriving again reopens it as a regression.
// Prereqs: `make up`, `pnpm -C sdk build`.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { BASE, login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { cookies, api } = await login();
const app = await serve({
  routes: {
    '/replayd.min.js': `${root}sdk/packages/core/dist/replayd.min.js`,
    '/': () => `<!doctype html><html><head><meta charset="utf-8"><script src="/replayd.min.js"></script>
<script>Replayd.init({ dsn: window.__DSN, release: window.__REL, replay: { sampleRate: 0 } });</script></head>
<body><button id="boom">Buy</button><script>document.getElementById('boom').onclick = () => { null.qty; };</script></body></html>`,
  },
});
const slug = `st-${Date.now().toString(36)}`;
const project = await api('POST', '/projects', { slug, name: `Status ${slug}`, allowed_origins: [app.origin] });
const browser = await chromium.launch();
let failed = false;
const fire = async (rel) => {
  const p = await (await browser.newContext()).newPage();
  await p.addInitScript(([d, r]) => { window.__DSN = d; window.__REL = r; }, [project.dsn, rel]);
  await p.goto(app.origin);
  await p.waitForFunction(() => !!window.Replayd);
  await p.click('#boom');
  await p.evaluate(() => window.Replayd.flush());
  await p.context().close();
};
try {
  await fire('1.0.0');
  let issue;
  for (let i = 0; i < 30 && !issue; i++) {
    issue = (await api('GET', `/projects/${slug}/issues`)).issues[0];
    if (!issue) await new Promise((r) => setTimeout(r, 500));
  }
  const dash = await browser.newContext();
  const u = new URL(BASE);
  await dash.addCookies(cookies.map((c) => ({ ...c, domain: u.hostname, path: c.name === 'rp_session' ? '/api' : '/', secure: false })));
  const dp = await dash.newPage();
  await dp.goto(`${BASE}/projects/${slug}/issues/${issue.id}`);
  // resolve in next release: the same release does not reopen it …
  await dp.locator('summary').filter({hasText:'Resolve options'}).click();
  await dp.click('[data-testid="action-resolve-next"]');
  await dp.waitForSelector('[data-testid="issue-status-text"] >> text=Resolved in next release (after 1.0.0)');
  await fire('1.0.0');
  await new Promise((r) => setTimeout(r, 3000));
  const stillResolved = (await api('GET', `/issues/${issue.id}`)).status === 'resolved';
  // … a new release does: regression
  await fire('1.1.0');
  let after;
  for (let i = 0; i < 30; i++) {
    after = await api('GET', `/issues/${issue.id}`);
    if (after.status === 'unresolved') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await dp.reload();
  const text = await dp.textContent('[data-testid="issue-status-text"]');
  // plain resolve → any new event regresses; ignore for next 10 events keeps it ignored
  await dp.click('[data-testid="action-ignore"]');
  await dp.click('[data-testid="action-ignore-10"]');
  await dp.waitForSelector('[data-testid="issue-status-text"] >> text=Ignored for 10 more events');
  const r = { stillResolved, reopened: after?.status === 'unresolved', regressed_at: !!after?.regressed_at, ui: text?.trim() };
  console.log(JSON.stringify(r));
  if (!stillResolved || !r.reopened || !r.regressed_at || !/regressed/.test(r.ui ?? '')) failed = true;
} finally {
  await browser.close();
  app.server.close();
}
console.log(JSON.stringify({ test: 'issue status: resolve in next release → regression', pass: !failed }));
if (failed) process.exit(1);
