import { readdir, readFile, writeFile, rename, rm, stat, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const rrdir = dirname(require.resolve('@rrweb/replay'));
const script = await readFile(join(rrdir, 'replay.umd.min.cjs'), 'utf8');
const css = await readFile(join(rrdir, 'style.css'), 'utf8');
const root = process.env.RENDER_DIR || '/renders';
const active = new Set();
const TTL = 86_400_000;
const FPS = 10;
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function status(dir, state, progress, finished_at = null) {
  await access(join(dir, 'job.json')); // deletion must never resurrect a job
  await writeFile(join(dir, 'status.tmp'), JSON.stringify({ state, progress, finished_at, updated_at: Date.now() }));
  await rename(join(dir, 'status.tmp'), join(dir, 'status.json'));
}
async function* events(path) {
  let data = Buffer.alloc(0), header = false;
  const seen = new Set();
  for await (const part of createReadStream(path, { highWaterMark: 65536 })) {
    data = Buffer.concat([data, part]);
    if (!header) {
      if (data.length < 22) continue;
      if (data.subarray(0,4).toString() !== 'RPL2' || data.readUInt16LE(4) !== 1) throw Error('Invalid recording');
      data = data.subarray(22); header = true;
    }
    while (data.length >= 29) {
      const len = data.readUInt32LE(0);
      if (len > 4*1024*1024) throw Error('Frame limit');
      if (data.length < len+29) break;
      const seq = data.readUInt32LE(4), end = Number(data.readBigUInt64LE(16));
      const body = data.subarray(29, len+29); data = data.subarray(len+29);
      if (seen.has(seq)) continue;
      if (seen.size >= 100000) throw Error('Frame count limit');
      seen.add(seq);
      const n = body.readUInt32LE(0);
      if (n > body.length-6) throw Error('Truncated frame');
      const decoded = JSON.parse(gunzipSync(body.subarray(4, n+4), { maxOutputLength: 64*1024*1024 }).toString());
      if (!Array.isArray(decoded)) throw Error('Invalid events');
      yield { events: decoded, end };
    }
  }
}
async function render(dir, job) {
  let browser, encoder;
  try {
    await status(dir, 'rendering', 0);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    // Defense in depth: no network is available in Compose, and recorded documents
    // use rrweb's script-disabled sandbox. No tokens or service credentials enter Chromium.
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><head></head><body style="margin:0;background:#000;overflow:hidden"><div id="replay"></div></body></html>');
    await page.addStyleTag({ content: css + '.replayer-wrapper{position:absolute!important}.replayer-mouse-tail{display:none}' });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => { window.recordedEvents = []; });
    let end = job.covered_until, count = 0;
    for await (const frame of events(join(dir, 'input.rpl'))) {
      end = Math.max(end, frame.end);
      count += frame.events.length;
      if (count > 2_000_000) throw Error('Event count limit');
      await page.evaluate(items => { for (const e of items) window.recordedEvents.push(e); }, frame.events);
    }
    const meta = await page.evaluate(() => {
      window.recordedEvents.sort((a,b) => a.timestamp-b.timestamp);
      const m = window.recordedEvents.find(e=>e.type===4)?.data;
      if (!m || !window.recordedEvents.some(e=>e.type===2)) throw Error('Snapshot missing');
      return { width: m.width, height: m.height, start: window.recordedEvents[0].timestamp };
    });
    if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width < 1 || meta.height < 1 || meta.width > 8192 || meta.height > 8192) throw Error('Viewport limit');
    await page.setViewportSize({ width: meta.width, height: meta.height });
    await page.evaluate(({ width, height }) => {
      const player = window.player = new window.rrwebReplay.Replayer(window.recordedEvents, {
        root: document.querySelector('#replay'), skipInactive: false, speed: 1,
        mouseTail: false, triggerFocus: false, showWarning: false, showDebug: false,
        UNSAFE_replayCanvas: false,
      });
      const fit = () => {
        const w = Number(player.iframe.width), h = Number(player.iframe.height);
        const scale = Math.min(width/w,height/h);
        Object.assign(player.wrapper.style,{transform:`scale(${scale})`,transformOrigin:'top left',left:`${(width-w*scale)/2}px`,top:`${(height-h*scale)/2}px`});
      };
      player.on('resize',fit); player.on('fullsnapshot-rebuilded',fit); player.pause(0); fit();
    }, meta);
    const seconds = Math.max(0.1, (end-meta.start)/1000);
    if (seconds > 3660) throw Error('Session duration limit');
    const total = Math.ceil(seconds*FPS);
    encoder = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate',String(FPS),'-vcodec','mjpeg','-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-movflags','+faststart','-fs',String(2*1024**3),join(dir,'pending.mp4')], { stdio: ['pipe','ignore','ignore'] });
    const completion = once(encoder, 'close');
    encoder.stdin.on('error', () => {});
    await page.evaluate(() => window.player.play(0));
    const started = performance.now();
    let written = 0;
    while (written < total) {
      await access(join(dir,'job.json'));
      const image = await page.screenshot({ type:'jpeg', quality:90, animations:'allow' });
      const due = Math.min(total, Math.max(written+1, Math.floor((performance.now()-started)/1000*FPS)+1));
      while (written < due) {
        if (encoder.exitCode !== null || encoder.stdin.destroyed) throw Error('Encoder stopped');
        if (!encoder.stdin.write(image)) await once(encoder.stdin,'drain');
        written++;
      }
      await status(dir,'rendering',Math.min(99,Math.floor(written/total*100)));
      await delay(Math.max(0,written/FPS*1000-(performance.now()-started)));
    }
    encoder.stdin.end();
    const [code] = await completion;
    if (code !== 0 || (await stat(join(dir,'pending.mp4'))).size >= 2*1024**3) throw Error('Encoder failed');
    await access(join(dir,'job.json'));
    await rename(join(dir,'pending.mp4'),join(dir,'output.mp4'));
    await rm(join(dir,'input.rpl'),{force:true});
    await status(dir,'ready',100,Date.now());
  } catch {
    await rm(join(dir,'pending.mp4'),{force:true}).catch(()=>{});
    await rm(join(dir,'input.rpl'),{force:true}).catch(()=>{});
    // Publish retryability only after cleanup, so a retry's snapshot cannot be removed.
    await status(dir,'failed',0,Date.now()).catch(()=>{});
  } finally {
    encoder?.kill('SIGKILL');
    await browser?.close().catch(()=>{});
    active.delete(job.sid);
  }
}
// Restarted workers never mistake interrupted files for finished videos.
for (const sid of await readdir(root)) {
  if (!/^[a-f0-9-]{36}$/.test(sid)) continue;
  const dir = join(root,sid), p = await json(join(dir,'status.json'));
  if (p?.state === 'rendering') await status(dir,'failed',0,Date.now()).catch(()=>{});
}
for (;;) {
  const waiting = [];
  for (const sid of (await readdir(root)).slice(0,512)) {
    if (!/^[a-f0-9-]{36}$/.test(sid) || active.has(sid)) continue;
    const dir=join(root,sid), job=await json(join(dir,'job.json')), p=await json(join(dir,'status.json'));
    if (!job) continue;
    if (Date.now()-(p?.finished_at ?? job.created_at)>=TTL) { await rm(dir,{recursive:true,force:true}); continue; }
    if (!p || p.state==='queued') waiting.push({dir,job});
  }
  waiting.sort((a,b)=>a.job.created_at-b.job.created_at);
  for (const {dir,job} of waiting.slice(0,Math.max(0,2-active.size))) {
    active.add(job.sid); void render(dir,job);
  }
  await delay(1000);
}
