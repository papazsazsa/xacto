# XACTO – DARPA Games

An vibe-coded 80s-arcade thermal sniper game built in Three.js (r170). You fire an EXACTO-style guided round and fly it around corners into tight spots: rooftops behind taller buildings, the tops of the tallest towers, ledges high on a tower, street canyons, under awnings. A technical (a pickup with a machine gun) or a quadcopter turns up every 6 to 8 stages. Each round can ricochet three times off glancing hits.

## Play

https://papazsazsa.github.io/xacto/ – anyone can play, on any device. On a phone or tablet it switches to touch controls by itself and renders at a lower resolution to save battery.

Touch controls: drag to aim, tap FIRE to shoot. In flight, drag to move the marker, or tap the target to lock the round onto him. The II button opens pause, sensor mode and sound.

Shortcuts: `?stage=N` starts at stage N (for example https://papazsazsa.github.io/xacto/?stage=10 for the helicopter). `?stage=5&mission=convoy` forces a fire mission set-up (`checkpoint`, `convoy`, `nest`, `motorpool`, `garage`).

## Builds

| File | What it is |
| --- | --- |
| `dist/xacto_web.html` | The published page (all devices) |
| `dist/xacto_mobile.html` | Same page with the touch layout forced on, for testing on desktop |
| `dist/xacto.html` | Plain build output for local testing |
| `baseline/xacto_v*.html` | Earlier versions, kept for reference |

## Building

```
node tools/build_artifact.mjs .
```

This builds `dist/xacto.html` from `src/`, then writes the web and mobile pages. The modules in `src/` are concatenated in name order into one `<script type="module">`. See `BRIEF.md` for the full code layout and the test hooks on `window.__X`.

Phone screenshots for testing: `MOBILE=1 DSF=2 node tools/snap.mjs dist/xacto.html <out> "<steps>" 844 390`.

## Layout

1. `src/` – game source (core, audio, materials, city, effects, target, bullet, post-processing, HUD, game loop).
2. `tools/` – build scripts plus headless test and capture tools (Playwright + Chromium); `tools/bots/` holds the difficulty test bots.
3. `vendor/` – local copies of three.js and fonts so the tests run offline.
4. `baseline/` – earlier builds and source snapshots.
