// Generates a realistic long `.rpl` session for the player benchmarks (T-23).
//
// 1. Records the terminal mock (sdk/bench/pages/terminal.html, live Centrifugo-like WS at 200 msg/s, 10 Hz
//    repaint) with rrweb using the PRD §4.6 record options for REC_S seconds.
// 2. Coalesces text mutations to the latest value per node every THROTTLE ms (the byte effect of
//    `data-rp-throttle`, D-04; T-01 measured the emit-side and hook-side byte counts as equal).
// 3. Repeats the recorded incremental events with shifted timestamps up to MINUTES, re-emitting the
//    Meta + FullSnapshot pair at every 10-minute checkout (checkoutEveryNms), and adds SDK custom events
//    (console, network, error, nav, breadcrumb, ws) at a terminal-like rate.
// 4. Cuts 5 s segments, gzips each events array and writes `.rpl` frames using the wire format
//    (sdk/packages/core/dist/wire.js `encodeSegment` + `splitSegment`).
// 5. Optionally installs it into the running stack: copies the file into the replayd container's data dir and
//    inserts the sessions row (INSTALL=1, project slug PROJECT, default `e2e-replay`).
//
// Usage: pnpm -C sdk build && node e2e/gen-replay.mjs [out.rpl]
//   env MINUTES=60 REC_S=30 THROTTLE=1000 INSTALL=0 PROJECT=e2e-replay
// Prints one JSON line: { sid, file, bytes, frames, events, minutes, ... }.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MINUTES = Number(process.env.MINUTES ?? 60);
const REC_S = Number(process.env.REC_S ?? 30);
const THROTTLE = Number(process.env.THROTTLE ?? 1000);
const SEG_MS = 5000;
const CHECKOUT_MS = 10 * 60_000;
const out = process.argv[2] ?? `${root}data/gen/session-${MINUTES}m.rpl`;

const { encodeSegment, splitSegment, RPL_FLAG_HAS_ERROR } = await import(new URL('../sdk/packages/core/dist/wire.js', import.meta.url).href);
const { startServer } = await import(new URL('../sdk/bench/server.mjs', import.meta.url).href);

// ---------- 1. record ----------
async function record() {
  const { server, port } = await startServer(0);
  const rrweb = await readFile(`${root}sdk/bench/node_modules/@rrweb/record/dist/record.umd.min.cjs`, 'utf8');
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newPage({ viewport: { width: 1440, height: 900 } }));
    await page.goto(`http://127.0.0.1:${port}/pages/terminal.html?hist=60`);
    await page.waitForTimeout(500);
    await page.addScriptTag({ content: `window.module = undefined; window.exports = undefined; ${rrweb}` });
    await page.evaluate(() => {
      window.__ev = [];
      window.rrwebRecord.record({
        emit: (e) => window.__ev.push(e),
        checkoutEveryNms: 10 * 60_000,
        sampling: { mousemove: 50, mouseInteraction: true, scroll: 150, media: 800, input: 'last' },
        maskInputOptions: { password: true },
        recordCanvas: false, collectFonts: false, inlineImages: false,
        inlineStylesheet: true, slimDOMOptions: 'all', recordCrossOriginIframes: false,
      });
    });
    // some user activity: mouse moves, clicks, typing into the order form, scrolling the history
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < REC_S * 1000) {
      i++;
      await page.mouse.move(200 + ((i * 37) % 900), 150 + ((i * 53) % 600), { steps: 4 });
      if (i % 7 === 0) await page.mouse.click(300 + ((i * 11) % 500), 200 + ((i * 17) % 400)).catch(() => {});
      if (i % 11 === 0) await page.mouse.wheel(0, i % 22 === 0 ? 300 : -300);
      if (i % 13 === 0) {
        const inp = await page.$('input[type="number"], input:not([type="password"])');
        if (inp) await inp.fill(String(0.01 * (i % 50))).catch(() => {});
      }
      await page.waitForTimeout(250);
    }
    return await page.evaluate(() => window.__ev);
  } finally {
    await browser.close();
    server.close();
  }
}

