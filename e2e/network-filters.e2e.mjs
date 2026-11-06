import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { BASE, login } from './lib.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const fixture=JSON.parse(execFileSync(process.execPath,[`${root}e2e/gen-replay.mjs`],{env:{...process.env,MINUTES:'0.1',REC_S:'2',INSTALL:'1'},encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim().split('\n').at(-1));
const ts=Date.now(), rows=[['GET',200,500,'fetch'],['POST',500,1500,'xhr'],['POST',0,6000,'fetch'],['HEAD',304,4000]];
const events=rows.map(([method,status,duration,type],i)=>({type:5,timestamp:ts+i,data:{tag:'network',payload:{method,status,duration,type,url:`https://filter.example/request-${i}`}}}));
const body=gzipSync(JSON.stringify(events)), frame=Buffer.alloc(29+4+body.length+2);
frame.writeUInt32LE(4+body.length+2);frame.writeUInt32LE(9999,4);frame.writeBigUInt64LE(BigInt(ts),8);frame.writeBigUInt64LE(BigInt(ts+3),16);frame.writeUInt32LE(body.length,29);body.copy(frame,33);
const container=execFileSync('docker',['compose','-f',`${root}deploy/docker-compose.yml`,'ps','-q','replayd'],{encoding:'utf8'}).trim();
execFileSync('docker',['run','--rm','-i','--volumes-from',container,'--user','65532','alpine:3.22','sh','-c',`cat >> /data/${fixture.project_id}/${fixture.day}/${fixture.sid}.rpl`],{input:frame,stdio:['pipe','ignore','inherit']});
const {cookies}=await login();
const browser=await chromium.launch();
try {
  const context=await browser.newContext();context.setDefaultTimeout(15000);
  await context.addCookies(cookies.map(c=>({...c,domain:new URL(BASE).hostname,path:c.name==='rp_session'?'/api':'/',secure:false})));
  const page=await context.newPage();
  await page.goto(`${BASE}/replay/${fixture.sid}`);
  await page.waitForFunction(()=>window.__rpPlayer?.loaded.done);
  await page.getByRole('tab',{name:/^network/i}).click();
  await page.getByLabel('Follow playhead').uncheck();
  await page.getByRole('searchbox').fill('filter.example');
  const list=page.getByRole('tabpanel').getByRole('button');
  assert.equal(await list.count(),4);
  await page.getByLabel('Method',{exact:true}).selectOption('POST');assert.equal(await list.count(),2);
  await page.getByLabel('Status',{exact:true}).selectOption('5');assert.equal(await list.count(),1);
  await page.getByLabel('Type',{exact:true}).selectOption('xhr');assert.equal(await list.count(),1);
  await page.getByLabel('Slower than',{exact:true}).selectOption('1000');assert.equal(await list.count(),1);
  await page.getByLabel('Failed only').check();assert.equal(await list.count(),1);
  await page.getByLabel('Slower than',{exact:true}).selectOption('3000');assert.equal(await list.count(),0);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();assert.equal(await list.count(),2);
  await page.getByLabel('Failed only').uncheck();assert.equal(await list.count(),4);
  await page.getByLabel('Status',{exact:true}).selectOption('failed');assert.equal(await list.count(),1);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await page.getByLabel('Type',{exact:true}).selectOption('fetch');assert.equal(await list.count(),2);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await page.getByLabel('Method',{exact:true}).selectOption('HEAD');assert.equal(await list.count(),1);
  await page.getByLabel('Type',{exact:true}).selectOption('fetch');assert.equal(await list.count(),0);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  for(const width of [1440,1024,525]) {
    await page.setViewportSize({width,height:1000});
    for(const theme of ['dark','light']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.waitForTimeout(250);
      const panel=page.locator('.player-panel');await panel.scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await panel.screenshot({path:`${root}docs/screenshots/network-${theme}-${width}.png`});
    }
  }
  await list.first().click();await page.getByRole('dialog',{name:'Network request'}).waitFor();
  console.log('Network filters passed: all dropdowns, combined AND, failed/search, clear, legacy type, pointer details, six views.');
} finally {await browser.close()}
