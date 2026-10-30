// ---------------------------------------------------------------------------
// Target: low-poly man drawn in ONE draw call (rigid parts skinned to bones in
// the vertex shader, per-vertex temperature: face/hands hottest, coat cooler,
// shoes coolest). Procedural locomotion (IK legs with heel/toe roll, pelvis bob
// and twist, counter-swinging arms), idles (smoking with a glowing ember, phone
// call, binoculars, leaning on the parapet, look-arounds, watch check), and a
// spooked duck -> sprint -> cower/peek. On hit: cartoon Verlet ragdoll launch
// with hinge limits, swept AABB contacts, friction, bounces and sleeping; the
// hat flies off on its own. No gore.
// ---------------------------------------------------------------------------
const Target = (() => {
  const J = { head: 0, neck: 1, chest: 2, pelvis: 3, lSh: 4, lEl: 5, lHa: 6, rSh: 7, rEl: 8, rHa: 9, lHip: 10, lKn: 11, lFt: 12, rHip: 13, rKn: 14, rFt: 15 };
  const NJ = 16;
  const V3 = () => new THREE.Vector3();
  const jp = Array.from({ length: NJ }, V3);   // world joints (alive pose)
  const loc = Array.from({ length: NJ }, V3);  // body-local pose (man faces +Z, +X is his left)
  const P = Array.from({ length: NJ }, V3), PP = Array.from({ length: NJ }, V3);
  const frac = (x) => x - Math.floor(x);
  const angD = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  const fxRand = mulberry32(9137);             // cosmetic randomness (keeps gameRand sequence stable)

  // ======================================================================
  // Geometry: rigid parts, one merged BufferGeometry per outfit variant
  // ======================================================================
  const BN = { pelvis: 0, torso: 1, head: 2, lUA: 3, lFA: 4, lHa: 5, rUA: 6, rFA: 7, rHa: 8, lTh: 9, lSn: 10, lFt: 11, rTh: 12, rSn: 13, rFt: 14, hat: 15, ember: 16, phone: 17, binoc: 18 };
  const NB = 19;
  const TT = { face: 0.96, skin: 0.93, hair: 0.86, neck: 0.92, hand: 0.95, nose: 0.9, ear: 0.9, sleeve: 0.73, trousers: 0.67, trousersLo: 0.64, shoe: 0.6, sole: 0.6, belt: 0.6, collar: 0.61, EMBER: 2.0 };

  function loft(G, bone, rings, n, temp, axis = 'y', rot = Math.PI / n, caps = true) {
    const base = G.p.length / 3;
    const put = (h, a, b, t) => { if (axis === 'y') G.p.push(a, h, b); else G.p.push(a, b, h); G.b.push(bone); G.t.push(t); };
    const tf = (a, h, b, tr) => (typeof temp === 'function' ? temp(a, h, b, tr) : tr != null ? tr : temp);
    for (const r of rings) {
      const [h, ra, rb, ca = 0, cb = 0, tr] = r;
      for (let k = 0; k < n; k++) {
        const ang = rot + (TAU * k) / n, a = ca + ra * Math.sin(ang), b = cb + rb * Math.cos(ang);
        put(h, a, b, tf(a, h, b, tr));
      }
    }
    const nr = rings.length;
    for (let r = 0; r < nr - 1; r++) for (let k = 0; k < n; k++) {
      const a = base + r * n + k, b = base + r * n + ((k + 1) % n);
      G.i.push(a, a + n, b, b, a + n, b + n);
    }
    if (!caps) return;
    for (const ri of [0, nr - 1]) {
      const r = rings[ri], c = G.p.length / 3;
      put(r[0], r[3] || 0, r[4] || 0, tf(r[3] || 0, r[0], r[4] || 0, r[5]));
      for (let k = 0; k < n; k++) G.i.push(c, base + ri * n + k, base + ri * n + ((k + 1) % n));
    }
  }
  const FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  function box(G, bone, x0, y0, z0, x1, y1, z1, t) {
    const base = G.p.length / 3;
    for (let k = 0; k < 8; k++) { G.p.push(k & 1 ? x1 : x0, k & 2 ? y1 : y0, k & 4 ? z1 : z0); G.b.push(bone); G.t.push(t); }
    for (const [a, b, c, d] of FACES) G.i.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
  function beam(G, bone, a, b, w, h, t) {
    const d = new THREE.Vector3().subVectors(b, a);
    const x = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 0, 1)).normalize().multiplyScalar(w / 2);
    const y = new THREE.Vector3().crossVectors(x, d).normalize().multiplyScalar(h / 2);
    const base = G.p.length / 3;
    for (let k = 0; k < 8; k++) {
      const e = k & 4 ? b : a, sx = k & 1 ? 1 : -1, sy = k & 2 ? 1 : -1;
      G.p.push(e.x + x.x * sx + y.x * sy, e.y + x.y * sx + y.y * sy, e.z + x.z * sx + y.z * sy); G.b.push(bone); G.t.push(t);
    }
    for (const [p, q, r, s] of FACES) G.i.push(base + p, base + q, base + r, base + p, base + r, base + s);
  }
  // outfit variants: 0 trench coat + fedora, 1 short jacket + flat cap + satchel, 2 field jacket + ball cap + backpack
  const HAT_Y = [0.058, 0.052, 0.05], HAT_Z = [-0.004, 0.0, -0.004];
  function buildMan(vr) {
    const G = { p: [], b: [], t: [], i: [] };
    const coat = [0.76, 0.77, 0.75][vr];
    // torso (pelvis -> neck along +Y): warmer over the chest and shoulders
    const torsoT = (x, y, z, tr) => (tr != null ? tr : coat + 0.02 * sstep(0.12, 0.4, y) - (z < -0.06 ? 0.015 : 0));
    loft(G, BN.torso, [[-0.03, 0.17, 0.118], [0.15, 0.172, 0.122], [0.33, 0.2, 0.135], [0.43, 0.232, 0.13], [0.49, 0.214, 0.118], [0.535, 0.14, 0.095], [0.562, 0.08, 0.077]], 8, torsoT);
    if (vr === 0) { // raised trench collar + belt
      loft(G, BN.torso, [[0.5, 0.118, 0.105, 0, -0.008], [0.6, 0.1, 0.094, 0, -0.018]], 8, TT.collar, 'y', Math.PI / 8, false);
      loft(G, BN.torso, [[-0.01, 0.178, 0.127], [0.05, 0.178, 0.127]], 8, TT.belt);
    } else if (vr === 1) { // satchel strap across the chest
      beam(G, BN.torso, new THREE.Vector3(-0.16, 0.5, 0.118), new THREE.Vector3(0.17, -0.02, 0.135), 0.05, 0.014, TT.belt);
      beam(G, BN.torso, new THREE.Vector3(-0.16, 0.5, -0.118), new THREE.Vector3(0.17, -0.02, -0.13), 0.05, 0.014, TT.belt);
      box(G, BN.torso, 0.165, -0.25, -0.1, 0.235, -0.01, 0.11, 0.62); // satchel rides with the strap
    } else { // backpack
      box(G, BN.torso, -0.15, 0.1, -0.29, 0.15, 0.47, -0.115, 0.61);
      box(G, BN.torso, -0.13, 0.36, -0.31, 0.13, 0.49, -0.2, 0.63);
    }
    if (vr !== 0) loft(G, BN.torso, [[0.515, 0.126, 0.11, 0, -0.005], [0.585, 0.106, 0.096, 0, -0.012]], 8, TT.collar, 'y', Math.PI / 8, false);
    // pelvis / seat
    loft(G, BN.pelvis, [[0.05, 0.162, 0.112], [-0.07, 0.17, 0.118], [-0.16, 0.13, 0.1]], 8, TT.trousers + 0.02);
    // coat skirt hanging from the waist (cooler toward the hem)
    const hem = [-0.45, -0.14, -0.2][vr];
    const skirtT = (x, y) => lerp(coat - 0.01, coat - 0.05, clamp(-y / 0.45, 0, 1));
    if (vr === 0) loft(G, BN.pelvis, [[0.03, 0.174, 0.124], [-0.2, 0.198, 0.142, 0, -0.006], [hem, 0.222, 0.158, 0, -0.014]], 8, skirtT);
    else {
      loft(G, BN.pelvis, [[0.03, 0.175, 0.125], [hem, 0.184, 0.132, 0, -0.004]], 8, skirtT);
      loft(G, BN.pelvis, [[hem + 0.045, 0.189, 0.137, 0, -0.004], [hem - 0.002, 0.189, 0.137, 0, -0.004]], 8, TT.belt); // waistband
    }
    // legs (hip -> knee -> ankle along +Y)
    for (const s of [1, -1]) {
      const th = s > 0 ? BN.lTh : BN.rTh, sn = s > 0 ? BN.lSn : BN.rSn, ft = s > 0 ? BN.lFt : BN.rFt;
      loft(G, th, [[-0.04, 0.088, 0.094], [0.2, 0.076, 0.082], [0.44, 0.058, 0.064]], 6, TT.trousers);
      loft(G, sn, [[0.0, 0.06, 0.065], [0.14, 0.058, 0.068, 0, -0.006], [0.4, 0.049, 0.052], [0.445, 0.056, 0.059]], 6, (x, y) => lerp(TT.trousers - 0.02, TT.trousersLo, y / 0.45));
      // shoe along +Z (ankle at origin, sole ~ -0.08)
      loft(G, ft, [[-0.078, 0.042, 0.03, 0, -0.048], [-0.04, 0.052, 0.046, 0, -0.035], [0.05, 0.056, 0.04, 0, -0.042], [0.145, 0.05, 0.028, 0, -0.054], [0.2, 0.03, 0.017, 0, -0.062]], 6,
        (x, y) => (y < -0.07 ? TT.sole : TT.shoe), 'z');
    }
    // arms (shoulder -> elbow -> wrist along +Y), hands
    for (const s of [1, -1]) {
      const ua = s > 0 ? BN.lUA : BN.rUA, fa = s > 0 ? BN.lFA : BN.rFA, ha = s > 0 ? BN.lHa : BN.rHa;
      loft(G, ua, [[-0.045, 0.07, 0.075], [0.11, 0.064, 0.068], [0.29, 0.051, 0.055]], 6, TT.sleeve + 0.01);
      loft(G, fa, [[0.0, 0.053, 0.056], [0.2, 0.046, 0.049], [0.255, 0.053, 0.055]], 6, TT.sleeve - 0.02);
      box(G, ha, -0.026, -0.012, -0.044, 0.026, 0.11, 0.044, TT.hand); // mitten
    }
    // head (centre at origin, face toward +Z) + neck, nose, ears
    const headT = (x, y, z) => (z > 0.025 && y < 0.065 ? TT.face : y > 0.06 || z < -0.035 ? TT.hair : TT.skin);
    loft(G, BN.head, [[-0.118, 0.036, 0.03, 0, 0.05], [-0.085, 0.072, 0.08, 0, 0.016], [-0.02, 0.087, 0.098], [0.05, 0.089, 0.101, 0, -0.005], [0.1, 0.067, 0.078, 0, -0.012], [0.128, 0.02, 0.022, 0, -0.012]], 8, headT);
    loft(G, BN.head, [[-0.21, 0.058, 0.058, 0, -0.012], [-0.07, 0.05, 0.05, 0, -0.006]], 6, TT.neck);
    box(G, BN.head, -0.013, -0.04, 0.085, 0.013, 0.018, 0.122, TT.nose);
    box(G, BN.head, 0.082, -0.04, -0.022, 0.098, 0.022, 0.014, TT.ear);
    box(G, BN.head, -0.098, -0.04, -0.022, -0.082, 0.022, 0.014, TT.ear);
    // hats (origin = hat base)
    if (vr === 0) loft(G, BN.hat, [[0, 0.176, 0.19], [0.016, 0.176, 0.19], [0.016, 0.104, 0.115], [0.034, 0.102, 0.113, 0, 0, 0.66], [0.1, 0.096, 0.107], [0.12, 0.068, 0.083, 0, -0.006], [0.126, 0.02, 0.03]], 10, 0.62);
    else if (vr === 1) {
      loft(G, BN.hat, [[0, 0.1, 0.108], [0.034, 0.113, 0.128, 0, 0.012], [0.056, 0.1, 0.122, 0, 0.022], [0.07, 0.03, 0.045, 0, 0.022]], 8, 0.63);
      box(G, BN.hat, -0.078, 0.0, 0.085, 0.078, 0.016, 0.168, 0.61);
    } else {
      loft(G, BN.hat, [[0, 0.098, 0.108], [0.05, 0.094, 0.103], [0.088, 0.066, 0.076], [0.106, 0.016, 0.016]], 8, 0.63);
      box(G, BN.hat, -0.074, -0.002, 0.09, 0.074, 0.012, 0.2, 0.61);
    }
    // props: cigarette with ember (ember at origin), phone, binoculars
    box(G, BN.ember, -0.012, -0.012, -0.012, 0.012, 0.012, 0.012, TT.EMBER);
    box(G, BN.ember, -0.006, -0.006, -0.068, 0.006, 0.006, -0.012, 0.62);
    box(G, BN.phone, -0.007, -0.01, -0.034, 0.007, 0.13, 0.034, 0.62);
    for (const s of [1, -1]) loft(G, BN.binoc, [[0.095, 0.027, 0.027, s * 0.036, -0.012], [0.15, 0.03, 0.03, s * 0.036, -0.012], [0.225, 0.034, 0.034, s * 0.036, -0.012]], 6, 0.6, 'z');
    box(G, BN.binoc, -0.02, -0.02, 0.12, 0.02, 0.0, 0.2, 0.6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(G.p, 3));
    g.setAttribute('aBone', new THREE.Float32BufferAttribute(G.b, 1));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(G.t, 1));
    g.setIndex(G.i);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }
  const GEOS = [buildMan(0), buildMan(1), buildMan(2)];

  const VS_MAN = VARY + `
uniform mat4 uBones[${NB}];
attribute float aBone; attribute float aSeed;
void main(){
  mat4 m = modelMatrix * uBones[int(aBone + 0.5)];
  vec4 wp = m * vec4(position, 1.0);
  vW = wp.xyz; vL = position; vS = vec3(1.0); vN = vec3(0.0, 1.0, 0.0); vSeed = aSeed; vStyle = aBone; vTop = 0.0;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
  const FS_MAN = /* glsl */`
