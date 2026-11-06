import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BASE, login } from './lib.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const {api,cookies}=await login();
const fixture=JSON.parse(execFileSync(process.execPath,[`${root}e2e/gen-replay.mjs`],{env:{...process.env,MINUTES:'0.1',REC_S:'2',INSTALL:'1',PROJECT:`header-${Date.now().toString(36)}`},encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim().split('\n').at(-1));
const id=randomUUID(), ts=Date.now();
await delay(11000); // SQL fixture is picked up by the bounded project-cache refresh.
const sent=await fetch(`${BASE}/ingest/${fixture.project_id}/events?key=pk_${fixture.project}`,{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify([{id,ts,sid:fixture.sid,source:'manual',level:'error',type:'TypeError',message:'Checkout total is unavailable',stack:'TypeError: Checkout total is unavailable\n at calculateTotal (https://app.example/checkout.js:12:4)',release:'2.4.1',env:'qa',url:'https://app.example/checkout',user:{id:'EXCLUDED-ID',email:'EXCLUDED-EMAIL',name:'EXCLUDED-NAME'},tags:{customer:'EXCLUDED-TAG'},breadcrumbs:Array.from({length:35},(_,i)=>({ts:ts+i,cat:'click',msg:`step ${i}`}))}])});
assert.equal(sent.status,202);
let issue;
for(let i=0;i<30;i++){issue=(await api('GET',`/projects/${fixture.project_id}/issues`)).issues[0];if(issue)break;await delay(500)}
assert.ok(issue);
const pg=execFileSync('docker',['compose','-f',`${root}deploy/docker-compose.yml`,'ps','-q','postgres'],{encoding:'utf8'}).trim();
const frames=[{function:'minified',url:'https://app.example/app.js',line:1,col:2,in_app:true,orig:{file:'src/checkout.ts',function:'calculateTotal',line:12,col:4,pre:['const order = getOrder()'],context:'return order.total.amount',post:['}']}},{function:'vendorDispatch',url:'https://vendor.example/runtime.js',line:20,col:1,in_app:false}];
const extra={frames,custom_fields:{customer:'EXCLUDED-CUSTOM'},ctx:{http:{method:'POST',url:'/orders',status:500,ms:120},ws:{url:'wss://app.example/ws',code:1006,reconnects:2},component:'Checkout',app:{device:'Test device'}}};
execFileSync('docker',['exec','-i',pg,'psql','-U','replayd','-d','replayd','-v','ON_ERROR_STOP=1'],{input:`UPDATE events SET payload=payload || '${JSON.stringify(extra).replaceAll("'","''")}'::jsonb WHERE id='${id}';`,stdio:['pipe','ignore','inherit']});
const browser=await chromium.launch();
try {
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  await context.addCookies(cookies.map(c=>({...c,domain:new URL(BASE).hostname,path:c.name==='rp_session'?'/api':'/',secure:false})));
  const page=await context.newPage();
  await page.goto(`${BASE}/projects/${fixture.project}/issues/${issue.id}`);
  await page.getByRole('button',{name:'Copy stack',exact:true}).click();
  const copied=await page.evaluate(()=>navigator.clipboard.readText());
  for(const text of ['TypeError','calculateTotal','src/checkout.ts:12:4','const order = getOrder()','return order.total.amount','2.4.1','qa','HTTP:','WS:','Checkout','Recent breadcrumbs (30):','step 34']) assert.ok(copied.includes(text),text);
  for(const text of ['EXCLUDED','vendorDispatch','step 0\n']) assert.ok(!copied.includes(text),text);
  await page.getByLabel('In-app frames only').uncheck();
  await page.getByRole('button',{name:'Copy stack',exact:true}).click();
  assert.ok((await page.evaluate(()=>navigator.clipboard.readText())).includes('vendorDispatch'));
  assert.ok((await page.getByTestId('header-play-replay').getAttribute('href')).includes(`t=${ts-2000}`));
  const more=page.locator('summary').filter({hasText:/^More/});
  await more.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Copy link',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  assert.ok(await more.evaluate(el=>el===document.activeElement));
  await page.getByTestId('action-ignore').click();
  await page.getByRole('button',{name:'Custom date or event count…'}).click();
  await page.getByLabel('Ignore until').selectOption('count');
  await page.getByLabel('Additional events').fill('17');
  await page.getByRole('button',{name:'Ignore issue',exact:true}).click();
  await page.getByTestId('issue-status-text').filter({hasText:'17 more events'}).waitFor();
  await page.getByTestId('action-reopen').click();
  for(const width of [1440,1024,525]) {
    await page.setViewportSize({width,height:1000});
    for(const theme of ['dark','light']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.waitForTimeout(250);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:`${root}docs/screenshots/issue-header-${theme}-${width}.png`,fullPage:true});
      await more.click();
      await page.waitForTimeout(150);
      const menuBox=await page.locator('.issue-workflow > .dropdown .dropdown-panel').boundingBox();
      assert.ok(menuBox.x>=0 && menuBox.x+menuBox.width<=width);
      await page.screenshot({path:`${root}docs/screenshots/issue-more-${theme}-${width}.png`});
      await page.keyboard.press('Escape');
    }
  }
  console.log('Issue header/copy passed: visible frames, source context, 30 breadcrumbs, exclusions, More keyboard/Escape, custom ignore and six theme/width views.');
} finally {await browser.close()}
