// Run real suites sequentially, retain bounded diagnostics, and propagate every failure to CI.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=resolve(process.env.BENCH_OUTPUT || fileURLToPath(new URL('../results/',import.meta.url)));
mkdirSync(output,{recursive:true});
if(!process.env.NO_BUILD) {
  const build=spawnSync(process.platform==='win32'?'pnpm.cmd':'pnpm',['build'],{cwd:root,stdio:'inherit',shell:process.platform==='win32'});
  if(build.status!==0) process.exit(build.status || 1);
}
const reports=[];
for(const suite of ['init','ws-gate','replay','compare']) {
  console.log(`Running ${suite} benchmark`);
  const started=Date.now();
  const run=spawnSync(process.execPath,[fileURLToPath(new URL(`./${suite}.mjs`,import.meta.url))],{
    cwd:root,encoding:'utf8',timeout:15*60_000,maxBuffer:4*1024*1024,
    env:{...process.env,NO_BUILD:'1',SCENARIOS:process.env.SCENARIOS || 'terminal-1000',CATS:'devtools.timeline,disabled-by-default-devtools.timeline'},
  });
  const stdout=run.stdout || '',stderr=run.stderr || '';
  writeFileSync(join(output,`${suite}.log`),stdout+stderr);
  process.stdout.write(stdout); process.stderr.write(stderr);
  const measurements=stdout.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  reports.push({suite,exit:run.status ?? 1,seconds:Math.round((Date.now()-started)/1000),error:run.error?.code || null,measurements});
  writeFileSync(join(output,'summary.json'),JSON.stringify({at:new Date().toISOString(),reports},null,2)+'\n');
}
if(reports.some(r=>r.exit!==0)) process.exitCode=1;
