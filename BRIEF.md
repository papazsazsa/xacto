# XACTO – team brief (read fully before touching code)

## The product
A browser game, Three.js r170, one self-contained HTML page. 1980s-arcade sniper game seen through a
monochrome thermal / night-vision scope. City at night, player on a rooftop at the head of a long avenue.
You find the target (a man-shaped low-poly silhouette on a far rooftop), press SPACE, and the camera goes
into a chase cam just behind the round. The round is a DARPA EXACTO-style guided .50 bullet: you steer it,
but control is imperfect (actuator lag, limited authority that falls with speed, turbulence, roll-reference
error, wind gusts, a finite control budget). When the man is hit he gets launched like a cartoon ragdoll
and his hat flies off – fun, NO gore, no blood, ever. Every stage generates a new city (new seed) with
low-poly obstacles to thread: skybridges, antennas, water towers, cranes, billboards, an elevated rail line.
Art direction: low-poly like Atari Battlezone (1980) but with a bit more detail so it never feels cheap;
monochrome thermal palette (white-hot default, black-hot, green night vision), vector edge lines,
CRT phosphor, scanlines, arcade typography (Press Start 2P + VT323). Quality bar: AAA, utterly polished.
Must run fast in any modern browser (WebGL2), including laptops with integrated GPUs.

## Code layout (concatenated in name order into one `<script type="module">`; all modules share one scope)
- `src/00_core.js` – THREE import, math/RNG helpers, `U` shared uniforms, `GRID`, `PHYS`, `PLAYER`, `OU`, `Store`.
- `src/01_audio.js` – `Sfx` synthesized WebAudio.
- `src/02_materials.js` – thermal shader library. Scene materials output R=temperature, G=facet code, B=log depth
  (post uses G/B to draw vector edge lines). `thermalMat(fragSrc, extraUniforms)`, `FS_SOLID` etc.
- `src/03_city.js` – `City`: procedural city per seed, AABB collision grid, `raycast`, roofs, emitters, traffic.
- `src/04_fx.js` – `FX`: additive heat particles.
- `src/05_target.js` – `Target`: articulated man, idle/walk animations, spawn, hit test, Verlet ragdoll + hat.
- `src/06_bullet.js` – `Bullet`: ballistics + guidance, prediction, autopilot, visuals (round, trail, streaks).
- `src/07_post.js` – `Post`: sensor + CRT display pipeline (DDE, edges, noise, persistence, bloom, scope optics).
- `src/08_hud.js` – `Hud`: 2D canvas HUD composited in the display shader (red channel = bright ink, green = dark ink).
- `src/09_game.js` – renderer, input, cameras, state machine (attract → brief → aim → shot → flight → killcam/misscam → tally → …), scoring, main loop, `window.__X` test hooks.
- `src/template.html` – page shell (importmap pulls three@0.170.0 from jsDelivr; Google Fonts link).
Globals such as `G`, `camera`, `Aim`, `Target`, `City`, `Bullet` are visible to every module at runtime.

## Tools
- Build: `node tools/build.mjs <workdir>` → `<workdir>/dist/xacto.html`.
- Capture: `node tools/shot.mjs <html> <outdir> [scenario] [w] [h] [seed] [pixelRatio]`
  scenarios: `full` (attract, brief, aim wide/zoom, muzzle, flight launch/mid/terminal, result, tally), `aim`, `modes`, `flight`, `miss`, `attract`.
  Headless Chromium uses SwiftShader (software GL): ~4 s per frame at pixelRatio 1, ~1 s at 0.5. Iterate at 0.5, confirm at 1.
  Try more than one seed (e.g. 4242, 77, 9001) – every stage is a new city.
- Probe JS / console errors: `node tools/probe.mjs <html> "<js expression>"` (prints result + console errors).
- `window.__X` in test mode (`?test=1`): `advance(sec)`, `start()`, `aimAtTarget(leadRad)`, `setMag(i)`, `fire()`, `G.auto=true` (autopilot steering), `setMode(m)`, `setState(s)`, plus module objects. `__X` also exposes `City, Target, Bullet, Post, Hud, FX, Sfx, scene, renderer, camera, Aim, G`. To add test hooks, put them on your own module object (e.g. `Target.debug = {...}`) and call them as `window.__X.Target.debug...`.
- Look at your PNGs with the Read tool. Judge them like a ruthless art director.

## Rules
1. Work ONLY in your own work directory. Edit ONLY the files you own (listed in your mission). If you need a change in a file you do not own, write the exact request in `<workdir>/REQUESTS.md` – the lead integrates it.
2. Keep public interfaces used by other modules working (names, signatures, return shapes). Additive changes are fine.
3. No external assets, no new network dependencies. Everything procedural. Keep it fast: avoid per-frame allocations in hot paths, keep draw calls and instance counts sane, no heavy full-screen effects at full resolution beyond what exists.
4. No gore. No real brand names or real organisations' logos/branding in the game.
5. Zero console errors. Build and capture after every meaningful change; never hand back something you have not looked at.
6. When done, write `<workdir>/CHANGES.md`: what you changed, why, and which screenshots prove it. Keep it short and plain.
