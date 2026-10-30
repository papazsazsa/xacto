# XACTO – working rules

1. One link for every device. Build with `node tools/build_artifact.mjs .` and publish `dist/xacto_web.html` to https://claude.ai/artifact/Dcmu13BD3JLdtgfnVzyZnV (pass this URL).
2. The page detects phones and tablets itself (`MOBILE` in `src/00_core.js`): touch controls, lower pixel ratio, drone feed at a third of the frame rate. Desktop and mobile adjustments both go into the same source.
3. After publishing, commit and push to `main` on github.com/papazsazsa/xacto, and give the user the link.
4. Check touch changes at phone size before publishing (see README, phone screenshots).
5. Read `BRIEF.md` before changing game code.
