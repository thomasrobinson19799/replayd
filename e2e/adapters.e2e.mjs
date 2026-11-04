// T-40 acceptance: every example app (examples/{html,vue,react,nuxt}) reports a component error to the stack
// with the adapter's context. Each example is built against a fresh project (DSN baked in at build time).
// Prereqs: `make up`, `pnpm -C sdk build`, `pnpm -C examples install`. Env ONLY=vue,react,… to run a subset.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}sdk/packages/core/dist`;
const { api } = await login();
const only = process.env.ONLY?.split(',');
const apps = {
  html: { out: null, expect: { source: 'onerror', release: 'html-1.0.0' } },
  vue: { dir: 'vue', out: 'vue/dist', env: 'VITE_REPLAYD_DSN', expect: { source: 'vue', release: 'vue-1.0.0', component: 'OrderPanel' } },
  // production React minifies component names: the component stack is present but not readable
  react: { dir: 'react', out: 'react/dist', env: 'VITE_REPLAYD_DSN', expect: { source: 'react', release: 'react-1.0.0', stack: true } },
  nuxt: { dir: 'nuxt', out: 'nuxt/.output/public', env: 'NUXT_PUBLIC_REPLAYD_DSN', expect: { source: 'vue', release: 'nuxt-1.0.0', component: 'OrderPanel' } },
};
const browser = await chromium.launch();
const results = {};
try {
  for (const [name, a] of Object.entries(apps)) {
    if (only && !only.includes(name)) continue;
    const slug = `ex-${name}-${Date.now().toString(36)}`;
    // the static server's origin must be allowed: create the server first
    const chunks = Object.fromEntries(['replayd.min.js', 'replay.js', 'worker.js'].map((f) => [`/${f}`, `${dist}/${f}`]));
    let dsn = '';
    const srv = await serve(a.out
      ? { dir: `${root}examples/${a.out}`, routes: chunks }
      : { routes: { ...chunks, '/': () => readFileSync(`${root}examples/html/index.html`, 'utf8').replace('__DSN__', dsn) } });
    const project = await api('POST', '/projects', { slug, name: slug, allowed_origins: [srv.origin] });
    dsn = project.dsn;
    if (a.dir) execSync('pnpm build', { cwd: `${root}examples/${a.dir}`, env: { ...process.env, [a.env]: dsn }, stdio: 'ignore' });
    const page = await (await browser.newContext()).newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(srv.origin);
    await page.waitForSelector('#buy');
    await page.waitForTimeout(500);
    await page.click('#buy');
    let issue = null;
    for (let i = 0; i < 40 && !issue; i++) {
      issue = (await api('GET', `/projects/${slug}/issues`)).issues[0] ?? null;
      if (!issue) await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 2500)); // a duplicate report would have arrived by now
    const ev = issue ? (await api('GET', `/issues/${issue.id}/events`)).events : [];
    const e0 = ev[0];
    const ctx = e0?.payload?.ctx ?? {};
    const got = {
      issues: (await api('GET', `/projects/${slug}/issues?status=all`)).issues.length,
      events: issue?.times_seen,
      source: issue?.source,
      release: e0?.release,
      component: ctx.component,
      stack: typeof ctx.componentStack === 'string' && /\n\s+at /.test(ctx.componentStack) ? true : undefined,
      fallback: name === 'react' ? await page.isVisible('#fallback') : undefined,
    };
    const ok = got.issues === 1 && got.events === 1 && Object.entries(a.expect).every(([k, v]) => got[k] === v) && (name !== 'react' || got.fallback);
    results[name] = { ok, ...got };
    console.log(JSON.stringify({ app: name, ...results[name] }));
    await page.context().close();
    srv.server.close();
  }
} finally {
  await browser.close();
}
const pass = Object.values(results).length > 0 && Object.values(results).every((r) => r.ok);
console.log(JSON.stringify({ test: 'adapters: example apps report errors', pass }));
if (!pass) process.exit(1);
