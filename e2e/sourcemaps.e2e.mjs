// T-30 acceptance: original TS lines are shown for web and APK builds of the same release.
// 1. esbuild bundles + minifies e2e/fixtures/sm-app/src/*.ts with a source map (like `nuxt build`).
// 2. The SAME bundle runs on the web origin (http://127.0.0.1:<port>/assets/app.js) and on an emulated APK
//    page (https://localhost/assets/app.js via Playwright routing, Capacitor stub → platform capacitor-android).
// 3. Release A: maps uploaded with `@replayd/cli` BEFORE the errors → symbolicated at ingest.
//    Release B: error first, upload after → reprocessed (stored frames updated, issue marked symbolicated).
// Checks via the dashboard API: frames carry orig {file: src/order.ts, line, context}; web + APK group into one
// issue per release; culprit names the original file.
// Prereqs: `make up`, `pnpm -C sdk build`.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { build } = await import(new URL('../sdk/node_modules/esbuild/lib/main.js', import.meta.url).href);
const dist = `${root}sdk/packages/core/dist`;
const cli = `${root}sdk/packages/cli/dist/index.js`;

// built next to the sources (like a real build): map sources come out as ../src/*.ts → src/*.ts
const out = `${root}e2e/fixtures/sm-app/dist`;
rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [`${root}e2e/fixtures/sm-app/src/main.ts`], bundle: true, minify: true, sourcemap: true,
  format: 'iife', outfile: join(out, 'assets/app.js'), sourcesContent: true, logLevel: 'error',
});
const appJs = readFileSync(join(out, 'assets/app.js'), 'utf8');

const { api } = await login();
const page = (sdkSrc) => `<!doctype html><html><head><meta charset="utf-8"><title>sm</title>
<script>${'${CAP}'}</script>
<script src="${sdkSrc}"></script>
<script>Replayd.init({ dsn: window.__DSN, release: window.__REL, environment: 'e2e', replay: { sampleRate: 0 } });</script></head>
<body><button id="buy">Buy</button><script src="/assets/app.js"></script></body></html>`;
const chunks = Object.fromEntries(['replay.js', 'worker.js', 'capacitor.js'].map((f) => [`/${f}`, `${dist}/${f}`]));
const app = await serve({ routes: { ...chunks, '/replayd.min.js': `${dist}/replayd.min.js`, '/assets/app.js': () => appJs, '/': () => page('/replayd.min.js').replace('${CAP}', '') } });
const slug = `sm-${Date.now().toString(36)}`;
const project = await api('POST', '/projects', { slug, name: `SM ${slug}`, allowed_origins: [app.origin, 'http://localhost', 'https://localhost'] });
const upload = (release) =>
  execFileSync('node', [cli, 'sourcemaps', 'upload', '--project', slug, '--release', release, '--dir', join(out, 'assets'), '--url-prefix', '~/assets'], {
    env: { ...process.env, REPLAYD_URL: BASE, REPLAYD_TOKEN: project.upload_token }, encoding: 'utf8',
  }).trim();

