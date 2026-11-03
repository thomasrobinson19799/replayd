// T-41 (local): the replayd-wp plugin on a real WordPress 6.8 — tag first in <head> with data-* config, an error
// thrown before any interaction and one on click arrive as issues, and the replay is recorded.
// The staging fxglory.com check (with WP Rocket enabled) needs access and is part of the T-41 notes.
// Prereqs: `make up`, `pnpm -C sdk build`, Docker.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}sdk/packages/core/dist`;
const WP = `http://localhost:${process.env.WP_PORT ?? 8089}`;
const compose = (...a) => execFileSync('docker', ['compose', '-f', `${root}wordpress/test/docker-compose.yml`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const wp = (...a) => compose('run', '--rm', 'cli', 'wp', ...a).trim();

compose('up', '-d', '--wait', 'db', 'wp');
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${WP}/wp-admin/install.php`)).status < 500) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 1000));
}
try { wp('core', 'is-installed'); } catch { wp('core', 'install', `--url=${WP}`, '--title=replayd e2e', '--admin_user=admin', '--admin_password=admin-pass-123', '--admin_email=a@example.com', '--skip-email'); }
wp('plugin', 'activate', 'replayd-wp');

const { api } = await login();
// the SDK (and its lazy chunks) from a separate origin: exercises the cross-origin worker bootstrap too
const sdk = await serve({ routes: Object.fromEntries(['replayd.min.js', 'replay.js', 'worker.js'].map((f) => [`/${f}`, `${dist}/${f}`])) });
const slug = `wp-${Date.now().toString(36)}`;
const project = await api('POST', '/projects', { slug, name: slug, allowed_origins: [WP] });
wp('option', 'update', 'replayd_wp', JSON.stringify({ enabled: '1', dsn: project.dsn, release: 'wp-1.0.0', environment: 'e2e', tunnel: '', sdk_url: `${sdk.origin}/replayd.min.js` }), '--format=json');

const browser = await chromium.launch();
const checks = {};
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${WP}/`);
  const head = await page.evaluate(() => [...document.head.querySelectorAll('script[src]')].map((s) => ({ id: s.id, src: s.src, dsn: s.dataset.dsn, defer: s.defer })));
  checks.first_in_head = head[0]?.id === 'replayd-js' && head[0].defer && head[0].dsn === project.dsn;
  checks.no_inline_config = !(await page.content()).includes('Replayd.init');
  // no interaction: the DOMContentLoaded error must arrive
  const issues = async () => (await api('GET', `/projects/${slug}/issues`)).issues;
  let list = [];
  for (let i = 0; i < 30 && !list.some((x) => /themeInit|slider/.test(x.title)); i++) {
    list = await issues();
    await new Promise((r) => setTimeout(r, 500));
  }
  checks.error_before_interaction = list.some((x) => /themeInit|slider/.test(x.title));
  await page.click('#buy');
  for (let i = 0; i < 30 && !list.some((x) => /price/.test(x.title)); i++) {
    list = await issues();
    await new Promise((r) => setTimeout(r, 500));
  }
  checks.click_error = list.some((x) => /price/.test(x.title));
  await page.waitForTimeout(6000);
  await page.close();
  let s = null;
  for (let i = 0; i < 20 && !s; i++) {
    s = (await api('GET', `/projects/${slug}/sessions`)).sessions[0] ?? null;
    if (!s) await new Promise((r) => setTimeout(r, 1000));
  }
  checks.replay_recorded = !!s && s.segments >= 1 && s.release === 'wp-1.0.0';
  console.log(JSON.stringify({ checks, head: head.slice(0, 2), session: s && { segments: s.segments, errors: s.error_count } }));
} finally {
  await browser.close();
  sdk.server.close();
  if (!process.env.KEEP) compose('down', '-v');
}
const pass = Object.values(checks).every(Boolean) && Object.keys(checks).length === 5;
console.log(JSON.stringify({ test: 'replayd-wp on WordPress 6.8', pass }));
if (!pass) process.exit(1);
