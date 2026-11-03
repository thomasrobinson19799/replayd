// Bench server: static files for perf pages + Centrifugo-like WebSocket mock.
// Usage: node server.mjs [port]   (env WS_RATE=200 messages/s)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
export const SYMBOLS = ['EURUSD','GBPUSD','USDJPY','XAUUSD','XAGUSD','USDCHF','AUDUSD','NZDUSD','USDCAD','EURGBP','EURJPY','GBPJPY','BTCUSD','ETHUSD','US30','NAS100','SPX500','UKOIL','USOIL','EURCHF','AUDJPY','CADJPY','CHFJPY','EURAUD','EURCAD','EURNZD','GBPAUD','GBPCAD','GBPCHF','GBPNZD','NZDJPY','AUDCAD','AUDCHF','AUDNZD','NZDCAD','NZDCHF','USDSGD','USDHKD','USDTRY','USDZAR'];

export function startServer(port = 0, rate = Number(process.env.WS_RATE ?? 200)) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
      const body = await readFile(p);
      res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  const wss = new WebSocketServer({ server, path: '/connection/websocket' });
  wss.on('connection', (ws) => {
    let seq = 0;
    const prices = Object.fromEntries(SYMBOLS.map((s, i) => [s, 1 + i * 0.37]));
    ws.on('message', (m) => {
      // Centrifugo v5 JSON protocol: reply to connect/subscribe commands.
      for (const line of String(m).split('\n')) {
        if (!line) continue;
        const cmd = JSON.parse(line);
        if (cmd.connect) ws.send(JSON.stringify({ id: cmd.id, connect: { client: 'c1', version: '5.0.0', ping: 25, pong: true } }));
        else if (cmd.subscribe) ws.send(JSON.stringify({ id: cmd.id, subscribe: {} }));
      }
    });
    // 200 msg/s delivered in 10 ms ticks of 2 frames; every 5th frame is a newline batch of 3 pushes.
    const perTick = Math.max(1, Math.round(rate / 100));
    const t = setInterval(() => {
      for (let i = 0; i < perTick; i++) {
        const n = ++seq % 5 === 0 ? 3 : 1;
        const lines = [];
        for (let k = 0; k < n; k++) {
          const s = SYMBOLS[(seq * 7 + k) % SYMBOLS.length];
          prices[s] += (Math.random() - 0.5) * 0.001;
          lines.push(JSON.stringify({ push: { channel: `quotes:${s}`, pub: { data: { s, b: +prices[s].toFixed(5), a: +(prices[s] + 0.0002).toFixed(5), t: Date.now() }, offset: seq } } }));
        }
        ws.send(lines.join('\n'));
      }
    }, 10);
    ws.on('close', () => clearInterval(t));
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, port: server.address().port })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.argv[2] ?? 8099));
  console.log(`bench server on http://127.0.0.1:${port}`);
}