uniform float uEmber; uniform float uHatCool;
void main(){
  vec3 n = flatN(vW);
  float t = vSeed > 1.5 ? uEmber : vSeed;
  if (abs(vStyle - 15.0) < 0.5) t = mix(t, 0.45, uHatCool);      // a detached hat cools quickly
  if (vSeed < 1.5) t *= 0.84 + 0.16*abs(dot(normalize(uCam - vW), n)); // rounder read: cooler toward the outline
  gl_FragColor = thermalOut(t, vW, n);
}`;
  const bones = Array.from({ length: NB }, () => new THREE.Matrix4());
  const mat = thermalMat(FS_MAN, { uBones: { value: bones }, uEmber: { value: 1.0 }, uHatCool: { value: 0 } }, { vertexShader: VS_MAN, side: THREE.DoubleSide });
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(GEOS[0], mat);
  mesh.frustumCulled = false; group.add(mesh); group.frustumCulled = false;

  // ======================================================================
  // State
  // ======================================================================
  const S = {
    alive: false, ragdoll: false, settled: false, roof: null, dist: 0, variant: 0,
    root: V3(), yaw: 0, yawT: 0, faceYaw: 0, speed: 0, wantSpeed: 0, phase: 0, mv: 0, run: 0, step: 0, D: 0, duty: 0.6, lift: 0,
    A: V3(), B: V3(), goingB: true, pause: 0, goal: null, beh: 'patrol', behavior: 'patrol', t: 0, sub: 0, cyc: 7, fid: 0, seed: 0,
    spooked: false, spookT: 0, cover: V3(), atCover: false, peekT: 0, peeking: false,
    headYaw: 0, headPitch: 0, hyT: 0, hpT: 0, scan: 0, parY: 1.05, fp: [0, 0], hf: V3(),
    puff: 0, puffT: 0, exhaled: true, simAcc: 0, settleT: 0, ragT: 0, hatFree: false, hatRest: false, hatRestT: 0, anyContact: false, react: 0, bounced: false, landT: 0, hatT0: 0, starK: 1, flailA: 55, flailW: 13,
  };
  const A = { drag: 0, cig: 0, phone: 0, binoc: 0, lean: 0, watch: 0, crouch: 0, duck: 0, pocket: 0, gesture: 0 };
  const AT = { drag: 0, cig: 0, phone: 0, binoc: 0, lean: 0, watch: 0, crouch: 0, duck: 0, pocket: 0, gesture: 0 };
  const AKEYS = Object.keys(A);
  const chest = V3(), headPos = V3();
  const hatS = { p: V3(), pp: V3(), q: new THREE.Quaternion(), w: V3() };

  // ======================================================================
  // Behaviour
  // ======================================================================
  function yawToPlayer() { return Math.atan2(PLAYER.eye.x - S.root.x, PLAYER.eye.z - S.root.z); }
  function think(dt) {
    for (let i = 0; i < AKEYS.length; i++) AT[AKEYS[i]] = 0;
    S.goal = null; S.wantSpeed = 0; S.hpT = 0;
    S.hyT = 0.5 * Math.sin(S.t * 0.37 + S.seed) * Math.sin(S.t * 0.13 + 1.7 * S.seed);
    if (S.spooked) {
      S.spookT += dt;
      if (S.spookT < 0.5) { AT.duck = 1; S.hpT = 0.25; }
      else if (!S.atCover) { S.goal = S.cover; S.wantSpeed = 4.6; S.hyT = 0; S.hpT = 0.1; }
      else {
        S.peekT -= dt;
        if (S.peekT < 0) { S.peeking = !S.peeking; S.peekT = S.peeking ? grnd(1.4, 2.6) : grnd(1.8, 3.4); }
        S.faceYaw = yawToPlayer();
        AT.crouch = S.peeking ? 0.3 : 1; AT.duck = S.peeking ? 0 : 0.35;
        S.hyT = S.peeking ? 0.3 * Math.sin(S.t * 1.3) : 0; S.hpT = S.peeking ? 0 : 0.3;
      }
      return;
    }
    S.sub += dt;
    if (S.sub > S.cyc) { S.sub = 0; S.cyc = S.beh === 'smoke' ? grnd(5.5, 8.5) : S.beh === 'binocs' ? grnd(7, 11) : grnd(8, 13); S.fid = fxRand() < 0.5 ? 1 : 0; }
    const u = S.sub, idleV = S.variant === 0 ? 1 : 0;
    switch (S.beh) {
      case 'patrol':
        if (S.pause > 0) {
          S.pause -= dt; AT.pocket = idleV;
          S.hyT = 0.95 * Math.sin(S.t * 0.75 + S.seed);
          if (S.fid === 1 && S.pause > 0.7) { AT.watch = 1; AT.pocket = 0; S.hpT = 0.55; S.hyT = 0; }
        } else { S.goal = S.goingB ? S.B : S.A; S.wantSpeed = 1.35; S.hyT = 0.3 * Math.sin(S.t * 0.45 + S.seed); }
        break;
      case 'phone':
        AT.phone = 1; S.hpT = 0.14; S.hyT = 0.45 * Math.sin(S.t * 0.3 + S.seed);
        if (S.pause > 0) { S.pause -= dt; AT.gesture = 0.5 + 0.5 * Math.sin(S.t * 0.9); }
        else { S.goal = S.goingB ? S.B : S.A; S.wantSpeed = 0.8; }
        break;
      case 'smoke': {
        AT.cig = 1; AT.pocket = 1;
        const drag = u > 0.2 && u < 2.1;
        AT.drag = drag ? 1 : 0; S.puff = damp(S.puff, drag && u > 0.9 ? 1 : 0, drag ? 3 : 1.2, dt);
        if (drag) S.exhaled = false;
        if (!S.exhaled && u > 2.7) { S.exhaled = true; S.puffT = 0.7; }
        S.hpT = drag ? -0.12 : S.fid ? 0.25 : 0;
        if (!drag && u > 3.2) S.hyT = 0.8 * Math.sin(S.t * 0.42 + S.seed);
        break;
      }
      case 'binocs': {
        const up = u < S.cyc - 2.8;
        AT.binoc = up ? 1 : 0; S.scan = 0.4 * Math.sin(S.t * 0.22 + S.seed);
        S.hpT = up ? -0.03 : 0.12; S.hyT = up ? 0 : 0.85 * Math.sin(S.t * 0.7 + S.seed); AT.pocket = up ? 0 : idleV;
        break;
      }
      case 'lean': {
        const up = u > S.cyc - 3;
        AT.lean = up ? 0 : 1; AT.pocket = up ? idleV : 0;
        S.hpT = up ? 0.05 : 0.42; S.hyT = up ? 0.9 * Math.sin(S.t * 0.55 + S.seed) : 0.4 * Math.sin(S.t * 0.21 + S.seed);
        break;
      }
    }
    // exhale: a soft warm puff drifting from the mouth
    if (S.puffT > 0) {
      S.puffT -= dt;
      if (fxRand() < dt * 30) {
        const c = Math.cos(S.yaw), s = Math.sin(S.yaw);
        FX.spawn(headPos.x + s * 0.12, headPos.y - 0.05, headPos.z + c * 0.12, s * 0.5 + (fxRand() - 0.5) * 0.2, 0.18, c * 0.5 + (fxRand() - 0.5) * 0.2, 1.8, 0.05, 0.42, 0.2, 0.9, 0.25);
      }
    }
  }
  function arrive() {
    if (S.spooked) { S.atCover = true; S.peekT = grnd(1.5, 2.5); S.peeking = false; return; }
    S.goingB = !S.goingB; S.pause = S.beh === 'phone' ? grnd(2, 5) : grnd(1.6, 4.2); S.fid = fxRand() < 0.4 ? 1 : 0;
  }
  const _d = V3();
  function locomote(dt) {
    let want = 0;
    if (S.goal) {
      _d.subVectors(S.goal, S.root); _d.y = 0; const dist = _d.length();
      if (dist < 0.22) arrive();
      else {
        S.yawT = Math.atan2(_d.x, _d.z);
        const err = Math.abs(angD(S.yawT, S.yaw));
        want = S.wantSpeed * clamp(1.3 - err / 0.9, 0, 1) * clamp(dist / 0.5, 0.3, 1);
      }
    } else S.yawT = S.faceYaw;
    const err = angD(S.yawT, S.yaw), rate = S.wantSpeed > 3 ? 8 : 2.4;
    S.yaw += clamp(err * (1 - Math.exp(-5 * dt)), -rate * dt, rate * dt);
    S.speed = damp(S.speed, want, want > S.speed ? (S.wantSpeed > 3 ? 6 : 2.6) : 4.5, dt);
    if (S.speed > 1e-3) {
      S.root.x += Math.sin(S.yaw) * S.speed * dt; S.root.z += Math.cos(S.yaw) * S.speed * dt;
      const R = S.roof;
      if (R) { S.root.x = clamp(S.root.x, R.x0 + 0.75, R.x1 - 0.75); S.root.z = clamp(S.root.z, R.z0 + 0.75, R.z1 - 0.75); }
    }
    S.mv = clamp(S.speed / 0.45, 0, 1); S.run = clamp((S.speed - 1.8) / 2.2, 0, 1);
    S.step = damp(S.step, Math.abs(err) > 0.22 && S.speed < 0.35 ? 1 : 0, 6, dt);
    S.duty = 0.6 - 0.24 * S.run;
    S.D = clamp(S.speed * 0.62, 0, 0.86) + 0.28 * S.run;
    const f = S.speed > 0.02 ? (S.speed * S.duty) / Math.max(S.D, 0.05) : 0;
    S.phase = frac(S.phase + Math.max(f, S.step * 1.3) * dt);
    S.lift = 0.1 * S.mv + 0.13 * S.run + 0.07 * S.step * (1 - S.mv);
    for (let i = 0; i < AKEYS.length; i++) { const k = AKEYS[i]; A[k] = damp(A[k], AT[k], k === 'duck' ? 9 : k === 'lean' || k === 'crouch' ? 3.2 : 4.2, dt); }
    S.headYaw = damp(S.headYaw, S.hyT, 3, dt); S.headPitch = damp(S.headPitch, S.hpT, 3, dt);
  }

  // ======================================================================
  // Pose (body-local) -> world joints
  // ======================================================================
  const L_TH = 0.44, L_SN = 0.44, L_UA = 0.29, L_FA = 0.26, ANK = 0.08;
  const REST = [[J.chest, new THREE.Vector3(0, 0.29, 0)], [J.neck, new THREE.Vector3(0, 0.53, -0.005)], [J.head, new THREE.Vector3(0, 0.665, 0.012)],
    [J.lSh, new THREE.Vector3(0.197, 0.475, -0.012)], [J.rSh, new THREE.Vector3(-0.197, 0.475, -0.012)]];
  const _ik1 = V3(), _ik2 = V3();
  function ik2(a, t, L1, L2, pole, mid, end) {
    _ik1.subVectors(t, a); let d = _ik1.length();
    const dmax = (L1 + L2) * 0.999, dmin = Math.abs(L1 - L2) + 0.02;
    if (d < 1e-6) { _ik1.set(0, -1, 0); d = dmin; } else _ik1.multiplyScalar(1 / d);
    d = clamp(d, dmin, dmax);
    end.copy(a).addScaledVector(_ik1, d);
    const x = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - x * x));
    _ik2.copy(pole).addScaledVector(_ik1, -pole.dot(_ik1));
    if (_ik2.lengthSq() < 1e-8) _ik2.set(0, 0, 1);
    _ik2.normalize();
    mid.copy(a).addScaledVector(_ik1, x).addScaledVector(_ik2, h);
  }
  const _pel = V3(), _ft = V3(), _pole = V3(), _v = V3(), _w = V3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  function computePose() {
    const mv = S.mv, run = S.run, ph = S.phase, duty = S.duty, D = S.D, lift = S.lift, still = 1 - mv;
    const cr = Math.max(A.crouch, A.duck * 0.75);
    const bob = Math.cos(4 * Math.PI * (ph - duty / 2));
    const py = 0.985 - mv * (1 - run) * (0.024 - 0.017 * bob) - run * (0.075 + 0.035 * bob) - cr * 0.42 - A.lean * 0.035;
    const sway = mv * (1 - run) * 0.026 * Math.cos(TAU * (ph - duty / 2)) + still * (1 - cr) * 0.02 * Math.sin(S.t * 0.33 + S.seed);
    const ptw = -0.12 * mv * Math.cos(TAU * ph) * (1 + 0.6 * run);
    _pel.set(sway, py, -0.07 * A.lean - 0.06 * cr);
    loc[J.pelvis].copy(_pel);
    // legs: stance foot slides back at body speed, swing foot arcs forward; heel/toe roll keeps them reachable
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? 1 : -1;
      const hip = loc[k === 0 ? J.lHip : J.rHip];
      hip.set(_pel.x + s * 0.095 * Math.cos(ptw), py - 0.03, _pel.z - s * 0.095 * Math.sin(ptw));
      const p = frac(ph + (k === 0 ? 0 : 0.5));
      let fz, fy = 0, pitch;
      if (p < duty) { const u = p / duty; fz = D * (0.5 - u); pitch = mv * (u < 0.12 ? -0.3 * (1 - u / 0.12) : u > 0.7 ? (0.75 * (u - 0.7)) / 0.3 : 0); }
      else { const u = (p - duty) / (1 - duty), e = u * u * (3 - 2 * u); fz = D * (e - 0.5); fy = lift * Math.sin(Math.PI * u) * (1.25 - 0.5 * u); pitch = mv * lerp(0.75, -0.3, e); }
      fz += still * (s > 0 ? 0.06 : -0.04) * (1 - cr) + cr * (s > 0 ? 0.17 : -0.1) + A.lean * (s > 0 ? 0.02 : -0.2);
      _ft.set(s * (0.105 + 0.025 * still + 0.07 * cr), ANK + fy, fz);
      const reach = (L_TH + L_SN) * 0.992, dx = _ft.x - hip.x, dz = _ft.z - hip.z;
      const hy = Math.sqrt(Math.max(0, reach * reach - dx * dx - dz * dz));
      const raise = Math.min(0.15, hip.y - hy - _ft.y);
      if (raise > 0) { _ft.y += raise; pitch += (dz < 0 ? 1 : -1.6) * raise * 4.5; }
      S.fp[k] = clamp(pitch, -0.5, 1.0);
      _pole.set(s * 0.15, 0.05, 1);
      ik2(hip, _ft, L_TH, L_SN, _pole, loc[k === 0 ? J.lKn : J.rKn], loc[k === 0 ? J.lFt : J.rFt]);
    }
    // upper body: lean, counter-twist, roll
    const pitch = 0.03 + 0.24 * run + 0.52 * A.lean + 0.5 * cr + 0.06 * A.watch - 0.03 * A.binoc;
    const tw = -0.6 * ptw + A.binoc * S.scan + 0.12 * A.gesture * Math.sin(S.t * 1.1);
    const roll = -sway * 0.9 + 0.05 * A.phone;
    _e.set(pitch, tw, roll, 'YXZ'); _q.setFromEuler(_e);
    for (let i = 0; i < REST.length; i++) loc[REST[i][0]].copy(REST[i][1]).applyQuaternion(_q).add(_pel);
    loc[J.lSh].y += 0.035 * A.duck; loc[J.rSh].y += 0.035 * A.duck;
    const head = loc[J.head];
    const hy = S.headYaw + A.binoc * S.scan, hp = S.headPitch + 0.25 * cr;
    S.hf.set(Math.sin(hy) * Math.cos(hp), -Math.sin(hp), Math.cos(hy) * Math.cos(hp));
    const hf = S.hf, hsx = Math.cos(hy), hsz = -Math.sin(hy); // head's left vector (x,z)
    // arms
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? 1 : -1;
      const sh = loc[k === 0 ? J.lSh : J.rSh], el = loc[k === 0 ? J.lEl : J.rEl], ha = loc[k === 0 ? J.lHa : J.rHa];
      const sw = -s * Math.cos(TAU * ph) * (0.34 * mv * (1 - run) + 0.8 * run);
      const reach = 0.535 - 0.2 * run;
      _ft.set(sh.x + s * (0.045 - 0.07 * run), sh.y - reach * Math.cos(sw) + 0.12 * run, sh.z + reach * Math.sin(sw) + 0.02 + 0.1 * run);
      let raise = 0;
      if (A.pocket > 0.001) { _v.set(s * 0.168, _pel.y - 0.06, _pel.z + 0.085); _ft.lerp(_v, A.pocket * still); }
      if (A.crouch > 0.001) { const kn = loc[k === 0 ? J.lKn : J.rKn]; _v.set(kn.x + s * 0.02, kn.y + 0.07, kn.z + 0.04); _ft.lerp(_v, A.crouch * (1 - A.duck)); }
      if (A.lean > 0.001) { _v.set(s * 0.25, S.parY + 0.03, 0.5); _ft.lerp(_v, A.lean); }
      if (s < 0) {
        if (A.cig > 0.001) { _v.set(-0.17, _pel.y + 0.14, _pel.z + 0.25); _ft.lerp(_v, A.cig * (1 - A.lean)); raise = 0.25 * A.cig; }
        if (A.drag > 0.001) { _v.copy(head).addScaledVector(hf, 0.115); _v.y -= 0.06; _v.x -= hsx * 0.012; _v.z -= hsz * 0.012; _ft.lerp(_v, A.drag); raise = Math.max(raise, A.drag); }
        if (A.phone > 0.001) { _v.set(head.x - hsx * 0.085 + hf.x * 0.02, head.y - 0.035, head.z - hsz * 0.085 + hf.z * 0.02); _ft.lerp(_v, A.phone); raise = Math.max(raise, A.phone); }
      } else {
        if (A.watch > 0.001) { _v.set(0.03, 1.2, 0.3); _ft.lerp(_v, A.watch); raise = 0.5 * A.watch; }
        if (A.gesture > 0.001) { _v.set(0.21, 1.06 + 0.06 * Math.sin(S.t * 2.3), 0.3 + 0.05 * Math.sin(S.t * 1.7)); _ft.lerp(_v, A.gesture * still); raise = Math.max(raise, 0.4 * A.gesture); }
      }
      if (A.binoc > 0.001) { _v.copy(head).addScaledVector(hf, 0.16); _v.x += s * hsx * 0.045; _v.z += s * hsz * 0.045; _v.y -= 0.035; _ft.lerp(_v, A.binoc); raise = Math.max(raise, A.binoc); }
      if (A.duck > 0.001) { _v.set(head.x + s * 0.11, head.y + 0.07, head.z + 0.07); _ft.lerp(_v, A.duck); raise = Math.max(raise, A.duck); }
      _pole.set(s * 0.35, -0.25, -1).lerp(_w.set(s * 0.9, -1, 0.15), raise);
      ik2(sh, _ft, L_UA, L_FA, _pole, el, ha);
    }
  }
  function toWorld() {
    const c = Math.cos(S.yaw), s = Math.sin(S.yaw), r = S.root;
    for (let i = 0; i < NJ; i++) { const l = loc[i]; jp[i].set(r.x + l.x * c + l.z * s, r.y + l.y, r.z - l.x * s + l.z * c); }
  }

  // ======================================================================
  // Bones from joints
  // ======================================================================
  const _a = V3(), _b = V3(), _x = V3(), _y = V3(), _z = V3(), _tx = V3(), _ty = V3(), _tz = V3(), _px = V3(), _py = V3(), _pz = V3();
  const _hx = V3(), _hy = V3(), _hz = V3(), _rx = V3(), _ry = V3(), _rz = V3(), ONE = new THREE.Vector3(1, 1, 1);
  function frameYZ(y, zh, ox, oy, oz) {
    oy.copy(y).normalize();
    oz.copy(zh).addScaledVector(oy, -zh.dot(oy));
    if (oz.lengthSq() < 1e-8) { oz.set(-oy.y, oy.x, 0); if (oz.lengthSq() < 1e-8) oz.set(0, -oy.z, oy.y); }
    oz.normalize(); ox.crossVectors(oy, oz);
  }
  function frameZY(z, yh, ox, oy, oz) {
    oz.copy(z).normalize();
    oy.copy(yh).addScaledVector(oz, -yh.dot(oz));
    if (oy.lengthSq() < 1e-8) { oy.set(-oz.y, oz.x, 0); if (oy.lengthSq() < 1e-8) oy.set(0, -oz.z, oz.y); }
    oy.normalize(); ox.crossVectors(oy, oz);
  }
  function setB(i, o, x, y, z) { bones[i].set(x.x, y.x, z.x, o.x, x.y, y.y, z.y, o.y, x.z, y.z, z.z, o.z, 0, 0, 0, 1); }
  function hideB(i, o) { bones[i].set(0, 0, 0, o.x, 0, 0, 0, o.y, 0, 0, 0, o.z, 0, 0, 0, 1); }
  function limbB(i, a, b, zh) { _y.subVectors(b, a); frameYZ(_y, zh, _x, _y, _z); setB(i, a, _x, _y, _z); }
  function render(J3, alive) {
    const c = Math.cos(S.yaw), sn = Math.sin(S.yaw);
    // torso: up = pelvis->neck, left = rSh->lSh
    _ty.subVectors(J3[J.neck], J3[J.pelvis]);
    _a.subVectors(J3[J.lSh], J3[J.rSh]); _b.crossVectors(_a, _ty);
    frameYZ(_ty, _b, _tx, _ty, _tz); setB(BN.torso, J3[J.pelvis], _tx, _ty, _tz);
    // pelvis: half the torso lean when standing
    _py.copy(_ty); if (alive) _py.add(UP);
    _a.subVectors(J3[J.lHip], J3[J.rHip]); _b.crossVectors(_a, _py);
    frameYZ(_py, _b, _px, _py, _pz); setB(BN.pelvis, J3[J.pelvis], _px, _py, _pz);
    // head
    if (alive) { _a.set(S.hf.x * c + S.hf.z * sn, S.hf.y, -S.hf.x * sn + S.hf.z * c); _b.subVectors(J3[J.head], J3[J.neck]); frameZY(_a, _b, _hx, _hy, _hz); }
    else { _hy.subVectors(J3[J.head], J3[J.neck]); frameYZ(_hy, _tz, _hx, _hy, _hz); }
    setB(BN.head, J3[J.head], _hx, _hy, _hz);
    // arms + hands
    limbB(BN.lUA, J3[J.lSh], J3[J.lEl], _tz); limbB(BN.lFA, J3[J.lEl], J3[J.lHa], _tz); setB(BN.lHa, J3[J.lHa], _x, _y, _z);
    limbB(BN.rUA, J3[J.rSh], J3[J.rEl], _tz); limbB(BN.rFA, J3[J.rEl], J3[J.rHa], _tz); setB(BN.rHa, J3[J.rHa], _x, _y, _z);
    _rx.copy(_x); _ry.copy(_y); _rz.copy(_z);
    // legs + feet (flat with heel/toe pitch while alive; perpendicular to the shin as a ragdoll)
    for (let k = 0; k < 2; k++) {
      const hip = J3[k ? J.rHip : J.lHip], kn = J3[k ? J.rKn : J.lKn], ft = J3[k ? J.rFt : J.lFt];
      limbB(k ? BN.rTh : BN.lTh, hip, kn, _pz); limbB(k ? BN.rSn : BN.lSn, kn, ft, _pz);
      if (alive) { const p = S.fp[k]; _z.set(sn * Math.cos(p), -Math.sin(p), c * Math.cos(p)); frameZY(_z, UP, _x, _y, _z); }
      else { _y.subVectors(kn, ft); frameYZ(_y, _pz, _x, _y, _z); }
      setB(k ? BN.rFt : BN.lFt, ft, _x, _y, _z);
    }
    // hat
    if (!S.hatFree) { _a.copy(J3[J.head]).addScaledVector(_hy, HAT_Y[S.variant]).addScaledVector(_hz, HAT_Z[S.variant]); setB(BN.hat, _a, _hx, _hy, _hz); }
    else bones[BN.hat].compose(hatS.p, hatS.q, ONE);
    // props
    if (alive && A.cig > 0.3) { _a.copy(J3[J.rHa]).addScaledVector(_ry, 0.085).addScaledVector(_rz, 0.03); setB(BN.ember, _a, _rx, _ry, _rz); } else hideB(BN.ember, J3[J.rHa]);
    if (alive && A.phone > 0.5) { _a.copy(J3[J.rHa]).addScaledVector(_ry, 0.02); setB(BN.phone, _a, _rx, _ry, _rz); } else hideB(BN.phone, J3[J.rHa]);
    if (alive && A.binoc > 0.4) setB(BN.binoc, J3[J.head], _hx, _hy, _hz); else hideB(BN.binoc, J3[J.head]);
    mat.uniforms.uEmber.value = 0.9 + 0.55 * S.puff;
    mat.uniforms.uHatCool.value = S.hatFree ? clamp((U.uTime.value - S.hatT0) / 0.5, 0, 1) : 0;
    chest.lerpVectors(J3[J.pelvis], J3[J.neck], 0.6);
    headPos.copy(J3[J.head]);
  }

  // ======================================================================
  // Spawning: behaviour-aware spots (parapet edges, beside rooftop plant, paths)
  // ======================================================================
  function rangeFor(stage) {
    const lo = Math.min(1450, 330 + 125 * (stage - 1)), hi = Math.min(1900, lo + 200 + 25 * stage);
    return [lo, hi];
  }
  const _vo = V3(), _vd = V3(), _vp = V3();
  function visibleFrom(eye, p) {
    _vd.subVectors(p, eye); const d = _vd.length(); _vd.multiplyScalar(1 / d);
    if (!City.raycast(eye, _vd, d)) return true;
    return City.hit.t > d - 0.35;
  }
  const vis = (x, y, z) => visibleFrom(PLAYER.eye, _vp.set(x, y, z));
  function freeOnRoof(R, x, z, m = 1.3, om = 0.8) {
    if (x < R.x0 + m || x > R.x1 - m || z < R.z0 + m || z > R.z1 - m) return false;
    for (const o of R.occ) if (x > o[0] - om && x < o[2] + om && z > o[1] - om && z < o[3] + om) return false;
    return true;
  }
  function pathFree(R, ax, az, bx, bz, m, om) {
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
    for (let i = 0; i <= n; i++) if (!freeOnRoof(R, lerp(ax, bx, i / n), lerp(az, bz, i / n), m, om)) return false;
    return true;
  }
  function parapetTop(R, x, z) {
    _vo.set(x, R.y + 4, z); _vd.set(0, -1, 0);
    if (!City.raycast(_vo, _vd, 6)) return -1;
    return 4 - City.hit.t;
  }
  function pickBeh(stage) {
    const r = gameRand();
    if (stage <= 1) return r < 0.32 ? 'smoke' : r < 0.58 ? 'lean' : r < 0.78 ? 'binocs' : 'patrol';
    return r < 0.2 ? 'smoke' : r < 0.36 ? 'phone' : r < 0.52 ? 'lean' : r < 0.66 ? 'binocs' : 'patrol';
  }
  // Fair-shot corridor: the airspace around the line of fire must be clear (above it for the round's arc,
  // and to both sides for wind drift) until ~15 m short of the man, where local cover is allowed.
  const _cd = new THREE.Vector3(), _cp = new THREE.Vector3(), _side = new THREE.Vector3();
  const COR = [[0, 3.0], [2.0, 0.4], [-2.0, 0.4], [0, 1.4]];
  function corridor(x, y, z, stage) {
    const eye = PLAYER.eye, w = stage >= 9 ? 0.75 : 1;
    _side.set(z - eye.z, 0, -(x - eye.x)).normalize();
    for (const o of COR) {
      _cp.set(x + _side.x * o[0] * w, y + o[1] * w, z + _side.z * o[0] * w);
      _cd.subVectors(_cp, eye); const d = _cd.length(); _cd.multiplyScalar(1 / d);
      if (City.raycast(eye, _cd, d - 15)) return false;
    }
    return true;
  }
  // the line of sight past him must end on something cool (sky, roof deck, parapet, bulkhead, street),
  // never rooftop plant or a windowed facade close behind him
  const _bo = new THREE.Vector3(), _bd = new THREE.Vector3();
  let relax = 0; // 0 strict, 1 allow facades behind + any facing, 2 also allow a hidden hem, 3 allow plant behind
  function backdropOK(x, y0, z) {
    if (relax >= 3) return true;
    for (let k = 0; k < 3; k++) {
      _bd.set(x, y0 + (k === 0 ? 1.7 : k === 1 ? 1.3 : 0.95), z);
      _bo.copy(_bd); _bd.sub(PLAYER.eye).normalize(); _bo.addScaledVector(_bd, 0.7);
      if (!City.raycast(_bo, _bd, 500)) continue;
      const kind = City.hit.kind, t = City.hit.t;
      if (kind === 2 || kind === 3) { if (t < 150) return false; continue; }
      if (Math.abs(City.hit.ny) > 0.5 || City.hit.id < 0) continue;
      const b = City.boxes[City.hit.id];
      if (relax < 1 && b && b.y1 - b.y0 > 6 && t < 45) return false;
    }
    return true;
  }
  // stages 1-3: waist and coat hem must clear the parapet
  function hemOK(x, y0, z, stage) { return stage > 3 || relax >= 2 || (vis(x, y0 + 0.95, z) && vis(x, y0 + 0.6, z)); }
  // side-on to the player reads best at range (hat brim, coat outline)
  function sideYaw(x, z) { const vx = x - PLAYER.eye.x, vz = z - PLAYER.eye.z; return Math.atan2(-vz, vx) + (gameRand() < 0.5 ? Math.PI : 0); }
  function wantSide(x, z) { return relax >= 1 ? 0 : Math.hypot(x - PLAYER.eye.x, z - PLAYER.eye.z) > 600 ? 0.85 : 0.55; }
  function chestOK(ok, stage) { return ok || (stage >= 4 && gameRand() < 0.3); }
  function tryEdge(R, beh, stage, opts) {
    const e = Math.floor(gameRand() * 4), inset = beh === 'lean' ? 0.82 : grnd(0.95, 1.3);
    let x, z, fx = 0, fz = 0, px, pz;
    if (e < 2) { x = grnd(R.x0 + 1.4, R.x1 - 1.4); fz = e === 0 ? -1 : 1; z = e === 0 ? R.z0 + inset : R.z1 - inset; px = x; pz = e === 0 ? R.z0 + 0.17 : R.z1 - 0.17; }
    else { z = grnd(R.z0 + 1.4, R.z1 - 1.4); fx = e === 2 ? -1 : 1; x = e === 2 ? R.x0 + inset : R.x1 - inset; px = e === 2 ? R.x0 + 0.17 : R.x1 - 0.17; pz = z; }
    if (!freeOnRoof(R, x, z, 0.5, 0.75)) return false;
    if (beh !== 'smoke') { const vx = x - PLAYER.eye.x, vz = z - PLAYER.eye.z, vl = Math.hypot(vx, vz); if (Math.abs((fx * vx + fz * vz) / vl) > 0.55 && gameRand() < wantSide(x, z)) return false; }
    const ph = parapetTop(R, px, pz); if (ph < 0.7 || ph > 1.5) return false;
    const lean = beh === 'lean', off = lean ? 0.25 : 0;
    if (!vis(x + fx * off, R.y + (lean ? 1.45 : 1.7), z + fz * off)) return false;
    if (!chestOK(vis(x + fx * off * 0.7, R.y + (lean ? 1.18 : 1.3), z + fz * off * 0.7), stage)) return false;
    if (stage <= 2 && !vis(x, R.y + (lean ? 1.0 : 1.08), z)) return false; // early stages: a fair, open chest shot
    if (!corridor(x, R.y + 1.3, z, stage)) return false;
    if (!hemOK(x, R.y, z, stage) || !backdropOK(x, R.y, z)) return false;
    let yaw = Math.atan2(fx, fz);
    if (beh === 'smoke') yaw = sideYaw(x, z) + grnd(-0.35, 0.35);
    place(R, beh, x, z, x, z, yaw, opts, ph);
    return true;
  }
  function tryProp(R, beh, stage, opts) {
    if (!R.occ.length) return false;
    const o = R.occ[Math.floor(gameRand() * R.occ.length)], side = Math.floor(gameRand() * 4), gap = grnd(0.8, 1.2);
    let x, z, ox = 0, oz = 0;
    if (side === 0) { x = grnd(o[0], o[2]); z = o[1] - gap; oz = -1; } else if (side === 1) { x = grnd(o[0], o[2]); z = o[3] + gap; oz = 1; }
    else if (side === 2) { x = o[0] - gap; z = grnd(o[1], o[3]); ox = -1; } else { x = o[2] + gap; z = grnd(o[1], o[3]); ox = 1; }
    if (!freeOnRoof(R, x, z, 1.0, 0.55)) return false;
    if (!vis(x, R.y + 1.7, z) || !chestOK(vis(x, R.y + 1.3, z), stage)) return false;
    if (!corridor(x, R.y + 1.3, z, stage)) return false;
    if (!hemOK(x, R.y, z, stage) || !backdropOK(x, R.y, z)) return false;
    const yaw = gameRand() < wantSide(x, z) ? sideYaw(x, z) + grnd(-0.35, 0.35) : Math.atan2(ox, oz) + grnd(-0.8, 0.8);
    place(R, beh, x, z, x, z, yaw, opts);
    return true;
  }
  function tryPath(R, beh, stage, opts) {
    const ax = grnd(R.x0 + 1.3, R.x1 - 1.3), az = grnd(R.z0 + 1.3, R.z1 - 1.3);
    const vx0 = ax - PLAYER.eye.x, vz0 = az - PLAYER.eye.z;
    const ang = gameRand() < wantSide(ax, az) ? Math.atan2(vx0, -vz0) + grnd(-0.45, 0.45) + (gameRand() < 0.5 ? Math.PI : 0) : grnd(0, TAU), len = beh === 'phone' ? grnd(2.5, 5) : grnd(5, Math.min(16, Math.max(R.x1 - R.x0, R.z1 - R.z0) * 0.75));
    const bx = ax + Math.cos(ang) * len, bz = az + Math.sin(ang) * len;
    if (!pathFree(R, ax, az, bx, bz, 1.1, 0.7)) return false;
    if (!corridor(ax, R.y + 1.3, az, stage) || !corridor(bx, R.y + 1.3, bz, stage)) return false;
    if (!hemOK(ax, R.y, az, stage) || !hemOK(bx, R.y, bz, stage) || !backdropOK(ax, R.y, az) || !backdropOK(bx, R.y, bz)) return false;
    let hidden = 0;
    for (let s = 0; s <= 6; s++) {
      const x = lerp(ax, bx, s / 6), z = lerp(az, bz, s / 6);
      if (!vis(x, R.y + 1.7, z)) return false;
      if (!vis(x, R.y + 1.3, z)) hidden++;
    }
    if (hidden > (stage >= 3 && gameRand() < 0.5 ? 2 : 0)) return false;
    place(R, beh, ax, az, bx, bz, Math.atan2(bx - ax, bz - az), opts);
    return true;
  }
  function spawn(stage, opts = {}) {
    const eye = PLAYER.eye; const [lo, hi] = rangeFor(stage);
    const pool = City.roofs.filter((R) => {
      const cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2;
      const d = Math.hypot(cx - eye.x, cz - eye.z);
      const yaw = Math.atan2(cx - eye.x, -(cz - eye.z));
      return d > lo && d < hi && Math.abs(yaw) < 40 * DEG && R.x1 - R.x0 > 9 && R.z1 - R.z0 > 9 && R.y < 160;
    });
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(gameRand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    S.stage = stage;
    const first = opts.beh || pickBeh(stage);
    for (relax = 0; relax < 4; relax++) {
      for (const beh of relax === 0 ? [first] : [first, 'patrol', 'smoke']) {
        for (let a = 0; a < Math.min(pool.length, 60); a++) {
          const R = pool[a];
          for (let k = 0; k < (relax === 0 ? 10 : 6); k++) {
            const ok = beh === 'lean' || beh === 'binocs' ? tryEdge(R, beh, stage, opts)
              : beh === 'smoke' ? (gameRand() < 0.55 ? tryProp(R, beh, stage, opts) : tryEdge(R, beh, stage, opts))
                : tryPath(R, beh, stage, opts);
            if (ok) { S.relax = relax; relax = 0; return true; }
          }
        }
      }
    }
    relax = 0;
    const R = pool[0] || City.roofs[Math.floor(City.roofs.length / 2)];
    const cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2;
    place(R, 'patrol', cx - 2, cz, cx + 2, cz, Math.PI / 2, opts);
    return false;
  }
  function place(R, beh, ax, az, bx, bz, yaw, opts = {}, parY = 1.05) {
    S.roof = R; S.alive = true; S.ragdoll = false; S.settled = false; S.hatFree = false; S.hatRest = false;
    S.spooked = false; S.atCover = false; S.beh = S.behavior = beh; S.parY = parY;
    S.A.set(ax, R.y, az); S.B.set(bx, R.y, bz); S.root.copy(S.A); S.goingB = true; S.pause = grnd(0.4, 2.2);
    S.yaw = S.yawT = S.faceYaw = yaw;
    S.variant = opts.variant != null ? opts.variant : Math.floor(gameRand() * 3);
    mesh.geometry = GEOS[S.variant];
    S.seed = grnd(0, 10); S.cyc = grnd(6, 9); S.sub = grnd(0, S.cyc * 0.6); S.t = 0; S.speed = 0; S.phase = 0; S.step = 0; S.mv = S.run = 0;
    S.fid = 0; S.puff = 0; S.puffT = 0; S.exhaled = true; S.scan = 0;
    think(0);
    for (let i = 0; i < AKEYS.length; i++) A[AKEYS[i]] = AT[AKEYS[i]];
    S.headYaw = S.hyT; S.headPitch = S.hpT;
    locomote(0); computePose(); toWorld(); render(jp, true);
    S.dist = chest.distanceTo(PLAYER.eye);
    group.visible = true;
  }

  // ======================================================================
  // Update
  // ======================================================================
  function update(dt) {
    if (!group.visible) return;
    S.t += dt;
    if (S.ragdoll) { simulate(dt); render(P, false); return; }
    think(dt); locomote(dt); computePose(); toWorld(); render(jp, true);
    S.dist = chest.distanceTo(PLAYER.eye);
  }
  function pickCover() {
    // stay near the centre of the player's scope view: little sideways movement across the line of sight
    const R = S.roof; let best = -1e9;
    const lx = S.root.x - PLAYER.eye.x, lz = S.root.z - PLAYER.eye.z, ll = Math.hypot(lx, lz) || 1;
    const latMax = clamp(ll * 0.006, 2.5, 6);
    for (let k = 0; k < 36; k++) {
      const x = grnd(R.x0 + 1.1, R.x1 - 1.1), z = grnd(R.z0 + 1.1, R.z1 - 1.1);
      if (!freeOnRoof(R, x, z, 1.0, 0.55)) continue;
      const d = Math.hypot(x - S.root.x, z - S.root.z); if (d < 3.5) continue;
      const lat = Math.abs(((x - S.root.x) * lz - (z - S.root.z) * lx) / ll); if (lat > latMax) continue;
      if (!pathFree(R, S.root.x, S.root.z, x, z, 0.8, 0.4)) continue;
      let sc = Math.min(d, 14) * 0.15 + grnd(0, 0.6) - lat * 0.5;
      if (!vis(x, R.y + 0.9, z)) sc += 3;
      if (vis(x, R.y + 1.65, z)) sc += 1;
      if (sc > best) { best = sc; S.cover.set(x, R.y, z); }
    }
    if (best < -1e8) S.cover.copy(S.root);
  }
  function spook() {
    if (S.ragdoll || !S.alive || (S.spooked && !S.atCover)) return;
    S.spookT = S.spooked ? 0.35 : 0; S.spooked = true; S.atCover = false; S.peeking = false;
    pickCover();
  }

  // ======================================================================
  // Hit testing
  // ======================================================================
  const CAPS = [
    [J.head, J.head, 0.14, 'head'], [J.pelvis, J.neck, 0.2, 'torso'],
    [J.lSh, J.lEl, 0.08, 'arm'], [J.lEl, J.lHa, 0.075, 'arm'], [J.rSh, J.rEl, 0.08, 'arm'], [J.rEl, J.rHa, 0.075, 'arm'],
    [J.lHip, J.lKn, 0.1, 'leg'], [J.lKn, J.lFt, 0.085, 'leg'], [J.rHip, J.rKn, 0.1, 'leg'], [J.rKn, J.rFt, 0.085, 'leg'],
  ];
  const _d1 = V3(), _d2 = V3(), _r = V3(), _c1 = V3(), _c2 = V3();
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
  const hitRes = { t: 0, part: '', point: V3(), centre: 0 };
  function segmentHit(a, b) {
    if (!S.alive || S.ragdoll) return null;
    _r.subVectors(chest, a); _d1.subVectors(b, a); const L2 = _d1.lengthSq();
    const tt = clamp(_r.dot(_d1) / L2, 0, 1); _c1.copy(a).addScaledVector(_d1, tt);
    if (_c1.distanceToSquared(chest) > 9) return null;
    let best = 2, found = null;
    for (const c of CAPS) {
      const d2 = segSeg(a, b, jp[c[0]], jp[c[1]]);
      if (d2 < c[2] * c[2] && segS < best) { best = segS; found = c; }
    }
    if (!found) return null;
    hitRes.t = best; hitRes.part = found[3]; hitRes.point.copy(a).lerp(b, best);
    hitRes.centre = Math.sqrt(segSeg(a, b, chest, chest));
    return hitRes;
  }
  function distToSegment(a, b) { return Math.sqrt(segSeg(a, b, chest, chest)); }

  // ======================================================================
  // Ragdoll: Verlet particles, distance + hinge constraints, swept AABB contacts
  // ======================================================================
  const SUB = 1 / 240, ITERS = 10, MU = 0.5, BOUNCE = 0.34, VMAX = 38;
  const IMW = new Float32Array(NJ), RADJ = new Float32Array(NJ);
  [[J.head, 1, 0.12], [J.neck, 0.8, 0.08], [J.chest, 0.4, 0.15], [J.pelvis, 0.4, 0.14], [J.lSh, 0.7, 0.1], [J.rSh, 0.7, 0.1], [J.lEl, 1, 0.065], [J.rEl, 1, 0.065],
    [J.lHa, 1.3, 0.06], [J.rHa, 1.3, 0.06], [J.lHip, 0.6, 0.1], [J.rHip, 0.6, 0.1], [J.lKn, 1, 0.075], [J.rKn, 1, 0.075], [J.lFt, 1.2, 0.08], [J.rFt, 1.2, 0.08]]
    .forEach(([j, w, r]) => { IMW[j] = w; RADJ[j] = r; });
  const PAIRS = [
    [J.head, J.neck], [J.head, J.lSh], [J.head, J.rSh], [J.head, J.chest], [J.neck, J.chest], [J.chest, J.pelvis], [J.neck, J.lSh], [J.neck, J.rSh], [J.lSh, J.rSh],
    [J.chest, J.lSh], [J.chest, J.rSh], [J.lSh, J.lHip], [J.rSh, J.rHip], [J.lSh, J.rHip], [J.rSh, J.lHip], [J.pelvis, J.lHip], [J.pelvis, J.rHip], [J.lHip, J.rHip],
    [J.neck, J.pelvis], [J.chest, J.lHip], [J.chest, J.rHip],
    [J.lSh, J.lEl], [J.lEl, J.lHa], [J.rSh, J.rEl], [J.rEl, J.rHa], [J.lHip, J.lKn], [J.lKn, J.lFt], [J.rHip, J.rKn], [J.rKn, J.rFt],
  ];
  const MINC = [[J.lSh, J.lHa, 0.2], [J.rSh, J.rHa, 0.2], [J.lHip, J.lFt, 0.36], [J.rHip, J.rFt, 0.36], [J.lKn, J.rKn, 0.13], [J.lFt, J.rFt, 0.12],
    [J.lHa, J.head, 0.14], [J.rHa, J.head, 0.14], [J.lHa, J.chest, 0.16], [J.rHa, J.chest, 0.16], [J.lKn, J.chest, 0.3], [J.rKn, J.chest, 0.3], [J.lFt, J.pelvis, 0.3], [J.rFt, J.pelvis, 0.3], [J.lHa, J.rHa, 0.1]];
  let CONS = null;
  function buildCons() { // rest lengths from a neutral standing pose
    for (let i = 0; i < AKEYS.length; i++) A[AKEYS[i]] = 0;
    S.mv = S.run = S.step = S.D = S.lift = 0; S.phase = 0; S.headYaw = S.headPitch = 0; S.t = 0; S.seed = 0;
    computePose();
    CONS = new Float32Array(PAIRS.length * 3);
    PAIRS.forEach(([a, b], i) => { CONS[i * 3] = a; CONS[i * 3 + 1] = b; CONS[i * 3 + 2] = loc[a].distanceTo(loc[b]); });
  }
  buildCons();
  const near = [], nearH = []; let nN = 0, nH = 0;
  const addN = (b) => { near[nN++] = b; }, addH = (b) => { nearH[nH++] = b; };
  const CNx = new Float32Array(NJ), CNy = new Float32Array(NJ), CNz = new Float32Array(NJ), CON = new Uint8Array(NJ), VIN = new Float32Array(NJ * 3);
  const cn = { x: 0, y: 0, z: 0 };
  // push p out of the ground and boxes; entry face from the swept motion q->p (no tunnelling, no wrong-side pops)
  function collideP(p, q, r, list, n) {
    let hit = false;
    if (p.y < r) { p.y = r; cn.x = 0; cn.y = 1; cn.z = 0; hit = true; }
    for (let k = 0; k < n; k++) {
      const b = list[k];
      const x0 = b.x0 - r, x1 = b.x1 + r, y0 = b.y0 - r, y1 = b.y1 + r, z0 = b.z0 - r, z1 = b.z1 + r;
      if (p.x <= x0 || p.x >= x1 || p.y <= y0 || p.y >= y1 || p.z <= z0 || p.z >= z1) continue;
      const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
      let ax = -1, sg = 0, best = -1, t;
      if (q.x <= x0 && dx > 0) { t = (x0 - q.x) / dx; if (t > best) { best = t; ax = 0; sg = -1; } } else if (q.x >= x1 && dx < 0) { t = (q.x - x1) / -dx; if (t > best) { best = t; ax = 0; sg = 1; } }
      if (q.y <= y0 && dy > 0) { t = (y0 - q.y) / dy; if (t > best) { best = t; ax = 1; sg = -1; } } else if (q.y >= y1 && dy < 0) { t = (q.y - y1) / -dy; if (t > best) { best = t; ax = 1; sg = 1; } }
      if (q.z <= z0 && dz > 0) { t = (z0 - q.z) / dz; if (t > best) { best = t; ax = 2; sg = -1; } } else if (q.z >= z1 && dz < 0) { t = (q.z - z1) / -dz; if (t > best) { best = t; ax = 2; sg = 1; } }
      if (ax < 0) { // started inside: least penetration
        let m = p.x - x0; ax = 0; sg = -1;
        if (x1 - p.x < m) { m = x1 - p.x; sg = 1; }
        if (y1 - p.y < m) { m = y1 - p.y; ax = 1; sg = 1; }
        if (p.y - y0 < m) { m = p.y - y0; ax = 1; sg = -1; }
        if (p.z - z0 < m) { m = p.z - z0; ax = 2; sg = -1; }
        if (z1 - p.z < m) { m = z1 - p.z; ax = 2; sg = 1; }
      }
      if (ax === 0) p.x = sg < 0 ? x0 : x1; else if (ax === 1) p.y = sg < 0 ? y0 : y1; else p.z = sg < 0 ? z0 : z1;
      cn.x = ax === 0 ? sg : 0; cn.y = ax === 1 ? sg : 0; cn.z = ax === 2 ? sg : 0;
      hit = true;
    }
    return hit;
  }
  // velocity response after projection: one bounce + Coulomb friction per substep
  function respond(p, q, vix, viy, viz, nx, ny, nz, mu, e) {
    let vx = p.x - q.x, vy = p.y - q.y, vz = p.z - q.z;
    const vnIn = vix * nx + viy * ny + viz * nz, vn = vx * nx + vy * ny + vz * nz;
    let tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz), fr = mu * (Math.max(0, -vnIn) + PHYS.g * SUB * SUB);
    const k = tl > fr ? 1 - fr / tl : 0; tx *= k; ty *= k; tz *= k;
    const vo = vnIn < -1.8 * SUB ? -vnIn * e : Math.max(vn, 0);
    q.set(p.x - tx - nx * vo, p.y - ty - ny * vo, p.z - tz - nz * vo);
  }
  const _F = V3(), _U = V3(), _G = V3(), _u = V3(), _s = V3();
  // hinge: the distal segment (m->c) may only bend to one side of the proximal segment (a->m)
  function hinge(a, m, c, fwd, sign) {
    _u.subVectors(P[m], P[a]).normalize();
    _s.copy(fwd).addScaledVector(_u, -fwd.dot(_u)); const L = _s.length(); if (L < 0.35) return;
    _s.multiplyScalar(1 / L);
    const d = _v.subVectors(P[c], P[m]).dot(_s) * sign;
    if (d >= -0.015) return;
    const corr = (-0.015 - d) * sign;
    P[c].addScaledVector(_s, corr * 0.7); P[m].addScaledVector(_s, -corr * 0.3);
  }
  // limb midpoints also collide, so a segment cannot sink into a box edge while its two joints stay outside
  const SEGS = [[J.lSh, J.lEl, 0.07], [J.lEl, J.lHa, 0.06], [J.rSh, J.rEl, 0.07], [J.rEl, J.rHa, 0.06], [J.lHip, J.lKn, 0.09], [J.lKn, J.lFt, 0.07],
    [J.rHip, J.rKn, 0.09], [J.rKn, J.rFt, 0.07], [J.lSh, J.lHip, 0.13], [J.rSh, J.rHip, 0.13], [J.neck, J.head, 0.11], [J.chest, J.pelvis, 0.15]];
  const _sm = V3(), _sq = V3();
  function markCon(i) { if (!CON[i]) { CON[i] = 1; CNx[i] = cn.x; CNy[i] = cn.y; CNz[i] = cn.z; } }
  function collideSegs() {
    let any = false;
    for (let k = 0; k < SEGS.length; k++) {
      const ia = SEGS[k][0], ib = SEGS[k][1], a = P[ia], b = P[ib];
      _sm.addVectors(a, b).multiplyScalar(0.5); _sq.addVectors(PP[ia], PP[ib]).multiplyScalar(0.5);
      const x = _sm.x, y = _sm.y, z = _sm.z;
      if (!collideP(_sm, _sq, SEGS[k][2], near, nN)) continue;
      const dx = _sm.x - x, dy = _sm.y - y, dz = _sm.z - z;
      a.x += dx; a.y += dy; a.z += dz; b.x += dx; b.y += dy; b.z += dz;
      markCon(ia); markCon(ib); any = true;
    }
    return any;
  }
  // comic landing: once down, arms and legs drift out into a starfish
  const STAR = [[J.lHa, J.lSh, 1, 0.42, 0.24], [J.rHa, J.rSh, -1, 0.42, 0.24], [J.lFt, J.lHip, 1, 0.24, -0.82], [J.rFt, J.rHip, -1, 0.24, -0.82]];
  const STAR0 = STAR.map((e) => e.slice());
  function varyPoses() { // no two kills alike: landing spread, flail phases and limb lag are re-rolled per launch
    for (let i = 0; i < 4; i++) { const b = STAR0[i]; STAR[i][3] = b[3] * grnd(0.45, 1.25); STAR[i][4] = i < 2 ? grnd(-0.35, 0.55) : b[4] * grnd(0.85, 1.05); }
    S.starK = grnd() < 0.3 ? 0 : grnd(0.6, 1);
    for (let i = 0; i < FLAIL.length; i++) FLAIL[i][1] = grnd(0, TAU);
    S.flailA = grnd(25, 65); S.flailW = grnd(9, 15);
    for (const j of [J.lHa, J.rHa, J.lFt, J.rFt]) TRAIL[j] = grnd(0.55, 0.85);
    for (const j of [J.lEl, J.rEl, J.lKn, J.rKn]) TRAIL[j] = grnd(0.75, 0.92);
  }
  function starfish(k) {
    _G.subVectors(P[J.lSh], P[J.rSh]).normalize(); _U.subVectors(P[J.neck], P[J.pelvis]).normalize();
    for (let i = 0; i < STAR.length; i++) {
      const e = STAR[i], p = P[e[0]];
      _v.copy(P[e[1]]).addScaledVector(_G, e[2] * e[3]).addScaledVector(_U, e[4]);
      p.x += (_v.x - p.x) * k; p.y += (_v.y - p.y) * k; p.z += (_v.z - p.z) * k;
    }
  }
  const FLAIL = [[J.lHa, 0], [J.rHa, Math.PI * 1.1], [J.lEl, 0.5], [J.rEl, Math.PI * 1.1 + 0.5], [J.lFt, 2], [J.rFt, 4]];
  const GSCALE = 0.78; // cartoon hang time: the thrown body falls at 0.78 g
  function stepBody() {
    const g = PHYS.g * GSCALE * SUB * SUB, vmax = VMAX * SUB, damp_ = S.anyContact && S.ragT > S.landT + 0.8 && S.bounced ? 0.996 : 0.9995;
    for (let i = 0; i < NJ; i++) {
      const p = P[i], q = PP[i];
      let vx = (p.x - q.x) * damp_, vy = (p.y - q.y) * damp_, vz = (p.z - q.z) * damp_;
      const l2 = vx * vx + vy * vy + vz * vz; if (l2 > vmax * vmax) { const k = vmax / Math.sqrt(l2); vx *= k; vy *= k; vz *= k; }
      q.copy(p); p.x += vx; p.y += vy - g; p.z += vz;
      VIN[i * 3] = vx; VIN[i * 3 + 1] = vy - g; VIN[i * 3 + 2] = vz;
    }
    if (S.bounced && S.starK > 0 && S.ragT > S.landT + 0.25) starfish(0.01 * S.starK * Math.min(1, (S.ragT - S.landT - 0.25) / 0.5));
    // body frame for the hinge limits
    _G.subVectors(P[J.lSh], P[J.rSh]); _U.subVectors(P[J.neck], P[J.pelvis]).normalize(); _F.crossVectors(_G, _U).normalize();
    // the arms flail loosely while he is airborne (fades out over 1.3 s)
    if (S.ragT < 1.3 && !S.anyContact) {
      const amp = S.flailA * SUB * SUB * (1 - S.ragT / 1.3), w = S.ragT * S.flailW;
      for (let i = 0; i < FLAIL.length; i++) { const j = FLAIL[i][0], ph = FLAIL[i][1], a = i < 4 ? amp : amp * 0.5; P[j].addScaledVector(_F, a * Math.cos(w + ph)).addScaledVector(_U, a * Math.sin(w + ph)); }
    }
    _w.subVectors(P[J.lHip], P[J.rHip]); _G.crossVectors(_w, _U).normalize(); // pelvis forward
    let any = false; CON.fill(0);
    for (let it = 0; it < ITERS; it++) {
      for (let c = 0; c < CONS.length; c += 3) {
        const ia = CONS[c], ib = CONS[c + 1], a = P[ia], b = P[ib];
        _d.subVectors(b, a); const L = _d.length() || 1e-6; const wa = IMW[ia], wb = IMW[ib];
        const diff = (L - CONS[c + 2]) / (L * (wa + wb));
        a.addScaledVector(_d, diff * wa); b.addScaledVector(_d, -diff * wb);
      }
      for (let c = 0; c < MINC.length; c++) {
        const ia = MINC[c][0], ib = MINC[c][1], a = P[ia], b = P[ib];
        _d.subVectors(b, a); const L = _d.length() || 1e-6; if (L >= MINC[c][2]) continue;
        const wa = IMW[ia], wb = IMW[ib], diff = (L - MINC[c][2]) / (L * (wa + wb));
        a.addScaledVector(_d, diff * wa); b.addScaledVector(_d, -diff * wb);
      }
      if (it & 1) {
        hinge(J.lHip, J.lKn, J.lFt, _G, -1); hinge(J.rHip, J.rKn, J.rFt, _G, -1);
        hinge(J.lSh, J.lEl, J.lHa, _F, 1); hinge(J.rSh, J.rEl, J.rHa, _F, 1);
      }
      for (let i = 0; i < NJ; i++) if (collideP(P[i], PP[i], RADJ[i], near, nN)) { CON[i] = 1; CNx[i] = cn.x; CNy[i] = cn.y; CNz[i] = cn.z; any = true; }
      if (it >= ITERS - 3 && collideSegs()) any = true;
    }
    // one lively bounce on the first hard impact, then dead landings
    const e = S.bounced ? 0.1 : 0.55;
    let hard = false;
    for (let i = 0; i < NJ; i++) if (CON[i]) {
      if (VIN[i * 3] * CNx[i] + VIN[i * 3 + 1] * CNy[i] + VIN[i * 3 + 2] * CNz[i] < -3.2 * SUB) hard = true;
      respond(P[i], PP[i], VIN[i * 3], VIN[i * 3 + 1], VIN[i * 3 + 2], CNx[i], CNy[i], CNz[i], MU, e);
    }
    if (hard && !S.bounced) { S.bounced = true; S.landT = S.ragT; }
    S.anyContact = any;
    for (let i = 0; i < NJ; i++) if (!(P[i].x === P[i].x && P[i].y === P[i].y && P[i].z === P[i].z)) { for (let j = 0; j < NJ; j++) PP[j].copy(P[j].copy(jp[j])); break; }
  }
  const _hq = new THREE.Quaternion(), _hax = V3(), _hup = V3(), IDQ = new THREE.Quaternion();
  function stepHat() {
    const p = hatS.p, q = hatS.pp, g = PHYS.g * SUB * SUB * 0.85;
    const vx = (p.x - q.x) * 0.9985, vy = (p.y - q.y) * 0.9985, vz = (p.z - q.z) * 0.9985;
    q.copy(p); p.x += vx; p.y += vy - g; p.z += vz;
    if (collideP(p, q, 0.05, nearH, nH)) {
      respond(p, q, vx, vy - g, vz, cn.x, cn.y, cn.z, 0.6, 0.3);
      hatS.w.multiplyScalar(0.96);
      // settle flat (crown up or down, whichever is closer)
      _hup.set(0, 1, 0).applyQuaternion(hatS.q);
      _hax.set(0, _hup.y >= 0 ? 1 : -1, 0);
      _hq.setFromUnitVectors(_hup, _hax).slerp(IDQ, 0.94);
      hatS.q.premultiply(_hq);
      if (p.distanceTo(q) < 0.08 * SUB) { S.hatRestT += SUB; if (S.hatRestT > 0.4) S.hatRest = true; } else S.hatRestT = 0;
    }
    const wl = hatS.w.length();
    if (wl > 1e-3) { _hax.copy(hatS.w).multiplyScalar(1 / wl); _hq.setFromAxisAngle(_hax, wl * SUB); hatS.q.premultiply(_hq); }
  }
  const _cc = V3();
  function simulate(dt) {
    S.ragT += dt;
    if (S.react > 0) { S.react -= dt; if (S.react <= 0) applyLaunch(); }
    if (S.settled && (S.hatRest || !S.hatFree)) return;
    S.simAcc += Math.min(dt, 0.05);
    centroid(_cc);
    const sp = P[J.pelvis].distanceTo(PP[J.pelvis]) / SUB;
    nN = 0; City.forBoxesNear(_cc.x, _cc.z, 5 + sp * 0.1, addN);
    nH = 0; if (S.hatFree && !S.hatRest) City.forBoxesNear(hatS.p.x, hatS.p.z, 3, addH);
    let steps = 0;
    while (S.simAcc >= SUB && steps < 14) {
      S.simAcc -= SUB; steps++;
      if (!S.settled && S.react <= 0) stepBody();
      if (S.hatFree && !S.hatRest) stepHat();
    }
    if (steps >= 14) S.simAcc = 0;
    if (!S.settled && steps > 0 && S.react <= 0) {
      let m = 0; for (let i = 0; i < NJ; i++) m = Math.max(m, P[i].distanceToSquared(PP[i]));
      if (Math.sqrt(m) / SUB < 0.2 && S.anyContact) { S.settleT += dt; if (S.settleT > 0.45) S.settled = true; } else S.settleT = 0;
      if (S.ragT > 16) S.settled = true;
    }
  }
  const _hd = V3(), _om = V3(), _rel = V3(), _vel = V3(), _com = V3();
  const LV = { hd: V3(), point: V3(), part: '' };
  // contact-frame smear: the hit drives the hips along the shot so the body folds round them, everything pops up
  const FOLD = new Float32Array(NJ);
  [[J.pelvis, 0.16], [J.lHip, 0.15], [J.rHip, 0.15], [J.chest, 0.12], [J.lSh, 0.07], [J.rSh, 0.07], [J.neck, 0.05], [J.head, 0.01],
    [J.lKn, 0.08], [J.rKn, 0.08], [J.lFt, 0.02], [J.rFt, 0.02]].forEach(([j, w]) => { FOLD[j] = w; });
  function launch(point, dir, part) {
    if (S.ragdoll) return;
    const hadCig = A.cig > 0.3;
    S.ragdoll = true; S.alive = false; S.settled = false; S.simAcc = 0; S.settleT = 0; S.ragT = 0; S.anyContact = false;
    S.hatRest = false; S.hatRestT = 0; S.bounced = false; S.landT = 0; S.react = 0;
    for (let i = 0; i < NJ; i++) P[i].copy(jp[i]);
    _hd.set(dir.x, 0, dir.z); if (_hd.lengthSq() < 1e-6) _hd.set(Math.sin(S.yaw), 0, Math.cos(S.yaw)); _hd.normalize();
    LV.hd.copy(_hd); LV.point.copy(point); LV.part = part;
    const legHit = part === 'leg';
    for (let i = 0; i < NJ; i++) {
      const w = legHit ? (i === J.lFt || i === J.rFt ? 0.16 : i === J.lKn || i === J.rKn ? 0.14 : FOLD[i] * 0.4) : FOLD[i];
      P[i].addScaledVector(_hd, w); P[i].y += 0.07;
    }
    P[J.lFt].y += 0.06; P[J.rFt].y += 0.06;
    // arms flung back and out (trailing the shot), not raised
    _x.set(Math.cos(S.yaw), 0, -Math.sin(S.yaw)); // his left
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? 1 : -1, sh = P[k ? J.rSh : J.lSh], el = P[k ? J.rEl : J.lEl], ha = P[k ? J.rHa : J.lHa];
      _v.copy(_hd).multiplyScalar(-0.65).addScaledVector(_x, s * 0.7).addScaledVector(UP, k ? -0.15 : 0.2).normalize();
      el.copy(sh).addScaledVector(_v, L_UA);
      _w.copy(_v).addScaledVector(_hd, -0.4).addScaledVector(UP, k ? 0.5 : -0.3).normalize();
      ha.copy(el).addScaledVector(_w, L_FA);
    }
    // the hat pops off on the contact frame
    S.hatFree = true; S.hatT0 = U.uTime.value;
    hatS.p.setFromMatrixPosition(bones[BN.hat]); hatS.q.setFromRotationMatrix(bones[BN.hat]);
    hatS.p.addScaledVector(_hd, 0.05); hatS.p.y += 0.12;
    _vel.copy(_hd).multiplyScalar(grnd(2.5, 4.5)); _vel.x += grnd(-1.2, 1.2); _vel.y += grnd(8, 11); _vel.z += grnd(-1.2, 1.2);
    hatS.pp.copy(hatS.p).addScaledVector(_vel, -SUB);
    hatS.w.set(grnd(-14, 14), grnd(-20, 20), grnd(-14, 14));
    FX.puff(point, dir, 30);
    if (hadCig) { // the cigarette ember tumbles away
      _a.setFromMatrixPosition(bones[BN.ember]);
      FX.spawn(_a.x, _a.y, _a.z, _hd.x * 4 + grnd(-1, 1), grnd(3, 5), _hd.z * 4 + grnd(-1, 1), 1.6, 0.05, 0.03, 1.1, 0.4, -9.8);
    }
    varyPoses();
    applyLaunch(); // he leaves the roof on the contact frame
  }
  const TRAIL = new Float32Array(NJ).fill(1);
  [J.lHa, J.rHa, J.lFt, J.rFt].forEach((j) => { TRAIL[j] = 0.72; }); [J.lEl, J.rEl, J.lKn, J.rKn].forEach((j) => { TRAIL[j] = 0.86; });
  // a lower neighbouring roof within reach of the arc (never the street)
  const _lt = V3();
  function lowerRoofTarget(R, up, g, hd) {
    let best = -1e9, found = false;
    for (const R2 of City.roofs) {
      if (R2 === R) continue;
      const drop = R.y - R2.y; if (drop < 1.5 || drop > 30 || R2.y < 6) continue;
      if (R2.x1 - R2.x0 < 7 || R2.z1 - R2.z0 < 7) continue;
      const x = clamp(_com.x, R2.x0 + 3, R2.x1 - 3), z = clamp(_com.z, R2.z0 + 3, R2.z1 - 3);
      const dx = x - _com.x, dz = z - _com.z, D = Math.hypot(dx, dz); if (D < 4 || D > 32) continue;
      if (x > R.x0 && x < R.x1 && z > R.z0 && z < R.z1) continue;
      const cosA = (dx * hd.x + dz * hd.z) / D; if (cosA < -0.2) continue;
      if (!freeOnRoof(R2, x, z, 2.5, 0.9)) continue;
      const t = (up + Math.sqrt(up * up + 2 * g * drop)) / g, vh = D / t; if (vh > 12) continue;
      const sc = cosA * 2 - vh * 0.12 + grnd(0, 0.6);
      if (sc <= best) continue;
      // the arc must be clear: a ray from the apex of the arc to just above the landing spot
      const tu = up / g; _vo.set(_com.x + (dx / D) * vh * tu, _com.y + (up * up) / (2 * g), _com.z + (dz / D) * vh * tu); _vd.set(x, R2.y + 1.6, z).sub(_vo); const L = _vd.length(); _vd.multiplyScalar(1 / L);
      if (City.raycast(_vo, _vd, L - 0.5)) continue;
      if (sc > best) { best = sc; found = true; _lt.set(x, R2.y, z); LV.vh = vh; }
    }
    return found;
  }
  const JIT = new Float32Array(NJ * 3);
  function applyLaunch() {
    const R = S.roof, hd = LV.hd;
    centroid(_com);
    const g = PHYS.g * GSCALE;
    // rise 2.5-3 body heights with a long hang; always enough to clear railings and parapets
    const rise = grnd(4.6, 5.6), up = Math.sqrt(2 * g * rise), tF = (2 * up) / g + 0.15, kS = 0.06;
    let kick = 0; for (let i = 0; i < NJ; i++) kick += 3.5 * Math.exp(-3 * P[i].distanceTo(LV.point)) / NJ; // average hit kick, part of the throw
    let vh, inX = 0, inZ = 0, mode = 'roof';
    // about 1 in 4: sail over the edge onto a lower neighbouring roof (the big arc over the city)
    if (R && grnd() < 0.4 && lowerRoofTarget(R, up, g, hd)) {
      mode = 'over'; hd.set(_lt.x - _com.x, 0, _lt.z - _com.z).normalize(); vh = Math.max(0.5, LV.vh - kick);
    } else {
      // stay on this roof: horizontal speed limited by the room along the throw (air time plus slide);
      // with no room ahead (e.g. shot at the parapet), bend the throw toward open roof - cartoon physics
      const edgeDist = (dx, dz) => {
        if (!R) return 1e9;
        let d = 1e9;
        if (dx > 1e-4) d = Math.min(d, (R.x1 - _com.x) / dx); else if (dx < -1e-4) d = Math.min(d, (R.x0 - _com.x) / dx);
        if (dz > 1e-4) d = Math.min(d, (R.z1 - _com.z) / dz); else if (dz < -1e-4) d = Math.min(d, (R.z0 - _com.z) / dz);
        return d;
      };
      const need = 2.2 * tF + kS * 2.2 * 2.2 + 2.6;
      let bestA = 0, bestD = -1;
      for (const ang of [0, 0.5, -0.5, 1.0, -1.0, 1.45, -1.45]) {
        const c = Math.cos(ang), sn = Math.sin(ang), dx = hd.x * c - hd.z * sn, dz = hd.x * sn + hd.z * c, d = edgeDist(dx, dz);
        if (d >= need) { bestA = ang; bestD = d; break; }
        if (d > bestD) { bestA = ang; bestD = d; }
      }
      if (bestA !== 0) { const c = Math.cos(bestA), sn = Math.sin(bestA), x = hd.x * c - hd.z * sn; hd.z = hd.x * sn + hd.z * c; hd.x = x; }
      const avail = bestD - 2.6; // land well clear of the parapet so the kill camera can see him
      const vhMax = avail > 0 ? (-tF + Math.sqrt(tF * tF + 4 * kS * avail)) / (2 * kS) : 0;
      vh = Math.min(grnd(3, 6), Math.max(0.3, vhMax - kick));
      if (R) { // push away from any parapet he is standing close to
        const m = 2.2, k = (1.4 * 1.6) / tF;
        if (_com.x - R.x0 < m) inX += m - (_com.x - R.x0); if (R.x1 - _com.x < m) inX -= m - (R.x1 - _com.x);
        if (_com.z - R.z0 < m) inZ += m - (_com.z - R.z0); if (R.z1 - _com.z < m) inZ -= m - (R.z1 - _com.z);
        inX *= k; inZ *= k;
      }
    }
    // spin: random axis (backflip, frontflip, cartwheel or a twisting mix) and 1.2-2.4 turns over the air time
    const th = grnd(0, TAU), w = (grnd(1.2, 2.4) * TAU) / tF;
    _x.crossVectors(UP, hd); // backflip axis
    _om.copy(_x).multiplyScalar(Math.cos(th)).addScaledVector(hd, Math.sin(th)).addScaledVector(UP, grnd(-0.35, 0.35)).normalize().multiplyScalar(w);
    LV.dbg = { mode, up: +up.toFixed(2), vh: +vh.toFixed(2), tF: +tF.toFixed(2), spinAxisDeg: Math.round(th / DEG), turns: +((w * tF) / TAU).toFixed(2) };
    let jx = 0, jy = 0, jz = 0;
    for (let i = 0; i < NJ; i++) { const j = TRAIL[i] < 1 ? 2.2 : 0.35; JIT[i * 3] = grnd(-j, j); JIT[i * 3 + 1] = grnd(-j * 0.6, j); JIT[i * 3 + 2] = grnd(-j, j); jx += JIT[i * 3]; jy += JIT[i * 3 + 1]; jz += JIT[i * 3 + 2]; }
    jx /= NJ; jy /= NJ; jz /= NJ; // limbs get their own random lag and swing, without moving the body's centre
    for (let i = 0; i < NJ; i++) {
      _rel.subVectors(P[i], _com);
      _vel.copy(hd).multiplyScalar(vh * TRAIL[i]); _vel.y += up * (0.88 + 0.12 * TRAIL[i]);
      _vel.x += inX; _vel.z += inZ;
      _vel.add(_rel.crossVectors(_om, _rel));
      _vel.addScaledVector(hd, 3.5 * Math.exp(-3 * P[i].distanceTo(LV.point)));
      _vel.x += JIT[i * 3] - jx; _vel.y += JIT[i * 3 + 1] - jy; _vel.z += JIT[i * 3 + 2] - jz;
      PP[i].copy(P[i]).addScaledVector(_vel, -SUB);
    }
  }
  function hide() { group.visible = false; S.alive = false; }
  function centroid(out) { out.set(0, 0, 0); const Q = S.ragdoll ? P : jp; for (let i = 0; i < NJ; i++) out.add(Q[i]); return out.multiplyScalar(1 / NJ); }
  hide();
  const debug = {
    // put the man on a given roof spot with a given behaviour / outfit (for probes)
    respawn(stage = 1, beh, variant) { return spawn(stage, { beh, variant }); },
    bones, A, LV,
  };
  return { group, spawn, update, segmentHit, distToSegment, launch, spook, hide, centroid, chest, head: headPos, S, rangeFor, J, joints: () => (S.ragdoll ? P : jp), debug };
})();
