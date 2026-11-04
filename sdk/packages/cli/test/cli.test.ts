// @vitest-environment node
// T-30: CLI source-map upload (~/path part names, batching, delete-after, errors) + releases new.
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isEntry, main, parseArgs, tildePath, uploadSourcemaps } from '../src/index';

const map = (f: string) => JSON.stringify({ version: 3, file: f, sources: ['../src/a.ts'], names: [], mappings: 'AAAA' });
async function build() {
  const d = await mkdtemp(join(tmpdir(), 'rp-cli-'));
  await mkdir(join(d, 'chunks'));
  await writeFile(join(d, 'entry.Cx1a.js'), 'console.log(1)\n//# sourceMappingURL=entry.Cx1a.js.map');
  await writeFile(join(d, 'entry.Cx1a.js.map'), map('entry.Cx1a.js'));
  await writeFile(join(d, 'chunks/x.js'), 'x()\n//# sourceMappingURL=x.js.map\n');
  await writeFile(join(d, 'chunks/x.js.map'), map('x.js'));
  await writeFile(join(d, 'style.css'), 'a{}');
  return d;
}
const ok = () => vi.fn(async (_u: string, _i?: RequestInit) => new Response('{"files":2}', { status: 200 }));

describe('@replayd/cli', () => {
  it('detects being the entry script on any OS (spaces, Windows drive paths)', async () => {
    const d = await mkdtemp(join(tmpdir(), 'rp cli '));
    const f = join(d, 'index.js');
    await writeFile(f, '');
    const self = pathToFileURL(f).href;
    expect(isEntry(f, self)).toBe(true);
    expect(isEntry(join(d, 'other.js'), self)).toBe(false);
    expect(isEntry(undefined, self)).toBe(false);
  });

  it('maps paths to the ~/path the server keys maps by', () => {
    expect(tildePath('~/_nuxt', 'chunks/x.js.map')).toBe('~/_nuxt/chunks/x.js');
    expect(tildePath('~/_nuxt/', 'a.js.map')).toBe('~/_nuxt/a.js');
    expect(tildePath('_nuxt', 'a.js.map')).toBe('~/_nuxt/a.js');
    expect(tildePath('~', 'a.js.map')).toBe('~/a.js');
  });

  it('uploads every map as a multipart part named by ~/path, with the bearer token', async () => {
    const d = await build(), f = ok();
    const n = await uploadSourcemaps({ url: 'https://replay.example.com/', token: 'rpu_x', project: 'fxglory-terminal', release: '1.42.0 (142)', dir: d, urlPrefix: '~/_nuxt', fetch: f as unknown as typeof fetch });
    expect(n).toBe(2);
    const [u, init] = f.mock.calls[0]!;
    expect(u).toBe('https://replay.example.com/api/projects/fxglory-terminal/releases/1.42.0%20(142)/sourcemaps');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer rpu_x');
    const fd = init!.body as FormData;
    expect([...fd.keys()].sort()).toEqual(['~/_nuxt/chunks/x.js', '~/_nuxt/entry.Cx1a.js']);
    expect(JSON.parse(await (fd.get('~/_nuxt/chunks/x.js') as Blob).text()).file).toBe('x.js');
    // maps kept without --delete-after
    expect((await readdir(d)).includes('entry.Cx1a.js.map')).toBe(true);
  });

  it('--delete-after removes maps and their sourceMappingURL comments', async () => {
    const d = await build();
    await uploadSourcemaps({ url: 'http://r', token: 't', project: 'p', release: '1', dir: d, deleteAfter: true, fetch: ok() as unknown as typeof fetch });
    expect((await readdir(d)).filter((x) => x.endsWith('.map'))).toEqual([]);
    expect(await readFile(join(d, 'entry.Cx1a.js'), 'utf8')).toBe('console.log(1)\n');
    expect(await readFile(join(d, 'chunks/x.js'), 'utf8')).toBe('x()\n');
  });

  it('does not retry a 4xx and keeps the maps on failure', async () => {
    const d = await build();
    const f = vi.fn(async () => new Response('bad token', { status: 401 }));
    await expect(uploadSourcemaps({ url: 'http://r', token: 't', project: 'p', release: '1', dir: d, deleteAfter: true, fetch: f as unknown as typeof fetch })).rejects.toThrow(/HTTP 401/);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await readdir(d)).includes('entry.Cx1a.js.map')).toBe(true);
  });

  it('parses the CI command line; env supplies url and token', async () => {
    expect(parseArgs(['sourcemaps', 'upload', '--project', 'p', '--release=1.0', '--delete-after', '--dir', 'x'])).toEqual({
      cmd: 'sourcemaps upload', opts: { project: 'p', release: '1.0', 'delete-after': true, dir: 'x' },
    });
    const f = ok();
    vi.stubGlobal('fetch', f);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['releases', 'new', '--project', 'p', '--release', '2.0'], { REPLAYD_URL: 'http://r', REPLAYD_TOKEN: 'secret' })).toBe(0);
    expect(f.mock.calls[0]![0]).toBe('http://r/api/projects/p/releases');
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ version: '2.0' });
    expect(out.mock.calls.flat().join('')).not.toContain('secret');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['bogus'], {})).toBe(2);
    expect(err).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
