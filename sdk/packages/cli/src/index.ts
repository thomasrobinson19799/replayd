#!/usr/bin/env node
/**
 * @replayd/cli (PRD §5.6), used from GitLab CI:
 *   replayd sourcemaps upload --project fxglory-terminal --release "$APP_VERSION" --dir .output/public/_nuxt \
 *     --url-prefix "~/_nuxt" --delete-after
 *   replayd releases new --project fxglory-terminal --release "$APP_VERSION"
 * Env: REPLAYD_URL, REPLAYD_TOKEN (project upload token; never printed).
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { newRelease, uploadSourcemaps } from './upload';

export { newRelease, tildePath, uploadSourcemaps, type UploadOptions } from './upload';

const USAGE = `usage:
  replayd sourcemaps upload --project <slug|id> --release <version> --dir <path> [--url-prefix ~/_nuxt] [--delete-after]
  replayd releases new --project <slug|id> --release <version>
options: --url <replayd url> (env REPLAYD_URL), --token <upload token> (env REPLAYD_TOKEN)`;

export function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string | true> } {
  const cmd: string[] = [], opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) opts[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) opts[k] = argv[++i]!;
      else opts[k] = true;
    } else cmd.push(a);
  }
  return { cmd: cmd.join(' '), opts };
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const { cmd, opts } = parseArgs(argv);
  const s = (k: string) => (typeof opts[k] == 'string' ? (opts[k] as string) : undefined);
  const base = { url: s('url') ?? env.REPLAYD_URL ?? '', token: s('token') ?? env.REPLAYD_TOKEN ?? '', project: s('project') ?? '', release: s('release') ?? '' };
  const log = (m: string) => process.stdout.write(`${m}\n`);
  try {
    if (cmd === 'sourcemaps upload') {
      if (!s('dir')) throw new Error('--dir is required');
      await uploadSourcemaps({ ...base, dir: s('dir')!, urlPrefix: s('url-prefix') ?? '~', deleteAfter: opts['delete-after'] === true, log });
      return 0;
    }
    if (cmd === 'releases new') {
      await newRelease(base);
      log(`release ${base.project}@${base.release} created`);
      return 0;
    }
    process.stderr.write(`${USAGE}\n`);
    return 2;
  } catch (e) {
    process.stderr.write(`replayd: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/** true when run as the entry script (`node dist/index.js`, a `.bin` symlink or a Windows `.cmd` shim) */
export function isEntry(argv1: string | undefined, self: string): boolean {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === self;
  } catch {
    return false;
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  void main(process.argv.slice(2)).then((c) => process.exit(c));
}
