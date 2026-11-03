/**
 * @replayd/vite-plugin (PRD §5.6): after `vite build` uploads the generated source maps for `release`, then
 * deletes the `.map` files from the output (default) so they are never served. Use with `build.sourcemap:
 * 'hidden'` or `true`. Token from `REPLAYD_TOKEN`; the plugin does nothing without url/token/release (local
 * builds), and fails the build on upload errors only with `failOnError`.
 */
import { join } from 'node:path';
import { uploadSourcemaps } from '@replayd/cli';

export interface ReplaydViteOptions {
  url?: string;
  token?: string;
  project: string;
  release?: string;
  /** `~/` path the build output is served at (default `~`, i.e. the site root) */
  urlPrefix?: string;
  /** sub-directory of the output dir to scan (default: all of it) */
  dir?: string;
  deleteAfter?: boolean;
  failOnError?: boolean;
}

interface Plugin {
  name: string;
  apply: 'build';
  enforce: 'post';
  configResolved(c: { build: { outDir: string }; root: string }): void;
  closeBundle(): Promise<void>;
}

export default function replaydSourcemaps(o: ReplaydViteOptions): Plugin {
  let out = '';
  return {
    name: 'replayd-sourcemaps',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      out = join(c.root, c.build.outDir);
    },
    async closeBundle() {
      const url = o.url ?? process.env.REPLAYD_URL, token = o.token ?? process.env.REPLAYD_TOKEN, release = o.release ?? process.env.REPLAYD_RELEASE;
      if (!url || !token || !release) return;
      try {
        await uploadSourcemaps({
          url, token, release, project: o.project, dir: o.dir ? join(out, o.dir) : out,
          urlPrefix: o.urlPrefix ?? (o.dir ? `~/${o.dir}` : '~'), deleteAfter: o.deleteAfter ?? true,
          log: (m) => process.stdout.write(`[replayd] ${m}\n`),
        });
      } catch (e) {
        if (o.failOnError) throw e;
        process.stderr.write(`[replayd] ${e instanceof Error ? e.message : String(e)}\n`);
      }
    },
  };
}
