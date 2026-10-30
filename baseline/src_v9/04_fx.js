// ---------------------------------------------------------------------------
// FX: additive "heat" particles for the thermal sensor (R channel = temperature)
//   - textured gas / dust sprites (tileable noise texture, rotated per particle,
//     scrolled over time so plumes shimmer and billow)
//   - spark streaks (line segments stretched along velocity)
//   - ambient emitters: rooftop vent plumes (from City) + street steam (own),
//     culled by view cone and on-screen size, prewarmed when they come into view
// FX has its own RNG so effects never perturb the gameplay random sequence.
// No gore: the "hit" effect is a dust / fabric puff.
// ---------------------------------------------------------------------------
const FX = (() => {
  const MAX = 4000, AMB_MAX = 2600, MAXS = 700;
  const fr = mulberry32(0x5eed1e57);
  const frnd = (a = 0, b = 1) => a + (b - a) * fr();
  const fgauss = () => { let u = 0; while (u === 0) u = fr(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * fr()); };

  // ---- point particles ------------------------------------------------------
  const pos = new Float32Array(MAX * 3), heat = new Float32Array(MAX), size = new Float32Array(MAX), misc = new Float32Array(MAX * 2);
  const vel = new Float32Array(MAX * 3), life = new Float32Array(MAX), maxLife = new Float32Array(MAX);
  const s0 = new Float32Array(MAX), s1 = new Float32Array(MAX), h0 = new Float32Array(MAX), drag = new Float32Array(MAX), buoy = new Float32Array(MAX), amb = new Uint8Array(MAX);
  let n = 0, nAmb = 0;
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aHeat = new THREE.BufferAttribute(heat, 1).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const aMisc = new THREE.BufferAttribute(misc, 2).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('aHeat', aHeat); geo.setAttribute('aSize', aSize); geo.setAttribute('aMisc', aMisc);

  // tileable fbm value noise, baked once (one texture fetch per octave in the shader)
  const NT = 128;
  const noiseTex = (() => {
    const d = new Uint8Array(NT * NT), r = mulberry32(911);
    const lat = (g) => { const a = new Float32Array(g * g); for (let i = 0; i < a.length; i++) a[i] = r(); return a; };
    const oct = [[8, 0.55], [16, 0.28], [32, 0.17]].map(([g, w]) => ({ g, w, a: lat(g) }));
    for (let y = 0; y < NT; y++) for (let x = 0; x < NT; x++) {
      let v = 0;
      for (const o of oct) {
        const fx = (x / NT) * o.g, fy = (y / NT) * o.g, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), g = o.g, A = o.a;
        const v00 = A[(y0 % g) * g + (x0 % g)], v10 = A[(y0 % g) * g + ((x0 + 1) % g)], v01 = A[((y0 + 1) % g) * g + (x0 % g)], v11 = A[((y0 + 1) % g) * g + ((x0 + 1) % g)];
        v += o.w * ((v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy);
      }
      d[y * NT + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    const t = new THREE.DataTexture(d, NT, NT, THREE.RedFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  })();

  // Three passes over the same particle buffer:
  //   0 additive  : effects (sparks' glow, dust, flashes, rings)
  //   1 max blend : ambient plumes / steam - a plume shows its own temperature and never piles up
  //                 to white, never brightens the man or the round (they are hotter)
  //   2 darken    : R *= 1 - a (G / B untouched, so no false vector edges) - cool muzzle smoke
  const FXU = { uScale: { value: 500 }, uCam: U.uCam, uFogD: U.uFogD, uT: { value: 0 }, uMaxPt: { value: 256 }, tNoise: { value: noiseTex },
    uAmbMax: { value: 80 }, uLA: { value: new THREE.Vector3() }, uLB: { value: new THREE.Vector3() }, uLOn: { value: 0 },
    uScrT: { value: new THREE.Vector3() }, uScrR: { value: new THREE.Vector3() }, uAspect: { value: 1.78 } };
  const VSP = /* glsl */`
      uniform float uScale; uniform float uFogD; uniform float uMaxPt; uniform float uAmbMax; uniform vec3 uLA; uniform vec3 uLB; uniform float uLOn;
      uniform vec3 uScrT; uniform vec3 uScrR; uniform float uAspect;
      attribute float aHeat; attribute float aSize; attribute vec2 aMisc;
      varying float vHeat; varying float vKind; varying float vSeed; varying vec2 vRot;
      void cull(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vHeat = 0.0; vKind = 0.0; vSeed = 0.0; vRot = vec2(1.0, 0.0); }
      void main(){
        float isAmb = step(7.5, aMisc.x), kind = aMisc.x - 8.0 * isAmb;
        bool mine = PASS == 1 ? isAmb > 0.5 : PASS == 2 ? (isAmb < 0.5 && kind > 6.5) : (isAmb < 0.5 && kind < 6.5);
        if (!mine) { cull(); return; }
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(-mv.z, 0.01);
        float h = aHeat * exp(-d * uFogD);
        float px = aSize * uScale / d;
        vec4 cp = projectionMatrix * mv;
        if (isAmb > 0.5) {
          h *= smoothstep(2.0, 9.0, px);                          // distant plumes fade out instead of collapsing to dots
          if (px > uAmbMax) { float k = uAmbMax / px; h *= k * k; } // a plume never fills the frame
          if (uLOn > 0.5) {                                       // clear around the round -> target line and the man
            vec3 ab = uLB - uLA; float tt = clamp(dot(position - uLA, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
            float dl = length(position - (uLA + ab * tt)) - aSize * 0.5, dt = length(position - uLB) - aSize * 0.5;
            h *= smoothstep(2.0, 9.0, dl) * smoothstep(4.0, 16.0, dt);
          }
          // screen space: no plume over the target marker + range tag, or over the round
          vec2 sp = cp.xy / max(cp.w, 1e-3); sp.x *= uAspect;
          float rs = px / max(uScale, 1.0) * 0.0;                 // (sprite radius ignored: fade is soft and wide)
          if (uScrT.z > 0.5) { vec2 a = vec2(uScrT.x * uAspect, uScrT.y); float t2 = clamp((sp.x - a.x) / 0.32, 0.0, 1.0);
            h *= smoothstep(0.1, 0.26, length(sp - a - vec2(0.32 * t2, 0.0))); }
          if (uScrR.z > 0.5) { h *= smoothstep(0.06, 0.18, length(sp - vec2(uScrR.x * uAspect, uScrR.y))); }
        }
        if (px < 2.0) { h *= px * px * 0.25; px = 2.0; }          // sub-pixel: conserve energy, no aliased dots
        if (px > uMaxPt) {                                        // giant sprites at the lens: thin out, then cull (fill rate)
          float k = uMaxPt / px; if (k < 0.3) { cull(); return; }
          h *= k * k; px = uMaxPt; }
        h *= smoothstep(0.08, 0.9, d);                            // never smear across the lens
        vHeat = h; vKind = kind; vSeed = aMisc.y;
        float a = aMisc.y * 6.2831853; vRot = vec2(cos(a), sin(a));
        gl_PointSize = px;
        gl_Position = cp;
      }`;
  const FSP = /* glsl */`
      uniform sampler2D tNoise; uniform float uT;
      varying float vHeat; varying float vKind; varying float vSeed; varying vec2 vRot;
      void main(){
        vec2 c = gl_PointCoord - 0.5; float r2 = dot(c, c) * 4.0;
        if (r2 > 1.0 || vHeat < 0.0005) discard;
        vec2 q = mat2(vRot.x, vRot.y, -vRot.y, vRot.x) * c;
        float v;
        if (vKind < 0.5) {            // warm gas: soft body with gentle shimmer (feathered, no hard clumps)
          float n1 = texture(tNoise, q * 0.7 + vSeed * vec2(7.13, 3.71) + vec2(0.0, -uT * 0.11)).r;
          float n2 = texture(tNoise, q * 1.9 + vSeed * vec2(2.9, 5.3) + vec2(uT * 0.07, -uT * 0.29)).r;
          // the noise also carves the outline, so a lone puff seen through high magnification reads as a wisp
          float f = exp(-r2 * 2.2) - 0.11;
          float w = smoothstep(0.3, 1.0, n1 * 0.85 + n2 * 0.5 + (1.0 - r2) * 0.15);
          v = max(f, 0.0) * (0.25 + 1.25 * w);
        } else if (vKind < 1.5) {     // dust / debris cloud
          float n1 = texture(tNoise, q * 1.3 + vSeed * vec2(4.1, 8.3)).r;
          float n2 = texture(tNoise, q * 3.1 + vSeed * vec2(9.7, 1.3) + vec2(0.0, -uT * 0.05)).r;
          float f = 1.0 - r2;
          v = f * smoothstep(0.3, 0.9, n1 * 0.75 + n2 * 0.45) * 2.0;
        } else if (vKind < 2.5) {     // chunk / ember: small hard dot
          v = smoothstep(1.0, 0.35, r2);
        } else if (vKind < 3.5) {     // glow core (impact hot spot, flash)
          v = exp(-r2 * 3.5);
        } else if (vKind < 4.5) {     // shock ring
          float rr = sqrt(r2); v = smoothstep(0.6, 0.84, rr) * smoothstep(1.0, 0.88, rr);
        } else if (vKind < 5.5) {     // radial light burst: rays + core
          float an = atan(q.y, q.x); float rr = sqrt(r2);
          v = (pow(abs(cos(an * 5.0)), 18.0) * 0.8 + pow(abs(cos(an * 8.0 + 0.7)), 30.0) * 0.5) * (1.0 - rr) + exp(-r2 * 10.0);
        } else {                      // soft feathered gradient (smoke)
          v = exp(-r2 * 3.2) * (1.0 - r2);
        }
        gl_FragColor = vec4(vHeat * v, 0.0, 0.0, PASS == 2 ? 0.0 : 1.0);
      }`;
  const mkMat = (pass, extra) => new THREE.ShaderMaterial(Object.assign({ uniforms: FXU, defines: { PASS: pass }, vertexShader: VSP, fragmentShader: FSP, transparent: true, depthWrite: false }, extra));
  const mat = mkMat(0, { blending: THREE.AdditiveBlending });
  const matMax = mkMat(1, { blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });
  const matDark = mkMat(2, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcColorFactor });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 6;
  const pointsMax = new THREE.Points(geo, matMax); pointsMax.frustumCulled = false; pointsMax.renderOrder = 5;
  const pointsDark = new THREE.Points(geo, matDark); pointsDark.frustumCulled = false; pointsDark.renderOrder = 5;
  points.add(pointsMax, pointsDark);

  // ---- spark streaks ------------------------------------------------------------
  const spP = new Float32Array(MAXS * 3), spV = new Float32Array(MAXS * 3), spL = new Float32Array(MAXS), spM = new Float32Array(MAXS), spH = new Float32Array(MAXS);
  const lPos = new Float32Array(MAXS * 6), lHeat = new Float32Array(MAXS * 2);
  let ns = 0;
  const sGeo = new THREE.BufferGeometry();
  const aLPos = new THREE.BufferAttribute(lPos, 3).setUsage(THREE.DynamicDrawUsage), aLHeat = new THREE.BufferAttribute(lHeat, 1).setUsage(THREE.DynamicDrawUsage);
  sGeo.setAttribute('position', aLPos); sGeo.setAttribute('aHeat', aLHeat);
  const sMat = new THREE.ShaderMaterial({
    uniforms: { uFogD: U.uFogD },
    vertexShader: /* glsl */`uniform float uFogD; attribute float aHeat; varying float vHeat;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vHeat = aHeat * exp(-max(-mv.z, 0.0) * uFogD) * smoothstep(0.05, 0.6, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`varying float vHeat; void main(){ gl_FragColor = vec4(vHeat, 0.0, 0.0, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const streaks = new THREE.LineSegments(sGeo, sMat); streaks.frustumCulled = false; streaks.renderOrder = 6;
  points.add(streaks);

  // kind: 0 gas, 1 dust, 2 chunk, 3 glow
  function emit(x, y, z, vx, vy, vz, lifeS, sa, sb, ht, dr, by, kind, isAmb) {
    if (n >= MAX || (isAmb && nAmb >= AMB_MAX)) return -1;
    const i = n++;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
    life[i] = 0; maxLife[i] = lifeS; s0[i] = sa; s1[i] = sb; h0[i] = ht; drag[i] = dr; buoy[i] = by;
    misc[i * 2] = kind + (isAmb ? 8 : 0); misc[i * 2 + 1] = fr(); amb[i] = isAmb ? 1 : 0; if (isAmb) nAmb++;
    size[i] = sa; heat[i] = 0;
    return i;
  }
  // public, backwards compatible (used by Target for cigarette smoke)
  function spawn(x, y, z, vx, vy, vz, lifeS, sa, sb, ht, dr = 0.5, by = 0, kind = by < -1 ? 2 : 0) { return emit(x, y, z, vx, vy, vz, lifeS, sa, sb, ht, dr, by, kind, false); }
  function kill(i) {
    if (amb[i] === 1) nAmb--;
    const j = --n; if (i === j) return;
    const i3 = i * 3, j3 = j * 3;
    pos[i3] = pos[j3]; pos[i3 + 1] = pos[j3 + 1]; pos[i3 + 2] = pos[j3 + 2];
    vel[i3] = vel[j3]; vel[i3 + 1] = vel[j3 + 1]; vel[i3 + 2] = vel[j3 + 2];
    misc[i * 2] = misc[j * 2]; misc[i * 2 + 1] = misc[j * 2 + 1];
    life[i] = life[j]; maxLife[i] = maxLife[j]; s0[i] = s0[j]; s1[i] = s1[j]; h0[i] = h0[j]; drag[i] = drag[j]; buoy[i] = buoy[j]; size[i] = size[j]; heat[i] = heat[j]; amb[i] = amb[j];
  }
  function spark(x, y, z, vx, vy, vz, lifeS, ht) {
    if (ns >= MAXS) return;
    const i = ns++, i3 = i * 3;
    spP[i3] = x; spP[i3 + 1] = y; spP[i3 + 2] = z; spV[i3] = vx; spV[i3 + 1] = vy; spV[i3 + 2] = vz; spL[i] = 0; spM[i] = lifeS; spH[i] = ht;
  }
  function killSpark(i) {
    const j = --ns; if (i === j) return;
    const i3 = i * 3, j3 = j * 3;
    spP[i3] = spP[j3]; spP[i3 + 1] = spP[j3 + 1]; spP[i3 + 2] = spP[j3 + 2]; spV[i3] = spV[j3]; spV[i3 + 1] = spV[j3 + 1]; spV[i3 + 2] = spV[j3 + 2];
    spL[i] = spL[j]; spM[i] = spM[j]; spH[i] = spH[j];
  }

  // ---- ambient emitters -----------------------------------------------------------
  // type 0: rooftop vent stack (thin warm exhaust)  type 1: street steam (manhole / grate)
  let emitters = [], cityRef = null;
  function buildEmitters() {
    cityRef = City.emitters; emitters = [];
    let h = 2166136261;
    for (const E of cityRef) {
      if (E.street) emitters.push({ type: 1, x: E.x, y: 0.15, z: E.z, rate: 5 + E.rate, heat: 0.05 + E.heat, size: 1.6 + E.size * 0.6, acc: 0, on: false, top: 14 });
      else emitters.push({ type: 0, x: E.x, y: E.y, z: E.z, rate: E.rate, heat: E.heat, size: E.size, acc: 0, on: false, top: 9 });
      h = Math.imul(h ^ Math.round(E.x * 10 + E.z * 7), 16777619);
    }
    // street steam: deterministic per city; a few down the main avenue (depth cue from the rooftop), rest scattered
    const r = mulberry32(h >>> 0);
    // the city now supplies real steam grates (emitters flagged street); only invent steam if it has none
    const hasGrates = cityRef.some((E) => E.street);
    for (let i = 0; i < (hasGrates ? 0 : 26); i++) {
      let x, z;
      if (i < 9) { x = (r() - 0.5) * 2 * (GRID.mainHW - 4); z = -(120 + i * 280 + r() * 160); }
      else if (r() < 0.6) { x = Math.round((r() - 0.5) * 2 * GRID.nAve) * GRID.aveSp + (r() - 0.5) * 2 * (GRID.aveHW - 3); z = -(80 + r() * 2600); }
      else { x = (r() - 0.5) * 1400; z = -Math.round(1 + r() * 26) * GRID.stSp + (r() - 0.5) * 2 * (GRID.stHW - 2); }
      emitters.push({ type: 1, x, y: 0.15, z, rate: 5 + r() * 4, heat: 0.05 + r() * 0.035, size: 1.6 + r() * 1.4, acc: r(), on: false, top: 14 });
    }
    // tall, turbulent rooftop plumes rising across the approach lane (player -> target)
    if (typeof Target !== 'undefined' && Target.chest) {
      const ax = PLAYER.eye.x, az = PLAYER.eye.z, bx = Target.chest.x - ax, bz = Target.chest.z - az, L2 = bx * bx + bz * bz;
      const cand = [];
      for (const E of emitters) {
        if (E.type !== 0) continue;
        const t = ((E.x - ax) * bx + (E.z - az) * bz) / L2; if (t < 0.2 || t > 0.85) continue;
        const dx = E.x - (ax + bx * t), dz = E.z - (az + bz * t), dd = Math.hypot(dx, dz);
        const gap = PLAYER.eye.y + (Target.chest.y - PLAYER.eye.y) * t - E.y;   // lane height above this roof
        if (dd > 32 && dd < 95 && gap > 2 && gap < 45) cand.push([Math.abs(dd - 40) + Math.abs(gap - 15) * 1.5 + r() * 20, E, t]);
      }
      cand.sort((a, b) => a[0] - b[0]);
      const used = [];
      for (const [, E, t] of cand) {
        if (used.length >= 4) break;
        if (used.some((u) => Math.abs(u - t) < 0.12)) continue;
        used.push(t); E.type = 2; E.rate = 9; E.size = 2.2 + r() * 0.8; E.heat = 0.045 + r() * 0.02; E.top = 40;
      }
      for (const E of emitters) { // nothing ambient within ~30 m of the line of sight to the man
        const t = Math.max(0, Math.min(1.08, ((E.x - ax) * bx + (E.z - az) * bz) / L2));
        if (Math.hypot(E.x - (ax + bx * t), E.z - (az + bz * t)) < 30) E.off = true;
      }
    }
  }
  const wind = new THREE.Vector3();
  let fxT = 0, pxMin = 1.4, maxPtSet = false;
  const camF = new THREE.Vector3(), tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();
  const bPrev = new THREE.Vector3(), tA = new THREE.Vector3(), tB = new THREE.Vector3(); let hasPrev = false;

  function emitAmbient(E, age) {
    let i;
    if (E.type === 2) {
      i = emit(E.x + frnd(-0.3, 0.3), E.y + 0.1, E.z + frnd(-0.3, 0.3), frnd(-0.5, 0.5), frnd(5, 8), frnd(-0.5, 0.5), frnd(6, 9), E.size * 0.5, E.size * frnd(3.5, 5.5), frnd(0.5, 0.58), 0.3, 1.2, 0, true);
    } else if (E.type === 0) {
      i = emit(E.x + frnd(-0.15, 0.15), E.y + 0.1, E.z + frnd(-0.15, 0.15), frnd(-0.25, 0.25), frnd(1.6, 2.6), frnd(-0.25, 0.25), frnd(3.2, 5.2), E.size * 0.35, E.size * frnd(2.2, 3.2), frnd(0.42, 0.52), 0.55, 0.5, 0, true);
    } else {
      // street steam: a thin column out of a grate, widening as it rises (no floating ovals)
      i = emit(E.x + frnd(-0.25, 0.25), E.y, E.z + frnd(-0.25, 0.25), frnd(-0.2, 0.2), frnd(2.6, 3.6), frnd(-0.2, 0.2), frnd(2.8, 4.2), 0.35, E.size * frnd(1.6, 2.4), frnd(0.3, 0.38), 0.45, 0.7, 0, true);
    }
    if (i >= 0 && age > 0) { // prewarm: integrate this particle forward to its age
      let a = Math.min(age, maxLife[i] * 0.98);
      while (a > 0) { const st = Math.min(0.2, a); integrate(i, st); a -= st; }
    }
  }
  function updateEmitters(dt, camPos) {
    if (City.emitters !== cityRef) buildEmitters();
    if (typeof camera === 'undefined') return;
    camera.getWorldDirection(camF);
    const halfAng = Math.atan(Math.tan(camera.fov * DEG * 0.5) * Math.sqrt(1 + camera.aspect * camera.aspect));
    const sc = mat.uniforms.uScale.value;
    let active = 0;
    for (let e = 0; e < emitters.length; e++) {
      const E = emitters[e];
      if (E.off) continue;
      const dx = E.x - camPos.x, dy = E.y + E.top * 0.5 - camPos.y, dz = E.z - camPos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-3;
      const px = (E.size * (E.type ? 6 : 3) * (E.type === 2 ? 3 : 1) * sc) / d; // on-screen size of a grown puff (steam / lane plumes count more)
      const cosA = (dx * camF.x + dy * camF.y + dz * camF.z) / d;
      const vis = px > pxMin && cosA > Math.cos(Math.min(1.5, halfAng + Math.atan(E.top / d) + 0.03));
      if (!vis) { E.on = false; continue; }
      active++;
      if (!E.on) { // came into view: prewarm a full plume
        E.on = true; E.acc = 0;
        const lifeA = E.type === 2 ? 8 : 5, k = Math.round(E.rate * lifeA * 0.9);
        for (let j = 0; j < k; j++) emitAmbient(E, frnd(0, lifeA));
      }
      E.acc += E.rate * dt;
      while (E.acc > 1) { E.acc -= 1; emitAmbient(E, 0); }
    }
    // adaptive LOD: keep the number of live emitters (and fill rate) bounded
    if (active > 96 || nAmb > AMB_MAX * 0.9) pxMin *= 1.06; else if (active < 64 && pxMin > 1.4) pxMin = Math.max(1.4, pxMin * 0.97);
  }

  function integrate(i, dt) {
    life[i] += dt;
    const i3 = i * 3, k = Math.exp(-drag[i] * dt), by = buoy[i];
    let wx = wind.x, wz = wind.z;
    if (by > 0) { // gas: couples to the wind, billows a little
      const s = misc[i * 2 + 1] * 40.0;
      const tb = by > 1.1 ? 1.9 : 0.6;   // lane plumes are more turbulent
      wx += Math.sin(fxT * 1.3 + s) * tb; wz += Math.cos(fxT * 1.1 + s * 1.7) * tb;
    }
    vel[i3] = (vel[i3] - wx) * k + wx;
    vel[i3 + 1] = by > 0 ? vel[i3 + 1] * k + by * dt : vel[i3 + 1] * Math.exp(-drag[i] * 0.3 * dt) + by * dt;
    vel[i3 + 2] = (vel[i3 + 2] - wz) * k + wz;
    pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
    if (pos[i3 + 1] < 0.05) { pos[i3 + 1] = 0.05; vel[i3 + 1] *= -0.3; vel[i3] *= 0.7; vel[i3 + 2] *= 0.7; }
  }

  function update(dt, camPos) {
    fxT += dt; mat.uniforms.uT.value = fxT;
    if (!maxPtSet && typeof renderer !== 'undefined') {
      maxPtSet = true;
      try { const gl = renderer.getContext(); const r = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE); if (r && r[1]) mat.uniforms.uMaxPt.value = Math.min(256, r[1]); } catch (e) { /* keep default */ }
    }
    updateEmitters(dt, camPos);
    { const M = mat.uniforms;
      if (typeof camera !== 'undefined') M.uAmbMax.value = 0.16 * M.uScale.value * 2 * Math.tan(camera.fov * DEG * 0.5);
      M.uLOn.value = 0;
      if (typeof Bullet !== 'undefined' && Bullet.S.active && typeof Target !== 'undefined') { M.uLA.value.copy(Bullet.S.p); M.uLB.value.copy(Target.chest); M.uLOn.value = 1; }
      else if (typeof Target !== 'undefined' && Target.S && Target.S.alive) { M.uLA.value.copy(camPos); M.uLB.value.copy(Target.chest); M.uLOn.value = 1; }
      M.uScrT.value.z = 0; M.uScrR.value.z = 0;
      if (typeof camera !== 'undefined') {
        M.uAspect.value = camera.aspect || 1.78;
        if (typeof Target !== 'undefined' && Target.group && Target.group.visible) { tv.copy(Target.chest).project(camera); if (tv.z < 1) M.uScrT.value.set(tv.x, tv.y, 1); }
        if (typeof Bullet !== 'undefined' && Bullet.S.active) { tv.copy(Bullet.S.p).project(camera); if (tv.z < 1) M.uScrR.value.set(tv.x, tv.y, 1); }
      } }
    // the round tears a hole through gas it passes: push ambient particles away from its path and thin them
    let tear = false;
    if (typeof Bullet !== 'undefined' && Bullet.S.active) {
      if (hasPrev) { tear = true; tA.copy(bPrev); tB.copy(Bullet.S.p); }
      bPrev.copy(Bullet.S.p); hasPrev = true;
    } else hasPrev = false;
    const abx = tB.x - tA.x, aby = tB.y - tA.y, abz = tB.z - tA.z, ab2 = abx * abx + aby * aby + abz * abz + 1e-6;
    const inFlight = typeof G !== 'undefined' && G.state === 'flight';
    for (let i = n - 1; i >= 0; i--) {
      if (life[i] + dt >= maxLife[i] || (inFlight && amb[i] === 2)) { kill(i); continue; }
      if (tear && amb[i] === 1) {
        const i3 = i * 3, px = pos[i3] - tA.x, py = pos[i3 + 1] - tA.y, pz = pos[i3 + 2] - tA.z;
        const t = Math.max(0, Math.min(1, (px * abx + py * aby + pz * abz) / ab2));
        const ox = px - abx * t, oy = py - aby * t, oz = pz - abz * t, od = Math.sqrt(ox * ox + oy * oy + oz * oz) + 1e-4;
        const R = 2.2 + size[i] * 0.6;
        if (od < R) { const k = (R - od) * 14 / od; vel[i3] += ox * k; vel[i3 + 1] += oy * k; vel[i3 + 2] += oz * k; h0[i] *= 0.55; }
      }
      integrate(i, dt);
      const f = life[i] / maxLife[i], kind = misc[i * 2] % 8;
      size[i] = s0[i] + (s1[i] - s0[i]) * Math.sqrt(f);
      if (amb[i] === 1) { // ambient gas (max pass): heat is the displayed grey level; thins as it rises
        const fin = buoy[i] > 1.1 ? Math.min(1, life[i] * 0.55) : Math.min(1, life[i] * 3 + 0.2);
        heat[i] = h0[i] * Math.pow(1 - f, 1.3) * fin;
      } else if (kind < 1.5) { // gas / dust: fast fade-in, heat thins out as the puff grows
        const g = s0[i] / size[i];
        const fin = buoy[i] > 1.1 ? Math.min(1, life[i] * 0.55) : Math.min(1, life[i] * 6 + 0.15);   // lane plumes: dark base, column brightens as it rises
        heat[i] = h0[i] * (1 - f) * (1 - f) * fin * (0.35 + 0.65 * g);
      } else heat[i] = h0[i] * (1 - f) * (1 - f);
    }
    geo.setDrawRange(0, n);
    if (n) {
      aPos.clearUpdateRanges(); aPos.addUpdateRange(0, n * 3); aHeat.clearUpdateRanges(); aHeat.addUpdateRange(0, n);
      aSize.clearUpdateRanges(); aSize.addUpdateRange(0, n); aMisc.clearUpdateRanges(); aMisc.addUpdateRange(0, n * 2);
      aPos.needsUpdate = aHeat.needsUpdate = aSize.needsUpdate = aMisc.needsUpdate = true;
    }
    // sparks: ballistic, bounce once off the ground, streak length follows game-time motion
    const blur = Math.min(0.03, Math.max(0.006, dt * 2.0));
    for (let i = ns - 1; i >= 0; i--) {
      spL[i] += dt;
      if (spL[i] >= spM[i]) { killSpark(i); continue; }
      const i3 = i * 3, k = Math.exp(-1.6 * dt);
      spV[i3] *= k; spV[i3 + 1] = spV[i3 + 1] * k - 9.8 * dt; spV[i3 + 2] *= k;
      spP[i3] += spV[i3] * dt; spP[i3 + 1] += spV[i3 + 1] * dt; spP[i3 + 2] += spV[i3 + 2] * dt;
      if (spP[i3 + 1] < 0.03) { spP[i3 + 1] = 0.03; spV[i3 + 1] *= -0.35; spV[i3] *= 0.6; spV[i3 + 2] *= 0.6; }
    }
    for (let i = 0; i < ns; i++) {
      const i3 = i * 3, o = i * 6, f = spL[i] / spM[i];
      const vx = spV[i3], vy = spV[i3 + 1], vz = spV[i3 + 2], sp = Math.sqrt(vx * vx + vy * vy + vz * vz) + 1e-6;
      const L = Math.min(1.4, Math.max(0.04, sp * blur)) / sp;
      lPos[o] = spP[i3]; lPos[o + 1] = spP[i3 + 1]; lPos[o + 2] = spP[i3 + 2];
      lPos[o + 3] = spP[i3] - vx * L; lPos[o + 4] = spP[i3 + 1] - vy * L; lPos[o + 5] = spP[i3 + 2] - vz * L;
      const h = spH[i] * (1 - f * f) * (f < 0.85 || ((i + (fxT * 30 | 0)) & 1) ? 1 : 0.3); // flicker as they die
      lHeat[i * 2] = h; lHeat[i * 2 + 1] = h * 0.1;
    }
    sGeo.setDrawRange(0, ns * 2);
    if (ns) { aLPos.clearUpdateRanges(); aLPos.addUpdateRange(0, ns * 6); aLHeat.clearUpdateRanges(); aLHeat.addUpdateRange(0, ns * 2); aLPos.needsUpdate = aLHeat.needsUpdate = true; }
  }

  // random unit vector into tv3 (no allocation)
  function randDir(out) { out.set(fgauss(), fgauss(), fgauss()); const l = out.length() || 1; return out.multiplyScalar(1 / l); }

  // Bullet impact on a structure / the street. Keeps the v1 signature; reads the
  // round's incoming velocity (if available) so sparks ricochet along the surface.
  function sparks(p, nrm, count = 40, speed = 30) {
    const horiz = nrm.y > 0.6;
    const inc = tv.set(0, 0, 0);
    if (typeof Bullet !== 'undefined' && Bullet.S && Bullet.S.v) inc.copy(Bullet.S.v);
    if (inc.lengthSq() < 1) inc.copy(nrm).multiplyScalar(-1); inc.normalize();
    const refl = tv2.copy(inc).addScaledVector(nrm, -2 * inc.dot(nrm)).normalize(); // ricochet direction
    // 1. sparks: fast streaks, biased toward the ricochet, always leaving the surface
    count = Math.round(count * 1.7); speed *= 1.15;
    for (let i = 0; i < count; i++) {
      randDir(tv3);
      tv3.lerp(refl, frnd(0.2, 0.75)).normalize();
      const dn = tv3.dot(nrm); if (dn < 0.05) tv3.addScaledVector(nrm, 0.05 - dn * 1.6).normalize();
      const sp = speed * frnd(0.35, 1.25);
      spark(p.x + nrm.x * 0.05, p.y + nrm.y * 0.05, p.z + nrm.z * 0.05, tv3.x * sp, tv3.y * sp, tv3.z * sp, frnd(0.25, 1.0), frnd(1.2, 2.6));
    }
    // 2. hot spot where the core struck (glows, then cools)
    emit(p.x + nrm.x * 0.3, p.y + nrm.y * 0.3, p.z + nrm.z * 0.3, 0, 0, 0, 6.0, 0.42, 0.3, 2.4, 0, 0, 3, false);   // white-hot strike mark, lasts > 2.5 s
    emit(p.x + nrm.x * 0.25, p.y + nrm.y * 0.25, p.z + nrm.z * 0.25, 0, 0, 0, 4.0, 1.0, 0.8, 0.3, 0, 0, 3, false);  // warm halo
    emit(p.x + nrm.x * 1.4, p.y + nrm.y * 1.4, p.z + nrm.z * 1.4, 0, 0, 0, 0.16, 1.6, 2.8, 0.8, 0, 0, 3, false); // flash
    // 3. concrete dust: a jet out of the surface (geyser on the ground), then a lazy cloud
    const nDust = horiz ? 26 : 20;
    for (let i = 0; i < nDust; i++) {
      randDir(tv3); tv3.multiplyScalar(frnd(0.3, 1.2)).addScaledVector(nrm, frnd(0.8, 2.2));
      if (horiz) tv3.y += frnd(0.5, 2.5);
      const sp = frnd(2, 9);
      emit(p.x, p.y, p.z, tv3.x * sp, tv3.y * sp, tv3.z * sp, frnd(1.6, 3.4), frnd(0.25, 0.5), frnd(2.2, 4.5), frnd(0.08, 0.14), frnd(2.2, 3.5), horiz ? -0.4 : 0.15, 1, false);
    }
    // 4. debris chips: warm from the impact, arc and fall
    for (let i = 0; i < 34; i++) {
      randDir(tv3); tv3.addScaledVector(nrm, 1.2).normalize();
      const sp = frnd(4, 18), big = i < 12;
      emit(p.x, p.y, p.z, tv3.x * sp, tv3.y * sp + 2, tv3.z * sp, frnd(1.2, 2.8), big ? frnd(0.09, 0.15) : frnd(0.05, 0.09), big ? 0.08 : 0.05, big ? frnd(0.35, 0.6) : frnd(0.25, 0.5), 0.4, -9.8, 2, false);
    }
  }
  // Hit on the man, anchored at the hit point on the body (no gore): a flash about head size
  // that is gone within a few frames, a short starburst of streaks along the exit direction,
  // one expanding shock ring, and a grey dust / fabric puff that drifts off with the wind.
  const pAnchor = new THREE.Vector3();
  function puff(p0, dir, count = 24) {
    const d = tv2.copy(dir).normalize();
    // the hit test is generous: pull the point onto the man's body (vertical axis through the chest, ~0.14 m surface offset toward the shot point)
    const p = pAnchor.copy(p0);
    if (typeof Target !== 'undefined' && Target.chest && p0.distanceTo(Target.chest) < 2.5) {
      const c = Target.chest; let ox = p0.x - c.x, oz = p0.z - c.z; const ol = Math.hypot(ox, oz);
      if (ol > 0.14) { ox *= 0.14 / ol; oz *= 0.14 / ol; }
      p.set(c.x + ox, clamp(p0.y, c.y - 0.95, c.y + 0.4), c.z + oz);
    }
    // the man is knocked away at roughly 11 m/s along the shot plus 6 m/s up: the effects start
    // with his velocity so they stay on the body for the first frames, then drag off
    let bx = d.x, bz = d.z; const bl = Math.hypot(bx, bz) || 1; bx = bx / bl * 11; bz = bz / bl * 11; const by = 6;
    // flash + ring are pulled a little toward the camera so the torso never hides them
    let fx = p.x, fy = p.y, fz = p.z;
    if (typeof camera !== 'undefined') { tv.subVectors(camera.position, p); const cl = tv.length(); if (cl > 0.5) { tv.multiplyScalar(Math.min(0.35, cl * 0.3) / cl); fx += tv.x; fy += tv.y; fz += tv.z; } }
    emit(fx, fy, fz, bx, by, bz, 0.007, 0.2, 0.16, 3.6, 0, 0, 3, false);                      // hard white point flash, 2-3 frames
    emit(fx, fy, fz, bx, by, bz, 0.05, 0.7, 2.0, 1.05, 0, 0, 4, false);                       // expanding white ring, outside the silhouette
    const nS = 12 + Math.floor(fr() * 5);
    for (let i = 0; i < nS; i++) {                                                         // sparks out of his back along the bullet path
      randDir(tv3); tv3.multiplyScalar(0.3).add(d).normalize(); const sp = frnd(20, 45);
      spark(p.x + d.x * 0.15, p.y + d.y * 0.15, p.z + d.z * 0.15, tv3.x * sp + bx, tv3.y * sp + by, tv3.z * sp + bz, frnd(0.008, 0.02), frnd(1.2, 2.0));
    }
    for (let i = 0; i < 18; i++) {                                                         // cone of cloth / dust bits out of the back
      randDir(tv3); tv3.multiplyScalar(0.35).add(d).normalize(); const sp = frnd(5, 12);
      emit(p.x + d.x * 0.15, p.y + d.y * 0.15, p.z + d.z * 0.15, tv3.x * sp + bx, tv3.y * sp + by, tv3.z * sp + bz, frnd(0.4, 0.8), frnd(0.035, 0.06), 0.03, frnd(0.18, 0.3), 1.2, -6, 2, false);
    }
    for (let i = 0; i < 14; i++) {                                                         // dust spray along the path
      randDir(tv3); tv3.multiplyScalar(0.3).add(d); const sp = frnd(4, 9);
      emit(p.x + d.x * 0.15, p.y + d.y * 0.15, p.z + d.z * 0.15, tv3.x * sp + bx * 0.85, tv3.y * sp + by * 0.6, tv3.z * sp + bz * 0.85,
        frnd(0.25, 0.5), frnd(0.06, 0.1), frnd(0.35, 0.6), frnd(0.06, 0.09), 3, 0.05, 1, false);
    }
    for (let i = 0; i < Math.round(count * 0.5); i++) {                                     // grey puff that travels with him, then thins out
      randDir(tv3); const sp = frnd(0.2, 0.8), carry = frnd(0.85, 1.0);
      emit(p.x + tv3.x * 0.04, p.y + tv3.y * 0.04, p.z + tv3.z * 0.04, tv3.x * sp + bx * carry, tv3.y * sp + by * carry * 0.7, tv3.z * sp + bz * carry,
        frnd(0.6, 1.1), frnd(0.06, 0.1), frnd(0.3, 0.6), frnd(0.04, 0.06), frnd(1.2, 2.0), 0.1, 1, false);
    }
  }
  // Muzzle blast at the muzzle point p (along unit dir): hot forward gas cone, the
  // muzzle brake's two lateral jets (slightly rearward), a flash core, and lingering smoke.
  // muzzle particles are for the scope moment only: removed once the chase cam takes over
  function tag(i) { if (i >= 0) amb[i] = 2; }
  function muzzle(p, dir) {
    const d = tv2.copy(dir).normalize();
    const side = tv.set(-d.z, 0, d.x); if (side.lengthSq() < 1e-6) side.set(1, 0, 0); side.normalize();
    tag(emit(p.x + d.x * 0.8, p.y + d.y * 0.8, p.z + d.z * 0.8, d.x * 3, d.y * 3, d.z * 3, 0.07, 0.5, 1.4, 1.6, 0, 0, 3, false)); // flash
    for (let i = 0; i < 26; i++) {
      randDir(tv3); const sp = frnd(8, 45);
      tv3.multiplyScalar(frnd(0.12, 0.35)).add(d);
      tag(emit(p.x, p.y, p.z, tv3.x * sp, tv3.y * sp, tv3.z * sp, frnd(0.35, 1.2), frnd(0.15, 0.3), frnd(1.2, 2.6), frnd(0.18, 0.4), frnd(5, 8), 0.4, 0, false));
    }
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      for (let i = 0; i < 14; i++) {
        randDir(tv3); const sp = frnd(12, 38);
        tv3.multiplyScalar(0.18).addScaledVector(side, sgn).addScaledVector(d, -0.35);
        tag(emit(p.x, p.y, p.z, tv3.x * sp, tv3.y * sp, tv3.z * sp, frnd(0.4, 1.1), 0.15, frnd(1.0, 2.2), frnd(0.15, 0.32), frnd(5, 8), 0.4, 0, false));
      }
    }
    // scope moment: soft, feathered, cool smoke (darkens the image a little, ~25 %) in the lower
    // half and the sides of the view, keeping a clear window round the reticle; rises, thins and
    // is gone in ~0.3 s. Plus a few soft radial blast streaks for 2-3 frames.
    let tanH = Math.tan(3.3 * DEG), asp = 1.6;
    if (typeof camera !== 'undefined') { tanH = Math.tan(camera.fov * DEG * 0.5); asp = camera.aspect || 1.6; }
    const up = tv.set(-d.x * d.y, 1 - d.y * d.y, -d.z * d.y).normalize(), sd = tv3.crossVectors(d, up).normalize();
    const ux = up.x, uy = up.y, uz = up.z, sx = sd.x, sy = sd.y, sz = sd.z;
    for (let i = 0; i < 22; i++) {
      const dist = frnd(6, 24), h = tanH * dist;
      const ang = frnd(-Math.PI * 0.95, -Math.PI * 0.05) + (i % 4 === 0 ? Math.PI * frnd(0.7, 1.0) : 0); // mostly lower half, a few at the sides
      const rr = frnd(0.42, 0.95) * h;                                                                  // outside the central window
      const oy = Math.sin(ang) * rr, ox = Math.cos(ang) * rr * Math.min(1.1, asp * 0.6), sz0 = h * frnd(0.28, 0.5);
      const rise = frnd(0.6, 1.6) * h;
      tag(emit(p.x + d.x * dist + ux * oy + sx * ox, p.y + d.y * dist + uy * oy + sy * ox, p.z + d.z * dist + uz * oy + sz * ox,
        ux * rise, uy * rise, uz * rise, frnd(0.12, 0.17), sz0 * 0.8, sz0 * 1.7, frnd(0.2, 0.28), 0.5, 0.01, 7, false));
    }
    for (let i = 0; i < 9; i++) {
      const dist = frnd(8, 30), h = tanH * dist, ang = frnd(0, TAU), rr = frnd(0.3, 0.95) * h;
      const ox = Math.cos(ang) * rr, oy = Math.sin(ang) * rr, sp = frnd(700, 1000);
      spark(p.x + d.x * dist + ux * oy + sx * ox, p.y + d.y * dist + uy * oy + sy * ox, p.z + d.z * dist + uz * oy + sz * ox, d.x * sp, d.y * sp, d.z * sp, frnd(0.015, 0.025), frnd(0.25, 0.4));
    }
    // lingering propellant smoke + roof dust kicked by the brake, drifts off with the wind
    for (let i = 0; i < 14; i++) {
      randDir(tv3); tv3.y = Math.abs(tv3.y) * 0.4;
      const sp = frnd(0.5, 3);
      emit(p.x + d.x * frnd(0, 3), p.y + frnd(-0.4, 0.2), p.z + d.z * frnd(0, 3), tv3.x * sp, tv3.y * sp, tv3.z * sp, frnd(2.5, 4.5), 0.4, frnd(2.5, 4.5), frnd(0.012, 0.022), 1.2, 0.25, 1, false);
    }
  }
  // Small dust burst where a body / hat lands on a roof (no gore). strength 0..1
  function dust(p, strength = 1) {
    const k = Math.max(3, Math.round(14 * strength));
    for (let i = 0; i < k; i++) {
      const a = fr() * TAU, sp = frnd(1, 3.5) * (0.5 + strength);
      emit(p.x, p.y + 0.05, p.z, Math.cos(a) * sp, frnd(0.2, 1.2), Math.sin(a) * sp, frnd(0.8, 1.8), 0.15, frnd(0.7, 1.4) * (0.6 + strength * 0.6), 0.04 * (0.5 + strength), 3.5, 0.15, 1, false);
    }
  }
  function clear() { n = 0; nAmb = 0; ns = 0; geo.setDrawRange(0, 0); sGeo.setDrawRange(0, 0); for (const E of emitters) E.on = false; }
  const debug = { get count() { return n; }, get ambient() { return nAmb; }, get sparks() { return ns; }, get emitters() { return emitters.length; }, get active() { return emitters.reduce((a, E) => a + (E.on ? 1 : 0), 0); }, get pxMin() { return pxMin; }, get laneParticles() { let c = 0, hs = 0; for (let i = 0; i < n; i++) if (buoy[i] > 1.1) { c++; hs += heat[i]; } return [c, +hs.toFixed(2)]; }, get lane() { return emitters.filter((E) => E.type === 2).map((E) => ({ x: Math.round(E.x), y: Math.round(E.y), z: Math.round(E.z), on: E.on })); } };
  return { points, update, spawn, sparks, puff, muzzle, dust, clear, wind, debug, noiseTex, setScale(s) { mat.uniforms.uScale.value = s; } };
})();
