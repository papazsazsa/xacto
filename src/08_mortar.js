// ---------------------------------------------------------------------------
// Fire mission: a reward stage on stages 5, 15, 25 (FIRE_MISSION in 00_core.js switches it off). Three targets,
// a different set-up each time from a shuffled rotation (?mission=<name> in the link picks one):
//   checkpoint – three technicals parked at a checkpoint on the main avenue
//   convoy     – three technicals driving in a column up and down the main avenue
//   nest       – three quadcopters hovering over a rooftop
//   motorpool  – three technicals in a side street, out of sight behind the buildings (indirect fire)
//   garage     – three technicals parked on the roof deck of a parking structure
// Lock each one (tap it, or put the crosshairs on it and click); the mortar bomb drops down the tube with a
// thunk; fire, and the camera rides the bomb up its arc. At the top the nose splits into three cones that dive
// onto the three targets (and follow them if they move).
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

  // ---- the three targets
  function clear() {
    for (const tr of M.trucks) group.remove(tr.g);
    for (const d of M.deb) group.remove(d.m);
    for (const c of M.cones) group.remove(c.m);
    M.trucks = []; M.locks = []; M.cones = []; M.deb = []; M.phase = ''; M.done = false; M.on = false;
    bomb.visible = false; for (const c of bombCones) c.visible = true; group.visible = false;
  }
  const footClear = (x, z, y = 0) => {
    let ok = true;
    City.forBoxesNear(x, z, 5, (b) => { if (ok && !b.dead && b.x0 < x + 2.8 && b.x1 > x - 2.8 && b.z0 < z + 2.8 && b.z1 > z - 2.8 && b.y0 < y + 2.2 && b.y1 > y + 0.1) ok = false; });
    return ok;
  };
  const skyClear = (x, z, y = 0) => !City.raycast(T1.set(x, y + 2.3, z), UPV, 140);
  const seen = (x, y, z) => { T2.set(x, y, z).sub(PLAYER.eye); const L = T2.length(); T2.multiplyScalar(1 / L); return !City.raycast(PLAYER.eye, T2, L - 0.6); };
  const inBand = (R, lo, hi) => { const cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2, dx = cx - PLAYER.eye.x, dz = cz - PLAYER.eye.z, d = Math.hypot(dx, dz); return d > lo && d < hi && Math.abs(Math.atan2(dx, -dz)) < 22 * DEG; };
  const onRoof = (R, x, z, m, om) => x > R.x0 + m && x < R.x1 - m && z > R.z0 + m && z < R.z1 - m && R.occ.every((o) => x < o[0] - om || x > o[2] + om || z < o[1] - om || z > o[3] + om);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(gameRand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const QSC = 1.6;   // the nest's drones are drawn half again as big so they read at range
  function addTruck(x, y, z, yaw) {
    const g = Target.truckMesh(); g.position.set(x, y, z); g.rotation.set(0, yaw, 0); g.updateMatrixWorld(true); group.add(g);
    M.trucks.push({ kind: 'car', g, p: new THREE.Vector3(x, y, z), yaw, alive: true, box: [0.92, 0.1, 2.05, 2.45], aimY: 1.0, sc: 1 });
  }
  function addQuad(x, y, z) {
    const g = Target.quadMesh(), yaw = grnd(0, TAU); g.scale.setScalar(QSC); g.position.set(x, y, z); g.rotation.set(0, yaw, 0); g.updateMatrixWorld(true); group.add(g);
    M.trucks.push({ kind: 'quad', g, p: new THREE.Vector3(x, y, z), yaw, alive: true, box: [0.85 * QSC, -0.4 * QSC, 0.4 * QSC, 0.85 * QSC], aimY: 0, sc: QSC, h0: y, ph: grnd(0, TAU) });
  }
  const PLACE = {
    // three technicals at a checkpoint where a cross street meets the main avenue
    checkpoint() {
      const eye = PLAYER.eye;
      for (let a = 0; a < 60; a++) {
        const k = 3 + Math.floor(grnd(0, 3.99)), zc = -k * GRID.stSp + grnd(-8, 8), d = eye.z - zc;
        if (d < 280 || d > 520) continue;
        const cx = grnd(-3, 3), j = () => grnd(-1.5, 1.5);
        const lay = [[cx - 7 + j(), zc + 8 + j(), grnd(-0.5, 0.5)], [cx + 6 + j(), zc + j(), Math.PI / 2 + grnd(-0.4, 0.4)], [cx - 2 + j(), zc - 10 + j(), grnd(2.6, 3.6)]];
        if (lay.every(([x, z]) => Math.abs(x) < GRID.mainHW - 2.6 && footClear(x, z) && skyClear(x, z))) { lay.forEach(([x, z, yaw]) => addTruck(x, 0, z, yaw)); return true; }
      }
      const zc = -4 * GRID.stSp; [[-7, zc + 8, 0], [6, zc, Math.PI / 2], [-2, zc - 10, 3]].forEach(([x, z, yaw]) => addTruck(x, 0, z, yaw));
      return true;
    },
    // a column of three driving laps of the main avenue: away up the right-hand lane, a U-turn, back down the left
    convoy() {
      const eye = PLAYER.eye, lane = 7;
      for (let a = 0; a < 24; a++) {
        const d = grnd(270, 380), span = grnd(140, 190), zN = eye.z - d, zF = zN - span;
        if ([lane, -lane].some((x) => City.raycast(T1.set(x, 1.0, zN + 2), T2.set(0, 0, -1), span + 4))) continue;
        let open = 0, n = 0;
        for (let z = zN; z > zF; z -= 10) for (const x of [lane, -lane]) { n++; if (skyClear(x, z)) open++; }
        if (open < n * (a < 14 ? 0.95 : 0.7)) continue;
        M.loop = { lane, zN, zF, span, L: 2 * span + TAU * lane };
        const s0 = grnd(0, M.loop.L);
        for (let i = 0; i < 3; i++) { const s = s0 - i * 14; loopPos(s, T3); addTruck(T3.x, 0, T3.z, T3.y); const tr = M.trucks[i]; tr.s = s; tr.v = 6; }
        return true;
      }
      return false;
    },
    // three drones hovering in a triangle over a rooftop (below the shooter's eye, so he sees them)
    nest() {
      const pool = shuffle(City.roofs.filter((R) => !R.garage && R.y >= 12 && R.y <= 60 && R.x1 - R.x0 >= 18 && R.z1 - R.z0 >= 18 && inBand(R, 280, 560)));
      for (const R of pool.slice(0, 40)) for (let k = 0; k < 4; k++) {
        const cx = grnd(R.x0 + 6, R.x1 - 6), cz = grnd(R.z0 + 6, R.z1 - 6), a0 = grnd(0, TAU), rr = grnd(5, 7), y = R.y + grnd(3.4, 4.4);
        const pts = [0, 1, 2].map((i) => [cx + Math.cos(a0 + i * TAU / 3) * rr, cz + Math.sin(a0 + i * TAU / 3) * rr]);
        if (!pts.every(([x, z]) => onRoof(R, x, z, 2.2, 1.6) && skyClear(x, z, y) && seen(x, y, z))) continue;
        pts.forEach(([x, z]) => addQuad(x, y + grnd(-0.4, 0.4), z));
        return true;
      }
      return false;
    },
    // three technicals parked nose to tail in a cross street off the avenue, hidden behind the buildings
    motorpool() {
      const eye = PLAYER.eye;
      for (let a = 0; a < 90; a++) {
        const k = 3 + Math.floor(grnd(0, 3.99)), zc = -k * GRID.stSp, sd = grnd() < 0.5 ? -1 : 1;
        const x0 = sd * grnd(GRID.mainHW + 30, GRID.aveSp - GRID.aveHW - 30), d = Math.hypot(x0 - eye.x, zc - eye.z);
        if (d < 280 || d > 560) continue;
        const lay = [-1, 0, 1].map((i) => [x0 + i * 10.5 + grnd(-1, 1), zc + (i === 0 ? 1.6 : -1.6) + grnd(-0.6, 0.6), (gameRand() < 0.5 ? 1 : -1) * Math.PI / 2 + grnd(-0.25, 0.25)]);
        if (!lay.every(([x, z]) => footClear(x, z) && skyClear(x, z))) continue;
        if (a < 60 && lay.filter(([x, z]) => !seen(x, 1.5, z)).length < 2) continue;   // out of sight, mostly
        lay.forEach(([x, z, yaw]) => addTruck(x, 0, z, yaw));
        return true;
      }
      return false;
    },
    // three technicals side by side on a parking structure's roof deck
    garage() {
      const pool = shuffle(City.roofs.filter((R) => R.garage && inBand(R, 230, 650)));
      for (const R of pool) for (let k = 0; k < 10; k++) {
        const yaw = Math.floor(grnd(0, 3.99)) * Math.PI / 2 + grnd(-0.15, 0.15), sx = Math.cos(yaw), sz = -Math.sin(yaw);   // side by side along the truck's right
        const cx = grnd(R.x0 + 7, R.x1 - 7), cz = grnd(R.z0 + 7, R.z1 - 7);
        const lay = [-1, 0, 1].map((i) => [cx + sx * i * 3.4, cz + sz * i * 3.4]);
        if (!lay.every(([x, z]) => onRoof(R, x, z, 3, 1.4) && footClear(x, z, R.y) && skyClear(x, z, R.y))) continue;
        lay.forEach(([x, z]) => addTruck(x, R.y, z, yaw + grnd(-0.1, 0.1)));
        return true;
      }
      return false;
    },
  };
  // the convoy's lap: right-hand lane away from the shooter, a U-turn, the left-hand lane back, a U-turn
  // (out: x, z and the heading as a yaw in .y)
  function loopPos(s, out) {
    const P = M.loop, l = P.lane, h = Math.PI * l; s = ((s % P.L) + P.L) % P.L;
    if (s < P.span) return out.set(l, Math.PI, P.zN - s);
    s -= P.span; if (s < h) { const t = s / l; return out.set(l * Math.cos(t), Math.PI + t, P.zF - l * Math.sin(t)); }
    s -= h; if (s < P.span) return out.set(-l, 0, P.zF + s);
    s -= P.span; const t = s / l; return out.set(-l * Math.cos(t), t, P.zN + l * Math.sin(t));
  }
  const NAMES = ['checkpoint', 'convoy', 'nest', 'motorpool', 'garage'];
  const LABEL = { checkpoint: 'CHECKPOINT', convoy: 'CONVOY', nest: 'DRONE NEST', motorpool: 'MOTOR POOL', garage: 'PARKING DECK' };
  const TALLY = { checkpoint: 'CHECKPOINT DESTROYED', convoy: 'CONVOY DESTROYED', nest: 'DRONES DOWN 3', motorpool: 'MOTOR POOL DESTROYED', garage: 'PARKING DECK CLEARED' };
  let rota = [];
  function setup() {
    clear(); M.on = true; group.visible = true; M.loop = null;
    const asked = M.force || QS.get('mission');   // (M.force: test hook)
    if (!rota.length) rota = shuffle(NAMES.slice());
    const want = NAMES.includes(asked) ? asked : rota.pop();
    M.variant = 'checkpoint';
    for (const v of [want, ...shuffle(NAMES.filter((n) => n !== want && n !== 'checkpoint')), 'checkpoint']) {
      M.trucks.length = 0;
      if (PLACE[v]()) { M.variant = v; break; }
      for (const tr of M.trucks) group.remove(tr.g);
    }
    centre();
  }
  function centre() {
    M.center.set(0, 0, 0);
    for (const tr of M.trucks) M.center.addScaledVector(tr.p, 1 / M.trucks.length);
    M.center.y += 1;
  }
  // the convoy drives on and the drones hover, from the moment the stage starts
  function moveUnits(dt) {
    let moved = false;
    for (const tr of M.trucks) {
      if (!tr.alive) continue;
      if (tr.kind === 'quad') {
        tr.ph += dt; tr.p.y = tr.h0 + 0.45 * Math.sin(tr.ph * 1.3); tr.yaw += dt * 0.25;
        tr.g.position.copy(tr.p); tr.g.rotation.set(0.05 * Math.sin(tr.ph * 0.9), tr.yaw, 0.05 * Math.sin(tr.ph * 1.1), 'YXZ'); tr.g.updateMatrixWorld(true);
      } else if (M.loop) {
        tr.s += tr.v * dt; loopPos(tr.s, T3);
        let dy = T3.y - tr.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); tr.yaw += dy * (1 - Math.exp(-6 * dt));
        tr.p.set(T3.x, tr.p.y, T3.z); tr.g.position.copy(tr.p); tr.g.rotation.set(0, tr.yaw, 0); tr.g.updateMatrixWorld(true); moved = true;
      }
    }
    if (moved) centre();
  }
  // ---- locking: on screen (fractions, y down) each truck's box; a tap or the crosshairs picks the nearest
  function screen(cam) {
    cam.getWorldDirection(T3);
    M.trucks.forEach((tr, i) => {
      const s = SC[i]; let x0 = 9, x1 = -9, y0 = 9, y1 = -9, ok = tr.alive;
      const f = T1.set(Math.sin(tr.yaw), 0, Math.cos(tr.yaw)), r = T2.set(Math.cos(tr.yaw), 0, -Math.sin(tr.yaw)), B = tr.box;
      for (const lx of [-B[0], B[0]]) for (const y of [tr.p.y + B[1], tr.p.y + B[2]]) for (const lz of [-B[3], B[3]]) {
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
      const P3 = tr.p.clone(); P3.y += tr.aimY;
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
    moveUnits(dt);
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
        { const tr = M.trucks[c.ti]; c.P3.copy(tr.p); c.P3.y += tr.aimY; c.P2.copy(c.P3); c.P2.y += 95; }   // it follows a moving target
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
    const c = tr.p.clone(); c.y += tr.aimY;
    if (blast) blast(c, 2);
    tr.g.updateMatrixWorld(true);
    const kids = tr.g.children.slice(), tyres = kids.filter((m) => m.userData.tyre), kick = tyres[Math.floor(Math.random() * tyres.length)];
    for (const m of kids) {
      const p = m.getWorldPosition(new THREE.Vector3()), q = m.getWorldQuaternion(new THREE.Quaternion());
      group.add(m); m.position.copy(p); m.quaternion.copy(q); m.scale.setScalar(tr.sc || 1);
      T1.subVectors(p, tr.p); T1.y = 0; if (T1.lengthSq() < 1e-4) T1.set(grnd(-1, 1), 0, grnd(-1, 1)); T1.normalize();
      const r0 = (m.userData.r || 0.1) * (tr.sc || 1);
      const v = T1.clone().multiplyScalar(grnd(3, 9)); v.y = grnd(6, 14);
      if (m.userData.high) v.y += 6;
      if (m.userData.low) { v.multiplyScalar(0.2); v.y = grnd(2, 3); }
      if (m === kick) { v.copy(T1).multiplyScalar(grnd(9, 12)); v.y = grnd(7, 9); }
      const w = new THREE.Vector3(grnd(-1, 1), grnd(-1, 1), grnd(-1, 1)).normalize().multiplyScalar(grnd(4, 12));
      M.deb.push({ m, p, q, v, w, r: r0, tyre: !!m.userData.tyre, e: m.userData.tyre ? 0.62 : 0.28, rest: false, still: 0, ground: false, roll: 0 });
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
    if (M.phase === 'up' || (M.phase === 'down' && !M.cones.length)) {
      // right behind the bomb the whole way up, the bomb held in the middle of the frame with the city ahead
      // and below, so the split happens in front of you
      const f = T3.set(M.center.x - bombP.x, 0, M.center.z - bombP.z).normalize(), side = T4.crossVectors(f, UPV).normalize();
      want.copy(bombP).addScaledVector(f, -7).addScaledVector(UPV, 2.2).addScaledVector(side, 1.2);
      look.copy(bombP).addScaledVector(f, 22).addScaledVector(UPV, -6.8).addScaledVector(side, 0.4);
      rigid = true;
    } else if (M.phase === 'down') {
      // straight on from behind the bomb to behind one cone (no cut): the camera glides in over about a
      // second while the view turns down from the cones' path to the targets, then holds tight on the cone
      const c = M.cones.find((q) => !q.hit && q.ti === M.locks[1]) || M.cones.find((q) => !q.hit) || M.cones[0];
      bezD(c, Math.max(0.001, Math.pow(Math.min(1, c.t / c.D), 1.5)), T3).normalize();
      const since = M.t - M.splitT;
      want.copy(c.p).addScaledVector(T3, -6).addScaledVector(UPV, 1.4);
      look.copy(c.p).addScaledVector(T3, 20).lerp(M.center, sstep(0.25, 1.3, since));
      if (since < 1.3) rate = 5; else rigid = !c.hit;
    } else {
      orbit += rdt * 0.12;
      want.set(M.center.x + Math.sin(orbit) * 42, M.center.y + 25, M.center.z + 40 * Math.cos(orbit));
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
    label: () => LABEL[M.variant] || 'FIRE MISSION', tally: () => TALLY[M.variant] || 'TARGETS DESTROYED 3',
  };
})();
