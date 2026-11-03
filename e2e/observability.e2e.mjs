// T-50 acceptance: alert rules pass promtool; Prometheus scrapes the real server; every dashboard query is valid
// PromQL against the scraped metrics; the dashboard imports cleanly into Grafana (12.x) through its API.
// Prereqs: `make up` (network replayd_default), Docker images prom/prometheus:v3.5.0 and grafana/grafana:12.1.1.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE, login } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const obs = `${root}deploy/observability`;
const sh = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wait = async (url, ok = (r) => r.ok, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (ok(r)) return r; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout: ${url}`);
};
const checks = {};
const names = ['rp-obs-prom', 'rp-obs-grafana'];
for (const n of names) try { sh('rm', '-f', n); } catch { /* none */ }
try {
  // 1. rules
  const out = execFileSync('docker', ['run', '--rm', '--entrypoint', 'promtool', '-v', `${obs}:/o:ro`, 'prom/prometheus:v3.5.0', 'check', 'rules', '/o/alerts.yml'], { encoding: 'utf8' });
  checks.promtool = /SUCCESS: 6 rules found/.test(out);
  // some traffic so the metrics exist
  const { api } = await login();
  await api('GET', '/me');
  // 2. Prometheus on the stack network, scraping replayd:8080
  sh('run', '-d', '--name', names[0], '--network', 'replayd_default', '-p', '127.0.0.1:19090:9090', '-v', `${obs}/prometheus.yml:/etc/prometheus/prometheus.yml:ro`, '-v', `${obs}/alerts.yml:/etc/prometheus/alerts.yml:ro`, 'prom/prometheus:v3.5.0', '--config.file=/etc/prometheus/prometheus.yml');
  await wait('http://127.0.0.1:19090/-/ready');
  await wait('http://127.0.0.1:19090/api/v1/query?query=up%7Bjob%3D%22replayd%22%7D%3D%3D1', async (r) => r.ok && (await r.json()).data.result.length > 0);
  // the first scrape may predate the 15 s gauges / the API histogram: wait for them (scrape interval 15 s)
  const want = ['replayd_disk_free_bytes', 'replayd_disk_used_bytes', 'replayd_queue_depth', 'replayd_api_latency_seconds_bucket'];
  let have = [];
  for (let i = 0; i < 40 && !want.every((m) => have.includes(m)); i++) {
    await api('GET', '/me');
    const series = await (await fetch('http://127.0.0.1:19090/api/v1/label/__name__/values')).json();
    have = series.data.filter((n) => n.startsWith('replayd_'));
    if (!want.every((m) => have.includes(m))) await new Promise((r) => setTimeout(r, 1000));
  }
  checks.scraped = want.every((m) => have.includes(m));
  const rules = await (await fetch('http://127.0.0.1:19090/api/v1/rules')).json();
  checks.rules_loaded = rules.data.groups[0]?.rules.length === 6 && rules.data.groups[0].rules.every((r) => r.health !== 'err');
  // 3. every dashboard expression is valid PromQL
  const dash = JSON.parse(readFileSync(`${obs}/grafana-dashboard.json`, 'utf8'));
  const bad = [];
  for (const p of dash.panels) for (const t of p.targets) {
    const q = t.expr.replaceAll('$__rate_interval', '1m').replaceAll('$project', '.*');
    const r = await (await fetch(`http://127.0.0.1:19090/api/v1/query?query=${encodeURIComponent(q)}`)).json();
    if (r.status !== 'success') bad.push([p.title, r.error]);
  }
  checks.queries_valid = bad.length === 0;
  // 4. Grafana import
  sh('run', '-d', '--name', names[1], '--network', 'replayd_default', '-p', '127.0.0.1:13000:3000', '-e', 'GF_SECURITY_ADMIN_PASSWORD=obs-check', 'grafana/grafana:12.1.1');
  await wait('http://127.0.0.1:13000/api/health');
  const auth = { authorization: `Basic ${Buffer.from('admin:obs-check').toString('base64')}`, 'content-type': 'application/json' };
  const dsr = await fetch('http://127.0.0.1:13000/api/datasources', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Prometheus', type: 'prometheus', access: 'proxy', url: `http://${names[0]}:9090`, uid: 'prom' }) });
  const imp = await fetch('http://127.0.0.1:13000/api/dashboards/import', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ dashboard: dash, overwrite: true, inputs: [{ name: 'DS_PROMETHEUS', type: 'datasource', pluginId: 'prometheus', value: 'prom' }] }),
  });
  const ij = await imp.json();
  const got = await (await fetch('http://127.0.0.1:13000/api/dashboards/uid/replayd', { headers: auth })).json();
  checks.grafana_import = dsr.ok && imp.ok && ij.imported === true && got.dashboard?.panels?.length === dash.panels.length;
  console.log(JSON.stringify({ checks, bad, metrics: have.length }));
} finally {
  for (const n of names) try { sh('rm', '-f', n); } catch { /* gone */ }
}
const pass = Object.values(checks).every(Boolean) && Object.keys(checks).length === 5;
console.log(JSON.stringify({ test: 'observability: rules, scrape, dashboard queries, Grafana import', pass }));
if (!pass) process.exit(1);
