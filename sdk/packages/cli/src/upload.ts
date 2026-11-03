/**
 * Source-map upload (PRD §5.6), shared by the CLI and @replayd/vite-plugin.
 * Every `*.map` under `dir` is sent as a multipart part named by the `~/path` of its minified file
 * (`urlPrefix` + path relative to `dir`, without `.map`): the server keys maps by that path, which is what
 * error frames normalise to for web (`https://host/_nuxt/x.js`) and APK (`https://localhost/_nuxt/x.js`) alike.
 */
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface UploadOptions {
  /** replayd base URL, e.g. https://replay.example.com (env REPLAYD_URL) */
  url: string;
  /** project upload token (env REPLAYD_TOKEN) */
  token: string;
  /** project slug or id */
  project: string;
  release: string;
  /** build output directory to scan, e.g. .output/public/_nuxt */
  dir: string;
  /** `~/` path the directory is served at, e.g. `~/_nuxt` */
  urlPrefix?: string;
  /** delete the maps (and their sourceMappingURL comments) after a successful upload */
  deleteAfter?: boolean;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

/** request body budget per POST (nginx allows 64 MB) */
const BATCH = 32 << 20;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && e.name.endsWith('.map')) out.push(p);
  }
  return out.sort();
}

/** `~/_nuxt` + `chunks/a.js.map` → `~/_nuxt/chunks/a.js` */
export function tildePath(prefix: string, rel: string): string {
  const p = (prefix || '~').replace(/\/+$/, '');
  const base = p.startsWith('~') ? p : `~/${p.replace(/^\/+/, '')}`;
  return `${base}/${rel.split(sep).join('/').replace(/\.map$/, '')}`;
}

async function post(o: UploadOptions, body: FormData): Promise<unknown> {
  const f = o.fetch ?? fetch;
  const u = `${o.url.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(o.project)}/releases/${encodeURIComponent(o.release)}/sourcemaps`;
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      const r = await f(u, { method: 'POST', headers: { authorization: `Bearer ${o.token}` }, body });
      const t = await r.text();
      if (r.ok) return t ? JSON.parse(t) : null;
      last = `HTTP ${r.status}: ${t.slice(0, 300)}`;
      if (r.status < 500 && r.status !== 429) break; // bad token / bad map: retrying can't fix it
    } catch (e) {
      last = String(e);
    }
  }
  throw new Error(`source map upload failed: ${last}`);
}

/** uploads all maps under `o.dir`; returns the number of files */
export async function uploadSourcemaps(o: UploadOptions): Promise<number> {
  if (!o.url || !o.token || !o.project || !o.release) throw new Error('url, token, project and release are required');
  const log = o.log ?? (() => {});
  const files = await walk(o.dir);
  if (!files.length) {
    log(`no .map files under ${o.dir}`);
    return 0;
  }
  let fd = new FormData(), size = 0, n = 0;
  const flush = async () => {
    if (!size) return;
    await post(o, fd);
    fd = new FormData();
    size = 0;
  };
  for (const file of files) {
    const s = (await stat(file)).size;
    if (size && size + s > BATCH) await flush();
    const name = tildePath(o.urlPrefix ?? '~', relative(o.dir, file));
    fd.append(name, new Blob([await readFile(file)], { type: 'application/json' }), file.split(sep).pop());
    size += s;
    n++;
  }
  await flush();
  log(`uploaded ${n} source map(s) for ${o.project}@${o.release}`);
  if (o.deleteAfter) {
    for (const file of files) {
      await rm(file, { force: true });
      // drop the dangling `//# sourceMappingURL=` comment of the minified file (no 404s in the browser)
      const js = file.replace(/\.map$/, '');
      try {
        const src = await readFile(js, 'utf8');
        const out = src.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
        if (out !== src) await writeFile(js, out);
      } catch {
        /* map without its file */
      }
    }
    log(`deleted ${files.length} .map file(s)`);
  }
  return n;
}

/** `releases new` */
export async function newRelease(o: Pick<UploadOptions, 'url' | 'token' | 'project' | 'release' | 'fetch'>): Promise<void> {
  const r = await (o.fetch ?? fetch)(`${o.url.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(o.project)}/releases`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: o.release }),
  });
  if (!r.ok) throw new Error(`releases new failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
}
