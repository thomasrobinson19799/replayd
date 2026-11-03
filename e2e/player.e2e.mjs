// T-23 acceptance: the replay player shows the first frame of a 60-minute session in < 1 s and plays
// progressively while the rest of the recording is still downloading.
// Prereqs: `make up`, `pnpm -C sdk build`, then either SID=<sid of an installed session> or let this script run
// e2e/gen-replay.mjs with INSTALL=1 (default 60 minutes).
//
// The recording download is throttled (env MBPS, default 20 Mbit/s ≈ a decent mobile link) so that a 60-minute
// file takes seconds to download and "progressive" is observable; first-frame time is measured from navigation
// start (performance.now() in the dashboard page, which includes SPA boot, auth check and session API call).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASE, login } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const BUDGET_MS = 1000;
const MBPS = Number(process.env.MBPS ?? 20);
const RUNS = Number(process.env.RUNS ?? 3);

let gen = null;
let sid = process.env.SID;
if (!sid) {
  const outp = execFileSync('node', [`${root}e2e/gen-replay.mjs`], { env: { ...process.env, INSTALL: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  gen = JSON.parse(outp.trim().split('\n').at(-1));
  sid = gen.sid;
}

const { cookies } = await login();
const browser = await chromium.launch();
const results = [];
let failed = false;
try {
  for (let run = 0; run < RUNS; run++) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const u = new URL(BASE);
    await ctx.addCookies(cookies.map((c) => ({ ...c, domain: u.hostname, path: c.name === 'rp_session' ? '/api' : '/', secure: false })));
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 20, downloadThroughput: (MBPS * 1e6) / 8, uploadThroughput: (MBPS * 1e6) / 8,
    });
    await page.goto(`${BASE}/replay/${sid}`);
    await page.waitForFunction(() => window.__rpFirstFrameMs !== undefined, null, { timeout: 30000 });
    const first = await page.evaluate(() => ({ ms: window.__rpFirstFrameMs, load: window.__rpFirstFrameLoad }));
    // progressive: playback time advances while the download is still running
    const t1 = await page.evaluate(() => window.__rpPlayer.time());
    await page.waitForTimeout(700);
    const mid = await page.evaluate(() => ({ t: window.__rpPlayer.time(), done: window.__rpPlayer.loaded.done, frames: window.__rpPlayer.loaded.frames, bytes: window.__rpPlayer.loaded.bytes }));
    await page.waitForFunction(() => window.__rpDoneMs !== undefined, null, { timeout: 120000 });
    const end = await page.evaluate(() => ({ doneMs: window.__rpDoneMs, frames: window.__rpPlayer.loaded.frames, bytes: window.__rpPlayer.loaded.bytes }));
    // the rendered frame contains the terminal mock DOM
    const rendered = await page.frameLocator('.replayer-wrapper iframe').locator('#watchlist').count();
    // seek to minute 45 (needs the later checkout) and check it renders
    const seekOk = await page.evaluate(async () => {
      const bar = document.querySelector('[data-testid="timeline"]');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.75, clientY: r.top + r.height / 2 }));
      await new Promise((res) => setTimeout(res, 500));
      return window.__rpPlayer.time();
    });
    const r = {
      run, first_frame_ms: first.ms, frames_at_first_frame: first.load.frames, bytes_at_first_frame: first.load.bytes,
      total_bytes: end.bytes, total_frames: end.frames, download_done_ms: end.doneMs,
      playing_while_downloading: !mid.done && mid.t > t1, play_time_ms: [t1, mid.t], rendered: rendered > 0, seek_75pct_ms: seekOk,
    };
    results.push(r);
    console.log(JSON.stringify(r));
    if (r.first_frame_ms > BUDGET_MS || !r.playing_while_downloading || !r.rendered || !(seekOk > 40 * 60_000)) failed = true;
    await ctx.close();
  }
} finally {
  await browser.close();
}
const ff = results.map((r) => r.first_frame_ms).sort((a, b) => a - b);
console.log(JSON.stringify({ test: 'player first frame + progressive', sid, mbps: MBPS, gen, first_frame_ms_median: ff[Math.floor(ff.length / 2)], first_frame_ms_max: ff.at(-1), budget_ms: BUDGET_MS, pass: !failed }));
if (failed) process.exit(1);
