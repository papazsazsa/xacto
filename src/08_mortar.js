// ---------------------------------------------------------------------------
// Fire mission: a reward stage every fifth stage (FIRE_MISSION in 00_core.js switches it off). Three technicals
// at a checkpoint on the main avenue. Lock each one (tap it, or put the crosshairs on it and click); the mortar
// bomb drops down the tube with a thunk; fire, and the camera rides the bomb up its arc. At the top the nose
// splits into three cones that dive straight down onto the three trucks.
// Everything for the fire mission lives here; the game, HUD and sound hooks are marked "fire mission".
// ---------------------------------------------------------------------------
const Mortar = (() => {
  const group = new THREE.Group(); group.visible = false;
  const GM = 30, APEX = 200;                       // the arc: a stylised high lob, about 3.7 s up
  const M = { on: false, trucks: [], locks: [], phase: '', t: 0, center: new THREE.Vector3(), start: new THREE.Vector3(), v0: new THREE.Vector3(),
    ta: 0, cones: [], deb: [], restT: 0, thudT: 0, endT: 0, done: false, carrier: null };
  const SC = [0, 1, 2].map(() => ({ vis: false, x0: 0, y0: 0, x1: 0, y1: 0 }));
  const UPV = new THREE.Vector3(0, 1, 0), ZAX = new THREE.Vector3(0, 0, 1), XAX = new THREE.Vector3(1, 0, 0);
  const T1 = new THREE.Vector3(), T2 = new THREE.Vector3(), T3 = new THREE.Vector3(), T4 = new THREE.Vector3(), Q1 = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), ndcV = new THREE.Vector3();

  // ---- the bomb (forward is +z): tail boom and fins, two warm propellant rings, the fat body, three cones
  const mat = (t) => thermalMat(FS_SOLID, { uT: { value: t }, uStripe: { value: 0 } }, { side: THREE.DoubleSide });
  const mBody = mat(0.74), mRing = mat(0.88), mFin = mat(0.6), mCone = mat(0.82);
  const cyl = (rFront, rRear, h, n = 14) => new THREE.CylinderGeometry(rFront, rRear, h, n).rotateX(Math.PI / 2);   // along z
  const coneGeo = new THREE.ConeGeometry(0.045, 0.3, 10).rotateX(Math.PI / 2);                                     // tip at +z
  const bomb = new THREE.Group(), bombCones = [];
  const part = (geo, m, x, y, z, rz = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(0, 0, rz); o.frustumCulled = false; bomb.add(o); return o; };
  part(cyl(0.035, 0.035, 0.34), mFin, 0, 0, -0.45);                                                   // tail boom
  for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; part(new THREE.BoxGeometry(0.012, 0.12, 0.17), mFin, -Math.sin(a) * 0.095, Math.cos(a) * 0.095, -0.54, a); }
  for (const z of [-0.33, -0.26]) part(new THREE.TorusGeometry(0.058, 0.024, 8, 16), mRing, 0, 0, z);   // propellant rings
  part(cyl(0.08, 0.036, 0.22), mBody, 0, 0, -0.12);                                                    // rear taper
  part(cyl(0.084, 0.082, 0.24), mBody, 0, 0, 0.11);                                                    // body
  part(cyl(0.074, 0.084, 0.05), mBody, 0, 0, 0.255);                                                   // shoulder
  for (let k = 0; k < 3; k++) { const a = Math.PI / 2 + k * TAU / 3; bombCones.push(part(coneGeo, mCone, Math.cos(a) * 0.042, Math.sin(a) * 0.042, 0.43)); }
  bomb.scale.setScalar(2.4); bomb.visible = false; group.add(bomb);   // drawn large so it reads in the chase view

  // ---- the three trucks at a checkpoint on the main avenue
  function clear() {
    for (const tr of M.trucks) group.remove(tr.g);
    for (const d of M.deb) group.remove(d.m);
    for (const c of M.cones) group.remove(c.m);
    M.trucks = []; M.locks = []; M.cones = []; M.deb = []; M.phase = ''; M.done = false; M.on = false;
    bomb.visible = false; for (const c of bombCones) c.visible = true; group.visible = false;
  }
  const footClear = (x, z) => {
    let ok = true;
    City.forBoxesNear(x, z, 5, (b) => { if (ok && !b.dead && b.x0 < x + 2.8 && b.x1 > x - 2.8 && b.z0 < z + 2.8 && b.z1 > z - 2.8 && b.y0 < 2.2 && b.y1 > 0.1) ok = false; });
    return ok;
  };
  const skyClear = (x, z) => !City.raycast(T1.set(x, 2.3, z), UPV, 140);
  function setup() {
    clear(); M.on = true; group.visible = true;
    const eye = PLAYER.eye;
    let spots = null;
    for (let a = 0; a < 60 && !spots; a++) {
      const k = 3 + Math.floor(grnd(0, 3.99)), zc = -k * GRID.stSp + grnd(-8, 8), d = eye.z - zc;
      if (d < 280 || d > 520) continue;
      const cx = grnd(-3, 3), j = () => grnd(-1.5, 1.5);
      const lay = [[cx - 7 + j(), zc + 8 + j(), grnd(-0.5, 0.5)], [cx + 6 + j(), zc + j(), Math.PI / 2 + grnd(-0.4, 0.4)], [cx - 2 + j(), zc - 10 + j(), grnd(2.6, 3.6)]];
      if (lay.every(([x, z]) => Math.abs(x) < GRID.mainHW - 2.6 && footClear(x, z) && skyClear(x, z))) spots = lay;
    }
    if (!spots) { const zc = -4 * GRID.stSp; spots = [[-7, zc + 8, 0], [6, zc, Math.PI / 2], [-2, zc - 10, 3]]; }
    M.center.set(0, 0, 0);
    for (const [x, z, yaw] of spots) {
      const g = Target.truckMesh(); g.position.set(x, 0, z); g.rotation.set(0, yaw, 0); g.updateMatrixWorld(true); group.add(g);
      M.trucks.push({ g, p: new THREE.Vector3(x, 0, z), yaw, alive: true });
      M.center.x += x / 3; M.center.z += z / 3;
    }
    M.center.y = 1;
  }
  // ---- locking: on screen (fractions, y down) each truck's box; a tap or the crosshairs picks the nearest
  function screen(cam) {
    cam.getWorldDirection(T3);
    M.trucks.forEach((tr, i) => {
      const s = SC[i]; let x0 = 9, x1 = -9, y0 = 9, y1 = -9, ok = tr.alive;
      const f = T1.set(Math.sin(tr.yaw), 0, Math.cos(tr.yaw)), r = T2.set(Math.cos(tr.yaw), 0, -Math.sin(tr.yaw));
      for (const lx of [-0.92, 0.92]) for (const y of [0.1, 2.05]) for (const lz of [-2.45, 2.45]) {
        if (!ok) break;
        ndcV.set(tr.p.x + r.x * lx + f.x * lz, y, tr.p.z + r.z * lx + f.z * lz);
        if (T4.copy(ndcV).sub(cam.position).dot(T3) <= 0.5) { ok = false; break; }
        ndcV.project(cam); x0 = Math.min(x0, ndcV.x); x1 = Math.max(x1, ndcV.x); y0 = Math.min(y0, ndcV.y); y1 = Math.max(y1, ndcV.y);
      }
      s.vis = ok && x1 > -1 && x0 < 1 && y1 > -1 && y0 < 1;
      if (s.vis) { s.x0 = (x0 + 1) / 2; s.x1 = (x1 + 1) / 2; s.y0 = (1 - y1) / 2; s.y1 = (1 - y0) / 2; }
    });
    return SC;
  }
  function lockAt(nx, ny, radPx) {
    let best = -1, bd = 1e9;
    M.trucks.forEach((tr, i) => {
      const s = SC[i]; if (!s.vis || M.locks.includes(i)) return;
      const dx = Math.max(s.x0 - nx, 0, nx - s.x1) * innerWidth, dy = Math.max(s.y0 - ny, 0, ny - s.y1) * innerHeight, dd = Math.hypot(dx, dy);
      if (dd < radPx && dd < bd) { bd = dd; best = i; }
    });
    if (best >= 0) { M.locks.push(best); Sfx.lock(); return true; }
    Sfx.deny(); return false;
  }
  // in the scope: fire (click, space, the touch button) locks the truck under the crosshairs; a tap locks the
  // truck under the finger
  function aim(fire, tap) {
    if (tap) lockAt(tap.x, tap.y, 46 * innerHeight / 720 + 14);
    else if (fire) lockAt(0.5, 0.5, 70 * innerHeight / 720);
    return M.locks.length >= 3;
  }

  // ---- the shot
  const bombP = new THREE.Vector3(), bombV = new THREE.Vector3();
  function fire() {
    const eye = PLAYER.eye;
    M.start.set(eye.x + 2.2, PLAYER.roofY + 1.0, eye.z - 1.2);
    const dx = M.center.x - M.start.x, dz = M.center.z - M.start.z, L = Math.hypot(dx, dz) || 1;
    const vy = Math.sqrt(2 * GM * APEX); M.ta = vy / GM;
    const vh = 0.62 * L / M.ta;
    M.v0.set(dx / L * vh, vy, dz / L * vh);
    M.apex = M.start.clone().addScaledVector(M.v0, M.ta); M.apex.y -= 0.5 * GM * M.ta * M.ta;
    M.phase = 'up'; M.t = 0; M.endT = 0; M.done = false;
    bomb.visible = true; for (const c of bombCones) c.visible = true;
    bombAt(0);
    FX.muzzle(M.start.clone(), UPV.clone()); Sfx.mortarFire(); begin();
  }
  function bombAt(t) {
    bombP.copy(M.start).addScaledVector(M.v0, t); bombP.y -= 0.5 * GM * t * t;
    bombV.copy(M.v0); bombV.y -= GM * t;
    bomb.position.copy(bombP); bomb.quaternion.setFromUnitVectors(ZAX, T1.copy(bombV).normalize()); bomb.updateMatrixWorld(true);
  }
  function bez(c, e, out) { const u = 1 - e; return out.set(0, 0, 0).addScaledVector(c.P0, u * u * u).addScaledVector(c.P1, 3 * u * u * e).addScaledVector(c.P2, 3 * u * e * e).addScaledVector(c.P3, e * e * e); }
  function bezD(c, e, out) { const u = 1 - e; return out.set(0, 0, 0).addScaledVector(c.P0, -3 * u * u).addScaledVector(c.P1, 3 * u * u - 6 * u * e).addScaledVector(c.P2, 6 * u * e - 3 * e * e).addScaledVector(c.P3, 3 * e * e); }
  function split() {
    M.phase = 'down'; M.splitT = M.t;
    const dirH = T2.set(bombV.x, 0, bombV.z).normalize(), side = T3.crossVectors(dirH, UPV).normalize();
    M.locks.forEach((ti, k) => {
      const src = bombCones[k], m = new THREE.Mesh(coneGeo, mCone); m.scale.setScalar(4); m.frustumCulled = false; group.add(m);   // drawn large so they read on the dive
      const P0 = src.getWorldPosition(new THREE.Vector3()), tr = M.trucks[ti];
      const P3 = tr.p.clone(); P3.y = 1.0;
      const P1 = P0.clone().addScaledVector(dirH, 35).addScaledVector(side, (k - 1) * 14);
      const P2 = P3.clone(); P2.y += 95;
      M.cones.push({ m, P0, P1, P2, P3, ti, t: 0, D: 3.0 + 0.3 * k, hit: false, p: P0.clone() });
      src.visible = false;
    });
    M.carrier = { p: bombP.clone(), v: bombV.clone(), w: new THREE.Vector3(grnd(-1, 1), grnd(-1, 1), grnd(-1, 1)).normalize().multiplyScalar(3) };
    FX.sparks(bombP.clone(), UPV.clone(), 30, 20); Sfx.mortarSplit(); Sfx.whistle(3.3);
  }
  function update(dt, blast) {
    if (!M.on) return;
    M.t += dt;
    if (M.phase === 'up') {
      bombAt(Math.min(M.t, M.ta));
      if (Math.random() < 0.6) FX.spawn(bombP.x, bombP.y, bombP.z, 0, 0, 0, 0.7, 0.3, 1.3, 0.45, 1, 0.5, 0);
      if (M.t >= M.ta) split();
    } else if (M.phase === 'down' || M.phase === 'after') {
      // the empty carrier tumbles away
      const C = M.carrier;
      if (C && bomb.visible) {
        C.v.y -= GM * dt; C.p.addScaledVector(C.v, dt); bomb.position.copy(C.p);
        Q1.setFromAxisAngle(T1.copy(C.w).normalize(), C.w.length() * dt); bomb.quaternion.premultiply(Q1);
        if (C.p.y < 1 || M.t - M.splitT > 6) bomb.visible = false;
      }
      for (const c of M.cones) {
        if (c.hit) continue;
        c.t += dt; const u = Math.min(1, c.t / c.D), e = Math.pow(u, 1.5);
        bez(c, e, c.p); c.m.position.copy(c.p);
        bezD(c, Math.max(e, 0.001), T1).normalize(); c.m.quaternion.setFromUnitVectors(ZAX, T1);
        if (Math.random() < 0.5) FX.spawn(c.p.x, c.p.y, c.p.z, 0, 0, 0, 0.5, 0.25, 1.0, 0.5, 1, 0.4, 0);
        if (u >= 1) { c.hit = true; c.m.visible = false; explode(M.trucks[c.ti], blast); }
      }
      if (M.cones.every((c) => c.hit)) { if (M.phase !== 'after') { M.phase = 'after'; M.endT = 0; } M.endT += dt; }
      if (M.phase === 'after' && M.endT > 2.6) M.done = true;
    }
    debris(dt);
  }
  // the pacing: full speed up, slow motion through the split, a little slow on the way down and at the blasts
  function ts() {
    if (M.phase === 'up') return M.t > M.ta - 0.45 ? 0.3 : 1;
    if (M.phase === 'down') return M.t - M.splitT < 0.6 ? 0.3 : 0.85;
    if (M.phase === 'after') return M.endT < 0.5 ? 0.4 : 1;
    return 1;
  }

  // ---- a truck blows apart (the same breakup as the single technical: panels fly, a tyre bounces away)
  function explode(tr, blast) {
    if (!tr.alive) return; tr.alive = false;
    const c = tr.p.clone(); c.y = 1.0;
    if (blast) blast(c, 2);
    tr.g.updateMatrixWorld(true);
    const kids = tr.g.children.slice(), tyres = kids.filter((m) => m.userData.tyre), kick = tyres[Math.floor(Math.random() * tyres.length)];
    for (const m of kids) {
      const p = m.getWorldPosition(new THREE.Vector3()), q = m.getWorldQuaternion(new THREE.Quaternion());
      group.add(m); m.position.copy(p); m.quaternion.copy(q); m.scale.set(1, 1, 1);
      T1.subVectors(p, tr.p); T1.y = 0; if (T1.lengthSq() < 1e-4) T1.set(grnd(-1, 1), 0, grnd(-1, 1)); T1.normalize();
      const v = T1.clone().multiplyScalar(grnd(3, 9)); v.y = grnd(6, 14);
      if (m.userData.high) v.y += 6;
      if (m.userData.low) { v.multiplyScalar(0.2); v.y = grnd(2, 3); }
      if (m === kick) { v.copy(T1).multiplyScalar(grnd(9, 12)); v.y = grnd(7, 9); }
      const w = new THREE.Vector3(grnd(-1, 1), grnd(-1, 1), grnd(-1, 1)).normalize().multiplyScalar(grnd(4, 12));
      M.deb.push({ m, p, q, v, w, r: m.userData.r || 0.1, tyre: !!m.userData.tyre, e: m.userData.tyre ? 0.62 : 0.28, rest: false, still: 0, ground: false, roll: 0 });
    }
    group.remove(tr.g);
  }
  const dD = new THREE.Vector3(), dN = new THREE.Vector3();
  function debris(dt) {
    if (!M.deb.length) return;
    const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
    for (let k = 0; k < n; k++) for (const d of M.deb) {
      if (d.rest) continue;
      d.ground = false; d.v.y -= PHYS.g * h;
      const sp = d.v.length(); let moved = false;
      if (sp > 1e-4) {
        dD.copy(d.v).multiplyScalar(1 / sp);
        if (City.raycast(d.p, dD, sp * h + d.r)) {
          const Hh = City.hit; dN.set(Hh.nx, Hh.ny, Hh.nz); if (dN.dot(dD) > 0) dN.negate();
          d.p.addScaledVector(dD, Math.max(0, Hh.t - d.r)); moved = true;
          const vn = d.v.dot(dN);
          if (vn < 0) {
            d.v.addScaledVector(dN, -(1 + d.e) * vn);
            if (-vn > 3 && M.thudT <= 0) { M.thudT = 0.08; if (Sfx.bodyThud) Sfx.bodyThud(Math.min(1, -vn / 12) * (d.tyre ? 0.4 : 0.8)); }
            if (dN.y > 0.6) {
              d.ground = true;
              if (-vn > 1.2) { const kf = d.tyre ? 0.95 : 0.7; d.v.x *= kf; d.v.z *= kf; if (!d.tyre) d.w.multiplyScalar(0.6); }
              else { d.v.y = 0; const kf = Math.exp(-(d.tyre ? 0.35 : 4) * h); d.v.x *= kf; d.v.z *= kf; if (!d.tyre) d.w.multiplyScalar(Math.exp(-6 * h)); }
            }
          }
        }
      }
      if (!moved) d.p.addScaledVector(d.v, h);
      const hs = Math.hypot(d.v.x, d.v.z);
      if (d.tyre && d.ground && hs > 0.3) {
        T1.set(d.v.z, 0, -d.v.x).multiplyScalar(1 / hs); d.roll += (hs / d.r) * h;
        Q1.setFromUnitVectors(XAX, T1); Q2.setFromAxisAngle(T1, d.roll); Q2.multiply(Q1); d.q.slerp(Q2, 1 - Math.exp(-14 * h));
      } else { const wl = d.w.length(); if (wl > 1e-4) { Q1.setFromAxisAngle(T1.copy(d.w).multiplyScalar(1 / wl), wl * h); d.q.premultiply(Q1); } }
    }
    for (const d of M.deb) {
      if (!d.rest) { if (d.v.lengthSq() < 0.09 && d.ground) { d.still += dt; if (d.still > 0.4) d.rest = true; } else d.still = 0; }
      d.m.position.copy(d.p); d.m.quaternion.copy(d.q);
    }
    M.thudT -= dt;
  }

  // ---- the camera: beside and behind the bomb going up; at the split it swings to look down the dive, rides
  // one cone down with the targets ahead; after the blasts a slow high orbit over the wreckage
  const camP = new THREE.Vector3(), camL = new THREE.Vector3(); let camInit = false, orbit = 0;
  function camera(rdt, cam) {
    const want = T1, look = T2;
    let rigid = false, rate = 6;
    const pre = M.phase === 'up' && M.t > M.ta - 1.4, post = M.phase === 'down' && M.t - M.splitT < 0.9;
    if (pre || post) {
      // the split shot: held out beside the top of the arc, about 15 m off, watching the nose open and the
      // three cones peel apart
      const f = T3.set(M.center.x - M.apex.x, 0, M.center.z - M.apex.z).normalize(), side = T4.crossVectors(f, UPV).normalize();
      want.copy(M.apex).addScaledVector(f, -11).addScaledVector(side, 10).addScaledVector(UPV, 3.5);
      if (post && M.cones.length) { look.set(0, 0, 0); for (const c of M.cones) look.add(c.p); look.multiplyScalar(1 / M.cones.length); }
      else look.copy(bombP);
      rate = 6;
    } else if (M.phase === 'up' || (M.phase === 'down' && !M.cones.length)) {
      // behind and a little above the bomb, looking ahead and down over the city toward the targets, so the
      // bomb climbs through the bottom of the frame with the streets below
      const f = T3.set(M.center.x - bombP.x, 0, M.center.z - bombP.z).normalize(), side = T4.crossVectors(f, UPV).normalize();
      want.copy(bombP).addScaledVector(f, -7).addScaledVector(UPV, 2.2).addScaledVector(side, 1.6);
      look.copy(bombP).addScaledVector(f, 22).addScaledVector(UPV, -9);
      look.lerp(M.center, sstep(M.ta - 1.4, M.ta, M.t) * 0.85);
      rigid = true;
    } else if (M.phase === 'down') {
      // ride one cone down: just behind it, the targets ahead
      const c = M.cones.find((q) => !q.hit && q.ti === M.locks[1]) || M.cones.find((q) => !q.hit) || M.cones[0];
      bezD(c, Math.max(0.001, Math.pow(Math.min(1, c.t / c.D), 1.5)), T3).normalize();
      want.copy(c.p).addScaledVector(T3, -6).addScaledVector(UPV, 1.4);
      look.copy(M.center);
      // swing in from the split shot over half a second, then hold tight behind the cone
      if (M.t - M.splitT < 1.5) rate = 7; else rigid = !c.hit;
    } else {
      orbit += rdt * 0.12;
      want.set(M.center.x + Math.sin(orbit) * 42, 26, M.center.z + 40 * Math.cos(orbit));
      look.copy(M.center);
    }
    // keep the camera out of buildings
    T3.subVectors(want, look); const L = T3.length();
    if (L > 0.1) { T3.multiplyScalar(1 / L); if (City.raycast(look, T3, L)) want.copy(look).addScaledVector(T3, Math.max(2, City.hit.t - 1)); }
    if (!camInit) { camP.copy(want); camL.copy(look); camInit = true; }
    // the chase views hold their place on the bomb or cone (no lag at 100 m/s); the look point and the
    // after-shot orbit ease in
    const k = 1 - Math.exp(-rate * rdt);
    if (rigid) camP.copy(want); else camP.lerp(want, k);
    camL.lerp(look, 1 - Math.exp(-(rigid ? 12 : 6) * rdt));
    cam.position.copy(camP); cam.up.set(0, 1, 0); cam.lookAt(camL);
    cam.fov = M.phase === 'after' ? 50 : 58; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  }
  function begin() { camInit = false; orbit = Math.atan2(M.start.x - M.center.x, M.start.z - M.center.z); }

  return {
    group, M, SC, clear, setup, screen, aim, fire, update, camera, begin,
    ts, done: () => M.done, center: () => M.center, dist: () => M.center.distanceTo(PLAYER.eye),
  };
})();
