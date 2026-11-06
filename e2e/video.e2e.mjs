import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BASE, login } from './lib.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const out=execFileSync(process.execPath,[fileURLToPath(new URL('./gen-replay.mjs',import.meta.url))],{env:{...process.env,MINUTES:'0.1',REC_S:'2',WIDTH:'412',HEIGHT:'915',INSTALL:'1'},encoding:'utf8',stdio:['ignore','pipe','inherit']});
const fixture=JSON.parse(out.trim().split('\n').at(-1));
const container=service=>execFileSync('docker',['compose','-f',`${root}deploy/docker-compose.yml`,'ps','-q',service],{encoding:'utf8'}).trim();
const sql=statement=>execFileSync('docker',['exec','-i',container('postgres'),'psql','-U','replayd','-d','replayd','-tA','-v','ON_ERROR_STOP=1'],{input:statement,encoding:'utf8'}).trim();
sql(`UPDATE sessions SET ended=false WHERE id='${fixture.sid}'`);
const {api,cookies}=await login();
const endpoint=`/sessions/${fixture.sid}/video`;
const first=await api('POST',endpoint,{});
assert.ok(['queued','rendering'].includes(first.state));
assert.ok(['queued','rendering','ready'].includes((await api('POST',endpoint,{})).state));
let job;
for(let i=0;i<120;i++) {
  job=await api('GET',endpoint);
  if(job.state==='ready'||job.state==='failed') break;
  await delay(1000);
}
assert.equal(job.state,'ready','renderer must finish');
const file=await fetch(`${BASE}/api${endpoint}/download`,{headers:{cookie:cookies.map(c=>`${c.name}=${c.value}`).join('; ')}});
assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'video/mp4');
await writeFile(`${root}data/video-test.mp4`,Buffer.from(await file.arrayBuffer()));
const probe=JSON.parse(execFileSync('docker',['compose','-f',`${root}deploy/docker-compose.yml`,'exec','-T','renderer','ffprobe','-v','error','-show_streams','-show_format','-of','json',`/renders/${fixture.sid}/output.mp4`],{encoding:'utf8'}));
const stream=probe.streams[0];assert.equal(stream.codec_name,'h264');assert.equal(stream.width,412);assert.equal(stream.height,916);
assert.ok(Math.abs(Number(probe.format.duration)-6)<0.2,'full six seconds including idle');
const preview=execFileSync('docker',['compose','-f',`${root}deploy/docker-compose.yml`,'exec','-T','renderer','ffmpeg','-loglevel','error','-ss','3','-i',`/renders/${fixture.sid}/output.mp4`,'-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1']);
await writeFile(`${root}docs/screenshots/video-frame.png`,preview);
// New recording bytes leave the finished snapshot downloadable and expose Render latest.
const ts=Number(sql(`SELECT (extract(epoch from last_at)*1000)::bigint FROM sessions WHERE id='${fixture.sid}'`))+1000;
const body=gzipSync(JSON.stringify([{type:5,timestamp:ts,data:{tag:'console',payload:{level:'info',args:['late event']}}}]));
const frame=Buffer.alloc(29+4+body.length+2);
frame.writeUInt32LE(4+body.length+2,0);frame.writeUInt32LE(9999,4);frame.writeBigUInt64LE(BigInt(ts),8);frame.writeBigUInt64LE(BigInt(ts),16);frame.writeUInt32LE(body.length,29);body.copy(frame,33);
execFileSync('docker',['run','--rm','-i','--volumes-from',container('replayd'),'--user','65532','alpine:3.22','sh','-c',`cat >> /data/${fixture.project_id}/${fixture.day}/${fixture.sid}.rpl`],{input:frame,stdio:['pipe','ignore','inherit']});
sql(`UPDATE sessions SET ended=true,last_at=to_timestamp(${ts}/1000.0) WHERE id='${fixture.sid}'`);
assert.equal((await api('GET',endpoint)).partial,true);
const browser=await chromium.launch();
try {
  const context=await browser.newContext();
  await context.addCookies(cookies.map(c=>({...c,domain:new URL(BASE).hostname,path:c.name==='rp_session'?'/api':'/',secure:false})));
  const page=await context.newPage();
  await page.goto(`${BASE}/replay/${fixture.sid}`);
  await page.getByRole('link',{name:'Download MP4',exact:true}).waitFor();
  await page.getByRole('button',{name:'Render latest',exact:true}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'Render latest',exact:true}).waitFor();
} finally { await browser.close() }
const link=await api('POST',`/sessions/${fixture.sid}/shares`,{expiry:'1h'});
try {
  const token=link.url.split('/').at(-1);
  const reuse=await fetch(`${BASE}/api/public/shares/${token}/video`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(reuse.status,200);assert.equal((await reuse.json()).state,'ready');
  const publicFile=await fetch(`${BASE}/api/public/shares/${token}/video/download`);
  assert.equal(publicFile.status,200);assert.equal((await publicFile.arrayBuffer()).byteLength,Number(probe.format.size));
} finally {await api('DELETE',`/sessions/${fixture.sid}/shares/${link.id}`)}
await api('POST',endpoint,{latest:true});
for(let i=0;i<120;i++) {
  job=await api('GET',endpoint);
  if(job.state==='ready'||job.state==='failed') break;
  await delay(1000);
}
assert.equal(job.state,'ready');assert.equal(job.partial,false);
console.log(JSON.stringify({test:'MP4 render',codec:stream.codec_name,width:stream.width,height:stream.height,seconds:probe.format.duration,bytes:probe.format.size,publicReuse:true,pass:true}));
