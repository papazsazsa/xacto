// ---------------------------------------------------------------------------
// Bullet: EXACTO-style guided .50 round. Real ballistics (gravity, quadratic
// drag in moving air) plus limited, laggy, noisy steering authority with a
// finite control budget. Includes the round's visuals: body, canard fins,
// cooling heat trace and air-mote speed streaks.
// ---------------------------------------------------------------------------
const Bullet = (() => {
  const S = {
    active: false, t: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), pPrev: new THREE.Vector3(),
    origin: new THREE.Vector3(), aim: new THREE.Vector3(),
    aMax: 26, tau: 0.16, budget: 14, budget0: 14,
    aCur: new THREE.Vector2(), cmd: new THREE.Vector2(), roll: 0,
    windMean: new THREE.Vector3(), wind: new THREE.Vector3(),
    minDist: Infinity, travelled: 0, spin: 0, depleted: false,
  };
  let gustX = new OU(1.6, 1.2), gustZ = new OU(1.6, 0.8), turbX = new OU(0.3, 2), turbY = new OU(0.3, 2), rollOU = new OU(1.2, 0.15);
  const f = new THREE.Vector3(), r = new THREE.Vector3(), u = new THREE.Vector3(), tmp = new THREE.Vector3(), vrel = new THREE.Vector3();

  // ---- visuals --------------------------------------------------------------
  const group = new THREE.Group();
  const hot = thermalMat(FS_SOLID, { uT: { value: 1.05 }, uStripe: { value: 0 } });
  const warm = thermalMat(FS_SOLID, { uT: { value: 0.75 }, uStripe: { value: 0 } });
  const SC = 2.4; // visual exaggeration so the round reads in the chase cam
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.0064 * SC, 0.0064 * SC, 0.035 * SC, 8).rotateX(Math.PI / 2), warm);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.0064 * SC, 0.03 * SC, 8).rotateX(Math.PI / 2).translate(0, 0, 0.0325 * SC), hot);
  const boat = new THREE.Mesh(new THREE.CylinderGeometry(0.0064 * SC, 0.0052 * SC, 0.01 * SC, 8).rotateX(Math.PI / 2).translate(0, 0, -0.0225 * SC), warm);
  const spinner = new THREE.Group(); spinner.add(body, nose, boat);
  const fins = [];
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.0012 * SC, 0.009 * SC, 0.014 * SC).translate(0, 0.0105 * SC, 0), warm);
    const holder = new THREE.Group(); holder.rotation.z = (i * Math.PI) / 2; holder.position.z = 0.012 * SC; holder.add(fin); spinner.add(holder); fins.push(fin);
  }
  group.add(spinner);
  group.traverse((o) => (o.frustumCulled = false));

  // heat trace: a 1px vector line that cools over time
  const TR = 900;
  const trPos = new Float32Array(TR * 3), trHeat = new Float32Array(TR), trT = new Float32Array(TR);
  const trGeo = new THREE.BufferGeometry();
  trGeo.setAttribute('position', new THREE.BufferAttribute(trPos, 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setAttribute('aHeat', new THREE.BufferAttribute(trHeat, 1).setUsage(THREE.DynamicDrawUsage));
  const lineMat = new THREE.ShaderMaterial({
    uniforms: { uFogD: U.uFogD },
    vertexShader: `uniform float uFogD; attribute float aHeat; varying float vH; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vH = aHeat*exp(-(-mv.z)*uFogD); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying float vH; void main(){ gl_FragColor = vec4(vH, 0.0, 0.0, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const trail = new THREE.Line(trGeo, lineMat); trail.frustumCulled = false; trail.renderOrder = 7;
  let trN = 0, trAcc = 0;

  // speed streaks: motes in the air that streak past the chase camera
  const NM = 260;
  const mPos = new Float32Array(NM * 6), mHeat = new Float32Array(NM * 2), motes = [];
  const mGeo = new THREE.BufferGeometry();
  mGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3).setUsage(THREE.DynamicDrawUsage));
  mGeo.setAttribute('aHeat', new THREE.BufferAttribute(mHeat, 1).setUsage(THREE.DynamicDrawUsage));
  const streaks = new THREE.LineSegments(mGeo, lineMat); streaks.frustumCulled = false; streaks.renderOrder = 7;
  for (let i = 0; i < NM; i++) motes.push(new THREE.Vector3(1e6, 0, 0));

  const root = new THREE.Group(); root.add(group, trail, streaks);
  group.visible = false; streaks.visible = false;

  // ---- physics ----------------------------------------------------------------
  function accel(p, v, out, guided) {
    vrel.subVectors(v, S.wind);
    const sp = vrel.length();
    out.copy(vrel).multiplyScalar(-PHYS.k * sp);
    out.y -= PHYS.g;
    return out;
  }
  // Ballistic computer: superelevation so an unguided round (no wind) crosses the lased range on the aim line
  function solveLaunch(origin, dir, range, out) {
    const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
    let lo = 0, hi = 0.06, ang = 0.002;
    const q = new THREE.Quaternion(), d = new THREE.Vector3(), p = new THREE.Vector3(), v = new THREE.Vector3(), a = new THREE.Vector3();
    const saveW = S.wind.clone(); S.wind.set(0, 0, 0);
    const missAt = (an) => {
      q.setFromAxisAngle(right, an); d.copy(dir).applyQuaternion(q);
      p.copy(origin); v.copy(d).multiplyScalar(PHYS.v0);
      for (let i = 0; i < 2000; i++) {
        const dt = 0.004; accel(p, v, a); v.addScaledVector(a, dt); p.addScaledVector(v, dt);
        if (tmp.subVectors(p, origin).dot(dir) >= range) break;
      }
      // signed vertical miss relative to the aim line point
      return p.y - (origin.y + dir.y * tmp.subVectors(p, origin).dot(dir) / dir.dot(dir));
    };
    for (let it = 0; it < 22; it++) { ang = 0.5 * (lo + hi); if (missAt(ang) < 0) lo = ang; else hi = ang; }
    S.wind.copy(saveW);
    q.setFromAxisAngle(right, ang); out.copy(dir).applyQuaternion(q);
    return ang;
  }
  function fire(origin, dir, opt) {
    S.active = true; S.t = 0; S.p.copy(origin); S.pPrev.copy(origin); S.origin.copy(origin);
    S.v.copy(dir).multiplyScalar(PHYS.v0);
    S.aMax = opt.aMax; S.tau = opt.tau; S.budget = S.budget0 = opt.budget;
    S.aCur.set(0, 0); S.cmd.set(0, 0); S.minDist = Infinity; S.travelled = 0; S.depleted = false;
    S.windMean.copy(opt.wind); S.wind.copy(opt.wind);
    gustX = new OU(1.6, opt.gust); gustZ = new OU(1.6, opt.gust * 0.6);
    turbX = new OU(0.3, opt.turb); turbY = new OU(0.3, opt.turb); rollOU = new OU(1.2, opt.roll); S.roll = 0;
    group.visible = true; streaks.visible = true; trN = 0; trAcc = 0;
    for (const m of motes) m.set(1e6, 0, 0);
  }
  const SUB = 1 / 480;
  const a = new THREE.Vector3(), ag = new THREE.Vector3();
  const ev = { type: '', point: new THREE.Vector3(), normal: new THREE.Vector3(), part: '', centre: 0, kind: 0 };
  function frame() { f.copy(S.v).normalize(); r.crossVectors(f, UP).normalize(); u.crossVectors(r, f); }
  function step(gdt, stick) {
    if (!S.active) return null;
    let remaining = Math.min(gdt, 0.05);
    while (remaining > 1e-9) {
      const dt = Math.min(SUB, remaining); remaining -= dt;
      S.t += dt;
      // wind: mean + gusts + downrange variation
      const g1 = gustX.step(dt), g2 = gustZ.step(dt);
      const dr = S.p.distanceTo(S.origin);
      S.wind.copy(S.windMean).multiplyScalar(1 + 0.25 * Math.sin(dr / 260 + S.windMean.x));
      S.wind.x += g1; S.wind.z += g2;
      frame();
      // command (rotated by roll-reference error), lagged actuator response
      S.roll = rollOU.step(dt);
      const cs = Math.cos(S.roll), sn = Math.sin(S.roll);
      const sx = stick.x * cs - stick.y * sn, sy = stick.x * sn + stick.y * cs;
      const speedF = Math.pow(S.v.length() / PHYS.v0, 2);
      const auth = S.budget > 0 ? S.aMax * speedF : 0;
      S.cmd.set(sx * auth, sy * auth);
      const k = 1 - Math.exp(-dt / S.tau);
      S.aCur.x += (S.cmd.x - S.aCur.x) * k; S.aCur.y += (S.cmd.y - S.aCur.y) * k;
      const used = S.aCur.length() * dt;
      if (S.budget > 0) { S.budget = Math.max(0, S.budget - used); if (S.budget === 0) S.depleted = true; }
      accel(S.p, S.v, a);
      ag.copy(r).multiplyScalar(S.aCur.x + turbX.step(dt)).addScaledVector(u, S.aCur.y + turbY.step(dt));
      a.add(ag);
      S.pPrev.copy(S.p);
      S.v.addScaledVector(a, dt);
      S.p.addScaledVector(S.v, dt);
      S.travelled += S.p.distanceTo(S.pPrev);
      // collisions: target first (thin), then world
      const th = Target.segmentHit(S.pPrev, S.p);
      tmp.subVectors(S.p, S.pPrev); const segL = tmp.length(); tmp.multiplyScalar(1 / segL);
      const wh = City.raycast(S.pPrev, tmp, segL);
      const md = Target.distToSegment(S.pPrev, S.p); if (md < S.minDist) S.minDist = md;
      if (th && (!wh || th.t * segL <= City.hit.t)) {
        S.active = false; ev.type = 'hit'; ev.point.copy(th.point); ev.part = th.part; ev.centre = th.centre; S.p.copy(th.point);
        return ev;
      }
      if (wh) {
        S.active = false; ev.type = 'impact'; ev.point.copy(S.pPrev).addScaledVector(tmp, City.hit.t); ev.kind = City.hit.kind;
        ev.normal.set(City.hit.nx, City.hit.ny, City.hit.nz); S.p.copy(ev.point);
        return ev;
      }
      trAcc += segL;
      if (trAcc > 2.5) { trAcc = 0; pushTrail(); }
      if (S.t > 7 || S.travelled > 4200) { S.active = false; ev.type = 'lost'; ev.point.copy(S.p); return ev; }
    }
    return null;
  }
  function pushTrail() {
    if (trN >= TR) { trPos.copyWithin(0, 3); trT.copyWithin(0, 1); trN = TR - 1; }
    trPos[trN * 3] = S.p.x; trPos[trN * 3 + 1] = S.p.y; trPos[trN * 3 + 2] = S.p.z; trT[trN] = 0; trN++;
  }
  // Predicted crossing of the target plane if the stick were released now
  const pq = new THREE.Vector3(), pv = new THREE.Vector3(), pa = new THREE.Vector3(), f0 = new THREE.Vector3();
  function predict(target, out) {
    pq.copy(S.p); pv.copy(S.v); f0.copy(S.v).normalize();
    let prevD = tmp.subVectors(pq, target).dot(f0), tt = 0;
    for (let i = 0; i < 600; i++) {
      const dt = 0.006;
      accel(pq, pv, pa); pv.addScaledVector(pa, dt);
      const px = pq.x, py = pq.y, pz = pq.z;
      pq.addScaledVector(pv, dt); tt += dt;
      const d = tmp.subVectors(pq, target).dot(f0);
      if (d >= 0) { const w = prevD / (prevD - d); out.set(px + (pq.x - px) * w, py + (pq.y - py) * w, pz + (pq.z - pz) * w); return tt; }
      prevD = d;
    }
    out.copy(pq); return tt;
  }
  // Autopilot (attract mode / tests): steer predicted impact onto the target
  const ep = new THREE.Vector3();
  function autopilot(target, outStick, gain = 0.6) {
    predict(target, ep); frame();
    ep.sub(target).negate();
    outStick.set(clamp(ep.dot(r) * gain, -1, 1), clamp(ep.dot(u) * gain, -1, 1));
    return outStick;
  }

  // ---- per-frame visuals -----------------------------------------------------
  const look = new THREE.Matrix4();
  function updateVisual(gdt, cam) {
    if (group.visible) {
      group.position.copy(S.p);
      frame();
      look.lookAt(tmp.set(0, 0, 0), f, UP);
      group.quaternion.setFromRotationMatrix(look);
      group.rotateY(Math.PI);
      S.spin += gdt * 2400; spinner.rotation.z = S.spin % TAU;
      // canards deflect with the actuator command
      const dx = S.aMax > 0 ? S.aCur.x / S.aMax : 0, dy = S.aMax > 0 ? S.aCur.y / S.aMax : 0;
      fins.forEach((fn, i) => { fn.rotation.y = (i % 2 ? dx : dy) * 0.5; });
    }
    // trail cooling
    for (let i = 0; i < trN; i++) { trT[i] += gdt; trHeat[i] = 0.22 * Math.exp(-trT[i] * 0.35) * Math.min(1, i / 6 + 0.1); }
    trGeo.setDrawRange(0, trN);
    trGeo.attributes.position.needsUpdate = true; trGeo.attributes.aHeat.needsUpdate = true;
    // streak motes around the bullet path, only while flying
    if (streaks.visible && S.active) {
      frame();
      const sp = S.v.length();
      const L = clamp(sp * gdt * 0.9, 0.05, 6);
      for (let i = 0; i < NM; i++) {
        const m = motes[i];
        const rel = tmp.subVectors(m, S.p);
        const along = rel.dot(f);
        if (along < -4 || rel.lengthSq() > 120 * 120) {
          const ahead = grnd(5, 110), rad = grnd(0.6, 9), ang = grnd(0, TAU);
          m.copy(S.p).addScaledVector(f, ahead).addScaledVector(r, Math.cos(ang) * rad).addScaledVector(u, Math.sin(ang) * rad);
        }
        mPos[i * 6] = m.x; mPos[i * 6 + 1] = m.y; mPos[i * 6 + 2] = m.z;
        mPos[i * 6 + 3] = m.x - f.x * L; mPos[i * 6 + 4] = m.y - f.y * L; mPos[i * 6 + 5] = m.z - f.z * L;
        const hh = 0.05 + 0.05 * ((i * 7919) % 13) / 13; mHeat[i * 2] = hh; mHeat[i * 2 + 1] = 0;
      }
      mGeo.attributes.position.needsUpdate = true; mGeo.attributes.aHeat.needsUpdate = true;
    }
  }
  function hideRound() { group.visible = false; streaks.visible = false; }
  function clearTrail() { trN = 0; trGeo.setDrawRange(0, 0); }
  return { S, root, fire, step, predict, autopilot, solveLaunch, updateVisual, hideRound, clearTrail, frame: () => (frame(), { f, r, u }) };
})();
