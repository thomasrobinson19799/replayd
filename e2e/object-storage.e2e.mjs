// T-55 end to end against a real S3 server (SeaweedFS): a real SDK recording moves from the local volume to the
// bucket, plays back identically, takes a late segment, survives a bucket outage, redacts for viewers and deletes.
// Prereqs: stack images built (`make build`), `make up`, `pnpm -C sdk build`. Reconfigures the replayd container
// while it runs and restores it (without a bucket) at the end.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BASE, login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = process.env.E2E_SDK_DIST ?? `${root}sdk/packages/core/dist`;
const S3_IMAGE = 'chrislusf/seaweedfs:3.97';
const S3 = 'replayd-s3-e2e';
const BUCKET = 'replayd-e2e';
const KEY = 'e2eaccesskeyvalue';
const SECRET = 'e2esecretkeyvalue';
const IDLE_SECS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name, data = {}) => console.log(JSON.stringify({ step: name, ...data }));

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}
const stackEnv = (extra) => ({ ...process.env, REPLAYD_SITE_PROXIES: '172.30.53.1', ...extra });
function compose(env) {
  run('docker', ['compose', '-f', `${root}deploy/docker-compose.yml`, '--profile', 'app', 'up', '-d', '--no-build', '--wait', 'replayd', 'nginx'], { env: stackEnv(env), cwd: root });
}
const withBucket = {
  REPLAYD_S3_ENDPOINT: `http://${S3}:8333`,
  REPLAYD_S3_BUCKET: BUCKET,
  REPLAYD_S3_REGION: 'us-east-1',
  REPLAYD_S3_ACCESS_KEY: KEY,
  REPLAYD_S3_SECRET_KEY: SECRET,
  REPLAYD_S3_UPLOAD_IDLE_SECS: String(IDLE_SECS),
};

/** Object bytes straight from the S3 server's filer, bypassing replayd; null when absent. */
function objectBytes(key) {
  try {
    const hex = run('docker', ['exec', S3, 'sh', '-c', `wget -qO- http://127.0.0.1:8888/buckets/${BUCKET}/${key} | od -An -tx1 -v | tr -d ' \\n'`], { maxBuffer: 1 << 30 }).trim();
    return hex ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null;
  }
}
function volumeFind(pattern) {
  return run('docker', ['run', '--rm', '-v', 'replayd_replay-data:/d', '--entrypoint', 'sh', S3_IMAGE, '-c', `find /d -type f -name '${pattern}'`]).trim().split('\n').filter(Boolean);
}

/** seq → sha256 of the body, first copy wins (same rule as replayd's readers). */
function frames(buf) {
  if (buf.subarray(0, 4).toString() !== 'RPL2') throw new Error('not an .rpl');
  const out = new Map();
  let flags = 0;
  let duplicates = 0;
  for (let pos = 22; pos + 29 <= buf.length;) {
    const len = buf.readUInt32LE(pos);
    const seq = buf.readUInt32LE(pos + 4);
    flags |= buf[pos + 28];
    if (pos + 29 + len > buf.length) break;
    const h = createHash('sha256').update(buf.subarray(pos + 29, pos + 29 + len)).digest('hex');
    if (out.has(seq)) duplicates++;
    else out.set(seq, h);
    pos += 29 + len;
  }
  return { map: out, flags, duplicates };
}
function assertContains(actual, expected, what) {
  for (const [seq, h] of expected) if (actual.get(seq) !== h) throw new Error(`${what}: frame ${seq} missing or different`);
}

async function until(what, fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(500);
  }
}

/** Same segment under another seq: u16 meta_len | meta JSON | rest. */
function withSeq(body, seq) {
  const metaLen = body.readUInt16LE(0);
  const meta = JSON.parse(body.subarray(2, 2 + metaLen).toString());
  meta.seq = seq;
  const json = Buffer.from(JSON.stringify(meta));
  const len = Buffer.alloc(2);
  len.writeUInt16LE(json.length);
  return Buffer.concat([len, json, body.subarray(2 + metaLen)]);
}

run('docker', ['rm', '-f', S3], { stdio: 'ignore' });
run('docker', ['run', '-d', '--name', S3, '--network', 'replayd_default', '-e', `AWS_ACCESS_KEY_ID=${KEY}`, '-e', `AWS_SECRET_ACCESS_KEY=${SECRET}`, S3_IMAGE, 'server', '-dir=/data', '-s3', '-volume.max=5']);
await until('bucket created', () => {
  try {
    run('docker', ['exec', '-i', S3, 'weed', 'shell'], { input: `s3.bucket.create -name ${BUCKET}\nexit\n` });
    return run('docker', ['exec', S3, 'sh', '-c', `wget -qO- --header 'Accept: application/json' http://127.0.0.1:8888/buckets/`]).includes(BUCKET);
  } catch {
    return false;
  }
});

