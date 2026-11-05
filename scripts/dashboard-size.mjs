import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const dir = new URL('../dashboard/.output/public/_nuxt/', import.meta.url);
const files = readdirSync(dir).filter(n => /\.(js|css)$/.test(n));
let raw = 0, gzip = 0;
for (const n of files) { const b = readFileSync(new URL(n, dir)); raw += b.length; gzip += gzipSync(b).length; }
console.log(JSON.stringify({ files: files.length, raw, gzip, scope: 'All emitted JS/CSS, including lazy replay and worker; independent gzip per file' }));
