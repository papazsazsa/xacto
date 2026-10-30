// ---------------------------------------------------------------------------
// Target: low-poly articulated man. Procedural walk / smoke / phone idles.
// On hit he becomes a Verlet ragdoll and gets launched (cartoon, no gore).
// ---------------------------------------------------------------------------
const Target = (() => {
  const J = { head: 0, neck: 1, chest: 2, pelvis: 3, lSh: 4, lEl: 5, lHa: 6, rSh: 7, rEl: 8, rHa: 9, lHip: 10, lKn: 11, lFt: 12, rHip: 13, rKn: 14, rFt: 15 };
  const NJ = 16;
  const jp = Array.from({ length: NJ }, () => new THREE.Vector3());   // world joint positions
  const loc = Array.from({ length: NJ }, () => new THREE.Vector3());  // local pose
  const P = Array.from({ length: NJ }, () => new THREE.Vector3());
  const PP = Array.from({ length: NJ }, () => new THREE.Vector3());
  const group = new THREE.Group();
  const M = (t) => thermalMat(FS_SOLID, { uT: { value: t }, uStripe: { value: 0 } });
  const mat = { skin: M(0.95), cloth: M(0.82), legs: M(0.76), shoe: M(0.56), hat: M(0.6), ember: M(1.25) };

  const Y = new THREE.Vector3(0, 1, 0);
  function limb(r, L, m) { const g = new THREE.CapsuleGeometry(r, L, 1, 6); const mesh = new THREE.Mesh(g, m); mesh.userData.L = L; group.add(mesh); return mesh; }
  const parts = {
    head: new THREE.Mesh(new THREE.IcosahedronGeometry(0.112, 1), mat.skin),
    torso: limb(0.16, 0.30, mat.cloth),
    pelvis: new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 0), mat.legs),
    lUA: limb(0.056, 0.26, mat.cloth), lFA: limb(0.047, 0.24, mat.cloth),
    rUA: limb(0.056, 0.26, mat.cloth), rFA: limb(0.047, 0.24, mat.cloth),
    lTh: limb(0.078, 0.40, mat.legs), lSn: limb(0.062, 0.41, mat.legs),
    rTh: limb(0.078, 0.40, mat.legs), rSn: limb(0.062, 0.41, mat.legs),
    lHa: new THREE.Mesh(new THREE.IcosahedronGeometry(0.052, 0), mat.skin), rHa: new THREE.Mesh(new THREE.IcosahedronGeometry(0.052, 0), mat.skin),
    lFt: new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.27), mat.shoe), rFt: new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.27), mat.shoe),
    ember: new THREE.Mesh(new THREE.IcosahedronGeometry(0.022, 0), mat.ember),
  };
  const hat = new THREE.Group();
  hat.add(new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.018, 9), mat.hat));
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.112, 0.11, 9), mat.hat); crown.position.y = 0.06; hat.add(crown);
  for (const k of ['head', 'pelvis', 'lHa', 'rHa', 'lFt', 'rFt', 'ember']) group.add(parts[k]);
  group.add(hat);
  group.traverse((o) => { o.frustumCulled = false; });

  const S = {
    alive: false, mode: 'idle', ragdoll: false, settled: false,
    root: new THREE.Vector3(), yaw: 0, yawT: 0, phase: 0, speed: 0, gait: 0,
    A: new THREE.Vector3(), B: new THREE.Vector3(), goingB: true, pause: 0,
    behavior: 'patrol', t: 0, smoke: 0, smokeT: 4, phone: 0, headYaw: 0, spooked: false,
    roof: null, dist: 0, puff: 0, simAcc: 0, settleT: 0, hatFree: false,
  };
  const chest = new THREE.Vector3(), headPos = new THREE.Vector3();
  const hatS = { p: new THREE.Vector3(), pp: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3() };

  // ---- pose -------------------------------------------------------------
  function legPose(s, ph, amp, flex, hipOut, kneeOut, footOut) {
    const p = ph + (s > 0 ? Math.PI : 0);
    const a = amp * Math.sin(p);
    const k = flex * Math.pow(Math.max(0, Math.cos(p)), 1.5) + 0.06;
    hipOut.set(s * 0.1, 0.93, 0);
    kneeOut.set(hipOut.x, hipOut.y - 0.44 * Math.cos(a), hipOut.z + 0.44 * Math.sin(a));
    footOut.set(kneeOut.x, kneeOut.y - 0.45 * Math.cos(a - k), kneeOut.z + 0.45 * Math.sin(a - k));
  }
  function armPose(s, ph, amp, shOut, elOut, haOut) {
    const p = ph + (s > 0 ? 0 : Math.PI);
    const b = amp * Math.sin(p);
    const e = 0.22 + 0.35 * amp * Math.max(0, Math.sin(p));
    shOut.set(s * 0.2, 1.45, 0);
    elOut.set(shOut.x + s * 0.05, shOut.y - 0.29 * Math.cos(b), shOut.z + 0.29 * Math.sin(b));
    haOut.set(elOut.x + s * 0.01, elOut.y - 0.28 * Math.cos(b + e), elOut.z + 0.28 * Math.sin(b + e));
  }
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  function computePose() {
    const g = S.gait; // 0 idle, 1 walk, 2 run
    const amp = g < 1 ? 0.06 * g : g < 2 ? lerp(0.42, 0.75, g - 1) : 0.75;
    const flex = g < 1 ? 0.1 * g : lerp(0.75, 1.5, Math.min(1, g - 1));
    const armAmp = g < 1 ? 0.05 : lerp(0.35, 0.9, Math.min(1, g - 1));
    const ph = S.phase;
    legPose(-1, ph, amp, flex, loc[J.lHip], loc[J.lKn], loc[J.lFt]);
    legPose(1, ph, amp, flex, loc[J.rHip], loc[J.rKn], loc[J.rFt]);
    armPose(-1, ph, armAmp, loc[J.lSh], loc[J.lEl], loc[J.lHa]);
    armPose(1, ph, armAmp, loc[J.rSh], loc[J.rEl], loc[J.rHa]);
    const sway = g < 0.5 ? 0.02 * Math.sin(S.t * 0.9) : 0;
    loc[J.pelvis].set(sway, 0.97, 0);
    const lean = g > 1 ? 0.1 * Math.min(1, g - 1) : 0.0;
    loc[J.chest].set(sway * 0.5, 1.30, 0.01 + lean * 0.4);
    loc[J.neck].set(sway * 0.3, 1.50, 0.02 + lean);
    loc[J.head].set(sway * 0.2, 1.665, 0.035 + lean * 1.2);
    loc[J.lSh].z += lean; loc[J.rSh].z += lean; loc[J.lEl].z += lean; loc[J.rEl].z += lean; loc[J.lHa].z += lean; loc[J.rHa].z += lean;
    // right arm overrides: smoking / phone
    if (S.smoke > 0.001) {
      _a.set(0.21, 1.33, 0.16); _b.set(0.05, 1.60, 0.15);
      loc[J.rEl].lerp(_a, S.smoke); loc[J.rHa].lerp(_b, S.smoke);
    }
    if (S.phone > 0.001) {
      _a.set(0.25, 1.40, 0.06); _b.set(0.13, 1.66, 0.03);
      loc[J.rEl].lerp(_a, S.phone); loc[J.rHa].lerp(_b, S.phone);
    }
    // plant the lowest foot on the roof
    const minY = Math.min(loc[J.lFt].y, loc[J.rFt].y);
    const dy = 0.075 - minY + (g > 1.5 ? 0.04 * Math.abs(Math.sin(ph)) : 0);
    for (let i = 0; i < NJ; i++) loc[i].y += dy;
    const c = Math.cos(S.yaw), s = Math.sin(S.yaw);
    for (let i = 0; i < NJ; i++) { const l = loc[i]; jp[i].set(S.root.x + l.x * c + l.z * s, S.root.y + l.y, S.root.z - l.x * s + l.z * c); }
  }

  // ---- rendering from joints --------------------------------------------
  const _d = new THREE.Vector3(), _m4 = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
  function placeLimb(mesh, a, b) {
    _d.subVectors(b, a); const len = _d.length() || 1e-3;
    mesh.position.addVectors(a, b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(Y, _d.multiplyScalar(1 / len));
    mesh.scale.set(1, len / mesh.userData.L, 1);
  }
  function torsoBasis(J3) {
    _y.subVectors(J3[J.neck], J3[J.pelvis]).normalize();
    _x.subVectors(J3[J.rSh], J3[J.lSh]); _x.addScaledVector(_y, -_x.dot(_y)).normalize();
    _z.crossVectors(_x, _y).normalize();
    _m4.makeBasis(_x, _y, _z);
  }
  function render(J3) {
    torsoBasis(J3);
    const tq = new THREE.Quaternion().setFromRotationMatrix(_m4);
    const T = parts.torso;
    _d.subVectors(J3[J.neck], J3[J.pelvis]); const tl = _d.length();
    T.position.addVectors(J3[J.neck], J3[J.pelvis]).multiplyScalar(0.5); T.quaternion.copy(tq); T.scale.set(1.32, tl / 0.5, 0.74);
    parts.pelvis.position.copy(J3[J.pelvis]); parts.pelvis.quaternion.copy(tq); parts.pelvis.scale.set(1.2, 0.8, 0.85);
    parts.head.position.copy(J3[J.head]); parts.head.quaternion.copy(tq);
    placeLimb(parts.lUA, J3[J.lSh], J3[J.lEl]); placeLimb(parts.lFA, J3[J.lEl], J3[J.lHa]);
    placeLimb(parts.rUA, J3[J.rSh], J3[J.rEl]); placeLimb(parts.rFA, J3[J.rEl], J3[J.rHa]);
    placeLimb(parts.lTh, J3[J.lHip], J3[J.lKn]); placeLimb(parts.lSn, J3[J.lKn], J3[J.lFt]);
    placeLimb(parts.rTh, J3[J.rHip], J3[J.rKn]); placeLimb(parts.rSn, J3[J.rKn], J3[J.rFt]);
    parts.lHa.position.copy(J3[J.lHa]); parts.rHa.position.copy(J3[J.rHa]);
    parts.lFt.position.copy(J3[J.lFt]).addScaledVector(_z, 0.07); parts.lFt.quaternion.copy(tq);
    parts.rFt.position.copy(J3[J.rFt]).addScaledVector(_z, 0.07); parts.rFt.quaternion.copy(tq);
    parts.ember.visible = S.smoke > 0.6 && !S.ragdoll;
    parts.ember.position.copy(J3[J.rHa]).addScaledVector(_z, 0.06);
    mat.ember.uniforms.uT.value = 0.9 + 0.5 * S.puff;
    if (!S.hatFree) {
      _y.subVectors(J3[J.head], J3[J.neck]).normalize();
      hat.position.copy(J3[J.head]).addScaledVector(_y, 0.085);
      hat.quaternion.copy(tq).multiply(new THREE.Quaternion().setFromAxisAngle(Y, S.headYaw));
    } else { hat.position.copy(hatS.p); hat.quaternion.copy(hatS.q); }
    chest.lerpVectors(J3[J.pelvis], J3[J.neck], 0.62);
    headPos.copy(J3[J.head]);
  }

  // ---- spawning -----------------------------------------------------------
  function rangeFor(stage) {
    const lo = Math.min(1500, 330 + 170 * (stage - 1)), hi = Math.min(2100, lo + 220 + 40 * stage);
    return [lo, hi];
  }
  const _o = new THREE.Vector3(), _dir = new THREE.Vector3();
  function visibleFrom(eye, p) {
    _dir.subVectors(p, eye); const d = _dir.length(); _dir.multiplyScalar(1 / d);
    if (!City.raycast(eye, _dir, d)) return true;
    return City.hit.t > d - 0.6;
  }
  function freeOnRoof(R, x, z, m = 1.3) {
    if (x < R.x0 + m || x > R.x1 - m || z < R.z0 + m || z > R.z1 - m) return false;
    for (const o of R.occ) if (x > o[0] - 0.8 && x < o[2] + 0.8 && z > o[1] - 0.8 && z < o[3] + 0.8) return false;
    return true;
  }
  function spawn(stage) {
    const eye = PLAYER.eye; const [lo, hi] = rangeFor(stage);
    const pool = City.roofs.filter((R) => {
      const cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2;
      const d = Math.hypot(cx - eye.x, cz - eye.z);
      const yaw = Math.atan2(cx - eye.x, -(cz - eye.z));
      return d > lo && d < hi && Math.abs(yaw) < 40 * DEG && R.x1 - R.x0 > 9 && R.z1 - R.z0 > 9 && R.y < 160;
    });
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(gameRand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const tmp = new THREE.Vector3();
    for (let attempt = 0; attempt < Math.min(pool.length, 80); attempt++) {
      const R = pool[attempt];
      for (let k = 0; k < 10; k++) {
        const ax = grnd(R.x0 + 1.5, R.x1 - 1.5), az = grnd(R.z0 + 1.5, R.z1 - 1.5);
        const ang = grnd(0, TAU), len = grnd(4, Math.min(14, Math.max(R.x1 - R.x0, R.z1 - R.z0) * 0.7));
        const bx = ax + Math.cos(ang) * len, bz = az + Math.sin(ang) * len;
        let ok = true, vis = 0, nS = 6;
        for (let s = 0; s <= nS; s++) {
          const x = lerp(ax, bx, s / nS), z = lerp(az, bz, s / nS);
          if (!freeOnRoof(R, x, z)) { ok = false; break; }
          if (visibleFrom(eye, tmp.set(x, R.y + 1.35, z))) vis++;
        }
        if (!ok || vis < nS) continue;
        place(R, ax, az, bx, bz, stage);
        return true;
      }
    }
    // fallback: any roof in range, no visibility requirement
    const R = pool[0] || City.roofs[Math.floor(City.roofs.length / 2)];
    const cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2;
    place(R, cx - 2, cz, cx + 2, cz, stage);
    return false;
  }
  function place(R, ax, az, bx, bz, stage) {
    S.roof = R; S.alive = true; S.ragdoll = false; S.settled = false; S.hatFree = false; S.spooked = false;
    S.A.set(ax, R.y, az); S.B.set(bx, R.y, bz); S.root.copy(S.A); S.goingB = true; S.pause = grnd(0, 2);
    const r = gameRand();
    S.behavior = stage <= 1 ? (r < 0.6 ? 'smoke' : 'patrol') : r < 0.25 ? 'smoke' : r < 0.45 ? 'phone' : 'patrol';
    S.yaw = Math.atan2(bx - ax, bz - az); S.yawT = S.yaw;
    if (S.behavior !== 'patrol') { S.yaw = S.yawT = Math.atan2(PLAYER.eye.x - ax, PLAYER.eye.z - az) + grnd(-1.2, 1.2); }
    S.gait = 0; S.phase = 0; S.t = 0; S.smoke = 0; S.phone = S.behavior === 'phone' ? 1 : 0; S.smokeT = grnd(1, 4);
    S.dist = S.root.distanceTo(PLAYER.eye);
    group.visible = true;
    computePose(); render(jp);
  }

  // ---- behaviour update --------------------------------------------------
  function update(dt) {
    if (!group.visible) return;
    S.t += dt;
    if (S.ragdoll) { simulate(dt); render(P); return; }
    const runSpeed = 4.6, walkSpeed = S.behavior === 'phone' ? 0.8 : 1.35;
    let wantGait = 0, speed = 0;
    if (S.spooked || S.behavior === 'patrol' || S.behavior === 'phone') {
      if (S.pause > 0) { S.pause -= dt; }
      else {
        const goal = S.goingB ? S.B : S.A;
        _d.subVectors(goal, S.root); _d.y = 0; const dist = _d.length();
        S.yawT = Math.atan2(_d.x, _d.z);
        if (dist < 0.25) { S.goingB = !S.goingB; S.pause = S.spooked ? grnd(0, 0.4) : grnd(1.2, 4); }
        else {
          const yawErr = Math.atan2(Math.sin(S.yawT - S.yaw), Math.cos(S.yawT - S.yaw));
          speed = (S.spooked ? runSpeed : walkSpeed) * clamp(1 - Math.abs(yawErr) / 1.4, 0, 1);
          wantGait = S.spooked ? 2 : 1;
          S.root.addScaledVector(_d.normalize(), Math.min(dist, speed * dt));
        }
      }
    }
    const yerr = Math.atan2(Math.sin(S.yawT - S.yaw), Math.cos(S.yawT - S.yaw));
    S.yaw += yerr * (1 - Math.exp(-6 * dt));
    S.gait = damp(S.gait, wantGait, 5, dt);
    const stride = S.gait > 1.5 ? 2.6 : 1.5;
    S.phase += (TAU * Math.max(speed, S.gait > 0.3 ? 0.3 : 0)) / stride * dt;
    if (S.gait < 0.15) S.phase = damp(S.phase, Math.round(S.phase / Math.PI) * Math.PI, 3, dt);
    // smoking cycle
    if (S.behavior === 'smoke' && !S.spooked) {
      S.smokeT -= dt;
      if (S.smokeT < 0) S.smokeT = grnd(5, 9);
      const raising = S.smokeT > 0 && S.smokeT < 2.4;
      S.smoke = damp(S.smoke, raising ? 1 : 0, 4, dt);
      S.puff = raising && S.smokeT < 1.6 ? 1 : damp(S.puff, 0, 2, dt);
      if (S.smokeT > 4.8 && S.smokeT < 5.0 && gameRand() < 0.2) FX.spawn(headPos.x, headPos.y, headPos.z, grnd(-0.2, 0.2), 0.4, grnd(-0.2, 0.2), 2, 0.1, 0.6, 0.06, 0.6, 0.3);
    } else { S.smoke = damp(S.smoke, 0, 4, dt); }
    if (S.spooked) S.phone = damp(S.phone, 0, 6, dt);
    S.headYaw = 0.55 * Math.sin(S.t * 0.37) * Math.sin(S.t * 0.13 + 1.0);
    computePose(); render(jp);
    S.dist = chest.distanceTo(PLAYER.eye);
  }
  function spook() {
    if (S.ragdoll || S.spooked || !S.alive) return;
    S.spooked = true; S.behavior = 'patrol'; S.pause = 0.25;
    const R = S.roof;
    for (let k = 0; k < 20; k++) { const x = grnd(R.x0 + 1.5, R.x1 - 1.5), z = grnd(R.z0 + 1.5, R.z1 - 1.5); if (freeOnRoof(R, x, z) && Math.hypot(x - S.root.x, z - S.root.z) > 5) { S.A.copy(S.root); S.B.set(x, R.y, z); S.goingB = true; break; } }
  }

  // ---- hit testing ----------------------------------------------------------
  const CAPS = [
    [J.head, J.head, 0.15, 'head'], [J.pelvis, J.neck, 0.21, 'torso'],
    [J.lSh, J.lEl, 0.08, 'arm'], [J.lEl, J.lHa, 0.075, 'arm'], [J.rSh, J.rEl, 0.08, 'arm'], [J.rEl, J.rHa, 0.075, 'arm'],
    [J.lHip, J.lKn, 0.1, 'leg'], [J.lKn, J.lFt, 0.085, 'leg'], [J.rHip, J.rKn, 0.1, 'leg'], [J.rKn, J.rFt, 0.085, 'leg'],
  ];
  // closest points between segments p1q1 and p2q2 -> returns squared distance, sets s,t
  const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3(), _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
  let segS = 0;
  function segSeg(p1, q1, p2, q2) {
    _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _r.subVectors(p1, p2);
    const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
    let s, t;
    if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
    else if (a <= 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
    else {
      const c = _d1.dot(_r);
      if (e <= 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
      else {
        const b = _d1.dot(_d2), den = a * e - b * b;
        s = den !== 0 ? clamp((b * f - c * e) / den, 0, 1) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
      }
    }
    _c1.copy(p1).addScaledVector(_d1, s); _c2.copy(p2).addScaledVector(_d2, t);
    segS = s; return _c1.distanceToSquared(_c2);
  }
  const hitRes = { t: 0, part: '', point: new THREE.Vector3(), centre: 0 };
  function segmentHit(a, b) {
    if (!S.alive || S.ragdoll) return null;
    // quick reject
    _r.subVectors(chest, a); _d1.subVectors(b, a); const L2 = _d1.lengthSq();
    const tt = clamp(_r.dot(_d1) / L2, 0, 1); _c1.copy(a).addScaledVector(_d1, tt);
    if (_c1.distanceToSquared(chest) > 9) return null;
    let best = 2, found = null;
    const Jw = jp;
    for (const c of CAPS) {
      const d2 = segSeg(a, b, Jw[c[0]], Jw[c[1]]);
      if (d2 < c[2] * c[2] && segS < best) { best = segS; found = c; }
    }
    if (!found) return null;
    hitRes.t = best; hitRes.part = found[3]; hitRes.point.copy(a).lerp(b, best);
    // centre-mass accuracy (distance of the bullet line from the chest)
    hitRes.centre = Math.sqrt(segSeg(a, b, chest, chest));
    return hitRes;
  }
  function distToSegment(a, b) { return Math.sqrt(segSeg(a, b, chest, chest)); }

  // ---- ragdoll ------------------------------------------------------------
  const CONS = [];
  const MINC = [[J.lSh, J.lHa, 0.2], [J.rSh, J.rHa, 0.2], [J.lHip, J.lFt, 0.33], [J.rHip, J.rFt, 0.33], [J.lKn, J.rKn, 0.12], [J.lFt, J.rFt, 0.1], [J.lHa, J.pelvis, 0.12], [J.rHa, J.pelvis, 0.12], [J.head, J.chest, 0.2]];
  const PAIRS = [
    [J.head, J.neck], [J.head, J.lSh], [J.head, J.rSh], [J.neck, J.chest], [J.chest, J.pelvis], [J.neck, J.lSh], [J.neck, J.rSh], [J.lSh, J.rSh],
    [J.chest, J.lSh], [J.chest, J.rSh], [J.lSh, J.lHip], [J.rSh, J.rHip], [J.lSh, J.rHip], [J.rSh, J.lHip], [J.pelvis, J.lHip], [J.pelvis, J.rHip], [J.lHip, J.rHip], [J.neck, J.pelvis], [J.chest, J.lHip], [J.chest, J.rHip],
    [J.lSh, J.lEl], [J.lEl, J.lHa], [J.rSh, J.rEl], [J.rEl, J.rHa], [J.lHip, J.lKn], [J.lKn, J.lFt], [J.rHip, J.rKn], [J.rKn, J.rFt],
  ];
  let near = [];
  const RAD = 0.075, SUB = 1 / 240;
  function launch(point, dir, part) {
    S.ragdoll = true; S.alive = false; S.settled = false; S.simAcc = 0; S.settleT = 0;
    for (let i = 0; i < NJ; i++) { P[i].copy(jp[i]); }
    CONS.length = 0;
    for (const [a, b] of PAIRS) CONS.push([a, b, P[a].distanceTo(P[b])]);
    const com = new THREE.Vector3(); P.forEach((p) => com.add(p)); com.multiplyScalar(1 / NJ);
    const hd = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const base = hd.clone().multiplyScalar(grnd(10, 13)).add(new THREE.Vector3(0, grnd(5.5, 7.5), 0));
    const axis = new THREE.Vector3().crossVectors(UP, hd).normalize();   // tumble axis
    const spin = axis.multiplyScalar(grnd(7, 11)).add(new THREE.Vector3(0, grnd(-3, 3), 0));
    const v = new THREE.Vector3(), rel = new THREE.Vector3();
    for (let i = 0; i < NJ; i++) {
      rel.subVectors(P[i], com);
      v.copy(base).add(new THREE.Vector3().crossVectors(spin, rel));
      const dHit = P[i].distanceTo(point); v.addScaledVector(hd, 6 * Math.exp(-dHit * 3));
      v.x += grnd(-0.8, 0.8); v.y += grnd(-0.5, 0.8); v.z += grnd(-0.8, 0.8);
      PP[i].copy(P[i]).addScaledVector(v, -SUB);
    }
    // hat pops off
    S.hatFree = true;
    hatS.p.copy(hat.position); hatS.q.copy(hat.quaternion);
    const hv = hd.clone().multiplyScalar(grnd(4, 7)).add(new THREE.Vector3(grnd(-1.5, 1.5), grnd(5, 8), grnd(-1.5, 1.5)));
    hatS.pp.copy(hatS.p).addScaledVector(hv, -SUB);
    hatS.w.set(grnd(-14, 14), grnd(-20, 20), grnd(-14, 14));
    FX.puff(point, dir, 30);
  }
  function collide(p, pp, r, fric, rest) {
    let hitAny = false;
    if (p.y < r) { const vy = p.y - pp.y; p.y = r; const vx = p.x - pp.x, vz = p.z - pp.z; pp.x = p.x - vx * (1 - fric); pp.z = p.z - vz * (1 - fric); pp.y = p.y + vy * rest; hitAny = true; }
    for (let k = 0; k < near.length; k++) {
      const b = near[k];
      if (p.x < b.x0 - r || p.x > b.x1 + r || p.y < b.y0 - r || p.y > b.y1 + r || p.z < b.z0 - r || p.z > b.z1 + r) continue;
      const pen = [p.x - (b.x0 - r), (b.x1 + r) - p.x, p.y - (b.y0 - r), (b.y1 + r) - p.y, p.z - (b.z0 - r), (b.z1 + r) - p.z];
      let mi = 0; for (let i = 1; i < 6; i++) if (pen[i] < pen[mi]) mi = i;
      const ax = mi >> 1, sg = mi & 1 ? 1 : -1;
      const v = [p.x - pp.x, p.y - pp.y, p.z - pp.z];
      if (ax === 0) p.x += sg * pen[mi]; else if (ax === 1) p.y += sg * pen[mi]; else p.z += sg * pen[mi];
      const vn = v[ax] * sg;
      if (vn < 0) { v[ax] = -vn * rest * sg; }
      for (let i = 0; i < 3; i++) if (i !== ax) v[i] *= 1 - fric;
      pp.set(p.x - v[0], p.y - v[1], p.z - v[2]);
      hitAny = true;
    }
    return hitAny;
  }
  const _t = new THREE.Vector3();
  function simulate(dt) {
    if (S.settled) return;
    S.simAcc += Math.min(dt, 0.05);
    const com = _t.set(0, 0, 0); P.forEach((p) => com.add(p)); com.multiplyScalar(1 / NJ);
    near = []; City.forBoxesNear(com.x, com.z, 6, (b) => near.push(b));
    let moving = 0;
    while (S.simAcc >= SUB) {
      S.simAcc -= SUB;
      for (let i = 0; i < NJ; i++) {
        const p = P[i], pp = PP[i];
        const vx = (p.x - pp.x) * 0.999, vy = (p.y - pp.y) * 0.999, vz = (p.z - pp.z) * 0.999;
        pp.copy(p); p.x += vx; p.y += vy - PHYS.g * SUB * SUB; p.z += vz;
      }
      for (let it = 0; it < 8; it++) {
        for (const c of CONS) {
          const a = P[c[0]], b = P[c[1]]; _d.subVectors(b, a); const L = _d.length() || 1e-6; const diff = (L - c[2]) / L * 0.5;
          a.addScaledVector(_d, diff); b.addScaledVector(_d, -diff);
        }
        for (const c of MINC) {
          const a = P[c[0]], b = P[c[1]]; _d.subVectors(b, a); const L = _d.length() || 1e-6; if (L >= c[2]) continue; const diff = (L - c[2]) / L * 0.5;
          a.addScaledVector(_d, diff); b.addScaledVector(_d, -diff);
        }
        for (let i = 0; i < NJ; i++) collide(P[i], PP[i], i === J.head ? 0.11 : RAD, 0.35, 0.3);
      }
      // hat
      if (S.hatFree) {
        const vx = (hatS.p.x - hatS.pp.x) * 0.995, vy = (hatS.p.y - hatS.pp.y) * 0.995, vz = (hatS.p.z - hatS.pp.z) * 0.995;
        hatS.pp.copy(hatS.p); hatS.p.x += vx; hatS.p.y += vy - PHYS.g * SUB * SUB * 0.8; hatS.p.z += vz;
        const grounded = collide(hatS.p, hatS.pp, 0.04, 0.6, 0.2);
        if (grounded) hatS.w.multiplyScalar(0.9);
        const wl = hatS.w.length();
        if (wl > 1e-3) { const dq = new THREE.Quaternion().setFromAxisAngle(_d.copy(hatS.w).multiplyScalar(1 / wl), wl * SUB); hatS.q.premultiply(dq); }
      }
    }
    for (let i = 0; i < NJ; i++) moving = Math.max(moving, P[i].distanceTo(PP[i]) / SUB);
    if (moving < 0.15) { S.settleT += dt; if (S.settleT > 1.2) S.settled = true; } else S.settleT = 0;
  }
  function hide() { group.visible = false; S.alive = false; }
  function centroid(out) { out.set(0, 0, 0); (S.ragdoll ? P : jp).forEach((p) => out.add(p)); return out.multiplyScalar(1 / NJ); }
  hide();
  return { group, spawn, update, segmentHit, distToSegment, launch, spook, hide, centroid, chest, head: headPos, S, rangeFor, J, joints: () => (S.ragdoll ? P : jp) };
})();
