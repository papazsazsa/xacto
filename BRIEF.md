# XACTO – design and code brief

Read this before changing game code. `CLAUDE.md` has the working rules (build, push, one link). `README.md` is the player-facing summary.

## The game

XACTO ("DARPA GAMES") is a 1987-style arcade sniper game in one self-contained HTML page (Three.js r170, WebGL2). You look through a monochrome thermal scope from a rooftop at the head of a long avenue in a procedural night city. You fire a DARPA EXACTO-style guided .50 round, and the camera rides behind it while you steer it around buildings into tight spots. Steering is imperfect by design: actuator lag, limited fin authority, turbulence, wind and a finite steering budget. A hit launches the man like a cartoon ragdoll and his hat flies off. There is no gore, ever. Machines blow apart into bouncing pieces.

The look is low-poly vector art (Battlezone 1980, with more detail) in a thermal palette (white-hot, black-hot, green NV), with CRT effects and arcade type (Press Start 2P and VT323). It must run well on laptops with integrated graphics and on phones. The page detects phones and tablets and switches to touch controls and a lower pixel ratio (`MOBILE` in `src/00_core.js`).

The core idea is a round that can get into tight spots. Difficulty comes from where the target is. The round's handling stays the same.

## Stage schedule

1. **Stage 1.** A man in the open on a roof, right where the scope starts. Easy.
2. **Stage 2.** A technical (a pickup with a mounted machine gun) cruising laps of the main avenue. A straight shot if you lead it.
3. **Stage 3.** A hidden man from the bag (see below).
4. **Stage 4.** A man way up on the top deck of one of the tallest towers in view (`tower` spot).
5. **Stages 5, 15, 25.** Fire mission: a reward round (see below).
6. **Stages 10, 20, 30.** The helicopter (see below).
7. **Stage 30 is the last.** Bring the helicopter down to get YOU SAVED THE CITY!, a fanfare and a new game. If it escapes on stage 30, it is game over.
8. **Every other stage** draws a man from a shuffled bag with no spot type twice in a row:
   1. `roof` – a lower roof behind taller buildings, open sky above.
   2. `tower` – the top deck of one of the tallest towers (75 m and up, tallest first).
   3. `ledge` – a setback terrace high on a tower, with its upper floors rising beside him.
   4. `street` – a sidewalk down in a street canyon.
   5. `awning` – a sidewalk under a deep awning: no way in from above, so the round must come in level along the street.
9. **Machines.** A quadcopter and a parked technical each turn up about once every 6 to 8 stages, at least 3 stages apart. Both are hot all over, blow apart when hit and move once alerted.
   1. **Quadcopter sites:** low over a street, high in a street canyon, over a rooftop, or tucked in beside a tall tower. It drifts before the shot and bobs and sways faster once alerted (bot hit rate about 65% per shot).
   2. **Technical:** parked 1 m off the kerb. Once alerted it laps its block.

Every hidden spot needs a **gate**: open air on the shooter's side that a straight flight from the rifle can reach. A route planner (`planHidden`, a 2 m voxel A* in `09_game.js`) finds the way from the gate to the target.

## Difficulty

Stages 1 to 7 hold the round's handling roughly fixed, and the existing `difficulty(stage)` curve tops out around stage 8 to 10. From stage 8 a "pressure" value rises linearly to 1 at stage 20 (`pressure()` in `05_target.js` and `spawnChecked()` in `09_game.js`). It changes only the spots:

1. **Longer shots.** Both the near and far ends of the distance band move out, and very long shots come up more often (up to about 1,300 m).
2. **Tighter spot mix.** The bag adds extra ledges and awnings and drops towers late on.
3. **Deeper, lower awnings** and **narrower ledges** (terrace width 4.0 m early, 2.9 m at stage 20).
4. **Walled-in spots.** Roof and street spots must have walls within 25 m in up to 7 of 12 directions.
5. **Flight check** (`routeFlyable(slack)` in `09_game.js`). A point-mass round flies the planned route with the stage's fin authority and steering budget, scaled by `slack`. A spot whose route can't be flown is replaced. Early stages demand a margin (slack 0.65). By stage 20 the route may need everything (slack 1.0), and routes flyable with less than 60% are passed over as too easy. This also stops impossible spots, the "wall of buildings" problem.

Measured with the human-like bot (tools/bots/stages.js, 3 seeds × 10 shots), the hit rate per shot is about 57% at stage 8, 20% at 12, 23% at 16 and 7% at 19.

## The helicopter (stages 10, 20, 30)

