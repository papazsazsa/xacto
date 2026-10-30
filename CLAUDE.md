# XACTO – working rules

1. Every update ships to both links, built from the same source with `node tools/build_artifact.mjs .`:
   1. Web: publish `dist/xacto_web.html` to https://claude.ai/artifact/Dcmu13BD3JLdtgfnVzyZnV (pass this URL).
   2. Mobile: publish `dist/xacto_mobile.html` to https://claude.ai/artifact/VAyEH7qNHX4P3jLnwbpEys (pass this URL).
2. After publishing, commit and push to `main` on github.com/papazsazsa/xacto, and give the user both links.
3. Check touch changes at phone size before publishing (see README, phone screenshots).
4. Read `BRIEF.md` before changing game code.
