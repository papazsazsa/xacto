(() => {
  // stages 3-7 with a desktop-like bot and a touch-like bot (coarser, slower), same spots for both
  const X = window.__X, G = X.G, B = X.Bullet.S, T = X.Target, N = +window.__N || 8;
  const out = {};
  for (const mode of ['desk', 'touch']) {
    let sd = 991; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    X.Hud.setTouch(mode === 'touch');
    const E = mode === 'touch' ? 4.5 : 2.0, LAG = mode === 'touch' ? 0.45 : 0.3, EVERY = mode === 'touch' ? 0.35 : 0.2;
    const row = []; let hits = 0, n = 0;
    for (const st of (window.__ST || [3, 4, 6, 7])) for (let i = 0; i < N; i++) {
      X.startAt(st); X.sim(0.3);
      if (X.G.mission) continue;
      if (T.S.type !== 'man') T.refreshSpot();
      X.aimAt(T.S.spot ? T.S.spot.gate : T.chest); X.sim(0.05);
      const hist = []; let t0 = 0, last = -1;
      X.bot = (G, rdt) => {
        t0 += rdt; const w = B.p.clone(); const f = X.routeFollow(w); hist.push([t0, f ? w : null]);
        if (t0 - last < EVERY) return; last = t0;
        let seen = null; for (const h of hist) if (h[0] <= t0 - LAG) seen = h; if (!seen) return;
        if (seen[1]) X.setAim(seen[1].clone().add({ x: (rnd() - 0.5) * 2 * E, y: (rnd() - 0.5) * 2 * E * 0.6, z: (rnd() - 0.5) * 2 * E }), false); else X.setAim(null, true);
      };
      X.fire(); let tt = 0; while ((G.state === 'shot' || G.state === 'flight') && tt < 60) { X.sim(1 / 60); tt += 1 / 60; }
      const hit = G.state === 'killcam'; if (hit) hits++; n++; X.bot = null;
    }
    out[mode] = `${hits}/${n} (${Math.round(100 * hits / n)}%)`;
  }
  X.Hud.setTouch(false);
  return out;
})()