// ---------- 2. coalesce text mutations ----------
function coalesce(events) {
  if (!THROTTLE) return events;
  const outEv = [];
  const pending = new Map();
  let windowEnd = 0;
  const flush = (ts) => {
    if (pending.size) {
      outEv.push({ type: 3, timestamp: ts, data: { source: 0, texts: [...pending].map(([id, value]) => ({ id, value })), attributes: [], removes: [], adds: [] } });
      pending.clear();
    }
  };
  for (const e of events) {
    if (e.timestamp >= windowEnd) {
      flush(windowEnd || e.timestamp);
      windowEnd = e.timestamp + THROTTLE;
    }
    if (e.type === 3 && e.data.source === 0 && e.data.texts?.length) {
      for (const t of e.data.texts) pending.set(t.id, t.value);
      const { adds, removes, attributes } = e.data;
      if (!adds.length && !removes.length && !attributes.length) continue;
      outEv.push({ ...e, data: { ...e.data, texts: [] } });
      continue;
    }
    outEv.push(e);
  }
  flush(windowEnd);
  return outEv;
}

// ---------- 3. extend to MINUTES ----------
function* custom(ts, k) {
  // terminal-like SDK output: ~1 network call / 10 s, console every 15 s, a warning every 2 min, an error
  // every 10 min, navigation every 5 min, WS lifecycle + sampled frames.
  const n = Math.floor(ts / 1000);
  if (n % 10 === 0) {
    const fail = n % 120 === 0;
    yield { type: 5, timestamp: ts, data: { tag: 'network', payload: { start: ts - 120, method: n % 20 ? 'GET' : 'POST', url: `https://api.fxglory.test/v1/${['positions', 'orders', 'account', 'history'][n % 4]}?page=${k}`, status: fail ? 500 : 200, duration: 80 + (n % 300), reqSize: 120, resSize: 4800, reqHeaders: { 'content-type': 'application/json' }, resBody: JSON.stringify({ ok: !fail, items: [{ id: n, symbol: 'EURUSD', volume: 0.1 }] }) } } };
  }
  if (n % 15 === 0) yield { type: 5, timestamp: ts + 3, data: { tag: 'console', payload: { level: 'log', args: [`[quotes] resubscribed ${n % 40} channels`, { k, n }] } } };
  if (n % 120 === 60) {
    yield { type: 5, timestamp: ts + 5, data: { tag: 'console', payload: { level: 'warn', args: ['Slow tick handler', `${(n % 90) + 40}ms`] } } };
    yield { type: 5, timestamp: ts + 6, data: { tag: 'error', payload: { level: 'warning', source: 'console', message: 'Slow tick handler' } } };
  }
  if (n % 600 === 300) {
    yield { type: 5, timestamp: ts + 7, data: { tag: 'console', payload: { level: 'error', args: ['TypeError: Cannot read properties of undefined (reading \'price\')'] } } };
    yield { type: 5, timestamp: ts + 8, data: { tag: 'error', payload: { level: 'error', source: 'onerror', type: 'TypeError', message: 'Cannot read properties of undefined (reading \'price\')' } } };
  }
  if (n % 300 === 150) {
    const to = ['/trade', '/positions', '/history', '/deposit'][Math.floor(n / 300) % 4];
    yield { type: 5, timestamp: ts + 9, data: { tag: 'nav', payload: { from: '/trade', to } } };
  }
  if (n % 20 === 5) yield { type: 5, timestamp: ts + 10, data: { tag: 'breadcrumb', payload: { cat: 'click', msg: 'button.buy-btn' } } };
  if (n % 2 === 0) yield { type: 5, timestamp: ts + 11, data: { tag: 'ws', payload: { k: 'frame', id: 1, dir: 'in', raw: JSON.stringify({ push: { channel: `quotes:${['EURUSD', 'XAUUSD', 'BTCUSD'][n % 3]}`, pub: { data: { b: 1.08 + (n % 100) / 1e4 } } } }) } } };
  if (n % 900 === 450) {
    yield { type: 5, timestamp: ts + 12, data: { tag: 'ws', payload: { k: 'close', id: 1, code: 1006, wasClean: false } } };
    yield { type: 5, timestamp: ts + 900, data: { tag: 'ws', payload: { k: 'open', id: 2, url: 'wss://ws.fxglory.test/connection/websocket' } } };
  }
}

