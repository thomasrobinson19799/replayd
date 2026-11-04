// Shared e2e helpers: API login/project setup against a running stack, tiny static server for test apps.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize } from 'node:path';

export const BASE = process.env.E2E_BASE ?? 'http://localhost:8088';
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'change-me-now';

/** Logs in through the API; returns { cookies: [{name,value}], csrf, api(method, path, body) }. */
export async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  const cookies = r.headers.getSetCookie().map((c) => {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    return { name: kv.slice(0, i), value: kv.slice(i + 1) };
  });
  const csrf = cookies.find((c) => c.name === 'rp_csrf').value;
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const api = async (method, path, body) => {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  return { cookies, csrf, api };
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json', '.css': 'text/css', '.json': 'application/json' };

/** Serves `routes` ({ '/path': absolute file | string content }) plus files under `dir`. */
export function serve({ dir, routes = {} }) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (path in routes) {
        const v = routes[path];
        const body = typeof v === 'function' ? v() : isAbsolute(v) ? await readFile(v) : v;
        res.writeHead(200, { 'content-type': types[extname(path)] ?? 'text/html', 'access-control-allow-origin': '*' });
        return res.end(body);
      }
      if (!dir) throw new Error('404');
      const p = normalize(join(dir, path === '/' ? 'index.html' : path));
      if (!p.startsWith(normalize(dir))) throw new Error('403');
      const body = await readFile(p);
      res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}
