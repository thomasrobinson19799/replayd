// Builds the instrumented rrweb glue: wraps MutationBuffer.processMutations with timing.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const needle = 'callbackWrapper(mutationBuffer.processMutations.bind(mutationBuffer))';
await build({
  entryPoints: [new URL('./spike-entry.js', import.meta.url).pathname],
  bundle: true, minify: !process.env.NOMIN, format: 'iife', target: 'es2022',
  outfile: new URL(process.env.NOMIN ? '../dist/spike-glue.dev.js' : '../dist/spike-glue.js', import.meta.url).pathname,
  plugins: [{ name: 'instrument', setup(b) {
    b.onLoad({ filter: /@rrweb[\\/]record[\\/]dist[\\/]record\.js$/ }, async (a) => {
      let src = await readFile(a.path, 'utf8');
      // @rrweb/record is now patched workspace-wide (patches/@rrweb__record@2.2.0.patch, D-04/D-05): undo the
      // patch so this spike build still measures the variants it was written for
      const patched = 'if (mutationHook) {\n        mutations = mutationHook(mutations);\n        if (!mutations.length) return;\n      }\n      ';
      if (src.includes(patched)) {
        src = src.replace(patched, '')
          .replace('Element: ["shadowRoot"],\n  MutationObserver: []', 'Element: ["shadowRoot", "querySelector", "querySelectorAll"],\n  MutationObserver: []')
          .replace('Element: ["querySelector", "querySelectorAll"],\n  MutationObserver: ["constructor"]', 'Element: [],\n  MutationObserver: ["constructor"]');
      }
      if (!src.includes(needle)) throw new Error('instrumentation needle not found');
      const pm = `"processMutations", (mutations) => {
      mutations.forEach(this.processMutation);`;
      if (!src.includes(pm)) throw new Error('processMutations needle not found');
      const src2 = process.env.NOHOOK ? src : src.replace(pm, `"processMutations", (mutations) => {
      const h = globalThis.__rpMutationHook;
      if (h) { mutations = h(mutations); if (mutations.length === 0) return; }
      mutations.forEach(this.processMutation);`);
      let src3 = src2;
      if (!process.env.NOFIX) {
        const a = 'Element: ["shadowRoot", "querySelector", "querySelectorAll"],';
        const b = 'Element: [],\n  MutationObserver: ["constructor"]';
        if (!src3.includes(a) || !src3.includes(b)) throw new Error('taint needles not found');
        src3 = src3.replace(a, 'Element: ["shadowRoot"],').replace(b, 'Element: ["querySelector", "querySelectorAll"],\n  MutationObserver: ["constructor"]');
      }
      return { contents: src3.replace(needle, `callbackWrapper(((f) => (m, o) => { const s = performance.now(); f(m, o); globalThis.__rpT.mo.push([s, performance.now() - s, m.length]); })(mutationBuffer.processMutations.bind(mutationBuffer)))`), loader: 'js' };
    });
  } }],
});
console.log('built dist/spike-glue.js');
