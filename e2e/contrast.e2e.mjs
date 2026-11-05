// Runtime contrast checks for editable controls in both themes; no screenshots or fixture values logged.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { login, BASE } from './lib.mjs';
const auth=await login();
const browser=await chromium.launch();
try {
  const context=await browser.newContext({colorScheme:'light'});
  await context.addCookies(auth.cookies.map(c=>({...c,url:BASE})));
  const page=await context.newPage();
  await page.goto(BASE+'/account');
  await page.getByLabel('Current password',{exact:true}).waitFor();
  for(const theme of ['light','dark']) {
    await page.getByRole('button',{name:/Theme:/}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
    const results=await page.locator('input:not([type=checkbox]):not([type=range]),select,textarea').evaluateAll(els=>{
      function luminance(rgb) {
        const v=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4);
        return v[0]*0.2126+v[1]*0.7152+v[2]*0.0722;
      }
      function ratio(a,b) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); }
      return els.filter(el=>el.getClientRects().length && !el.disabled).map(el=>{
        const css=getComputedStyle(el);
        return {border:ratio(css.borderTopColor,css.backgroundColor),text:ratio(css.color,css.backgroundColor)};
      });
    });
    assert(results.length>=3);
    assert(results.every(r=>r.border>=3 && r.text>=4.5),`${theme} editable control contrast fails`);
    console.log(JSON.stringify({theme,controls:results.length,minBorder:+Math.min(...results.map(r=>r.border)).toFixed(2),minText:+Math.min(...results.map(r=>r.text)).toFixed(2)}));
  }
  console.log('PASS editable-control boundaries and text contrast in light and dark themes.');
} finally { await browser.close(); }