// the routed APK origin counts as public for Chromium's Local Network Access checks, which would block its
// requests to the loopback test stack (a real APK posts to a public ingest host)
const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests'] });
const fire = async (where, release) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const p = await ctx.newPage();
  await p.addInitScript(([dsn, rel]) => { window.__DSN = dsn; window.__REL = rel; }, [project.dsn, release]);
  if (process.env.DEBUG) { p.on('console', (m) => console.log('console', where, m.text())); p.on('requestfailed', (r) => console.log('failed', where, r.url(), r.failure()?.errorText)); p.on('response', (r) => r.url().includes('ingest') && console.log('resp', where, r.status(), r.url())); }
  if (where === 'apk') {
    // APK: app served from the WebView's localhost origin; SDK posts directly to the DSN host. (http here:
    // an https://localhost page may not POST to the plain-http test stack — mixed content; URL normalization
    // treats both schemes the same.)
    const sdk = readFileSync(`${dist}/replayd.min.js`);
    await p.route('http://localhost/**', (r) => {
      const u = new URL(r.request().url());
      if (u.pathname === '/replayd.min.js') return r.fulfill({ contentType: 'text/javascript', body: sdk });
      if (chunks[u.pathname]) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(chunks[u.pathname]) });
      if (u.pathname === '/assets/app.js') return r.fulfill({ contentType: 'text/javascript', body: appJs });
      return r.fulfill({ contentType: 'text/html', body: page('/replayd.min.js').replace('${CAP}', 'window.Capacitor = { isNativePlatform: () => true, Plugins: {} };') });
    });
    await p.goto('http://localhost/');
  } else await p.goto(app.origin);
  await p.waitForFunction(() => !!window.Replayd);
  await p.click('#buy');
  await p.evaluate(() => window.Replayd.flush());
  await p.waitForTimeout(500);
  await ctx.close();
};
const issueOf = async (release) => {
  for (let i = 0; i < 40; i++) {
    const { issues } = await api('GET', `/projects/${slug}/issues?release=${encodeURIComponent(release)}`);
    const it = issues.find((x) => /toFixed/.test(x.title));
    if (it) return it;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
};
const framesOf = async (issueId, n) => {
  for (let i = 0; i < 40; i++) {
    const { events } = await api('GET', `/issues/${issueId}/events`);
    if (events.length >= n) return events;
    await new Promise((r) => setTimeout(r, 500));
  }
  return [];
};
const checkOrig = (ev) => {
  const f = (ev.payload?.frames ?? ev.frames ?? []).find((x) => x.orig);
  return f?.orig ?? null;
};
const results = {};
let failed = false;
try {
  // A: upload first
  console.log(upload('A-1.0.0'));
  await fire('web', 'A-1.0.0');
  await fire('apk', 'A-1.0.0');
  const a = await issueOf('A-1.0.0');
  const evA = a ? await framesOf(a.id, 2) : [];
  results.A = { issue: a?.id, culprit: a?.culprit, symbolicated: a?.symbolicated, events: evA.map((e) => ({ platform: e.platform, orig: checkOrig(e) })) };
  // B: error first, then upload → reprocess
  await fire('web', 'B-1.0.0');
  const b0 = await issueOf("B-1.0.0");
  const before = b0 ? checkOrig((await framesOf(b0.id, 1))[0]) : 'none';
  console.log(upload('B-1.0.0'));
  let b = null, evB = [];
  for (let i = 0; i < 20; i++) {
    b = (await api('GET', `/issues/${b0.id}`));
    evB = await framesOf(b0.id, 1);
    if (b.symbolicated && checkOrig(evB[0])) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  results.B = { before_upload: before, after: checkOrig(evB[0]), symbolicated: b?.symbolicated, culprit: b?.culprit };
  console.log(JSON.stringify(results, null, 1));
  const good = (o) => !!o && o.file === 'src/order.ts' && o.line === 4 && /price!?\.toFixed/.test(o.context);
  const checks = {
    a_two_events_symbolicated: !!a && evA.length >= 2 && evA.every((e) => good(checkOrig(e))),
    a_web_and_apk_one_issue: new Set(evA.map((e) => e.platform)).size === 2,
    a_issue_symbolicated: !!a?.symbolicated && /src\/order\.ts/.test(a?.culprit ?? ''),
    b_unsymbolicated_before_upload: results.B.before_upload === null,
    b_reprocessed: good(results.B.after) && !!b?.symbolicated,
  };
  console.log(JSON.stringify({ checks }));
  failed = !Object.values(checks).every(Boolean);
} finally {
  await browser.close();
  app.server.close();
  rmSync(out, { recursive: true, force: true });
}
console.log(JSON.stringify({ test: 'source maps web + APK, upload before and after (reprocess)', pass: !failed }));
if (failed) process.exit(1);
