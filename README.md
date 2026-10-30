# XACTO – Ghost Soldier

An 80s-arcade thermal sniper game built in Three.js (r170). You fire an EXACTO-style guided round and fly it around corners to targets hidden behind cover, on rooftops, under awnings, inside rooms and in cars. A drone feed (MQ-DARC VIEW) in the scope shows targets you cannot see directly.

© 1987 VALENTINE ARCADE (fictional).

## Play

https://claude.ai/artifact/Dcmu13BD3JLdtgfnVzyZnV – one page for every device. On a phone or tablet it switches to touch controls by itself, renders at a lower resolution and refreshes the drone feed at a third of the frame rate to save battery.

Touch controls: drag to aim, tap FIRE to shoot. In flight, drag to move the marker, or tap the target to lock the round onto him. The II button opens pause, sensor mode and sound.

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
2. `tools/` – build scripts plus headless test and capture tools (Playwright + Chromium).
3. `vendor/` – local copies of three.js and fonts so the tests run offline.
4. `baseline/` – earlier builds and source snapshots.
