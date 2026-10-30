(() => {
  // a thumb on a phone: it drags the marker toward where it wants the round to go, through the real touch
  // input path (finger travel -> Input.dx/dy -> marker), reacting 0.3 s late, at most ~40 px per 1/10 s, with
  // some wobble. It aims the scope at the gate (or the target) first, like a player would.
  const X = window.__X, G = X.G, B = X.Bullet.S, T = X.Target, N = +window.__N || 8;
  X.Hud.setTouch(true); X.botFinger = true;
  const cam = X.camera, V = (x, y, z) => new X.camera.position.constructor(x, y, z);
  let sd = 991; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const out = {}; let tot = 0, totN = 0;
  for (const st of (window.__ST || [1, 2, 3, 4, 6])) {
    let hits = 0, n = 0;
    for (let i = 0; i < N; i++) {
      X.startAt(st); X.sim(0.3);
      if (G.mission) continue;
      if (T.S.type !== 'man') T.refreshSpot();
      X.aimAt(T.S.spot ? T.S.spot.gate : T.chest); X.sim(0.05);
      const hist = []; let t0 = 0, last = -1;
      X.bot = (G, rdt) => {
        t0 += rdt;
        const w = B.p.clone(); const f = X.routeFollow(w); hist.push([t0, f ? w : T.chest.clone()]);
        if (t0 - last < 0.1) return; last = t0;
        let seen = null; for (const h of hist) if (h[0] <= t0 - 0.3) seen = h; if (!seen) return;
        // where the marker is and where the thumb wants it, on screen
        cam.updateMatrixWorld();
        const a = G.aimP.clone().project(cam), b = seen[1].clone().project(cam);
        if (a.z > 1 || b.z > 1) return;
        // the thumb moves at most 40 px per tenth of a second and wobbles a few px; the game scales finger
        // travel by its gain, so both reach and wobble scale with it
        const g = window.__GAIN || 1.6;
        let dx = (b.x - a.x) * innerWidth / 2, dy = -(b.y - a.y) * innerHeight / 2;
        const m = Math.hypot(dx, dy), cap = 40 * g; if (m > cap) { dx *= cap / m; dy *= cap / m; }
        dx += (rnd() - 0.5) * 6 * g; dy += (rnd() - 0.5) * 6 * g;
        X.Input.dx += dx; X.Input.dy += dy;
      };
      X.fire(); let tt = 0; while ((G.state === 'shot' || G.state === 'flight') && tt < 60) { X.sim(1 / 60); tt += 1 / 60; }
      const hit = G.state === 'killcam'; if (hit) hits++; n++; X.bot = null;
    }
    out['s' + st] = `${hits}/${n}`; tot += hits; totN += n;
  }
  out.all = `${tot}/${totN} (${Math.round(100 * tot / totN)}%)`;
  X.Hud.setTouch(false); X.botFinger = false;
  return out;
})()
