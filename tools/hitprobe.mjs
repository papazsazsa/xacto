// Headless difficulty probe: plays many shots per stage with scripted controllers and prints hit rates.
// usage: node tools/hitprobe.mjs <html> [shotsPerStage=24] [stages=1-8] [bots=none,novice,skilled,auto] [seed=4242]
// Controllers only see what the player sees (target box + pipper on screen), react in real time with a
// reaction delay, a proportional gain, a stick slew limit and motor noise.
import { createRequire } from 'module'; import path from 'path';
const require = createRequire('/opt/npm-tools/node_modules/'); const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname); const vendor = path.join(here, '..', 'vendor');
const [, , htmlArg, nArg = '24', stArg = '1-8', botArg = 'none,novice,skilled,auto', seedArg = '4242'] = process.argv;
const html = path.resolve(htmlArg);
const [s0, s1] = stArg.split('-').map(Number);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = []; page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ path: path.join(vendor, 'three.module.js'), contentType: 'text/javascript' }));
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
await page.goto('file://' + html + `?test=1&seed=${seedArg}&pr=0.25`); await page.waitForFunction(() => window.__X, null, { timeout: 30000 });
const t0 = Date.now();
const res = await page.evaluate(({ n, s0, s1, bots }) => {
  const X = window.__X, G = X.G;
  let rs = 12345; const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(6.2831853 * rnd());
  // Human-like controllers: they know the route around the cover (the planned curve the autopilot uses), but act
  // through a reaction delay, motor noise and a limited stick speed. The novice only reacts once the man runs.
  const PROF = {
    none: null,
    novice: { delay: 0.30, noise: 0.16, slew: 5, aimSd: 0.0011, reactive: true, look: 75 },
    skilled: { delay: 0.18, noise: 0.08, slew: 9, aimSd: 0.0007, reactive: false, look: 65 },
  };
  function makeBot(p) {
    let t = 0; const buf = []; let nx = 0, ny = 0; const want = new (X.G.stick.constructor)(), raw = new (X.G.stick.constructor)();
    return (G, rdt) => {
      t += rdt;
      // a human tracks the route loosely (long look-ahead, lower gain), which keeps a delayed loop stable
      if (p.reactive && !G.coverBlocked) X.Bullet.autopilot(X.Target.chest, want, 0.6, G.tgtVel); else X.routeStick(want, 0.6, p.look);
      buf.push({ t, x: want.x, y: want.y });
      while (buf.length > 2 && buf[1].t <= t - p.delay) buf.shift();
      const o = buf[0];
      const a = Math.exp(-rdt / 0.3), sg = p.noise * Math.sqrt(1 - a * a);
      nx = nx * a + sg * gauss(); ny = ny * a + sg * gauss();
      const tx = (o.t <= t - p.delay + 1e-6 ? o.x : 0) + nx, ty = (o.t <= t - p.delay + 1e-6 ? o.y : 0) + ny, m = p.slew * rdt;
      G.stick.x += Math.max(-m, Math.min(m, tx - G.stick.x)); G.stick.y += Math.max(-m, Math.min(m, ty - G.stick.y));
      if (G.stick.length() > 1) G.stick.normalize();
    };
  }
  const out = {};
  for (const bn of bots) {
    out[bn] = [];
    for (let st = s0; st <= s1; st++) {
      let hits = 0, struct = 0, lost = 0, md = 0, ctrl = 0, real = 0, nanBad = 0, ranges = 0;
      for (let i = 0; i < n; i++) {
        X.startAt(st);
        const p = PROF[bn] || { aimSd: 0.0007 };
        X.sim(0.5 + rnd() * 2);
        X.aimAtTarget(gauss() * p.aimSd); X.Aim.pitch += gauss() * p.aimSd * 0.7; X.setMag(5);
        X.sim(0.05);
        G.auto = bn === 'auto'; X.bot = PROF[bn] ? makeBot(PROF[bn]) : null;
        ranges += X.Target.S.dist;
        X.fire();
        let tt = 0;
        while ((G.state === 'shot' || G.state === 'flight') && tt < 90) { X.sim(1 / 60); tt += 1 / 60; if (!isFinite(X.Bullet.S.p.x)) { nanBad++; break; } }
        real += tt;
        if (G.state === 'killcam') hits++;
        else if (G.lastEv === 'impact') struct++; else lost++;
        md += Math.min(50, X.Bullet.S.minDist); ctrl += X.Bullet.S.budget / X.Bullet.S.budget0;
        G.auto = false; X.bot = null;
      }
      out[bn].push({ stage: st, hit: +(hits / n).toFixed(2), struct: +(struct / n).toFixed(2), lost: +(lost / n).toFixed(2), meanMinDist: +(md / n).toFixed(2), ctrlLeft: +(ctrl / n).toFixed(2), realSec: +(real / n).toFixed(1), range: Math.round(ranges / n), nan: nanBad });
    }
  }
  return out;
}, { n: +nArg, s0, s1, bots: botArg.split(',') });
for (const [bn, rows] of Object.entries(res)) {
  console.log(`\n== ${bn} ==\nstage  range  hit   struct lost  minDist ctrlLeft realSec`);
  for (const r of rows) console.log(`${String(r.stage).padStart(5)} ${String(r.range).padStart(6)}  ${r.hit.toFixed(2)}  ${r.struct.toFixed(2)}   ${r.lost.toFixed(2)}  ${String(r.meanMinDist).padStart(6)}  ${r.ctrlLeft.toFixed(2)}     ${r.realSec}${r.nan ? '  NaN!' : ''}`);
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s`); if (errors.length) console.log([...new Set(errors)].slice(0, 10).join('\n'));
await browser.close();
