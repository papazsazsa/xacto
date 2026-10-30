// Free-camera screenshots of the city.
// usage: node tools/camshot.mjs <html> <outdir> <seed> <pr> <views.json | inline JSON>
// views: [{ "name": "x", "pos": [x,y,z], "look": [x,y,z], "fov": 40, "mode": 0 }, ...]
// Puts the game into an unknown state ('probe') so no camera controller runs.
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path';
const require = createRequire('/opt/npm-tools/node_modules/'); const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname); const vendor = path.join(here, '..', 'vendor');
const [, , htmlArg, outArg, seed = '4242', pr = '0.5', viewsArg = '[]', W = '1280', H = '720'] = process.argv;
const views = JSON.parse(fs.existsSync(viewsArg) ? fs.readFileSync(viewsArg, 'utf8') : viewsArg);
fs.mkdirSync(outArg, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +W, height: +H } });
const errors = []; page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 800)}`); }); page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ path: path.join(vendor, 'three.module.js'), contentType: 'text/javascript' }));
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
await page.goto('file://' + path.resolve(htmlArg) + `?test=1&seed=${seed}&pr=${pr}`);
await page.waitForFunction(() => window.__X, null, { timeout: 30000 }).catch(() => {});
const info = await page.evaluate((s) => { const X = window.__X; const t0 = performance.now(); const inf = X.City.generate(+s); const ms = performance.now() - t0; X.G.state = 'probe'; X.Hud.draw && 0; return { ms: Math.round(ms), info: JSON.parse(JSON.stringify(inf)) }; }, seed);
console.log('gen', JSON.stringify(info));
for (const v of views) {
  await page.evaluate((v) => {
    const X = window.__X; X.G.state = 'probe'; X.G.staticAmt = 0; X.setMode(v.mode || 0);
    const c = X.camera; c.position.set(...v.pos); c.up.set(0, 1, 0); c.lookAt(...v.look); c.fov = v.fov || 40; c.near = 0.3; c.far = 7000; c.updateProjectionMatrix();
    X.advance(0.05); X.advance(0.05);
  }, v);
  const t0 = Date.now();
  await page.screenshot({ path: path.join(outArg, v.name + '.png') });
  console.log(v.name, ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
if (errors.length) console.log('CONSOLE:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
await browser.close();
