import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BASE, login } from './lib.mjs';

// A generated local recording; never print share URLs or tokens, even on failure.
const out = execFileSync(process.execPath, [fileURLToPath(new URL('./gen-replay.mjs', import.meta.url))], {
  env: { ...process.env, INSTALL: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
});
const { sid, project_id: pid, day } = JSON.parse(out.trim().split('\n').at(-1));
const root = fileURLToPath(new URL('..', import.meta.url));
const container = service => execFileSync('docker', ['compose', '-f', `${root}deploy/docker-compose.yml`, 'ps', '-q', service], { encoding: 'utf8' }).trim();
const sql = statement => execFileSync('docker', ['exec', '-i', container('postgres'), 'psql', '-U', 'replayd', '-d', 'replayd', '-v', 'ON_ERROR_STOP=1'], { input: statement, stdio: ['pipe', 'ignore', 'inherit'] });
sql(`UPDATE sessions SET ended = false WHERE id = '${sid}'`);
const { api, cookies } = await login();
const browser = await chromium.launch();
let link;
let phase = 'owner dialog';
try {
  const owner = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await owner.addCookies(cookies.map(c => ({ ...c, domain: new URL(BASE).hostname, path: c.name === 'rp_session' ? '/api' : '/', secure: false })));
  const page = await owner.newPage();
  await page.goto(`${BASE}/replay/${sid}`);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByLabel('Expires', { exact: true }).selectOption('1h');
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  await page.getByLabel('New share link', { exact: true }).waitFor();
  const url = await page.getByLabel('New share link', { exact: true }).inputValue();
  phase = 'link metadata';
  link = (await api('GET', `/sessions/${sid}/shares`)).links[0];
  assert.ok(link.creator && link.expires_at);
  assert.equal(link.url, undefined);
  await page.getByRole('button', { name: 'Close dialog' }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);

  const visitor = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const publicPage = await visitor.newPage();
  phase = 'public navigation and headers';
  const response = await publicPage.goto(url);
  assert.equal(response.headers()['referrer-policy'], 'no-referrer');
  assert.match(response.headers()['x-robots-tag'], /noindex/);
  phase = 'public first frame';
  await publicPage.waitForFunction(() => window.__rpFirstFrameMs !== undefined);
  phase = 'live follow';
  await publicPage.waitForFunction(() => window.__rpPlayer.loaded.done);
  const before = await publicPage.evaluate(() => window.__rpPlayer.loaded.frames);
  const ts = Date.now();
  const compressed = gzipSync(JSON.stringify([{ type: 5, timestamp: ts, data: { tag: 'console', payload: { level: 'info', args: ['Live follow acceptance'] } } }]));
  const frame = Buffer.alloc(29 + 4 + compressed.length + 2);
  frame.writeUInt32LE(4 + compressed.length + 2, 0); frame.writeUInt32LE(9999, 4);
  frame.writeBigUInt64LE(BigInt(ts), 8); frame.writeBigUInt64LE(BigInt(ts), 16);
  frame.writeUInt32LE(compressed.length, 29); compressed.copy(frame, 33);
  execFileSync('docker', ['run', '--rm', '-i', '--volumes-from', container('replayd'), '--user', '65532', 'alpine:3.22', 'sh', '-c', `cat >> /data/${pid}/${day}/${sid}.rpl`], { input: frame, stdio: ['pipe', 'ignore', 'inherit'] });
  sql(`UPDATE sessions SET last_at = to_timestamp(${ts}/1000.0), ended = true WHERE id = '${sid}'`);
  await publicPage.waitForFunction(n => window.__rpPlayer.loaded.frames > n, before, { timeout: 15000 });
  await page.waitForFunction(n => window.__rpPlayer.loaded.frames > n, before, { timeout: 15000 });
  assert.equal(await publicPage.getByRole('button', { name: 'Share', exact: true }).count(), 0);
  assert.equal(await publicPage.getByRole('button', { name: 'Delete session' }).count(), 0);
  assert.equal(await publicPage.locator('a[href^="/projects/"], a[href^="/issues/"]').count(), 0);
  for (const width of [1440, 1024, 525]) {
    phase = `tabs and layout at ${width}`;
    await publicPage.setViewportSize({ width, height: 1000 });
    for (const theme of ['dark', 'light']) {
      await publicPage.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      for (const tab of ['console', 'network', 'WS', 'errors', 'Breadcrumbs', 'device']) {
        await publicPage.getByRole('tab', { name: new RegExp(`^${tab}`, 'i') }).click();
        assert.ok(await publicPage.getByRole('tabpanel').isVisible());
      }
      assert.ok(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await publicPage.screenshot({ path: fileURLToPath(new URL(`../docs/screenshots/share-${theme}-${width}.png`, import.meta.url)), fullPage: true });
    }
  }
  await api('DELETE', `/sessions/${sid}/shares/${link.id}`);
  phase = 'revoked page';
  await publicPage.reload();
  await publicPage.getByText('This share link is unavailable or has expired.').waitFor();
  console.log('Sharing browser acceptance passed: dialog, logged-out player, six tabs, themes, widths, revocation.');
} catch (error) {
  // Playwright errors include current URLs; never emit a capability to the console.
  const message = String(error).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]').slice(0, 1200);
  console.error(`Sharing browser acceptance failed at ${phase}: ${message}`);
  process.exitCode = 1;
} finally {
  sql(`UPDATE sessions SET ended = true WHERE id = '${sid}'`);
  if (link) await api('DELETE', `/sessions/${sid}/shares/${link.id}`).catch(() => {});
  await browser.close();
}
