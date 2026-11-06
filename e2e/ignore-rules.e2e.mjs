import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BASE, login } from './lib.mjs';
const { api, cookies } = await login();
const project = await api('POST','/projects',{slug:`ignore-${Date.now().toString(36)}`,name:'Ignore rules acceptance',allowed_origins:[]});
const base=`/projects/${project.id}/ignore-rules`;
const browser=await chromium.launch();
try {
  const context=await browser.newContext();
  await context.addCookies(cookies.map(c=>({...c,domain:new URL(BASE).hostname,path:c.name==='rp_session'?'/api':'/',secure:false})));
  const page=await context.newPage();
  await page.goto(`${BASE}/projects/${project.id}/settings?tab=ignore`);
  await page.getByLabel('Rule pattern').fill('noise');
  await page.getByRole('button',{name:'Add rule',exact:true}).click();
  await page.getByText('0 dropped').waitFor();
  let rules=(await api('GET',base)).rules;
  assert.equal(rules.length,1);assert.equal(rules[0].pattern,'noise');
  const before=(await api('GET',`/projects/${project.id}/issues`)).issues;
  const sent=await fetch(`${BASE}/ingest/${project.id}/events?key=${project.public_key}`,{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify([{id:randomUUID(),ts:Date.now(),source:'manual',level:'error',message:'NOISE from application'}])});
  assert.equal(sent.status,202);
  for(let i=0;i<30;i++) { rules=(await api('GET',base)).rules; if(rules[0].dropped_count===1) break; await delay(1000) }
  assert.equal(rules[0].dropped_count,1);assert.ok(rules[0].last_matched_at);
  assert.deepEqual((await api('GET',`/projects/${project.id}/issues`)).issues,before);
  await page.reload();
  await page.getByText('1 dropped').waitFor();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByLabel('Rule match').selectOption('regex');
  await page.getByLabel('Rule pattern').fill('[');
  await page.getByRole('button',{name:'Save rule',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Invalid'}).waitFor();
  await page.getByLabel('Rule kind').selectOption('network');
  await page.getByLabel('Rule pattern').fill('^wss://example');
  await page.getByRole('button',{name:'Save rule',exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Add rule',exact:true}).waitFor();
  await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Edit')?.disabled);
  assert.equal((await api('GET',base)).rules[0].kind,'network');
  for(const width of [1440,1024,525]) {
    await page.setViewportSize({width,height:1000});
    for(const theme of ['dark','light']) {
      await page.evaluate(t=>{document.documentElement.dataset.theme=t},theme);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:fileURLToPath(new URL(`../docs/screenshots/ignore-${theme}-${width}.png`,import.meta.url)),fullPage:true});
    }
  }
  await page.getByRole('button',{name:'Delete',exact:true}).click();
  await page.getByText('No ignore rules.').waitFor();
  console.log('Ignore rules passed: CRUD, invalid regex, keyboard save, dropped counters, no issue, six responsive/theme screenshots.');
} finally {
  await browser.close();
  await api('DELETE',`/projects/${project.id}`);
}
