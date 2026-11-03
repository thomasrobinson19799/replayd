// Terminal mock: ~3k elements, ticking watchlist + order book at 10 Hz, Centrifugo-like WS at 200 msg/s.
// Query params: ?ws=0 disables WS, ?text=content uses textContent (childList mutations) instead of nodeValue,
// ?throttle=500 adds data-rp-throttle to watchlist + order book.
(() => {
  const q = new URLSearchParams(location.search);
  const SYMBOLS = ['EURUSD','GBPUSD','USDJPY','XAUUSD','XAGUSD','USDCHF','AUDUSD','NZDUSD','USDCAD','EURGBP','EURJPY','GBPJPY','BTCUSD','ETHUSD','US30','NAS100','SPX500','UKOIL','USOIL','EURCHF','AUDJPY','CADJPY','CHFJPY','EURAUD','EURCAD','EURNZD','GBPAUD','GBPCAD','GBPCHF','GBPNZD','NZDJPY','AUDCAD','AUDCHF','AUDNZD','NZDCAD','NZDCHF','USDSGD','USDHKD','USDTRY','USDZAR'];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.append(String(text)); return e; };
  const setText = q.get('text') === 'content' ? (td, v) => { td.textContent = v; } : (td, v) => { td.firstChild.nodeValue = v; };

  // header / nav
  const top = document.getElementById('top');
  const nav = el('nav');
  for (let i = 0; i < 24; i++) { const a = el('a', `c${i}`, `Menu ${i}`); a.href = `#m${i}`; nav.append(a); }
  top.append(el('div', 'logo', 'FX Terminal'), nav, el('div', 'acct', 'Balance 10,000.00 USD'));

  // watchlist
  const wl = document.querySelector('#watchlist tbody');
  const rows = new Map();
  for (const s of SYMBOLS) {
    const tr = el('tr');
    const cells = ['', '0.00000', '0.00000', '0.0', '0.00%', '--:--:--'].map((v, i) => el('td', `c${i + 10}`, i === 0 ? s : v));
    tr.append(...cells); wl.append(tr); rows.set(s, cells);
  }

  // order panel form
  const op = document.getElementById('orderpanel');
  op.append(el('h2', null, 'New order'));
  const form = el('form');
  for (let i = 0; i < 12; i++) {
    const lab = el('label', 'c' + (i + 30), `Field ${i}`);
    const inp = el('input'); inp.name = `f${i}`; inp.value = i === 3 ? '' : String(i * 0.01);
    if (i === 3) inp.type = 'password';
    const sel = el('select'); for (let k = 0; k < 6; k++) sel.append(el('option', null, `Opt ${k}`));
    form.append(el('div', 'row', null), lab, inp, sel);
  }
  form.append(el('button', 'buy', 'Buy'), el('button', 'sell', 'Sell'));
  op.append(form);

  // order book 2x20 levels
  const ob = document.getElementById('orderbook');
  const levels = { bids: [], asks: [] };
  for (const side of ['bids', 'asks']) {
    const box = ob.querySelector('.' + side);
    for (let i = 0; i < 20; i++) {
      const r = el('div', 'lvl'); const p = el('span', 'p', '0.00000'); const v = el('span', 'v', '0.00'); const t = el('span', 't', '0');
      r.append(p, v, t); box.append(r); levels[side].push([p, v, t]);
    }
  }
  if (q.get('throttle')) { for (const id of ['watchlist', 'orderbook']) document.getElementById(id).setAttribute('data-rp-throttle', q.get('throttle')); }

  // positions 30x10, history 160x8
  const pos = document.querySelector('#positions tbody');
  for (let i = 0; i < 30; i++) { const tr = el('tr'); for (let k = 0; k < 10; k++) tr.append(el('td', `c${k + 50}`, `${SYMBOLS[i % 40]} ${k}`)); pos.append(tr); }
  const hist = document.querySelector('#history tbody');
  const histRows = Number(q.get('hist') ?? 235);
  for (let i = 0; i < histRows; i++) { const tr = el('tr'); for (let k = 0; k < 8; k++) tr.append(el('td', `c${k + 70}`, `#${100000 + i} ${k}`)); hist.append(tr); }
  window.__nodeCount = () => ({ elements: document.getElementsByTagName('*').length, nodes: (() => { let n = 0; const w = document.createTreeWalker(document, NodeFilter.SHOW_ALL); while (w.nextNode()) n++; return n; })() });

  // data feed
  const latest = new Map();
  let msgs = 0;
  if (q.get('ws') !== '0') {
    const ws = new WebSocket(`ws://${location.host}/connection/websocket`);
    ws.onopen = () => { ws.send(JSON.stringify({ id: 1, connect: { token: 'secret-jwt', name: 'js' } })); ws.send(JSON.stringify({ id: 2, subscribe: { channel: 'quotes' } })); document.getElementById('status').textContent = 'connected'; };
    ws.onmessage = (ev) => { // app-side cost (present in baseline too)
      const d = ev.data;
      for (const line of d.split('\n')) { const m = JSON.parse(line); if (m.push) { latest.set(m.push.pub.data.s, m.push.pub.data); msgs++; } }
    };
    window.__ws = ws;
  }
  window.__msgs = () => msgs;
  const prev = new Map();
  let tick = 0;
  setInterval(() => { // 10 Hz UI tick
    tick++;
    const now = new Date().toTimeString().slice(0, 8);
    for (const [s, d] of latest) {
      const c = rows.get(s); const p = prev.get(s);
      if (p === d) continue; prev.set(s, d);
      setText(c[1], d.b.toFixed(5)); setText(c[2], d.a.toFixed(5));
      setText(c[3], ((d.a - d.b) * 1e5).toFixed(1)); setText(c[4], ((tick % 7) - 3).toFixed(2) + '%'); setText(c[5], now);
    }
    const mid = (latest.get('EURUSD')?.b ?? 1.08);
    for (let i = 0; i < 20; i++) {
      const b = levels.bids[i], a = levels.asks[i];
      setText(b[0], (mid - i * 0.00001).toFixed(5)); setText(b[1], ((tick * 13 + i * 7) % 500 / 10).toFixed(2));
      setText(a[0], (mid + 0.0002 + i * 0.00001).toFixed(5)); setText(a[1], ((tick * 17 + i * 3) % 500 / 10).toFixed(2));
    }
  }, 100);
})();
