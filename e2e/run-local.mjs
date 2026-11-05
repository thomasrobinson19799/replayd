import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
const preload = new URL('./chrome-preload.mjs',import.meta.url).href;
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['issues','sdk-replay','issue-status','capacitor','sourcemaps','remote-config','adapters','player','alerts','observability','wordpress','dashboard'];
const results=[];
for(const suite of suites) {
  console.log(`Running ${suite}…`);
  const start=Date.now();
  const result=spawnSync(process.execPath,[fileURLToPath(new URL(`./${suite}.e2e.mjs`,import.meta.url))],{stdio:'inherit',env:{...process.env,NODE_OPTIONS:`--import=${preload}`}});
  results.push({suite,exit:result.status,seconds:Math.round((Date.now()-start)/1000)});
}
writeFileSync(new URL('../docs/e2e-results.json',import.meta.url),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
if(results.some(r=>r.exit!==0)) process.exitCode=1;
