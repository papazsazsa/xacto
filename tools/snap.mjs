// One-off screenshots after running setup code against window.__X.
// usage: node tools/snap.mjs <html> <outPrefix> "<setup js, may return a list of [name, js] steps>" [W=1280] [H=720] [query]
// Each step's js runs, then the page is captured to <outPrefix>_<name>.png.
import { createRequire } from 'module'; import path from 'path';
const require = createRequire('/opt/npm-tools/node_modules/'); const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname), vendor = path.join(here, '..', 'vendor');
const [, , htmlArg, outArg, setup = '[]', wA = '1280', hA = '720', q = ''] = process.argv;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +wA, height: +hA }, deviceScaleFactor: +(process.env.DSF || 1), hasTouch: !!process.env.MOBILE, isMobile: !!process.env.MOBILE });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ path: path.join(vendor, 'three.module.js'), contentType: 'text/javascript' }));
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: `@font-face{font-family:'Press Start 2P';src:url(https://fonts.gstatic.com/ps2p.ttf)}@font-face{font-family:'VT323';src:url(https://fonts.gstatic.com/vt323.ttf)}` }));
await page.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ path: path.join(vendor, r.request().url().includes('ps2p') ? 'PressStart2P-Regular.ttf' : 'VT323-Regular.ttf'), contentType: 'font/ttf' }));
await page.goto('file://' + path.resolve(htmlArg) + `?test=1&seed=${process.env.SEED || 4242}&pr=${process.env.PR || 0.75}${q ? '&' + q : ''}`);
await page.waitForFunction(() => window.__X, null, { timeout: 30000 }); await page.evaluate(() => window.__X.fontsReady);
const steps = await page.evaluate(setup);
for (const [name, js] of steps || []) {
  const r = await page.evaluate(js).catch((e) => 'ERR ' + e.message);
  await page.screenshot({ path: `${outArg}_${name}.png` });
  console.log(name, typeof r === 'string' ? r : JSON.stringify(r));
}
console.log(errors.slice(0, 8).join('\n')); await browser.close();
