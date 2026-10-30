(() => {
  const X = window.__X, G = X.G, B = X.Bullet.S, T = X.Target, TAU = Math.PI * 2;
  let sd = 991; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const rows = []; let hits = 0, n = 0;
  if (window.__TOUCH) X.Hud.setTouch(true);
  const E = window.__E || 2.0, LAG = window.__LAG || 0.3, EVERY = window.__EVERY || 0.2;
  for (const st of (window.__HS || [10, 20, 30])) for (const wait of (window.__W || [0, 0, 6])) {
    X.startAt(st); X.sim(0.3);
    if (T.S.type !== 'heli') continue;
    if (wait > 0) { T.evade(); X.sim(wait); }
    T.refreshSpot(); X.planHidden(); X.aimAt(T.S.spot.gate); X.sim(0.05);
    const hist = []; let t0 = 0, last = -1;
    X.bot = (G, rdt) => {
      t0 += rdt; const w = B.p.clone(); const f = X.routeFollow(w); hist.push([t0, f ? w : null]);
      if (t0 - last < EVERY) return; last = t0;
      let seen = null; for (const h of hist) if (h[0] <= t0 - LAG) seen = h; if (!seen) return;
      if (window.__CHASE && T.S.alive && B.p.distanceTo(T.chest) < 150 && X.clearLine(B.p, T.chest, 0.3)) { X.setAim(null, true); return; }
      if (seen[1]) X.setAim(seen[1].clone().add({ x: (rnd() - 0.5) * 2 * E, y: (rnd() - 0.5) * 2 * E * 0.6, z: (rnd() - 0.5) * 2 * E }), false); else X.setAim(null, true);
    };
    X.fire();
    let tt = 0, on = 0, lost = 0, was = false, minD = 1e9, lockD = 0, lostD = [];
    while ((G.state === 'shot' || G.state === 'flight') && tt < 60) {
      X.sim(1 / 60); tt += 1 / 60;
      const d = B.p.distanceTo(T.chest); if (T.S.alive) minD = Math.min(minD, d);
      if (G.tLock && !was) { on++; lockD = d; }
      if (!G.tLock && was && T.S.alive) { lost++; lostD.push(Math.round(d)); }
      was = G.tLock;
    }
    const hit = G.state === 'killcam'; n++; if (hit) hits++;
    rows.push(`s${st} w${wait}: ${hit ? 'HIT' : G.lastMiss} locks ${on} lost ${lost}${lostD.length ? '@' + lostD.join('/') : ''} minD ${minD.toFixed(1)} budget ${Math.round(B.budget)} v ${Math.round(B.v.length())} hv ${Math.round(G.tgtVel.length())}`);
    X.bot = null;
  }
  return { hits: `${hits}/${n}`, rows };
})()
