// T-32 acceptance: Telegram alerts per project — new issue, dedup, regression, spike, test message.
// A mock Bot API runs on the host; the stack must be started with it:
//   REPLAYD_TELEGRAM_API=http://host.docker.internal:18099 docker compose -f deploy/docker-compose.yml --profile app up -d --no-build
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { login, serve } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.TG_PORT ?? 18099);
const msgs = [];
const tg = createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const m = /^\/bot([^/]+)\/sendMessage$/.exec(req.url ?? '');
    const body = JSON.parse(b || '{}');
    msgs.push({ token: m?.[1], chat: body.chat_id, text: body.text, at: Date.now() });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
});
await new Promise((r) => tg.listen(PORT, '0.0.0.0', r));

const { api } = await login();
const app = await serve({
  routes: {
    '/replayd.min.js': `${root}sdk/packages/core/dist/replayd.min.js`,
    '/': () => `<!doctype html><html><head><meta charset="utf-8"><script src="/replayd.min.js"></script>
<script>Replayd.init({ dsn: window.__DSN, release: window.__REL, replay: { sampleRate: 0 } });</script></head>
<body><button id="a">A</button><button id="b">B</button>
<script>document.getElementById('a').onclick = () => { null.alpha; }; document.getElementById('b').onclick = () => { null.bravo; };</script></body></html>`,
  },
});
const mk = async (name, telegram) => {
  const slug = `${name}-${Date.now().toString(36)}`;
  const p = await api('POST', '/projects', { slug, name: slug, allowed_origins: [app.origin] });
  await api('PATCH', `/projects/${p.id}`, { telegram });
  return { ...p, slug };
};
const tgBase = { bot_token: '42:SECRET', chat_id: '-1001', enabled: true };
const A = await mk('alerts', { ...tgBase });
const B = await mk('spikes', { ...tgBase, chat_id: '-1002', new_issue: false, spike_threshold: 3, spike_minutes: 5 });
// the project cache refreshes every 10 s; give it a moment
await new Promise((r) => setTimeout(r, 11000));

const browser = await chromium.launch();
const fire = async (p, btn, rel = '1.0.0') => {
  const pg = await (await browser.newContext()).newPage();
  await pg.addInitScript(([d, r]) => { window.__DSN = d; window.__REL = r; }, [p.dsn, rel]);
  await pg.goto(app.origin);
  await pg.waitForFunction(() => !!window.Replayd);
  await pg.click(`#${btn}`);
  await pg.evaluate(() => window.Replayd.flush());
  await pg.context().close();
};
const wait = async (pred, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return pred();
};
const of = (chat, re) => msgs.filter((m) => m.chat === chat && re.test(m.text));
const checks = {};
try {
  await fire(A, 'a');
  checks.new_issue = await wait(() => of('-1001', /New issue/).length === 1);
  const first = of('-1001', /New issue/)[0];
  checks.content = !!first && /alpha/.test(first.text) && /\/projects\/alerts-[^/]+\/issues\/\d+/.test(first.text) && first.token === '42:SECRET';
  await fire(A, 'a');
  await new Promise((r) => setTimeout(r, 3000));
  checks.dedup = of('-1001', /New issue/).length === 1;
  const issue = (await api('GET', `/projects/${A.slug}/issues`)).issues[0];
  await api('PATCH', `/issues/${issue.id}`, { status: 'resolved' });
  await fire(A, 'a');
  checks.regression = await wait(() => of('-1001', /Regression/).length === 1);
  for (let i = 0; i < 3; i++) await fire(B, 'b');
  checks.spike = await wait(() => of('-1002', /Spike: 3\+ events in 5 min/).length === 1);
  checks.no_new_when_disabled = of('-1002', /New issue/).length === 0;
  await api('POST', `/projects/${A.id}/telegram/test`);
  checks.test_message = await wait(() => of('-1001', /test message/).length === 1);
  // the token is masked in the API
  checks.token_masked = (await api('GET', `/projects/${A.id}`)).telegram.bot_token === '***';
  console.log(JSON.stringify({ checks, messages: msgs.map((m) => ({ chat: m.chat, head: m.text.split('\n')[0] })) }));
} finally {
  await browser.close();
  app.server.close();
  tg.close();
}
const pass = Object.values(checks).every(Boolean) && Object.keys(checks).length === 8;
console.log(JSON.stringify({ test: 'telegram alerts', pass }));
if (!pass) process.exit(1);
