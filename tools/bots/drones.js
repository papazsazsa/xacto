(() => {
  // drones: a bot that taps to lock, and a bot that keeps steering by hand at the drone (fights the lock)
  const X = window.__X, G = X.G, B = X.Bullet.S, T = X.Target, TAU = Math.PI * 2, N = +window.__N || 8;
  const out = {};
  if (window.__TOUCH) X.Hud.setTouch(true);
  for (const style of ['tap', 'tapfight']) {
    let sd = 991; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    let hits = 0, n = 0, loops = 0; const why = {};
    for (let i = 0; i < N; i++) {
      X.startAt(5 + (i % 4)); X.sim(0.3);
      if (!X.spawnKind('quad')) continue;
      if (i % 2) { T.evade(); X.sim(2 + i); }
      T.refreshSpot(); X.planHidden(); X.aimAt(T.S.spot.gate); X.sim(0.05);
      const hist = []; let t0 = 0, last = -1;
      X.bot = (G, rdt) => {
        t0 += rdt; const w = B.p.clone(); const f = X.routeFollow(w); hist.push([t0, f ? w : null]);
        if (t0 - last < 0.2) return; last = t0;
        const d = B.p.distanceTo(T.chest);
        if (style !== 'lock' && X.clearLine(B.p, T.chest, 0.3) && !(style === 'tapfight' && d < 30)) { X.setAim(null, true); return; }
        if (style === 'tapfight' && d < 30 && X.clearLine(B.p, T.chest, 0.3)) { const c = T.chest; X.setAim(c.clone().add({ x: (rnd() - 0.5) * 3, y: (rnd() - 0.5) * 2, z: (rnd() - 0.5) * 3 }), false); return; }
        let seen = null; for (const h of hist) if (h[0] <= t0 - 0.3) seen = h; if (!seen) return;
        if (seen[1]) X.setAim(seen[1].clone().add({ x: (rnd() - 0.5) * 4, y: (rnd() - 0.5) * 2.4, z: (rnd() - 0.5) * 4 }), false); else X.setAim(null, true);
      };
      X.fire();
      let tt = 0, sweep = 0, prevA = null, behind = 0;
      while ((G.state === 'shot' || G.state === 'flight') && tt < 60) {
        X.sim(1 / 60); tt += 1 / 60;
        const c = T.chest, dx = B.p.x - c.x, dz = B.p.z - c.z, d = Math.hypot(dx, dz, B.p.y - c.y);
        if (G.tLock && T.S.alive) { const L = T.chest.clone().sub(B.p).normalize(), V = B.v.clone().normalize(); if (L.dot(V) < 0) behind++; }
        if (d < 40 && T.S.alive) { const a = Math.atan2(dz, dx); if (prevA !== null) { let da = a - prevA; da = Math.atan2(Math.sin(da), Math.cos(da)); sweep += Math.abs(da); } prevA = a; } else prevA = null;
      }
      const hit = G.state === 'killcam'; n++; if (hit) hits++; if (sweep > TAU) loops++; if (behind > 6) (out.behind = out.behind || []).push(style + ' ' + behind + 'f ' + (hit ? 'HIT' : G.lastMiss));
      const w = hit ? 'HIT' : (G.lastMiss || '').replace(/[0-9.]+ M/, 'N M'); why[w] = (why[w] || 0) + 1;
      X.bot = null;
    }
    out[style] = `${hits}/${n} hit, ${loops} looped  ${JSON.stringify(why)}`;
  }
  X.Hud.setTouch(false);
  return out;
})()
