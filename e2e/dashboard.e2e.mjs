// Dashboard acceptance: real pointer/keyboard actions against the local API, no mocked business data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { login, BASE } from './lib.mjs';
const admin = await login();
const tag = Date.now().toString(36);
const email = `ui-${tag}@example.test`;
const initial = `Initial-${tag}-password`;
const changed = `Changed-${tag}-password`;
let project;
const browser = await chromium.launch();
const context = await browser.newContext({viewport:{width:1440,height:1000}});
await context.addCookies(admin.cookies.map(c=>({...c,url:BASE})));
const page = await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
const out = new URL('../docs/screenshots/',import.meta.url);
await mkdir(out,{recursive:true});
let user;
try {
  await page.goto(BASE+'/');
  await page.getByRole('button',{name:'New project',exact:true}).click();
  const setup=page.getByRole('dialog',{name:'Create project'});
  await setup.getByLabel('Project name').fill('Terminal QA');
  await setup.getByLabel('Project slug').fill(`ui-${tag}`);
  await setup.getByLabel('Allowed origins').fill('https://qa.example.test');
  await setup.getByRole('button',{name:'Create',exact:true}).click();
  await page.getByRole('heading',{name:'Connect Terminal QA'}).waitFor();
  project=(await admin.api('GET','/projects')).projects.find(p=>p.slug===`ui-${tag}`);
  assert(project);
  assert(await page.getByRole('button',{name:'Copy token',exact:true}).count());
  await page.getByRole('tab',{name:'CI source maps'}).click();
  assert((await page.locator('pre').last().textContent()).includes('export REPLAYD_TOKEN='));
  await page.goto(`${BASE}/users`);
  await page.getByRole('button',{name:'Create user',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name',{exact:true}).fill('QA developer');
  await dialog.getByLabel('Email',{exact:true}).fill(email);
  await dialog.getByLabel('Initial password',{exact:true}).fill(initial);
  await dialog.getByRole('button',{name:'Create user',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  await page.getByRole('searchbox',{name:'Search users'}).fill(email);
  const row = page.locator('tbody tr').filter({hasText:email});
  await row.waitFor();
  user=(await admin.api('GET','/users')).users.find(u=>u.email===email);
  assert(user);
  await row.getByRole('button',{name:'Disable',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Confirm change'}).click();
  await row.getByRole('button',{name:'Enable',exact:true}).waitFor();
  assert((await admin.api('GET','/users')).users.find(u=>u.id===user.id).disabled);
  await row.getByRole('button',{name:'Enable',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Confirm change'}).click();
  await row.getByRole('button',{name:'Disable',exact:true}).waitFor();
  await admin.api('POST',`/projects/${project.id}/members`,{email,role:'member'});

  const memberContext=await browser.newContext();
  const member=await memberContext.newPage();
  await member.goto(`${BASE}/login`);
  await member.getByLabel('Email',{exact:true}).fill(email);
  await member.getByLabel('Password',{exact:true}).fill(initial);
  await member.getByRole('button',{name:'Sign in',exact:true}).click();
  await member.waitForURL(`${BASE}/`);
  const other=await fetch(`${BASE}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:initial})});
  assert.equal(other.status,200);
  const otherCookies=other.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  await member.goto(`${BASE}/account`);
  await member.getByLabel('Current password',{exact:true}).fill(initial);
  await member.getByLabel('New password',{exact:true}).fill(changed);
  await member.getByLabel('Confirm new password',{exact:true}).fill(changed);
  await member.getByRole('button',{name:'Change password',exact:true}).click();
  await member.getByText('Password changed. Your other sessions have been signed out.').waitFor();
  assert.equal((await fetch(`${BASE}/api/me`,{headers:{cookie:otherCookies}})).status,401);
  await member.reload(); await member.getByRole('heading',{name:'My account',exact:true}).waitFor();
  await memberContext.close();

  await page.goto(`${BASE}/projects/${project.slug}/issues`);
  await page.getByText('No issues match.',{exact:true}).waitFor();
  await page.keyboard.press('/');
  assert.equal(await page.getByRole('searchbox').evaluate(el=>document.activeElement===el),true);
  await page.getByRole('searchbox').fill('missing-search');
  await page.getByRole('button',{name:'Filter',exact:true}).click();
  await page.waitForURL(/q=missing-search/);
  await page.goBack();
  await page.waitForFunction(()=>document.querySelector('input[type=search]')?.value==='');
  await page.getByRole('heading',{name:'Issues',exact:true}).click();
  await page.keyboard.press('?');
  await page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor({state:'hidden'});

  await page.goto(`${BASE}/projects/${project.slug}/settings`);
  await page.locator('input[aria-label=name]').fill('Unsaved name');
  await page.getByRole('tab',{name:'Remote config',exact:true}).click();
  await page.getByRole('dialog',{name:'Discard unsaved changes?'}).waitFor();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.locator('input[aria-label=name]').inputValue(),'Unsaved name');
  await page.getByRole('tab',{name:'Remote config',exact:true}).click();
  await page.getByRole('button',{name:'Discard changes',exact:true}).click();
  await page.locator('[data-testid=remote-form]').waitFor();

  for(const tab of ['general','keys','members','telegram','remote','rules']) {
    await page.goto(`${BASE}/projects/${project.slug}/settings?tab=${tab}`);
    await page.getByRole('tabpanel').waitFor();
    await page.setViewportSize({width:525,height:1000});
    if(tab==='rules') {
      await page.getByRole('button',{name:'Add rule',exact:true}).click();
      await page.getByLabel('Pattern for rule 1',{exact:true}).fill('[');
      assert(await page.getByRole('button',{name:'Save',exact:true}).isDisabled());
      await page.getByLabel('Pattern for rule 1',{exact:true}).fill('order #\\d+');
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.getByText('Saved',{exact:true}).waitFor();
    }
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`settings ${tab} overflows`);
    await page.screenshot({path:new URL(`settings-${tab}-525.png`,out).pathname.replace(/^\/(\w:)/,'$1')});
  }

  const routes={projects:'/',issues:`/projects/${project.slug}/issues`,sessions:`/projects/${project.slug}/sessions`,settings:`/projects/${project.slug}/settings?tab=remote`,users:'/users',account:'/account'};
  for (const [name,path] of Object.entries(routes)) {
    await page.goto(BASE+path); await page.locator('h1').waitFor();
    if(name==='users') await page.getByRole('searchbox').fill(email);
    if(name==='projects') await page.getByRole('searchbox').fill('Terminal QA');
    await page.waitForTimeout(500);
    for(const width of [1440,1024,525]) {
      await page.setViewportSize({width,height:1000});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} overflows at ${width}`);
      await page.screenshot({path:new URL(`${name}-${width}.png`,out).pathname.replace(/^\/(\w:)/,'$1')});
    }
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:/Theme:/}).click();
  await page.getByRole('button',{name:/Theme:/}).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.waitForTimeout(200);
  await page.screenshot({path:new URL('account-dark.png',out).pathname.replace(/^\/(\w:)/,'$1')});
  assert.deepEqual(errors,[]);
  console.log('PASS dashboard: user create/disable/enable, own password and session revocation, URL history, shortcuts, dirty guard, theme, 18 responsive screenshots, no browser errors.');
  await writeFile(new URL('dashboard-results.json',out),JSON.stringify({passed:true,widths:[1440,1024,525],routes:Object.keys(routes),browserErrors:errors},null,2));
} finally {
  await browser.close();
  if(user) await admin.api('DELETE',`/users/${user.id}`);
  if(project) await admin.api('DELETE',`/projects/${project.id}`);
}
