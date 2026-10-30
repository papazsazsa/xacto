(() => {
  const X = window.__X, G = X.G, B = X.Bullet.S, T = X.Target, N = +window.__N || 8;
  let sd = 991; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const out = {};
  for (const [kind, mv] of (window.__K || [['tower', false], ['ledge', false], ['roof', false]])) {
    let hits = 0, tried = 0, fails = 0;
    for (let i = 0; i < N; i++) {
      X.startAt(window.__S || (4 + (i % 3))); X.sim(0.3);
      if (!X.spawnKind(kind)) { fails++; continue; }
      if (mv) { T.evade(); X.sim(2 + 1.3 * i); }
      if (T.refreshSpot) T.refreshSpot(); X.planHidden();
      X.aimAt(T.S.spot.gate); X.sim(0.05);
      const hist = []; let t0 = 0, last = -1;
      X.bot = (G, rdt) => {
        t0 += rdt;
        const w = B.p.clone(); const f = X.routeFollow(w);
        hist.push([t0, f ? w : null]);
        if (t0 - last < 0.2) return; last = t0;
        let seen = null; for (const h of hist) if (h[0] <= t0 - 0.3) seen = h; if (!seen) return;
        if (seen[1]) { const e = 2.0; X.setAim(seen[1].clone().add({ x: (rnd() - 0.5) * 2 * e, y: (rnd() - 0.5) * 2 * e * 0.6, z: (rnd() - 0.5) * 2 * e }), false); }
        else X.setAim(null, true);
      };
      X.fire();
      let tt = 0; while ((G.state === 'shot' || G.state === 'flight') && tt < 60) { X.sim(1 / 60); tt += 1 / 60; }
      if (G.state === "killcam") hits++; else (out.miss = out.miss || []).push(G.lastMiss + " end dy" + Math.round(B.p.y - T.S.root.y) + " dh" + Math.round(Math.hypot(B.p.x - T.S.root.x, B.p.z - T.S.root.z)) + " close dy" + Math.round(B.closeP.y - T.S.root.y) + " budget" + Math.round(B.budget) + " rp" + (X.RP.ok ? 1 : 0) + " d" + Math.round(T.S.dist) + " " + (T.S.spot && T.S.spot.kind));
      tried++; X.bot = null;
    }
    out[`${kind}${mv ? ' moving' : ''}`] = `${hits}/${tried}  spawn fails ${fails}`;
  }
  return out;
})()
