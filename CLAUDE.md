# XACTO – working rules

1. Every change ships by pushing to `main` on github.com/papazsazsa/xacto. Build first with `node tools/build_artifact.mjs .`; it writes `docs/index.html`, which GitHub Pages serves at https://papazsazsa.github.io/xacto/ (live a minute or two after the push). Give the user that link. Do not publish claude.ai artifacts.
2. The page detects phones and tablets itself (`MOBILE` in `src/00_core.js`): touch controls and a lower pixel ratio. Desktop and mobile adjustments both go into the same source.
3. Check touch changes at phone size before pushing (see README, phone screenshots).
4. Read `BRIEF.md` before changing game code.
