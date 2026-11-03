// @vitest-environment node
// T-30: @replayd/vite-plugin uploads the build's maps after the bundle is written, then deletes them.
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import replaydSourcemaps from '../src/index';

afterEach(() => vi.unstubAllGlobals());

describe('@replayd/vite-plugin', () => {
  it('uploads maps of outDir/<dir> as ~/<dir>/… and deletes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-vite-'));
    await mkdir(join(root, 'dist/assets'), { recursive: true });
    await writeFile(join(root, 'dist/assets/index-4f9a.js'), 'x\n//# sourceMappingURL=index-4f9a.js.map');
    await writeFile(join(root, 'dist/assets/index-4f9a.js.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const p = replaydSourcemaps({ url: 'https://replay.example.com', token: 'rpu_x', project: 'site', release: '2.0.0', dir: 'assets' });
    p.configResolved({ root, build: { outDir: 'dist' } });
    await p.closeBundle();
    expect(f).toHaveBeenCalledTimes(1);
    const [u, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(u).toBe('https://replay.example.com/api/projects/site/releases/2.0.0/sourcemaps');
    expect([...(init.body as FormData).keys()]).toEqual(['~/assets/index-4f9a.js']);
    expect(await readdir(join(root, 'dist/assets'))).toEqual(['index-4f9a.js']);
  });

  it('is a no-op without url/token/release (local builds) and does not fail the build by default', async () => {
    const f = vi.fn(async () => new Response('no', { status: 500 }));
    vi.stubGlobal('fetch', f);
    const p = replaydSourcemaps({ project: 'site' });
    p.configResolved({ root: tmpdir(), build: { outDir: 'nope' } });
    await p.closeBundle();
    expect(f).not.toHaveBeenCalled();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const q = replaydSourcemaps({ project: 'site', url: 'http://r', token: 't', release: '1', failOnError: false });
    const root = await mkdtemp(join(tmpdir(), 'rp-vite-'));
    await writeFile(join(root, 'a.js.map'), '{}');
    q.configResolved({ root, build: { outDir: '.' } });
    await expect(q.closeBundle()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  }, 20_000);
});
