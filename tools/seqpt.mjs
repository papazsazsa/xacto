// Frame sequence of one stage-N shot in pointing-steer mode (a bot drags the marker past the open side of his cover) at a fixed real-time step, for motion review / clips.
// usage: node tools/seq.mjs <html> <outDir> [seed=4242] [stage=1] [fps=12] [pr=0.5] [W=960] [H=540]
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path';
const require = createRequire('/opt/npm-tools/node_modules/'); const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname), vendor = path.join(here, '..', 'vendor');
const [, , htmlArg, outArg, seed = '4242', stage = '1', fpsArg = '12', pr = '0.5', wA = '960', hA = '540'] = process.argv;
const out = path.resolve(outArg); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +wA, height: +hA }, deviceScaleFactor: 1 });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ path: path.join(vendor, 'three.module.js'), contentType: 'text/javascript' }));
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: `@font-face{font-family:'Press Start 2P';src:url(https://fonts.gstatic.com/ps2p.ttf)}@font-face{font-family:'VT323';src:url(https://fonts.gstatic.com/vt323.ttf)}` }));
await page.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ path: path.join(vendor, r.request().url().includes('ps2p') ? 'PressStart2P-Regular.ttf' : 'VT323-Regular.ttf'), contentType: 'font/ttf' }));
await page.goto('file://' + path.resolve(htmlArg) + `?test=1&seed=${seed}&pr=${pr}&steer=point`); await page.waitForFunction(() => window.__X, null, { timeout: 30000 });
await page.evaluate(() => window.__X.fontsReady);
const fps = +fpsArg, step = 1 / fps;
await page.evaluate((st) => { const X = window.__X; X.startAt(st); X.sim(1.2); X.aimAtTarget(0); X.setMag(5); X.sim(0.1);
  const G = X.G, B = X.Bullet.S, T = X.Target; let t0 = 0, placed = false; const wp = B.p.clone(), los = B.p.clone(), rgt = B.p.clone(), tmp = B.p.clone();
  X.bot = (G, rdt) => {
    t0 += rdt; const app = T.S.app; if (placed || !app || t0 < 0.6) return; placed = true;
    los.subVectors(T.chest, B.p); los.y = 0; los.normalize(); rgt.set(-los.z, 0, los.x);
    const s = Math.sign(app.dir.dot(rgt)) || 1, b = app.box; let ext = 0;
    for (const x of [b[0], b[3]]) for (const z of [b[2], b[5]]) { tmp.set(x - T.chest.x, 0, z - T.chest.z); ext = Math.max(ext, s * tmp.dot(rgt)); }
    wp.copy(T.chest).addScaledVector(rgt, s * (ext + 4)); X.setAim(wp, false);
  }; }, +stage);
// a second of scope before the shot
let n = 0; const snap = async () => { await page.screenshot({ path: path.join(out, `f${String(n++).padStart(4, '0')}.png`) }); };
for (let i = 0; i < fps * 0.6; i++) { await page.evaluate((s) => window.__X.advance(s, 1 / 60, true), step); await snap(); }
await page.evaluate(() => window.__X.fire());
for (let i = 0; i < fps * 16; i++) {
  await page.evaluate((s) => window.__X.advance(s, 1 / 60, true), step); await snap();
  const st = await page.evaluate(() => window.__X.G.state);
  if (st === 'tally' || st === 'aim' || st === 'gameover') break;
}
console.log('frames', n, errors.join('\n')); await browser.close();
