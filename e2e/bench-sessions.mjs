// T-22 benchmark: session list API latency on the 140k seed (scripts/seed-sessions.sql), p95 over N requests
// per filter combination, measured end to end over HTTP (auth + SQL + JSON).
// E2E_BASE=http://127.0.0.1:18090 node e2e/bench-sessions.mjs
import { login } from './lib.mjs';

const N = Number(process.env.N ?? 40);
const { api } = await login();
const combos = {
  'default (14 days)': '',
  'has_error': 'has_error=true',
  'platform=APK': 'platform=capacitor-android',
  'user id (real, few sessions)': 'user=10011704',
  'url no match (worst case)': 'url=zz-no-such-page',
  'has_error + user + 24h': 'has_error=true&user=10011704&from=' + (Date.now() - 86400000),
  'url contains /deposit': 'url=%2Fdeposit',
  'release + browser': 'release=1.42.0&browser=Chrome',
  'min_duration 30 min': 'min_duration=1800',
  'has_ws_disconnect + APK': 'has_ws_disconnect=true&platform=capacitor-android',
  'last 24h': `from=${Date.now() - 86400000}`,
};
const results = {};
for (const [name, q] of Object.entries(combos)) {
  const t = [];
  let first;
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    const r = await api('GET', `/projects/seed/sessions?${q}`);
    t.push(performance.now() - s);
    first ??= r;
  }
  // page 2 via cursor
  if (first.next_cursor) {
    const s = performance.now();
    await api('GET', `/projects/seed/sessions?${q}&cursor=${encodeURIComponent(first.next_cursor)}`);
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  results[name] = { rows: first.sessions.length, p50_ms: +t[Math.floor(t.length * 0.5)].toFixed(1), p95_ms: +t[Math.floor(t.length * 0.95)].toFixed(1) };
}
console.table(results);
const worst = Math.max(...Object.values(results).map((r) => r.p95_ms));
console.log(JSON.stringify({ worst_p95_ms: worst, budget_ms: 100, pass: worst < 100 }));
process.exit(worst < 100 ? 0 : 1);
