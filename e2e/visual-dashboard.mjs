import { chromium } from 'playwright';
import { login,BASE } from './lib.mjs';
import assert from 'node:assert/strict';
const auth=await login();
const projects=(await auth.api('GET','/projects')).projects;
const project=projects.filter(p=>p.slug.startsWith('rec-')).at(-1);
const issue=(await auth.api('GET',`/projects/${project.id}/issues?status=all`)).issues[0];
const replayProject=projects.find(p=>p.slug==='e2e-replay');
const session=(await auth.api('GET',`/projects/${replayProject.id}/sessions`)).sessions[0];
const browser=await chromium.launch();
const context=await browser.newContext();
await context.addCookies(auth.cookies.map(c=>({...c,url:BASE})));
const page=await context.newPage();
const routes={ 'issues-populated':`/projects/${project.slug}/issues?status=all`, 'issue-detail':`/projects/${project.slug}/issues/${issue.id}`, 'sessions-populated':`/projects/${replayProject.slug}/sessions`, 'replay':`/replay/${session.id}?project=${replayProject.slug}` };
for (const [name,path] of Object.entries(routes)) {
  await page.goto(BASE+path); await page.locator('h1').waitFor();
  if(name==='replay') await page.waitForFunction(()=>window.__rpDoneMs!==undefined); else await page.waitForTimeout(500);
  for(const width of [1440,1024,525]) {
    await page.setViewportSize({width,height:1000}); await page.waitForTimeout(150);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} overflow at ${width}`);
    await page.screenshot({path:`docs/screenshots/${name}-${width}.png`});
  }
  if(name==='issue-detail') {
    await page.setViewportSize({width:1440,height:1000});
    const search=page.getByRole('searchbox',{name:'Search breadcrumbs'});
    await search.fill('no-matching-breadcrumb');
    await page.getByText('No breadcrumbs match.',{exact:true}).waitFor();
    await search.fill('');
    const stack=page.locator('summary').filter({hasText:'Stack trace'});
    await stack.click();
    assert.equal(await stack.locator('..').getAttribute('open'),null);
    await stack.press('Enter');
    assert.notEqual(await stack.locator('..').getAttribute('open'),null);
    await page.getByRole('button',{name:/Theme:/}).click();
    await page.getByRole('button',{name:/Theme:/}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    await page.waitForTimeout(200);
    await page.screenshot({path:'docs/screenshots/issue-detail-dark.png'});
    await page.getByRole('button',{name:/Theme:/}).click();
    for(const width of [525,375]) {
      await page.setViewportSize({width,height:1000});
      const trigger=page.locator('[data-testid=action-ignore]');
      await trigger.click();
      const menu=page.getByRole('group',{name:'Ignore options'});
      const box=await menu.boundingBox();
      assert(box && box.x>=0 && box.x+box.width<=width,`Ignore popup clipped at ${width}`);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`open Ignore overflows at ${width}`);
      await page.screenshot({path:`docs/screenshots/issue-ignore-${width}.png`});
      await menu.getByRole('button').first().focus();
      await page.keyboard.press('Escape');
      assert.equal(await menu.count(),0);
      assert(await trigger.evaluate(el=>el===document.activeElement));
    }
  }
  if(name==='replay') {
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('tab',{name:/network/i}).click();
    await page.getByLabel('Follow playhead').uncheck();
    await page.locator('[role=tabpanel] [role=button]').first().click();
    await page.getByRole('dialog',{name:'Network request'}).waitFor();
    assert(await page.getByRole('dialog').locator('pre').count()>0);
    await page.screenshot({path:'docs/screenshots/network-detail.png'});
    await page.keyboard.press('Escape');
    const timeline=page.getByRole('slider',{name:'Replay timeline'});
    await timeline.click({position:{x:200,y:10}}); await timeline.press('ArrowRight');
    await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
    assert(await page.evaluate(()=>!!document.fullscreenElement));
    await page.evaluate(()=>document.exitFullscreen());
    await page.getByRole('tab',{name:/device/i}).click();
    await page.getByRole('searchbox',{name:'Search inspection panel'}).fill('no-such-device-field');
    assert.equal(await page.getByRole('tabpanel').locator('dt').count(),0);
    await page.getByRole('searchbox',{name:'Search inspection panel'}).fill('');
    assert(await page.getByRole('tabpanel').locator('dt').count()>0);
  }
}
await page.goto(BASE+'/missing-page-qa');
await page.getByRole('heading',{name:'This page is no longer here.'}).waitFor();
for(const width of [1440,525]) {
  await page.setViewportSize({width,height:1000});
  await page.screenshot({path:`docs/screenshots/not-found-${width}.png`});
}
await page.evaluate(()=>localStorage.setItem('replayd-theme','dark'));
await page.reload();
await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
await page.screenshot({path:'docs/screenshots/not-found-dark.png'});
await page.evaluate(()=>localStorage.removeItem('replayd-theme'));
await page.emulateMedia({colorScheme:'dark'});
await page.reload();
await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
await page.emulateMedia({colorScheme:'light'});
await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
await page.getByRole('button',{name:'Back to projects',exact:true}).click();
await page.getByRole('heading',{name:'Projects',exact:true}).waitFor();
await context.close();
const anon=await browser.newPage({viewport:{width:525,height:900}}); await anon.goto(BASE+'/login'); await anon.getByLabel('Email').waitFor(); await anon.screenshot({path:'docs/screenshots/login-525.png'});
await browser.close();
console.log('PASS populated issue, stack, session and player screenshots; pointer timeline, keyboard seek, network inspector and fullscreen.');