1. **On the pad.** It sits on a tower's helipad in view. With none in view it gets a pad painted on a clear stretch of a big tall roof, and failing that a raised helideck built on a roof over whatever plant is up there, so a helicopter stage always has its helicopter. The rotor turns slowly.
2. **Off at the first shot.** It lifts off the moment you fire, drops into the street canyons and runs through the city on the street grid. It turns at the crossings (mostly away from you, off the main avenue, never revisiting a crossing) and hops over anything across the street.
3. **Path following.** It chases a "carrot" point 22 m ahead on the street centre lines, turns no faster than 1 rad/s and slows for corners. The round can always out-turn it, so the two never circle each other.
4. **Speed.** Top speed is about 27, 31 and 35 m/s on stages 10, 20 and 30.
5. **Lock and catch-up.** Terminal lock on it has twice the usual reach and a wider cone, and the round has a proximity fuze against it (a burst within 1.5 m counts). Once locked, the round aims where the helicopter will be (time to go from the closing speed) and holds the lock while it can see it. Close in, the round keeps to at least 1.5 times the target's speed plus 12 m/s (`settleSpeed` in `06_bullet.js`). With a bot that steers straight at the helicopter once it can see it, about 80% of shots hit, and every shot that got the lock hit.
6. **Escape.** Once it is 1,900 m out it has escaped: TARGET ESCAPED, no bonus, on to the next stage (game over on stage 30).

## Terminal lock

Close to the target, with an open line to it and the round pointed roughly at it, the round's seeker takes over (`TERMINAL LOCK`) and steers itself in with extra fin authority.

1. **Reach and cone.** They shrink with the stage. Moving targets get a little more, the helicopter twice the reach, touch 2.2 times the reach.
2. **Lead.** It aims where the target will be when the round arrives, using time to go from the closing speed. A drone's bob and sway are predicted exactly (`Target.predict`); leading a drone along its present velocity overshot every turn of the bob and looped the round round it.
3. **Hands off.** While the lock holds, drags and taps are ignored and the marker sits on the target, so a hand on the controls can't pull the round off.
4. **Hold and release.** The lock holds while the round can see the target. If the round has gone past (the target more than 80° off its nose), the lock lets go and stays off for a second, so the round never circles back in a loop.

## Suggested path (a stage's last two rounds)

When the magazine is down to its last two rounds (the 4th and 5th shot at the same target), a line of red dots shows the planned route. The dots run from the rifle out to the gate and on in to the target, or straight at a target in the open. Each dot is drawn at the perspective size of a ball 0.5 m across, so it shrinks with distance (scope magnification included), between a small speck and a cap of 2.75 HUD units. They are drawn in the scope and in flight, and in flight only the dots still ahead of the round show. The route is re-planned when each of those rounds comes up, every 2.5 s while a machine is on the move, and at the shot for a machine (`GUIDE`, `guideBuild()` and `guideUpdate()` in `09_game.js`; `guideDots()` in `08_hud.js`). A kill refills the magazine, so the dots only appear after misses.

## Touch assists (phones and tablets)

A finger cannot make the fine last-moment corrections a mouse can, so on touch:

1. The terminal lock reaches 2.2 times as far and its cone is 20° wider.
2. The last 90 m of the flight run up to a third slower, giving more time to react as the round goes round the target.
3. The marker snaps onto the target from 2.5 times as far, and a tap on the target locks it.
4. The marker moves less per finger travel as the round closes in.
5. Men only ever stand on roofs: a lower roof behind taller buildings, or a tower top (`roofsOnly()` in `05_target.js`, true when `MOBILE` or after the first touch). No street, awning or ledge spots. Machines, the helicopter and fire missions are the same as on desktop.

With a bot that plays coarser and slower than the desktop bot (about touch quality), stages 3 to 7 hit about 80% on both.

## Fire mission (stages 5, 15, 25)

This is a reward round with no skill test. Tap or click three targets to lock them, then HANG IT... (2 s, blinking), then FIRE!. The camera rides the mortar bomb up its arc. At the apex it splits into three cones that dive onto the targets (and follow them if they move). The sight is an M3 binocular reticle with an aiming ring.

Five set-ups come in a shuffled rotation. `?mission=<name>` in the link forces one:

1. `checkpoint` – three technicals parked at a checkpoint on the main avenue.
2. `convoy` – a column of three technicals lapping the main avenue.
3. `nest` – three quadcopters hovering over a rooftop.
4. `motorpool` – three technicals in a side street, out of sight behind buildings (indirect fire).
5. `garage` – three technicals on a parking structure's roof deck (only when one is in range).

Everything for it is in `src/08_mortar.js`. Set `FIRE_MISSION = false` in `src/00_core.js` to switch it off.

## Scoring rows (tally panel "DOPE")

The rows are RANGE, the hit quality (CENTER MASS, HAT TRICK, TECHNICAL DESTROYED, DRONE DOWN, HELICOPTER DOWN), CONTROL RESERVE, CURVE SHOT, the spot bonus and the extras.

1. **Spot bonus:** BLIND SHOT, UNDER COVER, ON THE LEDGE, ON THE PAD or AIRBORNE.
2. **Extras:** RICOCHET KILL ×N, HIGH RISE (75 m and up), ALERTED TARGET, MOVING TARGET, STAGE BONUS.

## Links and test shortcuts

1. **Play:** https://papazsazsa.github.io/xacto/
2. **Start at a stage:** `?stage=N`, for example `?stage=4` for the tower, `?stage=10` for the helicopter, `?stage=30` for the final.
3. **Force a fire mission set-up:** `?stage=5&mission=convoy`.
4. **Other:** `?touch` forces the touch layout. `?test=1&seed=N` is deterministic test mode, with the hooks below.