function extend(rec) {
  const fullIdx = rec.findIndex((e) => e.type === 2);
  const meta = rec.slice(0, fullIdx + 1); // Meta (4), [Load…], FullSnapshot (2)
  const incr = rec.slice(fullIdx + 1).filter((e) => e.type === 3);
  const tStart = meta[0].timestamp;
  const tFull = rec[fullIdx].timestamp;
  const span = incr.at(-1).timestamp - tFull + 50;
  // repeated copies only carry mutations without adds/removes (ids stay valid) + input/mouse/scroll
  const repeatable = incr.filter((e) => e.data.source !== 0 || (!e.data.adds.length && !e.data.removes.length));
  const end = tStart + MINUTES * 60_000;
  const events = [];
  for (let block = tStart; block < end; block += CHECKOUT_MS) {
    for (const e of meta) events.push({ ...e, timestamp: block + (e.timestamp - tStart) });
    const blockEnd = Math.min(block + CHECKOUT_MS, end);
    for (let k = 0, base = block + (tFull - tStart); base < blockEnd; k++, base += span) {
      const src = k === 0 && block === tStart ? incr : repeatable;
      for (const e of src) {
        const ts = base + (e.timestamp - tFull);
        if (ts >= blockEnd) break;
        events.push({ ...e, timestamp: ts });
      }
    }
  }
  for (let ts = tStart + 1000; ts < end; ts += 1000) for (const c of custom(ts - tStart, Math.floor((ts - tStart) / 1000))) events.push({ ...c, timestamp: c.timestamp + tStart });
  events.sort((a, b) => a.timestamp - b.timestamp);
  return { events, tStart, end };
}

// ---------- 4. segments → .rpl ----------
function uuidv7(ms) {
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}
const hex = (b) => b.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

function writeRpl(events, tStart, sidBytes) {
  const sid = hex(sidBytes);
  const parts = [];
  const h = Buffer.alloc(22);
  h.write('RPL2', 0, 'latin1');
  h.writeUInt16LE(1, 4);
  sidBytes.copy(h, 6);
  parts.push(h);
  let seq = 0;
  let i = 0;
  const stats = { frames: 0, errs: 0, warns: 0, clicks: 0, gzBytes: 0, rawBytes: 0 };
  while (i < events.length) {
    const segStart = events[i].timestamp;
    const seg = [];
    let raw = 0;
    while (i < events.length && events[i].timestamp < segStart + SEG_MS && raw < 256 * 1024) {
      const e = events[i++];
      seg.push(e);
      raw += JSON.stringify(e).length;
    }
    const json = JSON.stringify(seg);
    const gz = gzipSync(json, { level: 6 });
    let errs = 0;
    let warns = 0;
    for (const e of seg) {
      if (e.type === 5 && e.data.tag === 'error') e.data.payload.level === 'warning' ? warns++ : errs++;
      if (e.type === 3 && e.data.source === 2 && e.data.type === 2) stats.clicks++;
    }
    const t0 = seg[0].timestamp;
    const t1 = seg.at(-1).timestamp;
    const meta = JSON.stringify({ sid, seq, t0, t1, enc: 'gzip', n: seg.length, urls: [], clicks: 0, errs, warns, has_error: errs > 0, ws_disc: 0, canvas_bytes: 0, gap: false });
    const { body } = splitSegment(encodeSegment(meta, new Uint8Array(gz.buffer, gz.byteOffset, gz.length)));
    const fh = Buffer.alloc(29);
    fh.writeUInt32LE(body.length, 0);
    fh.writeUInt32LE(seq, 4);
    fh.writeBigUInt64LE(BigInt(t0), 8);
    fh.writeBigUInt64LE(BigInt(t1), 16);
    fh.writeUInt32LE(Math.floor(t1 / 1000), 24);
    fh[28] = errs > 0 ? RPL_FLAG_HAS_ERROR : 0;
    parts.push(fh, Buffer.from(body));
    stats.frames++;
    stats.errs += errs;
    stats.warns += warns;
    stats.gzBytes += gz.length;
    stats.rawBytes += json.length;
    seq++;
  }
  return { buf: Buffer.concat(parts), sid, stats };
}