let failed = false;
const browser = await chromium.launch();
const app = await serve({
  routes: {
    ...Object.fromEntries(['replayd.min.js', 'replay.js', 'worker.js'].map((f) => [`/${f}`, `${dist}/${f}`])),
    '/': () => `<!doctype html><html><head><meta charset="utf-8"><title>bucket e2e</title>
<script src="/replayd.min.js"></script><script>Replayd.init({ dsn: window.__DSN, release: 'e2e-bucket-1', environment: 'e2e' });</script></head>
<body><h1 id="t">0</h1><script>let n = 0; setInterval(() => { document.getElementById('t').textContent = ++n; }, 100);</script></body></html>`,
  },
});
const slug = `bucket-${Date.now().toString(36)}`;
let cleanup = async () => {};
try {
  compose(withBucket);
  await until('stack answers', async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok);
  const { cookies, api } = await login();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const download = async (sid, headers = {}, cookie = cookieHeader) => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/recording`, { headers: { cookie, ...headers } });
    return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
  };
  const project = await api('POST', '/projects', { slug, name: `Bucket ${slug}`, allowed_origins: [app.origin] });
  cleanup = () => api('DELETE', `/projects/${slug}`);

  // 1. real SDK recording
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let replayPost = null;
  page.on('request', (q) => {
    if (q.method() === 'POST' && q.url().includes('/replay') && q.postDataBuffer()) replayPost = { url: q.url(), headers: q.headers(), body: q.postDataBuffer() };
  });
  await page.addInitScript((dsn) => { window.__DSN = dsn; }, project.dsn);
  await page.goto(app.origin);
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.Replayd.flush());
  await page.waitForTimeout(1000);
  await ctx.close();
  if (!replayPost) throw new Error('no replay request seen');
  const session = await until('session row', async () => {
    const s = (await api('GET', `/projects/${slug}/sessions`)).sessions[0];
    return s?.segments > 0 ? s : null;
  });
  const sid = session.id;
  const key = `replays/${session.project_id}/${session.file_day}/${sid}.rpl`;
  const before = await download(sid);
  if (before.status !== 200) throw new Error(`recording before upload: ${before.status}`);
  const beforeFrames = frames(before.body);
  step('recorded', { segments: session.segments, bytes: before.body.length, frames: beforeFrames.map.size });

  // 2. moved to the bucket, gone from the volume, under the fixed prefix
  await until('object uploaded', () => objectBytes(key));
  await until('local file removed', () => volumeFind(`${sid}.rpl`).every((p) => p.includes('/_cache/')));
  const stored = objectBytes(key);
  const after = await download(sid);
  if (after.status !== 200) throw new Error(`recording after upload: ${after.status}`);
  if (!after.body.equals(stored)) throw new Error('API bytes differ from the object');
  assertContains(frames(after.body).map, beforeFrames.map, 'after upload');
  const again = await download(sid);
  if (after.headers.get('etag') !== again.headers.get('etag')) throw new Error('etag changed between reads');
  const notModified = await download(sid, { 'if-none-match': after.headers.get('etag') });
  if (notModified.status !== 304) throw new Error(`If-None-Match: ${notModified.status}`);
  if (!volumeFind(`${sid}*`).some((p) => p.includes('/_cache/'))) throw new Error('read-through copy not cached');
  step('uploaded', { key, bytes: stored.length, identical: true });

  // 3. Range over a recording that only lives in the bucket
  const ranged = await download(sid, { range: 'bytes=0-21' });
  if (ranged.status !== 206 || ranged.body.subarray(0, 4).toString() !== 'RPL2') throw new Error(`range: ${ranged.status}`);
  if (ranged.headers.get('content-range') !== `bytes 0-21/${stored.length}`) throw new Error(`content-range: ${ranged.headers.get('content-range')}`);
  step('range', { contentRange: ranged.headers.get('content-range') });

  // 4. late segment (an APK draining its offline queue): visible at once, merged without losing anything
  const LATE = 9000;
  const lateRes = await fetch(replayPost.url, { method: 'POST', headers: { ...replayPost.headers, origin: app.origin }, body: withSeq(replayPost.body, LATE) });
  if (lateRes.status !== 202) throw new Error(`late segment: ${lateRes.status}`);
  const stitched = await until('late frame visible', async () => {
    const r = await download(sid);
    return frames(r.body).map.has(LATE) ? r : null;
  });
  assertContains(frames(stitched.body).map, frames(stored).map, 'stitched');
  await until('late frame merged', () => {
    const o = objectBytes(key);
    return o && frames(o).map.has(LATE);
  });
  await until('late local file removed', () => volumeFind(`${sid}.rpl`).every((p) => p.includes('/_cache/')));
  const merged = frames(objectBytes(key));
  assertContains(merged.map, frames(stored).map, 'merged');
  if (merged.duplicates) throw new Error(`merged object has ${merged.duplicates} duplicate frames`);
  step('late-segment', { frames: merged.map.size, duplicates: merged.duplicates });

  // 5. viewers get the redacted copy of a bucket recording
  const email = `viewer-${slug}@example.com`;
  const password = 'viewer-password-e2e-1';
  await api('POST', '/users', { email, password, name: 'Viewer' });
  await api('POST', `/projects/${slug}/members`, { email, role: 'viewer' });
  const vl = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!vl.ok) throw new Error(`viewer login: ${vl.status}`);
  const viewerCookie = vl.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const viewed = await download(sid, {}, viewerCookie);
  const vf = frames(viewed.body);
  if (viewed.status !== 200 || !(vf.flags & 4) || vf.map.size !== merged.map.size) throw new Error(`viewer copy: ${viewed.status}, flags ${vf.flags}, ${vf.map.size} frames`);
  step('viewer', { redacted: true, frames: vf.map.size });

  // 6. outage: ingest keeps answering, the recording waits on disk and moves when the bucket returns
  run('docker', ['stop', S3]);
  const during = await browser.newContext();
  const p2 = await during.newPage();
  await p2.addInitScript((dsn) => { window.__DSN = dsn; }, project.dsn);
  await p2.goto(app.origin);
  await p2.waitForTimeout(5000);
  let accepted = 0;
  p2.on('response', (x) => { if (x.url().includes('/replay') && x.status() === 202) accepted++; });
  await p2.evaluate(() => window.Replayd.flush());
  await p2.waitForTimeout(1500);
  await during.close();
  if (!accepted) throw new Error('ingest stopped answering during the outage');
  const sid2 = await until('session during outage', async () => (await api('GET', `/projects/${slug}/sessions`)).sessions.find((s) => s.id !== sid && s.segments > 0)?.id);
  await sleep((IDLE_SECS + 5) * 1000);
  if (!volumeFind(`${sid2}.rpl`).length) throw new Error('recording left the disk while the bucket was down');
  const local = await download(sid2);
  if (local.status !== 200) throw new Error(`local recording during outage: ${local.status}`);
  run('docker', ['start', S3]);
  const key2 = `replays/${session.project_id}/${session.file_day}/${sid2}.rpl`;
  await until('upload after outage', () => objectBytes(key2), 120000);
  await until('local removed after outage', () => !volumeFind(`${sid2}.rpl`).some((p) => !p.includes('/_cache/')));
  step('outage', { ingestAccepted: accepted, servedFromDisk: true, uploadedAfterwards: true });

  // 7. delete removes the object and every cached copy
  const sql = `UPDATE sessions SET ended = true WHERE id = '${sid}'`;
  run('docker', ['exec', 'replayd-postgres-1', 'psql', '-U', 'replayd', '-d', 'replayd', '-c', sql]);
  await api('DELETE', `/sessions/${sid}`);
  if (objectBytes(key)) throw new Error('object survived the delete');
  const left = volumeFind(`${sid}*`).filter((p) => !p.includes('/.redacted/') || p.includes('/_cache/'));
  if (left.length) throw new Error(`files survived the delete: ${left.join(', ')}`);
  if ((await download(sid)).status !== 404) throw new Error('deleted recording still served');
  step('delete', { objectGone: true, cacheGone: true });

  // 8. credentials never reach the logs
  const logs = run('docker', ['logs', 'replayd-replayd-1'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  if (logs.includes(SECRET) || logs.includes(KEY)) throw new Error('S3 credentials in the logs');
  if (!logs.includes('object storage reachable')) throw new Error('startup probe did not log success');
  step('logs', { credentialsAbsent: true });
  await cleanup();
  cleanup = async () => {};
} catch (e) {
  failed = true;
  console.error('FAILED', e.message);
  try { console.error(run('docker', ['logs', '--tail', '15', 'replayd-replayd-1'], { stdio: ['ignore', 'pipe', 'pipe'] })); } catch { /* best effort */ }
} finally {
  await cleanup().catch(() => {});
  await browser.close();
  app.server.close();
  try { compose({}); } catch (e) { console.error('restoring the stack failed', e.message); failed = true; }
  run('docker', ['rm', '-f', S3], { stdio: 'ignore' });
}
console.log(JSON.stringify({ pass: !failed }));
process.exit(failed ? 1 : 0);
