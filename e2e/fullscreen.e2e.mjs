import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { BASE, login } from './lib.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const reproduce=process.argv.includes('--reproduce');
const fixture=JSON.parse(execFileSync(process.execPath,[...process.execArgv,`${root}e2e/gen-replay.mjs`],{env:{...process.env,MINUTES:'0.1',REC_S:'2',WIDTH:'412',HEIGHT:'915',INSTALL:'1'},encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim().split('\n').at(-1));
const {cookies,api}=await login();
const link=await api('POST',`/sessions/${fixture.sid}/shares`,{expiry:'1h'});
const results=[];
const measure=page=>page.evaluate(()=>{
  const iframe=document.querySelector('.replayer-wrapper iframe');
  const rect=iframe.getBoundingClientRect(), controls=document.querySelector('.player-controls').getBoundingClientRect();
  return {width:rect.width,height:rect.height,x:rect.x,y:rect.y,controlsBottom:controls.bottom,viewportHeight:innerHeight,panelsInFullscreen:!!document.fullscreenElement?.querySelector('.player-panel'),fullscreen:!!document.fullscreenElement,exitLabel:!![...document.querySelectorAll('button')].find(b=>b.textContent==='Exit fullscreen')};
});
try {
  for(const channel of ['chrome','msedge']) {
    const browser=await chromium.launch({channel});
    try {
      for(const publicView of [false,true]) {
        const context=await browser.newContext({viewport:{width:1920,height:1080}});
        context.setDefaultTimeout(15000);
        if(!publicView) await context.addCookies(cookies.map(c=>({...c,domain:new URL(BASE).hostname,path:c.name==='rp_session'?'/api':'/',secure:false})));
        const page=await context.newPage();
        await page.goto(publicView ? link.url : `${BASE}/replay/${fixture.sid}`);
        await page.waitForFunction(()=>window.__rpPlayer?.loaded.done&&document.querySelector('.replayer-wrapper iframe'));
        const normal=await measure(page);
        await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
        await page.waitForFunction(()=>!!document.fullscreenElement);
        await page.waitForTimeout(250);
        const full=await measure(page);
        await page.screenshot({path:`${root}docs/screenshots/fullscreen-${reproduce?'before':'after'}-${channel}-${publicView?'public':'private'}.png`});
        if(reproduce) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(250);
          results.push({channel,publicView,normal,full,afterEscape:await measure(page)});
        } else {
          assert.equal(full.panelsInFullscreen,false);
          assert.equal(full.exitLabel,true);
          assert.ok(full.height>915,'portrait replay scales beyond its recorded height');
          assert.ok(Math.abs(full.width/full.height-412/915)<0.001);
          assert.ok(full.y>=0&&full.y+full.height<=1081&&full.controlsBottom<=1081);
          if((await page.getByTestId('play-toggle').textContent()).trim()==='Pause') await page.getByTestId('play-toggle').click();
          await page.getByTestId('play-toggle').click();
          await page.getByRole('button',{name:'Pause',exact:true}).waitFor();
          await page.getByTestId('play-toggle').click();
          const timeline=page.getByTestId('timeline');
          const box=await timeline.boundingBox();
          await page.mouse.click(box.x+box.width*.6,box.y+box.height/2);
          assert.ok(Number(await timeline.getAttribute('aria-valuenow'))>3000);
          await page.keyboard.press('Escape');
          await page.waitForFunction(()=>!document.fullscreenElement);
          await page.getByRole('button',{name:'Fullscreen',exact:true}).waitFor();
          const escaped=await measure(page);
          assert.ok(Math.abs(escaped.height-normal.height)<2);
          await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
          await page.getByRole('button',{name:'Exit fullscreen',exact:true}).click();
          await page.waitForFunction(()=>!document.fullscreenElement);
          results.push({channel,publicView,normal,full,escaped,pass:true});
        }
        await context.close();
      }
    } finally {await browser.close()}
  }
} finally {await api('DELETE',`/sessions/${fixture.sid}/shares/${link.id}`)}
await writeFile(`${root}docs/fullscreen-${reproduce?'before':'after'}.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