// ---------- 5. install into the stack ----------
function sh(cmd, args, input) {
  return execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
}
function container(service) {
  return sh('docker', ['ps', '--filter', `label=com.docker.compose.service=${service}`, '--filter', 'label=com.docker.compose.project=replayd', '--format', '{{.Names}}']).split('\n')[0];
}
function install(file, sid, tStart, end, stats, rec) {
  const slug = process.env.PROJECT ?? 'e2e-replay';
  const pg = container('postgres');
  const psql = (sql) => sh('docker', ['exec', '-i', pg, 'psql', '-U', 'replayd', '-d', 'replayd', '-tA', '-v', 'ON_ERROR_STOP=1'], sql);
  const day = new Date(tStart).toISOString().slice(0, 10);
  const pid = psql(`SELECT replayd_ensure_partitions('${day}'::date, '${day}'::date + 1);
INSERT INTO projects (slug, name, public_key, upload_token_hash, allowed_origins)
VALUES ('${slug}', 'E2E replay', 'pk_${slug}', '\\x00', '{}') ON CONFLICT (slug) DO NOTHING;
SELECT id FROM projects WHERE slug = '${slug}';`).split('\n').at(-1);
  psql(`DELETE FROM sessions WHERE id = '${sid}';
INSERT INTO sessions (id, project_id, started_at, last_at, ended, duration_ms, entry_url, urls, release, environment, platform,
  browser, browser_ver, os, vw, vh, lang, error_count, warn_count, click_count, segments, bytes, file_day)
VALUES ('${sid}', ${pid}, to_timestamp(${tStart} / 1000.0), to_timestamp(${end} / 1000.0), true, ${end - tStart},
  'http://127.0.0.1/pages/terminal.html', 'http://127.0.0.1/pages/terminal.html', 'gen-1.0.0', 'bench', 'web',
  'Chrome', '140.0', 'Linux', ${rec.vw}, ${rec.vh}, 'en-US', ${stats.errs}, ${stats.warns}, ${stats.clicks}, ${stats.frames}, ${stats.gzBytes}, '${day}');`);
  // the replayd image is distroless (no shell): a throwaway container on the same /data volume writes
  // <pid>/<day>/<sid>.rpl and hands it to the distroless `nonroot` user (65532) — works from any host OS
  const rd = container('replayd');
  const dir = `/data/${pid}/${day}`;
  execFileSync('docker', ['run', '--rm', '-i', '--volumes-from', rd, '--user', '0', 'alpine:3.22', 'sh', '-c',
    `mkdir -p ${dir} && cat > ${dir}/${sid}.rpl && chown -R 65532:65532 /data/${pid}`],
  { input: readFileSync(file), stdio: ['pipe', 'inherit', 'inherit'] });
  return { project: slug, project_id: Number(pid), day };
}

const tRec = Date.now();
const rec = await record();
const recMs = Date.now() - tRec;
const recMeta = rec.find((e) => e.type === 4)?.data ?? {};
const { events, tStart, end } = extend(coalesce(rec));
// shift the session so that it ended "now" (fits the dashboard's 14-day window)
const shift = Date.now() - 60_000 - end;
for (const e of events) e.timestamp += shift;
const sidBytes = uuidv7(tStart + shift);
const { buf, sid, stats } = writeRpl(events, tStart + shift, sidBytes);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, buf);
const result = {
  sid, file: out, bytes: buf.length, frames: stats.frames, events: events.length, minutes: MINUTES,
  recorded_s: REC_S, recorded_events: rec.length, record_ms: recMs, throttle_ms: THROTTLE,
  raw_json_bytes: stats.rawBytes, kb_per_s: +(buf.length / 1024 / (MINUTES * 60)).toFixed(2),
  first_frame_bytes: buf.readUInt32LE(22) + 29,
};
if (process.env.INSTALL === '1') {
  Object.assign(result, install(out, sid, tStart + shift, end + shift, stats, { vw: recMeta.width ?? 1440, vh: recMeta.height ?? 900 }));
}
console.log(JSON.stringify(result));
