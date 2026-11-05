// Read-only migration inventory. Reports booleans and filenames, never config values or credentials.
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(process.argv[2] || 'D:/Projects/forex-trading-platform/terminal');
const output = process.argv[3];
const read = p => readFile(join(root, p), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const ci = await read('.gitlab-ci.yml');
const variants = [];
for (const brand of ['fx', 'up', 'cap']) {
  for (const platform of ['desktop', 'mobile', 'apk']) {
    const file = `.files/${brand}/nuxt.config.${platform}.ts`;
    const config = await read(file);
    variants.push({ brand, platform, file,
      module: config.includes('@replayd/nuxt'),
      configured: /replayd\s*:/.test(config),
      sourceMaps: /sourcemap\s*:/.test(config),
      sentryRemoved: !/@sentry\/|Sentry\./.test(config),
    });
  }
}
const remaining = [];
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.nuxt', '.output', 'vendor', 'public', 'dist', 'astra-review'].includes(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await scan(p);
    else if (/\.(?:ts|js|vue|conf|yml|yaml)$/.test(entry.name) && (await stat(p)).size < 2_000_000) {
      const s = await readFile(p, 'utf8');
      if (/@sentry\/|Sentry\.(?:init|capture|setUser)|location\s+(?:\^~\s+)?\/?sentry\b/.test(s)) remaining.push(relative(root, p).replaceAll('\\', '/'));
    }
  }
}
await scan(root);
const result = {
  repository: root.replaceAll('\\', '/'),
  commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sdkInstalled: !!deps['@replayd/core'] && !!deps['@replayd/nuxt'],
  sentryDependencyRemoved: !Object.keys(deps).some(k => k.startsWith('@sentry/')),
  ciSourceMapUpload: /replayd.*sourcemaps\s+upload|sourcemaps\s+upload/.test(ci) && ci.includes('REPLAYD_TOKEN'),
  variants, remainingSentryCode: remaining,
  limitation: 'Static source verification only. Does not assert deployment, live ingest, Android hardware performance or website migration.',
};
result.passed = result.sdkInstalled && result.sentryDependencyRemoved && result.ciSourceMapUpload && !remaining.length && variants.every(v => v.module && v.configured && v.sourceMaps && v.sentryRemoved);
if (output) { await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n'); }
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
