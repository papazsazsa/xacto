(() => {
  const X = window.__X, G = X.G, B = X.Bullet.S, T = X.Target, N = +window.__N || 8;
  let sd = 991; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const out = {};
  for (const st of (window.__ST || [12, 13, 14])) {
    const row = []; let hits = 0, n = 0;
    for (let i = 0; i < N; i++) {
      X.startAt(st); X.sim(0.3);
      if (X.G.mission) continue;
      const kind = T.S.spot ? T.S.spot.kind : "open", rp = X.RP.ok ? 1 : 0; const t0f = performance.now(); const fl = [0.6, 0.75, 0.9, 1].map((q) => X.flyable(q) ? 1 : 0).join(""); const fms = Math.round(performance.now() - t0f);
      if (T.S.type !== 'man') T.refreshSpot();
      X.aimAt(T.S.spot ? T.S.spot.gate : T.chest); X.sim(0.05);
      const hist = []; let t0 = 0, last = -1;
      X.bot = (G, rdt) => {
        t0 += rdt; const w = B.p.clone(); const f = X.routeFollow(w); hist.push([t0, f ? w : null]);
        if (t0 - last < 0.2) return; last = t0;
        let seen = null; for (const h of hist) if (h[0] <= t0 - 0.3) seen = h; if (!seen) return;
        if (seen[1]) { const e = 2.0; X.setAim(seen[1].clone().add({ x: (rnd() - 0.5) * 2 * e, y: (rnd() - 0.5) * 2 * e * 0.6, z: (rnd() - 0.5) * 2 * e }), false); } else X.setAim(null, true);
      };
      X.fire(); let tt = 0; while ((G.state === 'shot' || G.state === 'flight') && tt < 60) { X.sim(1 / 60); tt += 1 / 60; }
      const hit = G.state === 'killcam'; if (hit) hits++; n++;
      row.push(`${fl}:${fms}ms ${kind}${rp ? "" : "!RP"} ${Math.round(T.S.dist)}m ${hit ? 'HIT' : G.lastMiss}`); X.bot = null;
    }
    out['s' + st] = `${hits}/${n}: ` + row.join(' | ');
  }
  return out;
})()
