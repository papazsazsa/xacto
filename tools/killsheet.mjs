// Kill-camera contact sheet: node tools/killsheet.mjs <html> <out.png> [seed] [pr] [stage]
import { createRequire } from 'module'; import path from 'path'; import fs from 'fs'; import { execFileSync } from 'child_process';
const require = createRequire('/opt/npm-tools/node_modules/'); const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname); const vendor = path.join(here, '..', 'vendor');
const [, , htmlArg, outArg, seed = '4242', pr = '0.5', stage = '1'] = process.argv;
const tmp = fs.mkdtempSync('/tmp/claude-0/-home-claude/d16ee47e-34b8-5b25-ba71-56f2bce40f27/scratchpad/ks');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ path: path.join(vendor, 'three.module.js'), contentType: 'text/javascript' }));
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: `@font-face{font-family:'Press Start 2P';src:url(https://fonts.gstatic.com/ps2p.ttf)}@font-face{font-family:'VT323';src:url(https://fonts.gstatic.com/vt323.ttf)}` }));
await page.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ path: path.join(vendor, r.request().url().includes('ps2p') ? 'PressStart2P-Regular.ttf' : 'VT323-Regular.ttf'), contentType: 'font/ttf' }));
await page.goto('file://' + path.resolve(htmlArg) + `?test=1&seed=${seed}&pr=${pr}`);
await page.waitForFunction(() => window.__X); await page.evaluate(() => window.__X.fontsReady);
const st = await page.evaluate((stage) => { const X = window.__X; X.start(); X.advance(3.6, 1 / 60, false); X.aimAtTarget(); X.advance(0.3, 1 / 60, false); X.G.auto = true; X.fire();
  for (let i = 0; i < 400 && (X.G.state === 'flight' || X.G.state === 'shot'); i++) X.advance(0.05, 1 / 60, false); return X.G.state; }, +stage);
console.log('after flight:', st);
const files = [];
for (let i = 0; i < 16; i++) { await page.evaluate(() => { window.__X.advance(0.3, 1 / 60, false); window.__X.advance(1 / 60); }); const f = path.join(tmp, `k${String(i).padStart(2, '0')}.png`); await page.screenshot({ path: f, timeout: 180000 }); files.push(f); }
await browser.close();
execFileSync('python3', ['-c', `import sys\nfrom PIL import Image\nfs=sys.argv[2:]\nims=[Image.open(f).resize((480,270)) for f in fs]\nW=Image.new('RGB',(480*4,270*4))\nfor i,im in enumerate(ims): W.paste(im,((i%4)*480,(i//4)*270))\nW.save(sys.argv[1])`, outArg, ...files]);
console.log('wrote', outArg);
