// Replay segment load generator (crash test, bench). Sends valid segments (PRD §4.10 wire format) for
// many concurrent sessions with increasing seq, and logs every 202 as `sid seq ack_ms` to --log.
//
// node scripts/replay-load.mjs --url http://127.0.0.1:18080 --project bench --key pk_bench \
//   --rate 300 --seconds 10 --sessions 200 --size 20000 --log /tmp/acks.txt
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:18080' },
    project: { type: 'string', default: 'bench' },
    key: { type: 'string', default: 'pk_bench' },
    origin: { type: 'string', default: 'https://bench.example' },
    rate: { type: 'string', default: '300' },
    seconds: { type: 'string', default: '10' },
    sessions: { type: 'string', default: '200' },
    size: { type: 'string', default: '20000' },
    log: { type: 'string' },
  },
});
const rate = Number(a.rate), seconds = Number(a.seconds), size = Number(a.size);

// UUIDv7 for "now" (session start)
function uuidv7() {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// a few pre-built gzip payloads (rrweb-like JSON is ~8-10x compressible; use semi-random text)
const payloads = Array.from({ length: 8 }, () => {
  const words = Array.from({ length: size / 6 }, () => randomBytes(3).toString('hex')).join(' ');
  return gzipSync(JSON.stringify([{ type: 3, data: { source: 0, texts: [{ id: 1, value: words }] }, timestamp: Date.now() }]));
});

function body(sid, seq) {
  const t0 = Date.now() - 5000;
  const meta = Buffer.from(JSON.stringify({ sid, seq, t0, t1: t0 + 4999, enc: 'gzip', n: 400, urls: ['https://bench.example/trade'], clicks: 1, errs: 0, warns: 0, has_error: false, ws_disc: 0, canvas_bytes: 0, gap: false, ...(seq === 0 ? { init: { url: 'https://bench.example/trade', platform: 'web', release: 'bench' } } : {}) }));
  const ev = payloads[seq % payloads.length];
  const b = Buffer.alloc(2 + meta.length + 4 + ev.length + 2);
  let p = b.writeUInt16LE(meta.length, 0);
  meta.copy(b, p); p += meta.length;
  p = b.writeUInt32LE(ev.length, p);
  ev.copy(b, p); p += ev.length;
  b.writeUInt16LE(0, p);
  return b;
}

const sessions = Array.from({ length: Number(a.sessions) }, () => ({ sid: uuidv7(), seq: 0 }));
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const target = new URL(`${a.url}/ingest/${a.project}/replay?key=${a.key}`);
const log = a.log ? createWriteStream(a.log) : null;
const stats = { sent: 0, ok: 0, busy: 0, err: 0, other: 0 };
let inflight = 0;
const lat = [];

function send() {
  const s = sessions[stats.sent % sessions.length];
  const seq = s.seq++;
  const b = body(s.sid, seq);
  stats.sent++;
  inflight++;
  const t0 = performance.now();
  const req = http.request(target, { method: 'POST', agent, headers: { 'content-type': 'text/plain', origin: a.origin, 'content-length': b.length } }, (res) => {
    res.resume();
    res.on('end', () => {
      inflight--;
      lat.push(performance.now() - t0);
      if (res.statusCode === 202) { stats.ok++; log?.write(`${s.sid} ${seq} ${Date.now()}\n`); }
      else if (res.statusCode === 503) stats.busy++;
      else stats.other++;
    });
  });
  req.on('error', () => { inflight--; stats.err++; });
  req.end(b);
}

const start = Date.now();
const timer = setInterval(() => {
  const due = Math.floor(((Date.now() - start) / 1000) * rate);
  while (stats.sent < due && inflight < 512) send();
  if (Date.now() - start >= seconds * 1000) {
    clearInterval(timer);
    const end = setInterval(() => {
      if (inflight === 0 || Date.now() - start > seconds * 1000 + 5000) {
        clearInterval(end);
        log?.end();
        lat.sort((x, y) => x - y);
        const q = (p) => +(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? 0).toFixed(2);
        console.log(JSON.stringify({ ...stats, seconds: (Date.now() - start) / 1000, bytes_per_req: payloads[0].length, p50_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99), max_ms: q(1) }));
        agent.destroy();
      }
    }, 50);
  }
}, 5);
