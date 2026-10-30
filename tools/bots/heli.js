(() => {
  const X = window.__X, G = X.G, B = X.Bullet.S, T = X.Target, TAU = Math.PI * 2, DEG = Math.PI / 180;
  let sd = 991; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const res = { shots: 0, hits: 0, loops: 0, longClose: 0, inside: 0, reasons: {}, worst: [] };
  for (const st of (window.__HS || [10, 20, 30])) for (const wait of (window.__W || [0, 0, 6, 12])) for (const pilot of ['human', 'auto']) {
    X.startAt(st); X.sim(0.3);
    if (T.S.type !== 'heli') continue;
    if (wait > 0) { T.evade(); X.sim(wait); }
    T.refreshSpot(); X.planHidden(); X.aimAt(T.S.spot.gate); X.sim(0.05);
    const hist = []; let t0 = 0, last = -1;
    if (pilot === 'auto') G.auto = true;
    else X.bot = (G, rdt) => {
      t0 += rdt; const w = B.p.clone(); const f = X.routeFollow(w); hist.push([t0, f ? w : null]);
      if (t0 - last < 0.2) return; last = t0;
      let seen = null; for (const h of hist) if (h[0] <= t0 - 0.3) seen = h; if (!seen) return;
      if (seen[1]) { const e = 2.0; X.setAim(seen[1].clone().add({ x: (rnd() - 0.5) * 2 * e, y: (rnd() - 0.5) * 2 * e * 0.6, z: (rnd() - 0.5) * 2 * e }), false); } else X.setAim(null, true);
    };
    X.fire();
    let tt = 0, close = 0, sweep = 0, prevA = null, maxClose = 0;
    while ((G.state === 'shot' || G.state === 'flight') && tt < 60) {
      X.sim(1 / 60); tt += 1 / 60;
      const c = T.chest, dx = B.p.x - c.x, dz = B.p.z - c.z, d = Math.hypot(dx, dz, B.p.y - c.y);
      // the round close to it: how long, and how far round it the round has swung (an orbit sweeps 360)
      if (d < 40 && T.S.alive) {
        close += 1 / 60; maxClose = Math.max(maxClose, close);
        const a = Math.atan2(dz, dx); if (prevA !== null) { let da = a - prevA; da = Math.atan2(Math.sin(da), Math.cos(da)); sweep += Math.abs(da); } prevA = a;
      } else { close = 0; prevA = null; }
      X.City.forBoxesNear(c.x, c.z, 3, (b) => { if (b.kind === 1 && c.x > b.x0 && c.x < b.x1 && c.z > b.z0 && c.z < b.z1 && c.y + 1.5 > b.y0 && c.y + 1.5 < b.y1) res.inside++; });
    }
    const hit = G.state === 'killcam'; res.shots++; if (hit) res.hits++;
    if (sweep > TAU) res.loops++;
    if (maxClose > 3) res.longClose++;
    const why = hit ? 'HIT' : (G.lastMiss || '').replace(/[0-9.]+ M/, 'N M'); res.reasons[why] = (res.reasons[why] || 0) + 1;
    if (sweep > Math.PI) res.worst.push(`s${st} w${wait} ${pilot} sweep ${Math.round(sweep / DEG)}deg close ${maxClose.toFixed(1)}s ${hit ? 'HIT' : G.lastMiss}`);
    X.bot = null; G.auto = false;
  }
  return res;
})()
