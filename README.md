# XACTO – Ghost Soldier

An 80s-arcade thermal sniper game built in Three.js (r170). You fire an EXACTO-style guided round and fly it around corners to targets hidden behind cover, on rooftops, under awnings, inside rooms and in cars. A drone feed (MQ-DARC VIEW) in the scope shows targets you cannot see directly.

© 1987 VALENTINE ARCADE (fictional).

## Builds

| File | What it is |
| --- | --- |
| `dist/xacto_corners.html` | Current build ("XACTO Corners Test"): guided round, ricochet, terminal lock, hidden targets, three characters |
| `dist/xacto_artifact.html` | Same build packaged as a single self-contained page |
| `dist/xacto.html` | Plain build output |
| `baseline/xacto_v*.html` | Earlier versions, kept for reference |

Published on claude.ai:

1. Corners build: https://claude.ai/artifact/Dcmu13BD3JLdtgfnVzyZnV
2. Older main build: https://claude.ai/artifact/UztgoBm4Yd5tN7FfdE6bhX

## Building

```
node tools/build.mjs
node tools/build_artifact.mjs .
cp dist/xacto_artifact.html dist/xacto_corners.html
sed -i 's#<title>[^<]*</title>#<title>XACTO Corners Test</title>#' dist/xacto_corners.html
```

The modules in `src/` are concatenated in name order into one `<script type="module">`. See `BRIEF.md` for the full code layout and the test hooks on `window.__X`.

## Layout

1. `src/` – game source (core, audio, materials, city, effects, target, bullet, post-processing, HUD, game loop).
2. `tools/` – build scripts plus headless test and capture tools (Playwright + Chromium).
3. `vendor/` – local copies of three.js and fonts so the tests run offline.
4. `baseline/` – earlier builds and source snapshots.
