// Shared esbuild-based build for SDK packages. Usage (from a package dir): node ../../scripts/build.mjs <config.json>
// config: { entries: {name: srcPath}, formats: ['esm'|'iife'|'cjs'], external: [...], platform, iifeName, splitting,
//           iifeAliases: {importPath: srcPath} — swaps relative imports in the IIFE build only }
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = process.cwd();
const cfg = JSON.parse(readFileSync(resolve(cwd, process.argv[2] ?? 'build.json'), 'utf8'));
rmSync(resolve(cwd, 'dist'), { recursive: true, force: true });
const common = {
  bundle: true, minify: true, target: 'es2022', legalComments: 'none', sourcemap: true,
  platform: cfg.platform ?? 'browser', external: cfg.external ?? [], logLevel: 'warning',
  define: { __RP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')).version) },
};
for (const fmt of cfg.formats ?? ['esm']) {
  if (fmt === 'iife') {
    for (const [name, src] of Object.entries(cfg.iife ?? {})) {
      const alias = Object.entries(cfg.iifeAliases ?? {});
      const plugins = alias.length ? [{
        name: 'iife-aliases',
        setup(b) {
          for (const [from, to] of alias) b.onResolve({ filter: new RegExp(`^${from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, () => ({ path: resolve(cwd, to) }));
        },
      }] : [];
      await build({ ...common, entryPoints: [resolve(cwd, src)], format: 'iife', globalName: cfg.iifeName, outfile: resolve(cwd, `dist/${name}.js`), plugins });
    }
    continue;
  }
  await build({
    ...common, entryPoints: Object.fromEntries(Object.entries(cfg.entries).map(([k, v]) => [k, resolve(cwd, v)])),
    format: fmt, splitting: fmt === 'esm' && cfg.splitting !== false, outdir: resolve(cwd, 'dist'),
    outExtension: fmt === 'cjs' ? { '.js': '.cjs' } : undefined, chunkNames: 'chunks/[name]-[hash]',
  });
}
