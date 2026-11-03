// Shared esbuild-based build for SDK packages. Usage (from a package dir): node ../../scripts/build.mjs <config.json>
// config: { entries: {name: srcPath}, formats: ['esm'|'iife'|'cjs'], external: [...], platform, iifeName, splitting,
//           iifeAliases: {importPath: srcPath} — swaps relative imports in the IIFE build only,
//           iife: {name: srcPath | {src, aliases}} — per-entry aliases replace iifeAliases for that entry,
//           terser: [distFile…] — second minification pass (terser, source maps chained) for size-critical files }
import { build } from 'esbuild';
import { minify } from 'terser';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    for (const [name, e] of Object.entries(cfg.iife ?? {})) {
      const src = typeof e === 'string' ? e : e.src;
      const alias = Object.entries((typeof e === 'string' ? null : e.aliases) ?? cfg.iifeAliases ?? {});
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

// esbuild's minifier is fast but leaves ~4% gzip on the table for the size-budgeted sync bundles (PRD §2.1).
for (const f of cfg.terser ?? []) {
  const file = resolve(cwd, 'dist', f);
  const r = await minify(readFileSync(file, 'utf8'), {
    ecma: 2022, module: !f.endsWith('.min.js') && !Object.keys(cfg.iife ?? {}).some((n) => f === `${n}.js`), compress: { passes: 2 }, mangle: true,
    sourceMap: { content: readFileSync(`${file}.map`, 'utf8'), url: `${f.split('/').pop()}.map` },
  });
  writeFileSync(file, r.code);
  writeFileSync(`${file}.map`, r.map);
}
