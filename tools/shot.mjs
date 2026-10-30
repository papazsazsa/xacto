// Headless capture harness for XACTO.
// usage: node tools/shot.mjs <html file> <out dir> [scenario=full] [width=1280] [height=720] [seed=4242] [pixelRatio=1]
// Use pixelRatio 0.5 for fast iteration (SwiftShader is ~4s/frame at full res); final judging at 1.
// Scenarios: full | aim | flight | miss | modes | attract
// The game is driven deterministically through window.__X (test mode, fixed seed).
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const vendor = path.join(here, '..', 'vendor');

const [, , htmlArg, outArg, scenario = 'full', wArg = '1280', hArg = '720', seedArg = '4242', prArg = '1'] = process.argv;
const html = path.resolve(htmlArg || path.join(here, '..', 'dist', 'xacto.html'));
const out = path.resolve(outArg || path.join(here, '..', 'shots', 'latest'));
fs.mkdirSync(out, { recursive: true });
const W = +wArg, H = +hArg;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ path: path.join(vendor, 'three.module.js'), contentType: 'text/javascript' }));
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: `@font-face{font-family:'Press Start 2P';src:url(https://fonts.gstatic.com/ps2p.ttf)}@font-face{font-family:'VT323';src:url(https://fonts.gstatic.com/vt323.ttf)}` }));
await page.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ path: path.join(vendor, r.request().url().includes('ps2p') ? 'PressStart2P-Regular.ttf' : 'VT323-Regular.ttf'), contentType: 'font/ttf' }));
await page.goto('file://' + html + `?test=1&seed=${seedArg}&pr=${prArg}`);
await page.waitForFunction(() => window.__X, null, { timeout: 30000 }).catch(() => {});
const ok = await page.evaluate(() => !!window.__X);
if (!ok) { console.log('GAME FAILED TO BOOT'); console.log(errors.join('\n')); await browser.close(); process.exit(1); }
await page.evaluate(() => window.__X.fontsReady);
let n = 0;
const X = (fn, ...a) => page.evaluate(fn, ...a);
const adv = (s, draw = true) => X(([s, d]) => window.__X.advance(s, 1 / 60, d), [s, draw]);
async function snap(label) {
  const f = path.join(out, `${String(++n).padStart(2, '0')}_${label}.png`);
  const ts = Date.now(); await page.screenshot({ path: f, timeout: 180000 }); if (Date.now() - ts > 5000) console.log('  (slow screenshot ' + ((Date.now() - ts) / 1000).toFixed(1) + 's)');
  const st = await X(() => ({ s: window.__X.G.state, d: Math.round(window.__X.Target.S.dist) }));
  console.log(`${path.basename(f)}  state=${st.s} tgtDist=${st.d}`);
}
async function flyToEnd(maxSec = 25, shotsAt = [0.5, 0.45]) {
  let t = 0, taken = 0;
  while (t < maxSec) {
    await adv(0.25); t += 0.25;
    const st = await X(() => ({ s: window.__X.G.state, r: window.__X.G.tgtRange }));
    if (st.s !== 'flight') return st.s;
    for (let i = taken; i < shotsAt.length; i++) {
      // shotsAt: fraction of remaining range thresholds handled by caller
    }
  }
  return 'timeout';
}
const t0 = Date.now();
if (scenario === 'full' || scenario === 'attract') {
  await adv(2.0); await snap('attract');
  if (scenario === 'attract') { await adv(6); await snap('attract_b'); }
}
if (scenario !== 'attract') {
  await X(() => window.__X.start());
  await adv(1.4); await snap('brief');
  await adv(2.5, false);
  await X(() => { window.__X.aimAtTarget(0.012); window.__X.setMag(1); });
  await adv(0.3);
  if (scenario === 'full' || scenario === 'aim' || scenario === 'modes') await snap('aim_wide');
  await X(() => { window.__X.aimAtTarget(); window.__X.setMag(5); });
  await adv(0.6); await snap('aim_zoom');
  if (scenario === 'modes') {
    await X(() => window.__X.setMode(1)); await adv(0.1); await snap('aim_blackhot');
    await X(() => window.__X.setMode(2)); await adv(0.1); await snap('aim_nightvision');
    await X(() => window.__X.setMode(0));
  }
  if (scenario === 'full' || scenario === 'flight' || scenario === 'miss') {
    const miss = scenario === 'miss';
    await X((miss) => { window.__X.G.auto = !miss; if (miss) { window.__X.aimAtTarget(0.03); window.__X.advance(1 / 60, 1 / 60, false); } window.__X.fire(); }, miss);
    await adv(0.12); await snap('muzzle');
    await adv(0.3); await snap('flight_launch');
    // fly, capturing mid-flight and terminal approach
    let midDone = false, lateDone = false, t = 0, st;
    while (t < 30) {
      await adv(0.1, false); t += 0.1;
      st = await X(() => ({ s: window.__X.G.state, r: window.__X.G.tgtRange, d: window.__X.Target.S.dist }));
      if (st.s !== 'flight') break;
      if (!midDone && st.r < st.d * 0.55) { midDone = true; await adv(1 / 60); await snap('flight_mid'); }
      if (!lateDone && st.r < 45) { lateDone = true; await adv(1 / 60); await snap('flight_terminal'); }
    }
    console.log('flight ended in state', st && st.s, 'after', t.toFixed(1), 's');
    await adv(0.25); await snap('result_a');
    await adv(0.9, false); await adv(1 / 60); await snap('result_b');
    await adv(1.6, false); await adv(1 / 60); await snap('result_c');
    if (st && st.s === 'killcam') { await adv(3.0, false); await X(() => { if (window.__X.G.state === 'killcam') window.__X.setState('tally'); }); await adv(3.0, false); await adv(1 / 60); await snap('tally'); }
  }
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (errors.length) console.log('CONSOLE:\n' + [...new Set(errors)].slice(0, 30).join('\n'));
await browser.close();