## Code layout

The modules in `src/` are concatenated in name order into one `<script type="module">` (filter `^\d\d_.*\.js$`) and share one scope.

1. `00_core.js` – THREE import, math and RNG helpers, `QS` query string, flags (`FIRE_MISSION`, `FINAL_STAGE`, `MOBILE`, `STEER_MODE`), shared uniforms `U`, `GRID`, `PHYS`, `PLAYER`.
2. `01_audio.js` – `Sfx`: all sound synthesised with WebAudio (chiptune jingles including the `victory()` fanfare, the rifle, the round in flight, the mortar).
3. `02_materials.js` – thermal shader library (R = temperature, G = facet code, B = log depth for vector edges).
4. `03_city.js` – `City`: procedural city per seed, AABB collision grid and `raycast`, `roofs` (with `heli` helipads and `garage` decks), `ledges` (tower setback terraces), tree-lined streets, skybridges, rail and traffic.
5. `04_fx.js` – `FX`: heat particles.
6. `05_target.js` – `Target`: the articulated man (animation, ragdoll, hat), spot selection (`hiddenKind`, `spawnHidden`, `spawnTower`, `spawnLedge`, `tryStreet`, `tryRoofHidden`, `pressure`), and the machine rigs (`RIG`: technical, quadcopter, helicopter, with explode/debris, movement, `heliMove`, `quadMesh`/`truckMesh`).
7. `06_bullet.js` – `Bullet`: ballistics, guidance, terminal homing, visuals.
8. `07_post.js` – `Post`: sensor and CRT display pipeline, grain and motes.
9. `08_hud.js` – `Hud`: 2D canvas HUD composited in the display shader (red channel bright ink, green dark ink, blue = red bracket ink). Touch buttons, scope, flight gauges, mission card, tally, game over, victory.
10. `08_mortar.js` – `Mortar`: the fire mission.
11. `09_game.js` – renderer, input, cameras, state machine (attract → brief → aim → shot → flight → killcam/misscam → tally; plus mload/mflight for the mission, escaped, victory, gameover), scoring, `planHidden`, `routeFlyable`, `spawnChecked`, main loop, `window.__X` test hooks.
12. `template.html` – page shell (import map for three@0.170.0, fonts).

## Tools

1. **Build:** `node tools/build_artifact.mjs .` writes `dist/` and `docs/index.html` (the page GitHub Pages serves). `node tools/build.mjs .` builds only `dist/xacto.html`.
2. **Probe:** `node tools/probe.mjs dist/xacto.html "<js>"` runs JS in headless Chromium (test mode) and prints the result and any console errors. `SEED=N` picks the city seed.
3. **Screenshots:** `node tools/snap.mjs dist/xacto.html <outPrefix> "<js returning [[name, js], ...]>" [W] [H] [query]`. Env: `SEED`, `PR` (pixel ratio, use 0.75 or 1), `MOBILE=1 DSF=2` with `390 844` for a phone.
4. **Bots** (`tools/bots/*.js`, pass the file's text as the probe's JS; settings on `window.__*` before it):
   1. `stages.js` – the human-like bot on natural stages (`__ST=[8,12,16,19]`, `__N=10`): hit rate and each target's spot, distance and miss reason.
   2. `kind.js` – one spot kind at a time (`__K=[['ledge',false]]`, `__S` stage), with miss diagnostics.
   3. `heli.js` – helicopter engagements, checking for orbiting, long close chases and building clipping.
   4. `missions.js` – plays every fire mission set-up to the end.
   5. `spawns.js` – spawn success, heights and distances per spot kind.
   6. `touch.js` – stages 3 to 7 with a desktop-like bot and a coarser, slower touch-like bot.
   7. `heli_chase.js` – helicopter shots traced through the terminal lock (`__CHASE=1` steers straight at it once it is in sight).
   8. `drones.js` – drone shots with a bot that taps to lock as soon as it can see the drone, and one that keeps steering by hand close in; counts loops and locks held with the drone behind the round (`__TOUCH=1` for touch).
   Headless runs use SwiftShader. Use `sim()` (no rendering) for bots. A run of 30 shots takes a few minutes.
5. **Test hooks on `window.__X`:** `startAt(stage)`, `sim(sec)`, `advance(sec)`, `spawnKind(kind)`, `aimAt(v)`, `aimAtTarget()`, `fire()`, `planHidden()`, `RP` (route), `flyable(slack)`, `routeFollow`, `setAim`, `bot` (per-frame callback), `look(p, t, fov)` (free camera), `setState`, plus the modules (`G`, `City`, `Target`, `Bullet`, `Mortar`, `Hud`, `Input`, …). `Mortar.M.force = '<set-up>'` forces a fire mission set-up.

## Rules

1. No gore. No real brands or organisations' logos.
2. No external assets beyond three.js and the two fonts. Everything else is procedural.
3. Zero console errors. Build and look at screenshots after every meaningful change, on desktop and at phone size.
4. Keep it fast: no per-frame allocations in hot paths, and keep draw calls and instance counts sane.
5. Measure difficulty changes with the bots before and after.
