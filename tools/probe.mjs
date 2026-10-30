import { createRequire } from 'module'; import path from 'path';
const require = createRequire('/opt/npm-tools/node_modules/'); const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname); const vendor = path.join(here, '..', 'vendor');
const html = path.resolve(process.argv[2]); const code = process.argv[3] || '';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = []; page.on('console', (m) => errors.push(`[${m.type()}] ${m.text().slice(0, 1500)}`)); page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ path: path.join(vendor, 'three.module.js'), contentType: 'text/javascript' }));
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
await page.goto('file://' + html + `?test=1&seed=${process.env.SEED || 4242}${process.env.STEER ? '&steer=' + process.env.STEER : ''}`); await page.waitForFunction(() => window.__X, null, { timeout: 30000 }).catch(() => {});
if (code) { const r = await page.evaluate(code).catch((e) => 'EVAL ERROR ' + e.message); console.log('RESULT:', typeof r === 'string' ? r : JSON.stringify(r, null, 1)); }
console.log([...new Set(errors)].slice(0, 20).join('\n')); await browser.close();
