import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {BASE,login,serve} from './lib.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const {api,cookies}=await login();
const files=Object.fromEntries(['replayd.min.js','replay.js','worker.js'].map(f=>[`/${f}`,`${root}sdk/packages/core/dist/${f}`]));
const app=await serve({routes:{...files,'/':()=>`<!doctype html><html><head><meta charset="utf-8"><script src="/replayd.min.js"></script><script>Replayd.init({dsn:window.__DSN,appVersion:'fields-2.4',release:'fields-release',replay:{sampleRate:1}});</script></head><body><h1>Fields acceptance</h1><input type="password" value="never-visible"><button>Continue</button></body></html>`}});
const project=await api('POST','/projects',{slug:`fields-${Date.now().toString(36)}`,name:'Fields acceptance',allowed_origins:[app.origin]});
const browser=await chromium.launch();
const until=async(fn)=>{for(let i=0;i<35;i++){const value=await fn();if(value)return value;await delay(500)}throw new Error('Field acceptance timed out')};
async function views(page,name){
  for(const width of [1440,1024,525]) for(const theme of ['dark','light']) {
    await page.setViewportSize({width,height:1000});
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await delay(150);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} overflow at ${width}`);
    await page.screenshot({path:`${root}docs/screenshots/fields-${name}-${theme}-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
}
try {
  const ac=await browser.newContext({timezoneId:'Asia/Tehran'}),ap=await ac.newPage();
  await ap.addInitScript(dsn=>window.__DSN=dsn,project.dsn);await ap.goto(app.origin);await delay(1800);
  await ap.evaluate(()=>{Replayd.setUser({id:'first-id',email:'first@example.test',name:'First Person'});Replayd.setCustomFields({plan:'basic',remove:'old',nested:{password:'SECRET',visible:'retained'}});Replayd.captureException(new Error('First identity error'));return Replayd.flush()});
  const session=await until(async()=> (await api('GET',`/projects/${project.id}/sessions`)).sessions.find(s=>s.user_id==='first-id'));
  const first=await api('GET',`/sessions/${session.id}`);
  assert.equal(first.timezone,'Asia/Tehran');assert.match(first.local_time,/\+03:30$/);assert.ok(first.client_ip);assert.equal(first.app_version,'fields-2.4');
  assert.equal(first.custom_fields.nested.password,'[Filtered]');
  await ap.evaluate(()=>{Replayd.setUser({id:'latest-id',email:'latest@example.test',name:'Latest Person'});Replayd.setCustomFields({plan:'pro',remove:null});Replayd.captureException(new Error('Latest identity error'));return Replayd.flush()});
  const latest=await until(async()=>{const s=await api('GET',`/sessions/${session.id}`);return s.user_id==='latest-id'&&s.custom_fields.plan==='pro'?s:null});
  assert.equal(latest.custom_fields.remove,undefined);assert.equal(latest.custom_fields.nested.visible,'retained');
  const issues=(await until(async()=>{const r=(await api('GET',`/projects/${project.id}/issues`)).issues;return r.length===2?r:null}));
  const issue=issues.find(i=>i.title.includes('Latest'));
  const ev=(await api('GET',`/issues/${issue.id}`)).latest_event;
  assert.equal(ev.user_name,'Latest Person');assert.ok(ev.client_ip);assert.equal(ev.payload.timezone,'Asia/Tehran');assert.match(ev.payload.local_time,/\+03:30$/);assert.ok(ev.payload.received_at);assert.equal(ev.payload.custom_fields.plan,'pro');
  for(const value of ['latest-id','latest@example.test','Latest Person',latest.client_ip,'fields-2.4']) {
    assert.ok((await api('GET',`/projects/${project.id}/sessions?user=${encodeURIComponent(value)}`)).sessions.some(s=>s.id===session.id));
    assert.ok((await api('GET',`/projects/${project.id}/issues?q=${encodeURIComponent(value)}`)).issues.some(i=>i.id===issue.id));
  }
  assert.equal((await api('GET',`/projects/${project.id}/sessions?user=first-id`)).sessions.length,0);
  assert.equal((await api('GET',`/projects/${project.id}/issues?q=first-id`)).issues.length,1);
  const dc=await browser.newContext({viewport:{width:1440,height:1000}});
  await dc.addCookies(cookies.map(c=>({...c,domain:new URL(BASE).hostname,path:c.name==='rp_session'?'/api':'/',secure:false})));
  const dp=await dc.newPage();await dp.goto(`${BASE}/replay/${session.id}`);await dp.waitForFunction(()=>window.__rpPlayer?.loaded.done);
  await dp.getByRole('tab',{name:/^device/i}).click();
  await dp.screenshot({path:`${root}docs/screenshots/fields-device-identity.png`,fullPage:true});
  const history=dp.getByRole('region',{name:'Field changes'});
  await history.getByRole('button').filter({hasText:'Latest Person'}).click();
  assert.ok(Number(await dp.getByTestId('timeline').getAttribute('aria-valuenow'))>0);
  assert.ok((await dp.locator('.player-panel').textContent()).includes('latest@example.test'));
  assert.ok(!(await dp.locator('.player-panel').textContent()).includes('SECRET'));
  await dp.screenshot({path:`${root}docs/screenshots/fields-device.png`,fullPage:true});
  await views(dp,'device');
  await dp.goto(`${BASE}/projects/${project.id}/issues/${issue.id}`);await dp.getByRole('heading',{name:'Custom fields'}).waitFor();
  assert.ok((await dp.locator('.issue-sidebar').textContent()).includes('Latest Person'));
  await dp.screenshot({path:`${root}docs/screenshots/fields-issue.png`,fullPage:true});
  await views(dp,'issue');
  for(const role of ['admin','member','viewer']) {
    const email=`${role}-${project.slug}@example.test`, password='Local-fields-acceptance-1';
    await api('POST','/users',{email,password,name:`Fields ${role}`});
    await api('POST',`/projects/${project.id}/members`,{email,role});
    const response=await fetch(`${BASE}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});assert.ok(response.ok);
    const rc=await browser.newContext();
    await rc.addCookies(response.headers.getSetCookie().map(raw=>{const pair=raw.split(';')[0],i=pair.indexOf('=');const name=pair.slice(0,i);return{name,value:pair.slice(i+1),domain:new URL(BASE).hostname,path:name==='rp_session'?'/api':'/',secure:false}}));
    const rp=await rc.newPage();
    rp.on('response',r=>{if(r.status()>=400)console.log(`Role ${role}: ${r.status()} ${new URL(r.url()).pathname}`)});
    await rp.goto(`${BASE}/replay/${session.id}`);
    await rp.getByRole('tab',{name:/^device/i}).click().catch(async e=>{await rp.screenshot({path:`${root}data/fields-role-failure.png`,fullPage:true});console.log(`Role ${role} page: ${new URL(rp.url()).pathname}`);throw e});
    await rp.getByText('Latest Person',{exact:true}).waitFor();
    assert.ok((await rp.locator('.player-panel').textContent()).includes(latest.client_ip));
    assert.ok((await rp.locator('.player-panel').textContent()).includes('retained'));
    await rp.goto(`${BASE}/projects/${project.id}/issues/${issue.id}`);await rp.getByRole('heading',{name:'Custom fields'}).waitFor();
    assert.ok((await rp.locator('.issue-sidebar').textContent()).includes('latest@example.test'));
    if(role==='viewer') assert.equal(await rp.getByTestId('action-resolve').count(),0);
    await rc.close();
  }
  // Exact 16 KiB makes a >16 KiB metadata envelope, then oversize is atomically rejected.
  await ap.evaluate(()=>{Replayd.setCustomFields({plan:null,nested:null,x:'x'.repeat(16384-8)});return Replayd.flush()});
  await until(async()=>{const s=await api('GET',`/sessions/${session.id}`);return s.custom_fields.x?.length===16384-8});
  await ap.evaluate(()=>{Replayd.setCustomFields({extra:'too large'});return Replayd.flush()});await delay(3500);
  assert.equal((await api('GET',`/sessions/${session.id}`)).custom_fields.extra,undefined);
  await ap.evaluate(()=>{Replayd.setUser();Replayd.setCustomFields({x:null});return Replayd.flush()});
  await until(async()=>{const s=await api('GET',`/sessions/${session.id}`);return s.user_id===null&&Object.keys(s.custom_fields).length===0});
  console.log('Fields passed: real SDK login changes, clocks/IP, latest vs retained-event search, history seek, redaction, exact 16 KiB, atomic oversize and logout clears.');
} finally {await browser.close();app.server.close()}
