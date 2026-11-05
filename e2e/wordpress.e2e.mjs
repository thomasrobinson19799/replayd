// T-41 (local): the replayd-wp plugin on a real WordPress 6.8 — tag first in <head> with data-* config, an error
// thrown before any interaction and one on click arrive as issues, and the replay is recorded.
// The staging fxglory.com check (with WP Rocket enabled) needs access and is part of the T-41 notes.
// Prereqs: `make up`, `pnpm -C sdk build`, Docker.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
const rocketChecks = {};
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
  const rocket = resolve(process.env.WPROCKET_DIR || `${root}data/wp-rocket`);
  if (existsSync(`${rocket}/inc/Engine/Optimization/DelayJS/HTML.php`)) {
    // Exercise the actual plugin's exclusions against WP Rocket's public DelayJS implementation.
    // This is local compatibility evidence, not a claim that staging has been deployed.
    const fixtureDir = `${root}data/wp-compat`;
    mkdirSync(fixtureDir, { recursive: true });
    const html = await (await fetch(`${WP}/`)).text();
    writeFileSync(`${fixtureDir}/page.html`, html);
    const exclusions = JSON.parse(wp('eval', 'echo json_encode(apply_filters("rocket_delay_js_exclusions", []));'));
    for (const excluded of [false, true]) {
      const transformed = execFileSync('docker', ['run', '--rm', '--entrypoint', 'php',
        '-v', `${root}:/repo:ro`, '-v', `${rocket}:/wpr:ro`, 'wordpress:cli-php8.3',
        '/repo/sdk/bench/spikes/t04/delayjs-harness.php', '/wpr', '/repo/data/wp-compat/page.html',
        ...(excluded ? exclusions : [])], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      writeFileSync(`${fixtureDir}/${excluded ? 'excluded' : 'default'}.html`, transformed);
      const pageName = `replayd-delay-${excluded ? 'excluded' : 'default'}.html`;
      compose('cp', `${fixtureDir}/${excluded ? 'excluded' : 'default'}.html`, `wp:/var/www/html/${pageName}`);
      const context = await browser.newContext();
      const delayed = await context.newPage();
      // Use a real local HTTP response: synthetic route.fulfill loses the response's
      // loopback classification in current Chrome and blocks cross-origin local SDKs.
      await delayed.goto(`${WP}/${pageName}`);
      await delayed.waitForTimeout(2000);
      const before = await delayed.evaluate(() => ({ sdk: !!window.Replayd, delayed: document.querySelectorAll('script[type="text/rocketlazyloadscript"]').length, sdkDelayed: document.getElementById('replayd-js')?.type === 'text/rocketlazyloadscript' }));
      rocketChecks[excluded ? 'sdk_excluded_before_interaction' : 'negative_control_sdk_delayed'] = excluded ? before.sdk : !before.sdk;
      if (excluded) {
        rocketChecks.sdk_tag_preserved = !before.sdkDelayed;
        rocketChecks.other_scripts_delayed = before.delayed > 0;
        await delayed.mouse.move(100, 100);
        await delayed.keyboard.press('Tab');
        await delayed.waitForTimeout(2000);
        rocketChecks.delayed_scripts_released = await delayed.evaluate(() => document.querySelectorAll('script[type="text/rocketlazyloadscript"]').length === 0);
      }
      await context.close();
    }
  }
  console.log(JSON.stringify({ checks, rocketChecks, script_ids: head.slice(0, 2).map(x => x.id), session: s && { segments: s.segments, errors: s.error_count } }));
} finally {
  await browser.close();
  sdk.server.close();
  if (!process.env.KEEP) compose('down', '-v');
}
const pass = Object.values(checks).every(Boolean) && Object.keys(checks).length === 5 && Object.values(rocketChecks).every(Boolean);
if (!Object.keys(rocketChecks).length) console.log('WP Rocket compatibility not run: set WPROCKET_DIR to the public v3.24 source checkout.');
console.log(JSON.stringify({ test: 'replayd-wp on WordPress 6.8', pass }));
if (!pass) process.exit(1);
