// ---------------------------------------------------------------------------
// Bullet: EXACTO-style guided round. It leaves the barrel at PHYS.v0, pops its
// fins and brakes hard to a subsonic cruise speed (S.vc), then flies level on
// its fins while it still has steering energy. Steering is strong but laggy and
// noisy, every hard turn bleeds speed (and authority falls with speed squared),
// crosswind pushes it sideways, and the control budget is finite: when it runs
// out, gravity takes over. Closing on the man (last ~90 m) it sheds speed to S.vMin:
// fin pull does not fade with speed, so the turning circle (v^2 / a) tightens
// sharply in the last metres and a late hook around his cover is possible. Includes the round's visuals: body, fins, cooling
// heat trace and air-mote speed streaks.
// ---------------------------------------------------------------------------
const Bullet = (() => {
  const S = {
    active: false, t: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), pPrev: new THREE.Vector3(),
    origin: new THREE.Vector3(), aim: new THREE.Vector3(),
    aMax: 26, tau: 0.16, budget: 14, budget0: 14, vc: 140, vMin: 55, deploy: 0, brakeT: 0.24, dash: 0, windK: 1, bleed: 0.12, bend: 0, dir0: new THREE.Vector3(),
    aCur: new THREE.Vector2(), cmd: new THREE.Vector2(), roll: 0,
    windMean: new THREE.Vector3(), wind: new THREE.Vector3(),
    minDist: Infinity, travelled: 0, spin: 0, depleted: false, closeP: new THREE.Vector3(),
    // seeker model: the predicted-impact pipper only exists after lock, and carries sensor noise (metres at the target plane)
    lock: 0, lockT: 0.1, seeker: 0.1, pipErr: new THREE.Vector2(), turb: new THREE.Vector2(), gust: 0,
  };
  let pipOX = new OU(0.18, 0.1), pipOY = new OU(0.18, 0.1);
  let gustX = new OU(1.6, 1.2), gustZ = new OU(1.6, 0.8), turbX = new OU(0.3, 2), turbY = new OU(0.3, 2), rollOU = new OU(1.2, 0.15);
  const f = new THREE.Vector3(), r = new THREE.Vector3(), u = new THREE.Vector3(), tmp = new THREE.Vector3(), vrel = new THREE.Vector3();

  // ---- visuals --------------------------------------------------------------
  // A slim, pointed, spinning round (tangent-ogive nose, body, boat tail, four small
  // steering vanes), hottest at the nose, with a thin cold outline shell and a short
  // heat-shimmer wake. Only seen from the chase cam.
  const vr = mulberry32(0xb011e7);
  const vrnd = (a = 0, b = 1) => a + (b - a) * vr();
  const group = new THREE.Group();
  const VS = 1.35, VL = 2.1;                // visual exaggeration: diameter x1.35, length x2.1 (slim, reads in the chase cam)
  const RAD = 0.00648 * VS, LEN = 0.058 * VL;
  const Z0 = -LEN * 0.42, Z1 = LEN * 0.58;   // tail .. nose tip (origin near the centre of mass)
  const prof = [];
  { const tail = 0.07, boat = 0.14, ogive = 0.42;  // fractions of length
    prof.push(new THREE.Vector2(0.0, 0)); prof.push(new THREE.Vector2(RAD * 0.62, 0));
    prof.push(new THREE.Vector2(RAD * 0.78, LEN * tail * 0.5));
    prof.push(new THREE.Vector2(RAD, LEN * boat));
    prof.push(new THREE.Vector2(RAD, LEN * (1 - ogive)));
    for (let i = 1; i < 8; i++) { const x = i / 8; prof.push(new THREE.Vector2(RAD * Math.pow(Math.cos(x * Math.PI / 2), 0.9), LEN * (1 - ogive + ogive * x))); }
    prof.push(new THREE.Vector2(0.0, LEN)); }  // ogive: tangent to the body, pointed tip
  const roundGeo = new THREE.LatheGeometry(prof, 10).rotateX(Math.PI / 2).translate(0, 0, Z0);  // lathe y -> +z (nose forward)
  // flip so the nose points to +z (rotateX(+90deg) maps +y to +z)
  const FS_ROUND = /* glsl */`
  uniform float uNoseT; uniform float uTailT; uniform float uZ0; uniform float uZ1; uniform float uBand;
  void main(){
    vec3 n = flatN(vW);
    float a = clamp((vL.z - uZ0) / (uZ1 - uZ0), 0.0, 1.0);
    float t = mix(uTailT, uNoseT, pow(a, 2.4));
    t += uBand * smoothstep(0.035, 0.0, abs(a - 0.22));      // warm driving band
    gl_FragColor = thermalOut(t, vW, n);
  }`;
  const roundMat = thermalMat(FS_ROUND, { uNoseT: { value: 1.08 }, uTailT: { value: 0.74 }, uZ0: { value: Z0 }, uZ1: { value: Z1 }, uBand: { value: 0.06 } });
  const body = new THREE.Mesh(roundGeo, roundMat);
  // outline: inverted hull, cold -> a thin dark rim in white-hot
  const coldMat = thermalMat(FS_SOLID, { uT: { value: 0.06 }, uStripe: { value: 0 } }, { side: THREE.BackSide });
  const hull = new THREE.Mesh(roundGeo, coldMat); hull.scale.set(1.22, 1.22, 1.05); hull.position.z = -LEN * 0.012;
  const spinner = new THREE.Group(); spinner.add(body);   // no outline shell: the round must read as the hottest thing, not a dark capsule
  const vaneMat = thermalMat(FS_SOLID, { uT: { value: 0.66 }, uStripe: { value: 0 } });
  const fins = [];
  const vaneGeo = new THREE.BoxGeometry(RAD * 0.12, RAD * 0.7, LEN * 0.11).translate(0, RAD * 1.25, 0);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(vaneGeo, vaneMat);
    const holder = new THREE.Group(); holder.rotation.z = (i * Math.PI) / 2 + Math.PI / 4; holder.position.z = Z0 + LEN * 0.2; holder.add(fin); spinner.add(holder); fins.push(fin);
  }
  // heat-shimmer wake: short open cone behind the tail, additive, noise scrolling backwards
  const wakeLen = LEN * 1.6;
  const wakeGeo = new THREE.CylinderGeometry(RAD * 0.7, RAD * 2.6, wakeLen, 12, 1, true).rotateX(-Math.PI / 2).translate(0, 0, Z0 - wakeLen / 2);
  const wakeMat = new THREE.ShaderMaterial({
    uniforms: { tNoise: { value: FX.noiseTex }, uT: { value: 0 }, uHeat: { value: 0.16 }, uZ0: { value: Z0 }, uLen: { value: wakeLen } },
    vertexShader: /* glsl */`varying vec3 vP; varying vec3 vNv; varying vec3 vV;
      void main(){ vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); vNv = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`uniform sampler2D tNoise; uniform float uT, uHeat, uZ0, uLen; varying vec3 vP; varying vec3 vNv; varying vec3 vV;
      void main(){
        float a = clamp((uZ0 - vP.z) / uLen, 0.0, 1.0);          // 0 at the tail, 1 at the end of the wake
        float ang = atan(vP.y, vP.x);
        float nz = texture(tNoise, vec2(ang * 0.32, a * 0.9 + uT * 1.7)).r * 0.7 + texture(tNoise, vec2(ang * 0.61 + 0.3, a * 2.1 + uT * 3.1)).r * 0.5;
        float edge = 1.0 - abs(dot(normalize(vNv), vV));         // brighter where the cone is seen edge-on
        float v = (0.55 + 0.45 * smoothstep(0.3, 1.0, nz)) * (1.0 - a) * (1.0 - a) * (0.35 + 0.65 * edge) * smoothstep(0.0, 0.08, a) * 0.6;
        gl_FragColor = vec4(uHeat * v, 0.0, 0.0, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const wake = new THREE.Mesh(wakeGeo, wakeMat); wake.renderOrder = 7;
  // short bright heat streak right behind the base (hot boundary layer / base flow)
  const coreLen = LEN * 2.2;
  const coreGeo = new THREE.CylinderGeometry(RAD * 0.5, RAD * 0.12, coreLen, 8, 1, true).rotateX(-Math.PI / 2).translate(0, 0, Z0 - coreLen / 2);
  const coreMat = new THREE.ShaderMaterial({
    uniforms: { uHeat: { value: 0.9 }, uZ0: { value: Z0 }, uLen: { value: coreLen } },
    vertexShader: 'varying float vA; uniform float uZ0, uLen; void main(){ vA = clamp((uZ0 - position.z) / uLen, 0.0, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uHeat; varying float vA; void main(){ float v = (1.0 - vA); gl_FragColor = vec4(uHeat * v * v * v, 0.0, 0.0, 1.0); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const core = new THREE.Mesh(coreGeo, coreMat); core.renderOrder = 7;
  group.add(spinner, wake, core);
  // soft glow (2-3x the round's width) and a tapered tracer fading over ~30 m: axial billboards
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uHeat: { value: 0.42 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uHeat; varying vec2 vUv; void main(){ vec2 c = (vUv - 0.5) * 2.0; float r2 = dot(c, c); float v = exp(-r2 * 3.2) * (1.0 - smoothstep(0.7, 1.0, r2)); gl_FragColor = vec4(uHeat * v, 0.0, 0.0, 1.0); }',
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat); glow.renderOrder = 8; glow.frustumCulled = false;
  const tracerMat = new THREE.ShaderMaterial({
    uniforms: { uHeat: { value: 0.7 } },
    vertexShader: 'varying vec2 vUv; varying float vD; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float uHeat; varying vec2 vUv; varying float vD; void main(){ float a = 1.0 - vUv.x; float w = abs(vUv.y - 0.5) * 2.0; float taper = 1.0 - a; if (w > taper) discard; float v = pow(1.0 - a, 2.0) * (1.0 - w / max(taper, 1e-3)) * smoothstep(0.35, 1.2, vD); gl_FragColor = vec4(uHeat * v, 0.0, 0.0, 1.0); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const tracer = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(-0.5, 0, 0), tracerMat); tracer.renderOrder = 7; tracer.frustumCulled = false;
  glow.visible = tracer.visible = false;
  const bX = new THREE.Vector3(), bY = new THREE.Vector3(), bZ = new THREE.Vector3(), bM = new THREE.Matrix4();
  function axialBillboard(obj, axis, toCam) {
    bX.copy(axis).normalize(); bY.crossVectors(bX, toCam); if (bY.lengthSq() < 1e-8) bY.set(0, 1, 0).cross(bX); bY.normalize(); bZ.crossVectors(bX, bY);
    bM.makeBasis(bX, bY, bZ); obj.quaternion.setFromRotationMatrix(bM);
  }
  group.traverse((o) => (o.frustumCulled = false));

  // heat trace: a 1px vector line that cools over time
  const TR = 900;
  const trPos = new Float32Array(TR * 3), trHeat = new Float32Array(TR), trT = new Float32Array(TR);
  const trGeo = new THREE.BufferGeometry();
  trGeo.setAttribute('position', new THREE.BufferAttribute(trPos, 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setAttribute('aHeat', new THREE.BufferAttribute(trHeat, 1).setUsage(THREE.DynamicDrawUsage));
  const lineMat = new THREE.ShaderMaterial({
    uniforms: { uFogD: U.uFogD },
    vertexShader: `uniform float uFogD; attribute float aHeat; varying float vH; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vH = aHeat*exp(-(-mv.z)*uFogD)*smoothstep(0.05, 0.5, -mv.z); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying float vH; void main(){ gl_FragColor = vec4(vH, 0.0, 0.0, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const trail = new THREE.Line(trGeo, lineMat); trail.frustumCulled = false; trail.renderOrder = 7;
  let trN = 0, trAcc = 0;

  // speed streaks: air motes in a cone ahead of the round, drawn as lines along the
  // flight direction (so they radiate from the vanishing point), stretched by the
  // distance the round covers per frame; dense near the round, sparse far out.
  const NM = 150;
  const mPos = new Float32Array(NM * 6), mHeat = new Float32Array(NM * 2), mH = new Float32Array(NM), motes = [];
  const mGeo = new THREE.BufferGeometry();
  mGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3).setUsage(THREE.DynamicDrawUsage));
  mGeo.setAttribute('aHeat', new THREE.BufferAttribute(mHeat, 1).setUsage(THREE.DynamicDrawUsage));
  const streaks = new THREE.LineSegments(mGeo, lineMat); streaks.frustumCulled = false; streaks.renderOrder = 7;
  for (let i = 0; i < NM; i++) motes.push(new THREE.Vector3(1e6, 0, 0));
  let burst = 0, burstLatch = false;

  const root = new THREE.Group(); root.add(group, trail, streaks, glow, tracer);
  group.visible = false; streaks.visible = false;

  // ---- physics ----------------------------------------------------------------
  // Non-control accelerations at sim time t: braking toward cruise speed along the flight path,
  // crosswind push (the slow round weathervanes and drifts), and gravity once the fins stop flying it.
  const BRAKE_TAU = 0.09, TERM_TAU = 0.12;
  // speed the round settles to at point p: cruise far out, easing to vMin over the last ~75 m to the man
  function settleSpeed(p) {
    if (typeof Target === 'undefined' || !Target.S.alive) return S.vc;
    return S.vMin + (S.vc - S.vMin) * sstep(12, 90, p.distanceTo(Target.chest));
  }
  function deployAt(t) { return clamp((t - S.dash) / S.brakeT, 0, 1); }
  function accel(p, v, out, t = S.t, budgetLeft = S.budget > 0) {
    const sp = v.length() || 1;
    out.set(0, 0, 0);
    if (t > S.dash) { const vT = Math.min(S.vc, settleSpeed(p)); if (sp > vT) out.addScaledVector(v, -((sp - vT) / (sp > S.vc * 1.01 ? BRAKE_TAU : TERM_TAU)) / sp); }
    // wind: only the component across the flight path pushes the round
    const wd = (S.wind.x * v.x + S.wind.y * v.y + S.wind.z * v.z) / sp;
    out.x += S.windK * (S.wind.x - v.x / sp * wd); out.y += S.windK * (S.wind.y - v.y / sp * wd); out.z += S.windK * (S.wind.z - v.z / sp * wd);
    out.y -= PHYS.g * (budgetLeft ? 1 - deployAt(t) : 1);
    return out;
  }
  // stick response curve: pull = |stick|^EXPO along the stick direction (gentle near centre, full at the stops)
  const EXPO = 1.8;
  function shape(sx, sy, out) { const m = Math.hypot(sx, sy); if (m < 1e-6) return out.set(0, 0); const k = Math.pow(Math.min(1, m), EXPO) / m; return out.set(sx * k, sy * k); }
  function unshape(ax, ay, out) { const m = Math.hypot(ax, ay); if (m < 1e-6) return out.set(0, 0); const k = Math.pow(Math.min(1, m), 1 / EXPO) / m; return out.set(ax * k, ay * k); }
  const shp = new THREE.Vector2();
  // steering authority: full once the fins are out, at any speed (so slower means a tighter turn)
  function authority(t = S.t, sp = S.v.length()) { return S.aMax * deployAt(t); }
  // Ballistic computer: superelevation so an unguided round (no wind) crosses the lased range on the aim line
  // Ballistic computer: only the short braking phase drops (the fins fly it level after that),
  // so the superelevation is the small angle that cancels that drop at the lased range.
  function solveLaunch(origin, dir, range, out) {
    const tb = S.brakeT, drop = PHYS.g * tb * tb / 6;
    const ang = Math.atan2(drop, Math.max(50, range));
    const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
    out.copy(dir).applyAxisAngle(right, ang);
    return ang;
  }
  function fire(origin, dir, opt) {
    S.active = true; S.t = 0; S.p.copy(origin); S.pPrev.copy(origin); S.origin.copy(origin);
    S.v.copy(dir).multiplyScalar(PHYS.v0); S.dir0.copy(dir).normalize(); S.bend = 0;
    S.aMax = opt.aMax; S.tau = opt.tau; S.budget = S.budget0 = opt.budget;
    S.vc = opt.vc || 140; S.vMin = opt.vMin || Math.min(S.vc, 55); S.brakeT = opt.brakeT || 0.24; S.dash = opt.dash || 0; S.windK = opt.windK != null ? opt.windK : 1; S.bleed = opt.bleed != null ? opt.bleed : 0.12; S.deploy = 0;
    S.aCur.set(0, 0); S.cmd.set(0, 0); S.minDist = Infinity; S.travelled = 0; S.depleted = false;
    S.windMean.copy(opt.wind); S.wind.copy(opt.wind);
    gustX = new OU(1.6, opt.gust); gustZ = new OU(1.6, opt.gust * 0.6);
    S.basket = opt.basket || 0; S.homeT = opt.homeT || 0.5; S.homing = false;
    S.lock = 0; S.lockT = opt.lockT != null ? opt.lockT : 0.1; S.seeker = opt.seeker != null ? opt.seeker : 0.1;
    pipOX = new OU(0.18, S.seeker); pipOY = new OU(0.18, S.seeker); S.pipErr.set(0, 0); S.turb.set(0, 0);
    turbX = new OU(0.3, opt.turb); turbY = new OU(0.3, opt.turb); rollOU = new OU(1.2, opt.roll); S.roll = 0;
    group.visible = true; streaks.visible = true; trN = 0; trAcc = 0; burst = 0;
    for (const m of motes) m.set(1e6, 0, 0);
  }
  const SUB = 1 / 480;
  const a = new THREE.Vector3(), ag = new THREE.Vector3(), hv = new THREE.Vector3();
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
      shape(stick.x, stick.y, shp);
      const sx = shp.x * cs - shp.y * sn, sy = shp.x * sn + shp.y * cs;
      S.deploy = deployAt(S.t);
      const auth = S.budget > 0 ? authority() : 0, authF = S.aMax > 0 ? auth / S.aMax : 0;
      S.cmd.set(sx * auth, sy * auth);
      const k = 1 - Math.exp(-dt / S.tau);
      S.aCur.x += (S.cmd.x - S.aCur.x) * k; S.aCur.y += (S.cmd.y - S.aCur.y) * k;
      // EXACTO terminal homing: in the last moments, if the round is already inside the capture basket,
      // the seeker closes the remaining miss itself (costs control budget, needs authority)
      let hx = 0, hy = 0; S.homing = false;
      if (S.basket > 0 && S.budget > 0 && S.lock >= 1 && Target.S.alive) {
        hv.subVectors(Target.chest, S.p);
        const sp = S.v.length(), tgo = hv.dot(f) / Math.max(sp, 1);
        if (tgo > 0.004 && tgo < S.homeT) {
          hv.addScaledVector(S.v, -tgo);
          const mx = hv.dot(r), my = hv.dot(u);
          if (mx * mx + my * my < S.basket * S.basket) {
            const lim = S.aMax * authF * 1.2, k2 = 2 / (tgo * tgo);
            hx = clamp(mx * k2, -lim, lim); hy = clamp(my * k2, -lim, lim); S.homing = true;
          }
        }
      }
      const used = (S.aCur.length() + Math.hypot(hx, hy)) * dt;
      if (S.budget > 0) { S.budget = Math.max(0, S.budget - used); if (S.budget === 0) S.depleted = true; }
      accel(S.p, S.v, a);
      S.turb.set(turbX.step(dt), turbY.step(dt)); S.gust = g1;
      ag.copy(r).multiplyScalar(S.aCur.x + S.turb.x * S.deploy + hx).addScaledVector(u, S.aCur.y + S.turb.y * S.deploy + hy);
      // turning costs energy: induced drag bleeds speed in proportion to the lateral pull (never below 55 % of cruise)
      { const sp = S.v.length(), lat = Math.hypot(S.aCur.x + hx, S.aCur.y + hy);
        if (sp <= S.vc * 1.02 && sp > S.vc * 0.55) a.addScaledVector(f, -S.bleed * lat); }
      if (S.t >= S.lockT) S.lock = Math.min(1, S.lock + dt / 0.04);
      S.pipErr.set(pipOX.step(dt), pipOY.step(dt));
      a.add(ag);
      S.pPrev.copy(S.p);
      S.v.addScaledVector(a, dt);
      S.p.addScaledVector(S.v, dt);
      S.travelled += S.p.distanceTo(S.pPrev);
      { const c = clamp(f.dot(S.dir0), -1, 1); const bd = Math.acos(c); if (bd > S.bend) S.bend = bd; }
      if (!(Number.isFinite(S.p.x) && Number.isFinite(S.p.y) && Number.isFinite(S.p.z) && Number.isFinite(S.v.x))) {
        S.p.copy(S.pPrev); S.v.set(0, 0, -PHYS.v0); S.active = false; ev.type = 'lost'; ev.point.copy(S.p); return ev;
      }
      // collisions: target first (thin), then world
      const th = Target.segmentHit(S.pPrev, S.p);
      tmp.subVectors(S.p, S.pPrev); const segL = Math.max(1e-6, tmp.length()); tmp.multiplyScalar(1 / segL);
      const wh = City.raycast(S.pPrev, tmp, segL);
      const md = Target.distToSegment(S.pPrev, S.p);
      if (md < S.minDist) {
        S.minDist = md;
        // where on this step the round came closest to his chest (for the miss replay's measured gap)
        const c = Target.chest; hv.subVectors(S.p, S.pPrev); const l2 = Math.max(1e-9, hv.lengthSq());
        const tt = clamp(((c.x - S.pPrev.x) * hv.x + (c.y - S.pPrev.y) * hv.y + (c.z - S.pPrev.z) * hv.z) / l2, 0, 1);
        S.closeP.copy(S.pPrev).addScaledVector(hv, tt);
      }
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
      if (S.t > 16 || S.travelled > 4200) { S.active = false; ev.type = 'lost'; ev.point.copy(S.p); return ev; }
    }
    return null;
  }
  function pushTrail() {
    if (trN >= TR) { trPos.copyWithin(0, 3); trT.copyWithin(0, 1); trN = TR - 1; }
    trPos[trN * 3] = S.p.x; trPos[trN * 3 + 1] = S.p.y; trPos[trN * 3 + 2] = S.p.z; trT[trN] = 0; trN++;
  }
  // Predicted crossing of the target plane if the stick were released now
  const pq = new THREE.Vector3(), pv = new THREE.Vector3(), pa = new THREE.Vector3(), f0 = new THREE.Vector3();
  // (the actuators keep pushing while they relax back to neutral, so their current state is included)
  const pr_ = new THREE.Vector3(), pu_ = new THREE.Vector3();
  function predict(target, out) {
    pq.copy(S.p); pv.copy(S.v); f0.copy(S.v).normalize();
    frame(); pr_.copy(r); pu_.copy(u);
    let prevD = tmp.subVectors(pq, target).dot(f0), tt = 0, ax = S.aCur.x, ay = S.aCur.y;
    const dt = 0.008, kd = Math.exp(-dt / Math.max(0.02, S.tau));
    for (let i = 0; i < 1200; i++) {
      accel(pq, pv, pa, S.t + tt); pv.addScaledVector(pa, dt);
      if (S.budget > 0) { pv.addScaledVector(pr_, ax * dt).addScaledVector(pu_, ay * dt); ax *= kd; ay *= kd; }
      const px = pq.x, py = pq.y, pz = pq.z;
      pq.addScaledVector(pv, dt); tt += dt;
      const d = tmp.subVectors(pq, target).dot(f0);
      if (d >= 0) { const w = prevD / (prevD - d); out.set(px + (pq.x - px) * w, py + (pq.y - py) * w, pz + (pq.z - pz) * w); return tt; }
      prevD = d;
    }
    out.copy(pq); return tt;
  }
  // Path preview for the HUD: where the round goes over the next `sec` (sim seconds) if the stick
  // stays where it is (actuators settle on the current command)
  const pp = new THREE.Vector3(), pvv = new THREE.Vector3(), ppa = new THREE.Vector3(), pf = new THREE.Vector3(), pr2 = new THREE.Vector3(), pu2 = new THREE.Vector3();
  // samples are spaced as (k / n)^pw of `sec`, so a chase camera right behind sees the near bend spread out
  function previewPath(stick, sec, n, out, pw = 1) {
    pp.copy(S.p); pvv.copy(S.v);
    let ax = S.aCur.x, ay = S.aCur.y, tt = 0, k = 0; const steps = n * 6, dt = sec / steps;
    let next = sec * Math.pow(1 / n, pw);
    for (let i = 0; i < steps && k < n; i++) {
      pf.copy(pvv).normalize(); pr2.crossVectors(pf, UP).normalize(); pu2.crossVectors(pr2, pf);
      const auth = S.budget > 0 ? authority(S.t + tt, pvv.length()) : 0;
      shape(stick.x, stick.y, shp);
      const kk = 1 - Math.exp(-dt / S.tau); ax += (shp.x * auth - ax) * kk; ay += (shp.y * auth - ay) * kk;
      accel(pp, pvv, ppa, S.t + tt); ppa.addScaledVector(pr2, ax).addScaledVector(pu2, ay);
      pvv.addScaledVector(ppa, dt); pp.addScaledVector(pvv, dt); tt += dt;
      while (k < n && tt >= next - 1e-9) { out[k++].copy(pp); next = sec * Math.pow((k + 1) / n, pw); }
    }
    for (; k < n; k++) out[k].copy(pp);
    return out;
  }
  // Autopilot (attract mode / tests): steer predicted impact onto the target
  // gain is a fraction of the lateral acceleration needed to null the predicted miss; tVel leads a moving target
  const ep = new THREE.Vector3(), tl = new THREE.Vector3();
  function autopilot(target, outStick, gain = 0.6, tVel = null) {
    const tti = predict(target, ep);
    tl.copy(target); if (tVel) tl.addScaledVector(tVel, tti);
    frame();
    ep.sub(tl).negate();
    const auth = Math.max(1, S.budget > 0 ? authority() : 0);
    const k = gain * 2 / Math.max(0.004, tti * tti + S.tau * tti) / auth;
    outStick.set(clamp(ep.dot(r) * k, -1, 1), clamp(ep.dot(u) * k, -1, 1));
    if (outStick.length() > 1) outStick.normalize();
    return unshape(outStick.x, outStick.y, outStick);
  }
  function abort() { if (!S.active) return null; S.active = false; ev.type = 'lost'; ev.point.copy(S.p); return ev; }

  // ---- per-frame visuals -----------------------------------------------------
  const look = new THREE.Matrix4(), vAx = new THREE.Vector3(), vC = new THREE.Vector3(), vT = new THREE.Vector3();
  const MIN_VIEW = 22 * DEG; // keep the round at least this far off the camera's line of sight so its length reads
  let visT = 0;
  function placeMote(m, near) {
    // ahead distance and radius both biased toward the round
    const ahead = near ? vrnd(1.5, 18) : 2 + 95 * Math.pow(vr(), 1.7);
    const rad = near ? vrnd(0.25, 2.2) : 0.3 + 7.5 * Math.pow(vr(), 1.6), ang = vrnd(0, TAU);
    m.copy(S.p).addScaledVector(f, ahead).addScaledVector(r, Math.cos(ang) * rad).addScaledVector(u, Math.sin(ang) * rad);
  }
  function updateVisual(gdt, cam) {
    visT += gdt;
    if (group.visible) {
      group.position.copy(S.p);
      frame();
      // view-angle cheat: if the camera looks almost straight up the round's tail, tilt the model
      // (not the flight path) away from the view ray so the slim body and nose stay visible
      vAx.copy(f);
      if (cam) {
        vC.subVectors(S.p, cam.position); const dl = vC.length();
        if (dl > 1e-4) {
          vC.multiplyScalar(1 / dl);
          const c = clamp(vAx.dot(vC), -1, 1), ang = Math.acos(c);
          if (ang < MIN_VIEW) {
            vT.copy(vAx).addScaledVector(vC, -c); if (vT.lengthSq() < 1e-8) vT.copy(u); vT.normalize();
            vAx.copy(vC).multiplyScalar(Math.cos(MIN_VIEW)).addScaledVector(vT, Math.sin(MIN_VIEW));
          }
        }
      }
      // hold the round at ~5 % of screen height whatever the chase-cam distance / fov
      if (cam && cam.isPerspectiveCamera) {
        const dl = Math.max(0.05, S.p.distanceTo(cam.position)), Hs = 2 * dl * Math.tan(cam.fov * DEG * 0.5);
        const vAng = Math.acos(clamp(Math.abs(vAx.dot(vC)), 0, 1));
        const ext = LEN * Math.sin(vAng) + 2 * RAD * Math.cos(vAng);
        group.scale.setScalar(clamp((0.05 * Hs) / Math.max(1e-4, ext), 0.5, 3.5));
      }
      look.lookAt(tmp.set(0, 0, 0), vAx, UP);
      group.quaternion.setFromRotationMatrix(look);
      group.rotateY(Math.PI);
      S.spin += gdt * 70; spinner.rotation.z = S.spin % TAU;   // a slow, readable roll in slow motion
      // steering vanes deflect with the actuator command
      const dx = S.aMax > 0 ? S.aCur.x / S.aMax : 0, dy = S.aMax > 0 ? S.aCur.y / S.aMax : 0;
      fins.forEach((fn, i) => { fn.rotation.y = (i % 2 ? dx : dy) * 0.45; fn.scale.set(1, 0.25 + 1.6 * S.deploy, 0.4 + 0.9 * S.deploy); });
      if (cam) {
        const sc = group.scale.x;
        vC.subVectors(cam.position, S.p).normalize();
        axialBillboard(glow, vAx, vC); glow.position.copy(S.p).addScaledVector(vAx, (Z0 + Z1) * 0.5 * sc);
        glow.scale.set(LEN * sc * 1.5, RAD * 2 * sc * 3.2, 1);
        axialBillboard(tracer, f, vC); tracer.position.copy(S.p).addScaledVector(f, Z0 * sc);
        tracer.scale.set(30, RAD * 2 * sc * 1.1, 1);
      }
      glow.visible = tracer.visible = true;
      wakeMat.uniforms.uT.value = visT * 6;
      wakeMat.uniforms.uHeat.value = 0.16 + 0.12 * Math.min(1, S.v.length() / PHYS.v0) + 0.06 * Math.min(1, S.v.length() / S.vc);
    }
    // trail cooling
    for (let i = 0; i < trN; i++) { trT[i] += gdt; trHeat[i] = 0.22 * Math.exp(-trT[i] * 0.35) * Math.min(1, i / 6 + 0.1); }
    trGeo.setDrawRange(0, trN);
    trGeo.attributes.position.needsUpdate = true; trGeo.attributes.aHeat.needsUpdate = true;
    // speed streaks, only while flying
    const flying = typeof G === 'undefined' || G.state === 'flight';
    streaks.material.visible = true; mGeo.setDrawRange(0, flying ? NM * 2 : 0);   // never in the scope view
    if (streaks.visible && S.active && flying) {
      frame();
      // near-miss burst: the game raises G.whoosh to 1 on a close call
      const w = typeof G !== 'undefined' ? (G.whoosh || 0) : 0;
      if (w > 0.95 && !burstLatch) { burstLatch = true; burst = 1; for (let i = 0; i < NM; i += 2) { placeMote(motes[i], true); mH[i] = 2.6; } }
      if (w < 0.5) burstLatch = false;
      burst = Math.max(0, burst - gdt * 25);
      const sp = S.v.length();
      const L = clamp(sp * gdt * 1.8, 0.15, 9);   // ~2 frames of travel: stretches with velocity x time scale
      for (let i = 0; i < NM; i++) {
        const m = motes[i];
        const rel = tmp.subVectors(m, S.p);
        const along = rel.dot(f);
        if (along < 0.6 || rel.lengthSq() > 110 * 110) { placeMote(m, false); mH[i] = 1; }   // only ahead of the round: nothing crosses the lens
        const rr = Math.sqrt(Math.max(0, rel.lengthSq() - along * along));
        const near = 1 / (1 + rr * 0.6) * clamp(1 - along / 100, 0, 1);
        let hh = (0.05 + 0.15 * near) * (0.6 + 0.4 * ((i * 7919) % 13) / 13) * mH[i] * clamp((along - 0.6) / 4, 0, 1);
        if (cam && typeof Target !== 'undefined') {   // keep the target ring clean
          vC.subVectors(m, cam.position).normalize(); vT.subVectors(Target.chest, cam.position).normalize();
          hh *= sstep(0.9975, 0.990, vC.dot(vT));
        }
        const Lm = L * (0.6 + 0.8 * near) * (mH[i] > 1 ? 1.6 : 1);
        mPos[i * 6] = m.x; mPos[i * 6 + 1] = m.y; mPos[i * 6 + 2] = m.z;
        mPos[i * 6 + 3] = m.x - f.x * Lm; mPos[i * 6 + 4] = m.y - f.y * Lm; mPos[i * 6 + 5] = m.z - f.z * Lm;
        mHeat[i * 2] = hh; mHeat[i * 2 + 1] = 0;
        if (mH[i] > 1) mH[i] = Math.max(1, mH[i] - gdt * 18);
      }
      mGeo.attributes.position.needsUpdate = true; mGeo.attributes.aHeat.needsUpdate = true;
    }
  }
  function hideRound() { group.visible = false; streaks.visible = false; glow.visible = tracer.visible = false; }
  function clearTrail() { trN = 0; trGeo.setDrawRange(0, 0); }
  return { S, root, fire, step, predict, previewPath, autopilot, authority: () => authority(), unshape, abort, solveLaunch, updateVisual, hideRound, clearTrail, frame: () => (frame(), { f, r, u }) };
})();
