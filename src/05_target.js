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
  const BN = { pelvis: 0, torso: 1, head: 2, lUA: 3, lFA: 4, lHa: 5, rUA: 6, rFA: 7, rHa: 8, lTh: 9, lSn: 10, lFt: 11, rTh: 12, rSn: 13, rFt: 14, hat: 15, ember: 16, phone: 17, binoc: 18, bat: 19, pack: 20 };
  const NB = 21;
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
  // outfit variants: 0 trench coat + fedora, 1 short jacket + flat cap + satchel, 2 field jacket + ball cap
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
    }   // (variant 2 used to carry a small backpack; only the backpack character carries a pack now)
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
    // character props: a baseball bat (grip at the origin, along +Y) and a big pack (torso frame, on his back,
    // with straps over the shoulders and a small hot light on the side)
    loft(G, BN.bat, [[-0.05, 0.026, 0.026], [-0.032, 0.018, 0.018], [0.26, 0.018, 0.018], [0.46, 0.029, 0.029], [0.8, 0.035, 0.035], [0.84, 0.028, 0.028]], 6, 0.58);
    box(G, BN.pack, -0.22, 0.0, -0.47, 0.22, 0.66, -0.13, 0.64);
    box(G, BN.pack, -0.24, 0.6, -0.45, 0.24, 0.74, -0.21, 0.62);
    for (const s of [1, -1]) {
      box(G, BN.pack, s > 0 ? 0.22 : -0.29, 0.08, -0.42, s > 0 ? 0.29 : -0.22, 0.38, -0.2, 0.63);
      beam(G, BN.pack, new THREE.Vector3(s * 0.11, 0.56, -0.13), new THREE.Vector3(s * 0.13, 0.5, 0.125), 0.05, 0.016, TT.belt);
      beam(G, BN.pack, new THREE.Vector3(s * 0.13, 0.5, 0.125), new THREE.Vector3(s * 0.15, 0.08, 0.13), 0.05, 0.016, TT.belt);
    }
    box(G, BN.pack, 0.29, 0.3, -0.33, 0.31, 0.36, -0.27, 1.0);
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
  mesh.frustumCulled = false; mesh.renderOrder = -2; group.add(mesh); group.frustumCulled = false;   // before window masks

  // ======================================================================
  // State
  // ======================================================================
  const S = {
    alive: false, ragdoll: false, settled: false, roof: null, dist: 0, variant: 0,
    root: V3(), yaw: 0, yawT: 0, faceYaw: 0, speed: 0, wantSpeed: 0, phase: 0, mv: 0, run: 0, step: 0, D: 0, duty: 0.6, lift: 0,
    A: V3(), B: V3(), goingB: true, pause: 0, goal: null, beh: 'patrol', behavior: 'patrol', t: 0, sub: 0, cyc: 7, fid: 0, seed: 0,
    spooked: false, spookT: 0, cover: V3(), atCover: false, peekT: 0, peeking: false, alertT: 0, hide: null, app: null, sprint: 4.6,
    headYaw: 0, headPitch: 0, hyT: 0, hpT: 0, scan: 0, parY: 1.05, fp: [0, 0], hf: V3(),
    puff: 0, puffT: 0, exhaled: true, simAcc: 0, settleT: 0, ragT: 0, hatFree: false, hatRest: false, hatRestT: 0, anyContact: false, react: 0, bounced: false, landT: 0, hatT0: 0, starK: 1, flailA: 55, flailW: 13,
  };
  const A = { drag: 0, cig: 0, phone: 0, binoc: 0, lean: 0, watch: 0, crouch: 0, duck: 0, pocket: 0, gesture: 0, bat: 0 };
  const AT = { drag: 0, cig: 0, phone: 0, binoc: 0, lean: 0, watch: 0, crouch: 0, duck: 0, pocket: 0, gesture: 0, bat: 0 };
  const AKEYS = Object.keys(A);
  const chest = V3(), headPos = V3();
  const hatS = { p: V3(), pp: V3(), q: new THREE.Quaternion(), w: V3() };

  // ======================================================================
  // Behaviour
  // ======================================================================
  function yawToPlayer() { return Math.atan2(PLAYER.eye.x - S.root.x, PLAYER.eye.z - S.root.z); }
  function think(dt) {
    for (let i = 0; i < AKEYS.length; i++) AT[AKEYS[i]] = 0;
    if (S.char === 'bat') AT.bat = 1;
    S.goal = null; S.wantSpeed = 0; S.hpT = 0;
    S.hyT = 0.5 * Math.sin(S.t * 0.37 + S.seed) * Math.sin(S.t * 0.13 + 1.7 * S.seed);
    if (S.spooked) {
      S.spookT += dt;
      if (S.spookT < 0.5) { AT.duck = 1; S.hpT = 0.25; }
      else if (!S.atCover) { S.goal = S.cover; S.wantSpeed = S.sprint; S.hyT = 0; S.hpT = 0.1; }
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
      case 'evade':
        // alerted: sprinting back and forth along his line, reversing at random moments
        S.evT -= dt; if (S.evT <= 0) { S.goingB = !S.goingB; S.evT = grnd(0.6, 1.6); }
        S.goal = S.goingB ? S.B : S.A; S.wantSpeed = 4.2; S.hyT = 0.25 * Math.sin(S.t * 2.3); S.hpT = 0.12; AT.duck = 0.35;
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
    if (S.spooked) { S.atCover = true; S.peekT = grnd(1.5, 2.5); S.peeking = false; S.speed = Math.min(S.speed, 0.6); return; }
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
        // the bat rests on his right shoulder: the hand holds the grip just in front of it
        if (A.bat > 0.001) { _v.set(sh.x + 0.05, sh.y - 0.07, sh.z + 0.17); _ft.lerp(_v, A.bat * (1 - A.duck)); raise = Math.max(raise, 0.7 * A.bat); }
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
  const _hx = V3(), _hy = V3(), _hz = V3(), _rx = V3(), _ry = V3(), _rz = V3(), ONE = new THREE.Vector3(1, 1, 1), _ba = V3(), _bx = V3(), _by = V3(), _bz = V3();
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
    // the bat: over the shoulder while he carries it (up and back along his torso), along his forearm once he falls
    if (S.char === 'bat') {
      if (alive) { _ba.copy(_tx).multiplyScalar(0.12).addScaledVector(_ty, 0.6).addScaledVector(_tz, -0.79); frameYZ(_ba, _tx, _bx, _by, _bz); _a.copy(J3[J.rHa]).addScaledVector(_ry, 0.04); setB(BN.bat, _a, _bx, _by, _bz); }
      else setB(BN.bat, J3[J.rHa], _rx, _ry, _rz);
    } else hideB(BN.bat, J3[J.rHa]);
    if (S.char === 'pack' && !S.packGone) setB(BN.pack, J3[J.pelvis], _tx, _ty, _tz); else hideB(BN.pack, J3[J.pelvis]);
    mat.uniforms.uEmber.value = 0.9 + 0.55 * S.puff;
    mat.uniforms.uHatCool.value = S.hatFree ? clamp((U.uTime.value - S.hatT0) / 0.5, 0, 1) : 0;
    chest.lerpVectors(J3[J.pelvis], J3[J.neck], 0.6);
    headPos.copy(J3[J.head]);
  }

  // ======================================================================
  // Spawning: behaviour-aware spots (parapet edges, beside rooftop plant, paths)
  // ======================================================================
  function rangeFor(stage) {
    const lo = Math.min(780, 300 + 60 * (stage - 1)), hi = Math.min(950, lo + 140 + 10 * stage);
    return [lo, hi];
  }
  // approach-angle band (degrees off the line of sight) that the man's cover demands, per stage
  function coverBand(stage) { const s = Math.max(1, stage) - 1; return [Math.min(17, 6 + 1.3 * s), Math.min(25, 12 + 1.7 * s)]; }
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
  function corridor(x, y, z, stage, near = 15) {
    const eye = PLAYER.eye, w = stage >= 9 ? 0.75 : 1;
    _side.set(z - eye.z, 0, -(x - eye.x)).normalize();
    for (const o of COR) {
      _cp.set(x + _side.x * o[0] * w, y + o[1] * w, z + _side.z * o[0] * w);
      _cd.subVectors(_cp, eye); const d = _cd.length(); _cd.multiplyScalar(1 / d);
      if (City.raycast(eye, _cd, d - near)) return false;
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
  // ---- cover spawn: a rooftop structure stands between him and the player. He starts just outside its
  // shadow (in plain view); when the report reaches him he runs into the shadow. The placement is accepted
  // only if a clear approach lane exists around one side (or over the top) at an angle inside the stage band.
  const _ap = new THREE.Vector3(), _ad = new THREE.Vector3(), _h = new THREE.Vector3();
  // a lane is a fat line: the centre ray plus four rays offset by `pad` metres must all be clear
  const _ar = new THREE.Vector3(), _au = new THREE.Vector3(), _ao = new THREE.Vector3();
  const LANE_OFF = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]], LANE_LEN = 60;
  function approachClear(P, az, el, len, pad = 0.75) {
    _ad.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    _ar.crossVectors(_ad, UP).normalize(); _au.crossVectors(_ar, _ad);
    for (const [ox, oy] of LANE_OFF) {
      // offset rays start a little out from the man (they would otherwise start inside his own roof deck)
      _ao.copy(P).addScaledVector(_ad, ox || oy ? 2.5 : 0.4).addScaledVector(_ar, ox * pad).addScaledVector(_au, oy * pad);
      if (City.raycast(_ao, _ad, len)) return false;
    }
    return true;
  }
  // smallest approach angle (radians off the line of sight) with a clear lane of `len` metres whose entry
  // point can also be reached in a straight line from the shooter's side (so a route exists end to end)
  const _en = new THREE.Vector3(), _eo = new THREE.Vector3(), _ed = new THREE.Vector3(), _er = new THREE.Vector3();
  function entryReachable(P, len) {
    const eye = PLAYER.eye;
    _en.copy(P).addScaledVector(_ad, len);
    _ed.subVectors(eye, _en); const L = _ed.length(); _ed.multiplyScalar(1 / L);
    _er.crossVectors(_ed, UP).normalize();
    for (const o of [0, 1.2, -1.2]) { _eo.copy(_en).addScaledVector(_er, o); if (City.raycast(_eo, _ed, Math.max(10, L - 35))) return false; }
    return true;
  }
  function bestApproach(P, len) {
    const eye = PLAYER.eye, dx = eye.x - P.x, dz = eye.z - P.z, Lh = Math.hypot(dx, dz);
    const az0 = Math.atan2(dx, dz), el0 = Math.atan2(eye.y - P.y, Lh);
    const ok = (az, el) => approachClear(P, az, el, len) && entryReachable(P, len);
    for (let a = 0; a <= 46; a += 1.5) {
      const ar = a * DEG;
      for (const sgn of a === 0 ? [1] : [1, -1]) {
        for (const de of [0, 3, 7]) {
          if (ok(az0 + sgn * ar, el0 + de * DEG)) return { ang: ar, az: az0 + sgn * ar, el: el0 + de * DEG, sgn, top: false };
        }
      }
      // over the top: dive in from higher up the same bearing
      if (a > 0 && ok(az0, el0 + ar)) return { ang: ar, az: az0, el: el0 + ar, sgn: 0, top: true };
    }
    return null;
  }
  const CF = {};   // placement failure counters (debug)
  // free spots for a cover footprint (Wx by Wz) on a roof, scanned on a 1 m grid
  function coverSpots(R, Wx, Wz) {
    const out = [], m = 0.9;
    for (let x = R.x0 + Wx / 2 + m; x <= R.x1 - Wx / 2 - m; x += 1) for (let z = R.z0 + Wz / 2 + m; z <= R.z1 - Wz / 2 - m; z += 1) {
      const c0 = x - Wx / 2, c1 = z - Wz / 2, c2 = x + Wx / 2, c3 = z + Wz / 2;
      if (!R.occ.some((o) => o.length === 4 && c0 < o[2] + 0.6 && c2 > o[0] - 0.6 && c1 < o[3] + 0.6 && c3 > o[1] - 0.6)) out.push([x, z]);
    }
    return out;
  }
  function tryCover(R, beh, stage, opts) {
    const eye = PLAYER.eye, band = coverBand(stage);
    const rcx = (R.x0 + R.x1) / 2, rcz = (R.z0 + R.z1) / 2;
    let lx = rcx - eye.x, lz = rcz - eye.z; const Lr = Math.hypot(lx, lz); lx /= Lr; lz /= Lr;
    const rx = -lz, rz = lx;                                   // player's right, across the line of sight
    // the man's depth into the shadow sets the approach angle: atan((dIn + 0.75) / gBack)
    const Wz = grnd(2.6, 4.4), gBack = grnd(6, 11), aT = grnd(band[0], band[1]) * DEG;
    const dIn = Math.max(0.35, gBack * Math.tan(aT) - 0.75);
    const halfWant = dIn + 0.35 + grnd(0.6, 2.4);
    const Wx = clamp((2 * halfWant - Wz * Math.abs(rz)) / Math.max(0.5, Math.abs(rx)), 4.5, 17);
    if (R.x1 - R.x0 < Wx + 2.2 || R.z1 - R.z0 < Wz + gBack + 3) { CF.small = (CF.small || 0) + 1; return false; }
    const spots = coverSpots(R, Wx, Wz);
    if (!spots.length) { CF.occ = (CF.occ || 0) + 1; return false; }
    for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(gameRand() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
    const halfW = (Wx * Math.abs(rx) + Wz * Math.abs(rz)) / 2;
    if (dIn + 0.35 > halfW + 0.05) { CF.narrow = (CF.narrow || 0) + 1; return false; }
    const occ0 = R.occ.length;
    let deep = 0;
    for (let si = 0; si < Math.min(spots.length, 40) && deep < 4; si++) {
      const cx = spots[si][0], cz = spots[si][1];
      lx = cx - eye.x; lz = cz - eye.z; const L0 = Math.hypot(lx, lz); lx /= L0; lz /= L0;
      const depth = (Wx * Math.abs(lx) + Wz * Math.abs(lz)) / 2 + gBack;
      const scale = (L0 + depth) / L0;                         // shadow widens with distance behind the cover
      const cov = [cx - Wx / 2, cz - Wz / 2, cx + Wx / 2, cz + Wz / 2];
      R.occ.length = occ0; R.occ.push(cov);
      const s0 = gameRand() < 0.5 ? 1 : -1;
      for (const sideS of [s0, -s0]) {
        const latH = sideS * (halfW * scale - dIn - 0.35), latS = sideS * (halfW * scale + grnd(0.75, 1.3) + 0.35);
        const hx = cx + lx * depth + rx * latH, hz = cz + lz * depth + rz * latH;
        const sx = cx + lx * depth + rx * latS, sz = cz + lz * depth + rz * latS;
        if (!freeOnRoof(R, hx, hz, 0.9, 0.5) || !freeOnRoof(R, sx, sz, 0.9, 0.5) || !pathFree(R, sx, sz, hx, hz, 0.8, 0.4)) { CF.roof = (CF.roof || 0) + 1; continue; }
        deep++;
        const r = coverChecks(R, beh, stage, opts, band, cov, cx, cz, Wx, Wz, gBack, depth, hx, hz, sx, sz, rx, rz);
        if (r) return true;
        R.occ.length = occ0; R.occ.push(cov);
        break;
      }
    }
    R.occ.length = occ0;
    return false;
  }
  // the expensive checks (raycasts) for one candidate; on success the cover is built and the man placed
  function coverChecks(R, beh, stage, opts, band, cov, cx, cz, Wx, Wz, gBack, depth, hx, hz, sx, sz, rx, rz) {
    const eye = PLAYER.eye, no = (w) => { City.popCol(); CF[w] = (CF[w] || 0) + 1; return false; };
    // height: hide him standing, whatever the sight line's slope
    const Lh = Math.hypot(hx - eye.x, hz - eye.z), slope = (eye.y - (R.y + 1.85)) / Lh;
    const Hc = clamp(1.85 + slope * (gBack + 0.5) + grnd(1.0, 2.2), 3.4, 9.5);
    City.addCol(cov[0], R.y, cov[1], cov[2], R.y + Hc, cov[3], 1);
    // start spot in plain view, hide spot fully hidden
    if (!vis(sx, R.y + 1.7, sz) || !vis(sx, R.y + 1.3, sz) || !vis(sx, R.y + 1.0, sz)) return no('startHidden');
    if (vis(hx, R.y + 1.75, hz) || vis(hx, R.y + 1.3, hz) || vis(hx, R.y + 0.95, hz)) return no('hideVisible');
    if (!corridor(sx, R.y + 1.3, sz, stage, depth + Wz + 6)) return no('corridor');
    if (!backdropOK(sx, R.y, sz)) return no('backdrop');
    // an approach lane into his crouched chest, around a side or over the top
    _h.set(hx, R.y + 1.0, hz);
    const ap = bestApproach(_h, LANE_LEN);
    if (!ap) return no('noLane');
    const angD_ = ap.ang / DEG;
    if (angD_ < band[0] - 2.5) return no('laneTooEasy');
    if (angD_ > band[1] + 5) return no('laneTooHard');
    // accepted: render the structure (a stair / plant penthouse or a small walk-up with windows), keep the lane
    const style = gameRand() < 0.55 ? 12 : 2;
    City.popCol();
    City.addCover([
      [cov[0], R.y, cov[1], cov[2], R.y + Hc, cov[3], style, grnd()],
      [cov[0] - 0.12, R.y + Hc, cov[1] - 0.12, cov[2] + 0.12, R.y + Hc + 0.22, cov[3] + 0.12, 3, grnd()],
    ]);
    const dir = new THREE.Vector3(Math.sin(ap.az) * Math.cos(ap.el), Math.sin(ap.el), Math.cos(ap.az) * Math.cos(ap.el));
    const sideName = ap.top ? 'TOP' : (dir.x * rx + dir.z * rz) > 0 ? 'RIGHT' : 'LEFT';
    const runYaw = Math.atan2(hx - sx, hz - sz);
    // a regular patrol: from his spot in the open to his spot behind the cover and back, pausing at each end
    place(R, beh, sx, sz, hx, hz, runYaw + grnd(-0.6, 0.6), opts);
    S.hide = new THREE.Vector3(hx, R.y, hz);
    S.app = { dir, len: LANE_LEN, ang: ap.ang, side: sideName, chest: new THREE.Vector3(hx, R.y + 1.0, hz), coverH: Hc, box: [cov[0], R.y, cov[1], cov[2], R.y + Hc + 0.22, cov[3]] };
    return true;
  }
  // three characters, dealt from a shuffled bag: the plain man, a man with a baseball bat on his shoulder, and a
  // man with a big pack that blows up when the round hits him
  let charBag = [];
  function pickChar() {
    if (!charBag.length) { charBag = ['plain', 'bat', 'pack']; for (let i = 2; i > 0; i--) { const j = Math.floor(gameRand() * (i + 1)); [charBag[i], charBag[j]] = [charBag[j], charBag[i]]; } }
    return charBag.pop();
  }
  function spawn(stage, opts = {}) {
    rigReset(); S.type = 'man';
    S.hide = null; S.app = null; S.alertT = 0; S.spot = null; S.wary = 0; S.base = null; S.evT = 0;
    S.char = opts.char || pickChar(); S.packGone = false;
    // the first target: always in the open, close to where the scope starts out pointing
    if (stage <= 1 && !opts.kind) { schedule(); return spawnOpen(stage, Object.assign({ maxYaw: 12 * DEG }, opts)); }
    if (opts.hidden !== false && spawnHidden(stage, opts)) return true;
    if (opts.cover !== false && spawnCover(stage, opts)) return true;
    return spawnOpen(stage, opts);
  }
  // ---- hidden spawn: no line of sight from the shooter at all. The scope sees his heat through the walls;
  // the round has to be flown to him. Three kinds of spot:
  //   roof   – on a lower roof behind taller buildings (open sky above: the round can drop onto him)
  //   street – on a sidewalk, down in a street canyon (open sky above)
  //   awning – on a sidewalk under a deep awning: no way in from above, the round must come down into the
  //            street and fly in level along it or across it
  const nope = (w) => { CF[w] = (CF[w] || 0) + 1; return false; };
  const HID = [[0, 1.75], [0, 1.3], [0, 0.95], [0, 0.35], [-0.32, 1.3], [0.32, 1.3]];
  const _hs = V3(), _up = new THREE.Vector3(0, 1, 0), _hdir = V3();
  function hiddenAt(x, y0, z) {
    const eye = PLAYER.eye; const lx = -(z - eye.z), lz = x - eye.x, ll = Math.hypot(lx, lz) || 1;
    for (const [o, h] of HID) if (visibleFrom(eye, _hs.set(x + (lx / ll) * o, y0 + h, z + (lz / ll) * o))) return false;
    return true;
  }
  function skyOpen(x, y, z, h = 90) {
    for (const [ox, oz] of [[0, 0], [2.2, 0], [-2.2, 0], [0, 2.2], [0, -2.2]]) if (City.raycast(_hs.set(x + ox, y, z + oz), _up, h)) return false;
    return true;
  }
  // nothing solid in the strip he walks (A to B, padded), from ankle to head height
  function walkClear(ax, az, bx, bz, y0, pad = 0.7) {
    const x0 = Math.min(ax, bx) - pad, x1 = Math.max(ax, bx) + pad, z0 = Math.min(az, bz) - pad, z1 = Math.max(az, bz) + pad;
    let ok = true;
    City.forBoxesNear((x0 + x1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0) / 2 + 2, (b) => {
      if (ok && b.x0 < x1 && b.x1 > x0 && b.z0 < z1 && b.z1 > z0 && b.y0 < y0 + 2.1 && b.y1 > y0 + 0.1) ok = false;
    });
    return ok;
  }
  function boxFree(b, skipWall) {
    let ok = true;
    City.forBoxesNear((b[0] + b[3]) / 2, (b[2] + b[5]) / 2, Math.max(b[3] - b[0], b[5] - b[2]) / 2 + 2, (q) => {
      if (!ok || q === skipWall) return;
      if (q.x0 < b[3] && q.x1 > b[0] && q.y0 < b[4] && q.y1 > b[1] && q.z0 < b[5] && q.z1 > b[2]) ok = false;
    });
    return ok;
  }
  // A gate: a point in open air on the shooter's side of him, above the local roofs, that a straight flight
  // from the rifle reaches with room to spare. Every hidden spot needs one (the route in starts there).
  const _ga = V3(), _gb = V3(), _gd = V3(), _dn = new THREE.Vector3(0, -1, 0);
  function gateFor(x, y, z) {
    const eye = PLAYER.eye, hx = eye.x - x, hz = eye.z - z, hl = Math.hypot(hx, hz) || 1, ux = hx / hl, uz = hz / hl;
    for (const back of [55, 42, 66]) for (const up of [18, 28, 40, 55, 75, 100]) {
      const gx = x + ux * back, gz = z + uz * back, gy = y + up;
      if (gy > Math.max(220, y + 50)) continue;
      if (City.raycast(_hs.set(gx, gy + 5, gz), _dn, 10)) continue;   // open air 5 m above and below
      let ok = true;
      for (const [o, oy] of [[0, 0], [3.5, 0], [-3.5, 0], [0, 3.5]]) {
        _ga.set(eye.x - uz * o, eye.y + oy, eye.z + ux * o); _gb.set(gx - uz * o, gy + oy, gz + ux * o);
        _gd.subVectors(_gb, _ga); const L = _gd.length(); _gd.multiplyScalar(1 / L);
        if (City.raycast(_ga, _gd, L)) { ok = false; break; }
      }
      if (ok) return new THREE.Vector3(gx, gy, gz);
    }
    return null;
  }
  function rayLen(x, y, z, dx, dz, len) { _hdir.set(dx, 0, dz).normalize(); return City.raycast(_hs.set(x, y, z), _hdir, len) ? City.hit.t : len; }
  // What the target is, stage by stage. Mostly a man in a tight spot from a shuffled bag, no spot type twice in
  // a row: a lower roof behind taller buildings, the top of one of the tallest towers, a setback ledge high on a
  // tower, a sidewalk down in a street canyon, under an awning. Round 2 is a technical out on the main avenue,
  // round 4 a man way up on top of one of the tallest towers. After that a technical and a quadcopter each
  // turn up about once every 6 to 8 stages.
  let bag = [], lastKind = '', nextCar = 9, nextQuad = 5, lastMachine = 2;
  function schedule() { nextCar = 8 + Math.floor(gameRand() * 3); nextQuad = 4 + Math.floor(gameRand() * 3); lastMachine = 2; }
  function hiddenKind(stage) {
    if (stage === 2) { lastKind = 'highway'; return 'highway'; }   // the second target: a technical out on the avenue
    if (stage === 4) { lastKind = 'tower'; return 'tower'; }       // the fourth: way up on top of a tall tower
    if (stage === 10) { lastKind = 'heli'; lastMachine = 10; return 'heli'; }   // the tenth: a helicopter on a helipad
    const gap = stage - lastMachine >= 3;                            // machines at least three stages apart
    if (gap && stage >= nextQuad) { nextQuad = stage + 6 + Math.floor(gameRand() * 3); lastMachine = stage; lastKind = 'quad'; return 'quad'; }
    if (gap && stage >= nextCar) { nextCar = stage + 6 + Math.floor(gameRand() * 3); lastMachine = stage; lastKind = 'car'; return 'car'; }
    // up high (roof, tower, ledge) about three times in five
    const kinds = stage <= 1 ? ['roof', 'street', 'roof'] : stage <= 3 ? ['roof', 'roof', 'street', 'awning'] : ['roof', 'tower', 'ledge', 'street', 'awning'];
    if (!bag.length || bag.some((k) => !kinds.includes(k))) { bag = kinds.slice(); for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(gameRand() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; } }
    let i = bag.findIndex((k) => k !== lastKind); if (i < 0) i = 0;
    const k = bag.splice(i, 1)[0]; lastKind = k; return k;
  }
  // distance: anywhere from ~250 m out to the stage's longest, now and then a very long shot
  function hiddenBand(stage) {
    const s = Math.max(1, stage) - 1, max = Math.min(950, 450 + 70 * s);
    if (stage >= 2 && gameRand() < 0.15) return [Math.max(260, max - 40), Math.min(1150, max + 220)];
    const c = grnd(260, max); return [Math.max(230, c - 80), c + 80];
  }
  const inSector = (x, z, band) => { const eye = PLAYER.eye, d = Math.hypot(x - eye.x, z - eye.z); return d > band[0] && d < band[1] && Math.abs(Math.atan2(x - eye.x, -(z - eye.z))) < 26 * DEG; };
  const shuffled = (out) => { for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(gameRand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };
  function streetSpots(band) {
    const eye = PLAYER.eye, out = [], river = City.features.river, half = 26 * DEG;
    const inBand = (x, z) => inSector(x, z, band);
    const offAve = (x, m) => { const j = Math.round(x / GRID.aveSp); return Math.abs(x - j * GRID.aveSp) > (j === 0 ? GRID.mainHW : GRID.aveHW) + GRID.sw + m; };
    const offSt = (z, m) => { const k = Math.round(-z / GRID.stSp); return Math.abs(z + k * GRID.stSp) > GRID.stHW + GRID.sw + m; };
    const face = GRID.stHW + GRID.sw;
    // sidewalks of the cross streets (they run across the view, along x)
    for (let k = 1; k < GRID.nSt; k++) {
      if (river && (k === river.k || k === river.k + 1)) continue;
      const zc = -k * GRID.stSp;
      for (const side of [-1, 1]) {
        const zWall = zc + side * face;
        for (let i = 0; i < 8; i++) {
          const zm = zWall - side * grnd(1.6, 2.5), dz = eye.z - zm, x = eye.x + grnd(-1, 1) * Math.tan(half) * dz;
          if (inBand(x, zm) && offAve(x, 9)) out.push({ x, z: zm, wall: zWall, ax: 1, az: 0, nx: 0, nz: -side, opp: zWall - side * 2 * face });
        }
      }
    }
    // sidewalks of the side avenues (they run away from the shooter, along z)
    for (let j = -GRID.nAve + 1; j < GRID.nAve; j++) {
      if (j === 0) continue;
      const xc = j * GRID.aveSp, fw = GRID.aveHW + GRID.sw;
      for (const side of [-1, 1]) {
        const xWall = xc + side * fw;
        for (let i = 0; i < 8; i++) {
          const xm = xWall - side * grnd(1.6, 2.5), z = eye.z - grnd(band[0], band[1]);
          if (inBand(xm, z) && offSt(z, 9)) out.push({ x: xm, z, wall: xWall, ax: 0, az: 1, nx: -side, nz: 0, opp: xWall - side * 2 * fw });
        }
      }
    }
    return shuffled(out);
  }
  // ---- technical: a pickup with a machine gun, parked a metre off the kerb; the truck itself is the target (see "Car target" below)
  function carSpots(band) {
    const eye = PLAYER.eye, out = [], river = City.features.river, half = 26 * DEG;
    for (let k = 1; k < GRID.nSt; k++) {
      if (river && (k === river.k || k === river.k + 1)) continue;
      const zc = -k * GRID.stSp;
      for (const side of [-1, 1]) for (let i = 0; i < 6; i++) {
        const z = zc + side * (GRID.stHW - 2.0), x = eye.x + grnd(-1, 1) * Math.tan(half) * (eye.z - z);
        if (inSector(x, z, band)) out.push({ x, z, ax: 1, az: 0 });
      }
    }
    for (let j = -GRID.nAve + 1; j < GRID.nAve; j++) {
      if (j === 0) continue;
      for (const side of [-1, 1]) for (let i = 0; i < 6; i++) {
        const x = j * GRID.aveSp + side * (GRID.aveHW - 2.3), z = eye.z - grnd(band[0], band[1]);
        if (inSector(x, z, band)) out.push({ x, z, ax: 0, az: 1 });
      }
    }
    return shuffled(out);
  }
  function tryCar(c) {
    const ax = c.ax, az = c.az, lx = -az, lz = ax;
    const cb = (a0, a1, l0, l1, y0, y1) => {
      const xs = [c.x + ax * a0 + lx * l0, c.x + ax * a1 + lx * l1], zs = [c.z + az * a0 + lz * l0, c.z + az * a1 + lz * l1];
      return [Math.min(...xs), y0, Math.min(...zs), Math.max(...xs), y1, Math.max(...zs)];
    };
    if (!boxFree(cb(-2.5, 2.5, -1.15, 1.15, 0.02, 1.9), null)) return nope('hcBox');
    // a clear run in along the street to one end of the car, at body height
    const runF = rayLen(c.x + ax * 2.6, 0.9, c.z + az * 2.6, ax, az, 60), runB = rayLen(c.x - ax * 2.6, 0.9, c.z - az * 2.6, -ax, -az, 60);
    if (Math.max(runF, runB) < 42) return nope('hcRun');
    const dir = runF >= runB ? 1 : -1;
    const gate = gateFor(c.x, 0.9, c.z); if (!gate) return nope('hcGate');
    rigSpawn('car', c.x, 0, c.z, Math.atan2(ax * dir, az * dir));
    // the run-in: a shallow glide down the street (above the kerbside clutter) into the truck's nose
    const ex = (d) => new THREE.Vector3(c.x + ax * dir * d, 1.2 + 0.06 * d, c.z + az * dir * d);
    S.spot = { kind: 'car', gate, glass: [], entry: ex(9), entry2: ex(33) };
    return true;
  }
  function tryStreet(c, kind, stage) {
    const L = grnd(3.5, 6.5), ax = c.x - c.ax * L, az = c.z - c.az * L, bx = c.x + c.ax * L, bz = c.z + c.az * L;
    if (!hiddenAt(c.x, 0, c.z) || !hiddenAt(ax, 0, az) || !hiddenAt(bx, 0, bz)) return nope('hsVisible');
    if (!walkClear(ax, az, bx, bz, 0)) return nope('hsWalk');
    // a wall right behind him all along his walk (the awning hangs from it; it also reads as a street front)
    let wallBox = null;
    for (const [px, pz] of [[ax, az], [c.x, c.z], [bx, bz]]) {
      _hs.set(px, 2, pz); _hdir.set(-c.nx, 0, -c.nz);
      if (!City.raycast(_hs, _hdir, 3.6) || City.hit.kind !== 1) return nope('hsWall');
      if (px === c.x) wallBox = City.boxes[City.hit.id];
    }
    // the street in front of him is open: across to the far side, and along it for a run-in
    if (rayLen(c.x, 1.6, c.z, c.nx, c.nz, 30) < 16) return nope('hsAcross');
    const runA = rayLen(ax, 1.6, az, -c.ax, -c.az, 80), runB = rayLen(bx, 1.6, bz, c.ax, c.az, 80);
    if (Math.max(runA, runB) < 40) return nope('hsRun');
    const y0 = 0;
    const gate = gateFor(c.x, 1.3, c.z); if (!gate) return nope('hsGate');
    let awning = null;
    if (kind === 'awning') {
      // a deep cantilevered awning off the wall, its lip low enough that nothing drops in on him from above
      const depth = grnd(5.0, 5.6), ext = 2.6;
      let x0, x1, z0, z1;
      if (c.ax) { x0 = Math.min(ax, bx) - ext; x1 = Math.max(ax, bx) + ext; const zo = c.wall + c.nz * depth; z0 = Math.min(c.wall, zo); z1 = Math.max(c.wall, zo); }
      else { z0 = Math.min(az, bz) - ext; z1 = Math.max(az, bz) + ext; const xo = c.wall + c.nx * depth; x0 = Math.min(c.wall, xo); x1 = Math.max(c.wall, xo); }
      const yS = grnd(5.0, 5.5);
      awning = [[x0, yS, z0, x1, yS + 0.32, z1, 3, grnd()]];
      // the outer lip (fascia): a deeper band along the street edge
      const lipW = 0.3;
      if (c.ax) { const zo = c.wall + c.nz * depth; awning.push([x0, yS - 0.45, Math.min(zo, zo - c.nz * lipW), x1, yS + 0.32, Math.max(zo, zo - c.nz * lipW), 3, grnd()]); }
      else { const xo = c.wall + c.nx * depth; awning.push([Math.min(xo, xo - c.nx * lipW), yS - 0.45, z0, Math.max(xo, xo - c.nx * lipW), yS + 0.32, z1, 3, grnd()]); }
      const shrink = (b) => [b[0] + (c.nx > 0 ? 0.06 : 0), b[1], b[2] + (c.nz > 0 ? 0.06 : 0), b[3] - (c.nx < 0 ? 0.06 : 0), b[4], b[5] - (c.nz < 0 ? 0.06 : 0)];
      for (const b of awning) if (!boxFree(shrink(b), wallBox)) return nope('hsAwning');
    } else {
      // open sky: the round can come straight down the canyon onto him
      if (!skyOpen(c.x, 2.4, c.z) || !skyOpen(ax, 2.4, az) || !skyOpen(bx, 2.4, bz)) return nope('hsSky');
    }
    if (awning) City.addCover(awning);
    const R = c.ax ? { x0: c.x - 40, x1: c.x + 40, z0: Math.min(c.wall, c.opp), z1: Math.max(c.wall, c.opp), y: y0, h: y0, occ: [], street: true }
      : { x0: Math.min(c.wall, c.opp), x1: Math.max(c.wall, c.opp), z0: c.z - 40, z1: c.z + 40, y: y0, h: y0, occ: [], street: true };
    const beh = gameRand() < 0.75 ? 'patrol' : 'phone';
    place(R, beh, ax, az, bx, bz, Math.atan2(c.ax, c.az), {});
    S.spot = { kind, gate, awning: awning ? awning.map((b) => b.slice(0, 6)) : null, nx: c.nx, nz: c.nz, ax: c.ax, az: c.az, wall: c.wall };
    return true;
  }
  function tryRoofHidden(R, stage, kind = 'roof') {
    for (let k = 0; k < 10; k++) {
      const x = grnd(R.x0 + 2, R.x1 - 2), z = grnd(R.z0 + 2, R.z1 - 2);
      if (!freeOnRoof(R, x, z, 1.6, 1.0)) continue;
      const a = grnd(0, TAU), L = grnd(3, 5.5), ax = x - Math.cos(a) * L, az = z - Math.sin(a) * L, bx = x + Math.cos(a) * L, bz = z + Math.sin(a) * L;
      if (!pathFree(R, ax, az, bx, bz, 1.4, 0.9)) continue;
      if (!hiddenAt(x, R.y, z) || !hiddenAt(ax, R.y, az) || !hiddenAt(bx, R.y, bz)) { nope('hrVisible'); continue; }
      if (!skyOpen(x, R.y + 2.4, z) || !skyOpen(ax, R.y + 2.4, az) || !skyOpen(bx, R.y + 2.4, bz)) { nope('hrSky'); continue; }
      const gate = gateFor(x, R.y + 1.3, z); if (!gate) { nope('hrGate'); continue; }
      place(R, gameRand() < 0.7 ? 'patrol' : 'phone', ax, az, bx, bz, a, {});
      S.spot = { kind, gate, awning: null };
      return true;
    }
    return false;
  }
  function spawnHidden(stage, opts) {
    S.stage = stage;
    let want = ['roof', 'street', 'awning', 'car', 'quad', 'highway', 'tower', 'ledge', 'heli'].includes(opts.kind) ? opts.kind : hiddenKind(stage);
    if (want === 'heli') { if (spawnHeli()) return true; if (opts.kind) return false; want = 'tower'; }
    // up high: the asked-for spot, then the other high one, then the usual mix
    if (want === 'tower' || want === 'ledge') {
      if ((want === 'tower' ? spawnTower : spawnLedge)(stage)) return true;
      if (opts.kind) return false;
      if ((want === 'tower' ? spawnLedge : spawnTower)(stage)) return true;
    }
    const base = want === 'tower' || want === 'ledge' ? 'roof' : want, order = [base, ...['street', 'awning', 'roof'].filter((k) => k !== base)];
    const first = hiddenBand(stage), s1 = Math.max(1, stage) - 1, widest = [230, Math.min(950, 450 + 70 * s1) + 80];
    for (const band of [first, [first[0] - 120, first[1] + 120], widest]) {
      for (const kind of order) {
        if (kind === 'roof') {
          let pool = shuffled(City.roofs.filter((R) => inSector((R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2, band) && R.x1 - R.x0 > 9 && R.z1 - R.z0 > 9 && R.y > 5 && R.y < 230));
          // mostly the taller roofs (30 m and up) first, so heights above the street vary
          if (gameRand() < 0.75) pool = pool.filter((R) => R.y >= 30).concat(pool.filter((R) => R.y < 30));
          for (let a = 0; a < Math.min(pool.length, 90); a++) if (tryRoofHidden(pool[a], stage)) return true;
        } else if (kind === 'car') { const cands = carSpots(band); for (let a = 0; a < Math.min(cands.length, 80); a++) if (tryCar(cands[a])) return true; }
        else if (kind === 'highway') { for (let a = 0; a < 12; a++) if (tryHighway(band)) return true; }
        else if (kind === 'quad') { if (spawnQuad(band)) return true; }
        else { const cands = streetSpots(band); for (let a = 0; a < Math.min(cands.length, 160); a++) if (tryStreet(cands[a], kind, stage)) return true; }
        if (opts.kind) break;   // a requested kind: no substitutes
      }
    }
    return false;
  }
  // ---- way up high. The top deck of one of the tallest towers in view (taller first), or a setback terrace
  // high on a tower with its upper floors rising beside him. Both out of the shooter's sight: the round climbs
  // past the tower's edge and comes in over the deck or along the terrace.
  function towerBand(stage, k) { const s = Math.max(1, stage) - 1; return k === 0 ? [280, Math.min(950, 560 + 40 * s)] : k === 1 ? [250, Math.min(1000, 760 + 40 * s)] : [230, 1100]; }
  const highFirst = (list) => list.map((R) => [R, R.y * grnd(0.8, 1)]).sort((a, b) => b[1] - a[1]).map((a) => a[0]);
  const centreIn = (R, band) => inSector((R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2, band);
  function spawnTower(stage) {
    for (const [k, minY] of [[0, 75], [1, 75], [2, 50]]) {
      const band = towerBand(stage, k);
      const pool = highFirst(City.roofs.filter((R) => !R.garage && R.y >= minY && R.y <= 190 && R.x1 - R.x0 > 9 && R.z1 - R.z0 > 9 && centreIn(R, band)));
      for (let a = 0; a < Math.min(pool.length, 30); a++) if (tryRoofHidden(pool[a], stage, 'tower')) return true;
    }
    return false;
  }
  function spawnLedge(stage) {
    for (const [k, minY] of [[0, 40], [1, 30], [2, 30]]) {
      const band = towerBand(stage, k);
      const pool = highFirst(City.ledges.filter((L) => L.y >= minY && L.y <= 190 && centreIn(L, band)));
      for (let a = 0; a < Math.min(pool.length, 40); a++) if (tryLedge(pool[a], stage)) return true;
    }
    return false;
  }
  // ---- the helicopter (stage 10): on a tower's helipad in view; with none in view, on a helipad painted on a
  // big tall roof. The rotor has room to turn and there is open sky above it.
  function spawnHeli() {
    for (const band of [[350, 950], [250, 1150]]) {
      for (const R of shuffled(City.roofs.filter((R) => R.heli && centreIn(R, band)))) if (tryHeli(R, R.heli, false)) return true;
    }
    const pool = highFirst(City.roofs.filter((R) => !R.garage && !R.heli && R.y >= 55 && R.y <= 190 && R.x1 - R.x0 > 18 && R.z1 - R.z0 > 18 && centreIn(R, [300, 1000])));
    for (const R of pool.slice(0, 24)) for (let k = 0; k < 6; k++) {
      const s = 14, x = grnd(R.x0 + s / 2 + 1.5, R.x1 - s / 2 - 1.5), z = grnd(R.z0 + s / 2 + 1.5, R.z1 - s / 2 - 1.5);
      if (!R.occ.every((o) => o[2] < x - s / 2 - 0.5 || o[0] > x + s / 2 + 0.5 || o[3] < z - s / 2 - 0.5 || o[1] > z + s / 2 + 0.5)) continue;
      if (tryHeli(R, { x, z, y: R.y + 1.0, s }, true)) return true;
    }
    return false;
  }
  function tryHeli(R, pad, paint) {
    const y = pad.y;
    if (!boxFree([pad.x - 6.2, y + 0.2, pad.z - 6.2, pad.x + 6.2, y + 5, pad.z + 6.2], null)) return nope('hhBox');
    if (City.raycast(_hs.set(pad.x, y + 5, pad.z), _up, 120)) return nope('hhSky');
    const gate = gateFor(pad.x, y + 1.5, pad.z); if (!gate) return nope('hhGate');
    if (paint) City.addCover([[pad.x - pad.s / 2, R.y, pad.z - pad.s / 2, pad.x + pad.s / 2, y, pad.z + pad.s / 2, 9]]);
    rigSpawn('heli', pad.x, y, pad.z, grnd(0, TAU));
    S.roof = R; S.spot = { kind: 'heli', gate, glass: [] };
    refreshSpot();
    return true;
  }
  // a terrace is the ring between the lower tier's edge and the next tier's wall: he walks along one strip of it
  function tryLedge(L, stage) {
    const o = L.occ[0];
    const strips = shuffled([[L.x0, L.z0, o[0], L.z1, 0, 1], [o[2], L.z0, L.x1, L.z1, 0, 1], [L.x0, L.z0, L.x1, o[1], 1, 0], [L.x0, o[3], L.x1, L.z1, 1, 0]]);
    for (const [x0, z0, x1, z1, ax, az] of strips) {
      const across = ax ? z1 - z0 : x1 - x0, along = ax ? x1 - x0 : z1 - z0;
      if (across < 2.9 || along < 12) continue;
      for (let k = 0; k < 4; k++) {
        const x = ax ? grnd(x0 + 5, x1 - 5) : (x0 + x1) / 2, z = ax ? (z0 + z1) / 2 : grnd(z0 + 5, z1 - 5);
        if (!freeOnRoof(L, x, z, 1.2, 0.9)) continue;
        const Lw = grnd(2.5, 4.5), A = [x - ax * Lw, z - az * Lw], B = [x + ax * Lw, z + az * Lw];
        if (!pathFree(L, A[0], A[1], B[0], B[1], 1.1, 0.8)) { nope('hlPath'); continue; }
        if (!hiddenAt(x, L.y, z) || !hiddenAt(A[0], L.y, A[1]) || !hiddenAt(B[0], L.y, B[1])) { nope('hlVisible'); continue; }
        // open sky straight above his walk (the tower wall is right beside him, so no sideways samples)
        if ([[x, z], A, B].some(([px, pz]) => City.raycast(_hs.set(px, L.y + 2.4, pz), _up, 90))) { nope('hlSky'); continue; }
        if (!walkClear(A[0], A[1], B[0], B[1], L.y, 0.5)) { nope('hlWalk'); continue; }
        const gate = gateFor(x, L.y + 1.3, z); if (!gate) { nope('hlGate'); continue; }
        place(L, gameRand() < 0.65 ? 'patrol' : 'phone', A[0], A[1], B[0], B[1], Math.atan2(ax, az), {});
        S.spot = { kind: 'ledge', gate, awning: null };
        return true;
      }
    }
    return false;
  }
  function spawnCover(stage, opts) {
    const eye = PLAYER.eye; const [lo, hi] = rangeFor(stage);
    const pool = City.roofs.filter((R) => {
      const cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2;
      const d = Math.hypot(cx - eye.x, cz - eye.z);
      const yaw = Math.atan2(cx - eye.x, -(cz - eye.z));
      return d > lo && d < hi && Math.abs(yaw) < 34 * DEG && R.x1 - R.x0 > 9 && R.z1 - R.z0 > 12 && R.y < 140;
    });
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(gameRand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    S.stage = stage; relax = 1;
    const behs = ['patrol', 'patrol', 'phone'];
    for (let a = 0; a < Math.min(pool.length, 80); a++) {
      const R = pool[a];
      for (let k = 0; k < 8; k++) {
        const beh = opts.beh || behs[Math.floor(gameRand() * behs.length)];
        if (tryCover(R, beh, stage, opts)) { S.relax = 1; relax = 0; return true; }
      }
    }
    relax = 0;
    return false;
  }
  function spawnOpen(stage, opts = {}) {
    const eye = PLAYER.eye; const [lo, hi] = rangeFor(stage);
    const pool = City.roofs.filter((R) => {
      const cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2;
      const d = Math.hypot(cx - eye.x, cz - eye.z);
      const yaw = Math.atan2(cx - eye.x, -(cz - eye.z));
      return d > lo && d < hi && Math.abs(yaw) < (opts.maxYaw || 40 * DEG) && R.x1 - R.x0 > 9 && R.z1 - R.z0 > 9 && R.y < 160;
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
    if (S.char === 'bat' && beh !== 'patrol' && beh !== 'evade') beh = 'patrol';   // his right hand is on the bat
    S.roof = R; S.alive = true; S.ragdoll = false; S.settled = false; S.hatFree = false; S.hatRest = false;
    S.spooked = false; S.atCover = false; S.beh = S.behavior = beh; S.parY = parY; S.sprint = 4.6;
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
  // the report reaches him `delay` seconds after the shot: he flinches, then runs for his cover
  function alert(delay) {
    if (!S.alive || S.ragdoll) return;
    S.alertT = Math.max(0.05, delay);
  }
  function update(dt) {
    if (!group.visible) return;
    S.t += dt;
    if (S.type !== 'man') {
      if (S.alertT > 0 && S.alive) { S.alertT -= dt; if (S.alertT <= 0) { S.alertT = 0; rigAlert(); } }
      if (S.alive) { rigMove(dt); rigPose(); } else rigDebris(dt);
      return;
    }
    if (S.alertT > 0 && S.alive && !S.ragdoll) {
      S.alertT -= dt;
      if (S.alertT <= 0) {
        S.alertT = 0;
        if (S.hide && !(S.spooked && S.atCover)) { S.spooked = true; S.atCover = false; S.peeking = false; S.spookT = 0.34; S.sprint = 5.6; S.cover.copy(S.hide); }
        else if (S.spot) evade();
        else if (!S.hide) spook();
      }
    }
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
  // Missed once, he is on to you: for every shot after, a moment after he hears it he tries to get away.
  // Street and awning: sprints up and down his stretch of pavement (staying under the awning); roof: zigzags
  // across it; a car drives off along its street.
  function evade() {
    if (S.type !== 'man') { rigAlert(); return; }
    if (!S.alive || S.ragdoll) return;
    const sp = S.spot, k = sp ? sp.kind : '';
    if (!S.base) S.base = { A: S.A.clone(), B: S.B.clone(), beh: S.behavior };
    S.spooked = false; S.beh = 'evade'; S.evT = grnd(0.4, 1.0);
    if ((k === 'street' || k === 'awning') && sp.ax != null) {
      const ext = k === 'awning' ? 1.8 : 3.5, A0 = S.base.A, B0 = S.base.B;
      const dx = B0.x - A0.x, dz = B0.z - A0.z, L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L;
      const ax = A0.x - ux * ext, az = A0.z - uz * ext, bx = B0.x + ux * ext, bz = B0.z + uz * ext;
      if (walkClear(ax, az, bx, bz, S.A.y, 0.4)) { S.A.set(ax, S.A.y, az); S.B.set(bx, S.B.y, bz); }
    } else if (S.roof) {
      const R = S.roof; let best = null, bd = 0;
      for (let i = 0; i < 24; i++) {
        const x = grnd(R.x0 + 1.2, R.x1 - 1.2), z = grnd(R.z0 + 1.2, R.z1 - 1.2);
        if (!freeOnRoof(R, x, z, 1.0, 0.6)) continue;
        const d = Math.hypot(x - S.root.x, z - S.root.z); if (d > bd && d < 14 && pathFree(R, S.root.x, S.root.z, x, z, 0.9, 0.5)) { bd = d; best = [x, z]; }
      }
      if (best && bd > 4) { S.A.set(S.root.x, R.y, S.root.z); S.B.set(best[0], R.y, best[1]); }
    }
    S.goingB = true;
  }
  // between shots he settles back to what he was doing (still wary: he will run again at the next shot)
  function calm() {
    if (!S.alive || S.ragdoll || S.type !== 'man') return;
    S.spooked = false; S.atCover = false; S.alertT = 0;
    if (S.base) { S.A.copy(S.base.A); S.B.copy(S.base.B); S.beh = S.base.beh; S.base = null; }
  }
  function spook() {
    if (S.type !== 'man') return;
    if (S.ragdoll || !S.alive || (S.spooked && !S.atCover)) return;
    if (S.hide) { if (!S.atCover) { S.spooked = true; S.spookT = 0.34; S.sprint = 5.6; S.cover.copy(S.hide); } return; }
    S.spookT = S.spooked ? 0.35 : 0; S.spooked = true; S.atCover = false; S.peeking = false; S.sprint = 4.6;
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
    if (S.type !== 'man') return S.alive ? rigHit(a, b) : null;
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
  function launch(point, dir, part, boost = 1) {
    if (S.type !== 'man') { rigExplode(point, dir); return; }
    if (S.ragdoll) return;
    LV.boost = boost;
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
    const rise = grnd(5.8, 7.2) * (LV.boost || 1), up = Math.sqrt(2 * g * rise), tF = (2 * up) / g + 0.15, kS = 0.06;
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
      vh = Math.min(grnd(4, 7.5), Math.max(0.3, vhMax - kick)) * (LV.boost || 1);
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
  // ======================================================================
  // Machine targets: a parked car or a hovering quadcopter, hot all over (engine and tyres, motors and battery).
  // Alerted (missed once), each moves on a steady, readable path: the car drives laps round its block, the
  // quadcopter rises and sinks between two heights. A hit blows it apart: the pieces fly, bounce off walls and
  // the street, and on a car one tyre goes bouncing away down the road.
  // ======================================================================
  const RIG = { kind: '', c: V3(), yaw: 0, f: V3(), r: V3(), lo: [0, 0, 0], hi: [0, 0, 0], cy: 0, meshes: null, g: null,
    deb: [], restT: 0, thudT: 0, move: null, t: 0, h0: 0, ax: 0, az: 1, tilt: 0, pitch: 0, roll: 0, vel: V3(), rpm: 0, rot: 0 };
  const CAR_L = 4.9, CAR_W = 1.84, CAR_H = 2.05, TYRE_R = 0.38, CAR_V = 4, QUAD_A = 6, QUAD_T = 3.6, QUAD_S = 4, QUAD_ST = 4.7;
  const rigMat = (t) => thermalMat(FS_SOLID, { uT: { value: t }, uStripe: { value: 0 } }, { side: THREE.DoubleSide });
  const carMat = [0.95, 0.62, 0.36, 0.78, 0.9, 0.55, 0.58].map(rigMat);   // engine, body, glass, tyres, gun, underbody, bed floor
  const quadMat = [0.97, 0.78, 0.88, 0.6].map(rigMat);   // motors, frame, battery, rotors
  const heliMat = [0.95, 0.62, 0.36, 0.5, 0.55, 0.99].map(rigMat);   // engine, body, glass, rotor blades, skids, exhaust
  // parts (x to its right, y up, z forward): box size or cylinder [radius, height], centre, material
  // the technical: a Hilux-style pickup with an open bed, a roll bar and a heavy machine gun on a pedestal,
  // firing over the cab. Thermal read: engine and grille hottest, gun and tyres warm, body mid, glass dark.
  // Materials: 0 engine, 1 body, 2 glass, 3 tyres, 4 gun, 5 underbody, 6 bed floor
  const SLOPE = -0.53;   // windshield lean (radians about x)
  const CAR_PARTS = [
    { s: [1.5, 0.26, 4.5], p: [0, 0.46, -0.05], m: 5, low: true },        // chassis and underbody
    { s: [1.78, 0.42, 1.12], p: [0, 0.8, 1.82], m: 1 },                   // front body and wings
    { s: [1.72, 0.06, 1.1], p: [0, 1.04, 1.8], m: 0 },                    // bonnet (engine heat)
    { s: [1.4, 0.34, 0.05], p: [0, 0.8, 2.39], m: 0 },                    // grille (radiator)
    { s: [1.84, 0.16, 0.14], p: [0, 0.5, 2.42], m: 1 },                   // front bumper
    { s: [0.26, 0.12, 0.05], p: [-0.66, 0.95, 2.39], m: 0 },              // headlights
    { s: [0.26, 0.12, 0.05], p: [0.66, 0.95, 2.39], m: 0 },
    { s: [1.76, 0.54, 1.2], p: [0, 0.82, 0.66], m: 1 },                   // cab doors
    { s: [1.56, 0.66, 0.04], p: [0, 1.39, 1.08], m: 2, rx: SLOPE },       // windshield
    { s: [0.07, 0.68, 0.07], p: [-0.79, 1.39, 1.08], m: 1, rx: SLOPE },   // windshield pillars
    { s: [0.07, 0.68, 0.07], p: [0.79, 1.39, 1.08], m: 1, rx: SLOPE },
    { s: [0.04, 0.5, 0.72], p: [-0.82, 1.36, 0.5], m: 2 },                // side windows
    { s: [0.04, 0.5, 0.72], p: [0.82, 1.36, 0.5], m: 2 },
    { s: [1.5, 0.52, 0.04], p: [0, 1.37, 0.08], m: 2 },                   // rear window
    { s: [0.07, 0.62, 0.07], p: [-0.8, 1.38, 0.08], m: 1 },               // rear pillars
    { s: [0.07, 0.62, 0.07], p: [0.8, 1.38, 0.08], m: 1 },
    { s: [1.66, 0.06, 0.9], p: [0, 1.72, 0.48], m: 1, high: true },       // cab roof
    { s: [0.18, 0.1, 0.05], p: [-0.98, 1.24, 1.0], m: 1 },                // mirrors
    { s: [0.18, 0.1, 0.05], p: [0.98, 1.24, 1.0], m: 1 },
    { s: [1.7, 0.07, 2.35], p: [0, 0.86, -1.2], m: 6 },                   // bed floor
    { s: [0.08, 0.44, 2.35], p: [-0.86, 1.1, -1.2], m: 1 },               // bed sides
    { s: [0.08, 0.44, 2.35], p: [0.86, 1.1, -1.2], m: 1 },
    { s: [1.76, 0.44, 0.08], p: [0, 1.1, -2.38], m: 1 },                  // tailgate
    { s: [1.8, 0.14, 0.12], p: [0, 0.52, -2.44], m: 1 },                  // rear bumper
    { s: [0.07, 0.62, 0.07], p: [-0.76, 1.58, -0.1], m: 1 },              // roll bar
    { s: [0.07, 0.62, 0.07], p: [0.76, 1.58, -0.1], m: 1 },
    { s: [1.6, 0.07, 0.07], p: [0, 1.9, -0.1], m: 1 },
    { s: [0.1, 0.95, 0.1], p: [0, 1.36, -0.95], m: 5 },                   // gun pedestal
    { s: [0.16, 0.18, 0.72], p: [0, 1.92, -0.88], m: 4 },                 // gun receiver
    { s: [0.06, 0.06, 1.3], p: [0, 1.95, 0.12], m: 4 },                   // barrel, out over the cab roof
    { s: [0.11, 0.11, 0.14], p: [0, 1.95, 0.8], m: 4 },                   // muzzle brake
    { s: [0.16, 0.16, 0.24], p: [0.18, 1.84, -0.88], m: 1 },              // ammo box
    { s: [0.78, 0.44, 0.04], p: [0, 1.96, -0.46], m: 1 },                 // gun shield
    { s: [0.24, 0.05, 0.05], p: [0, 1.94, -1.28], m: 4 },                 // spade grips
    { tyre: true, p: [-0.82, TYRE_R, 1.62] }, { tyre: true, p: [0.82, TYRE_R, 1.62] },
    { tyre: true, p: [-0.82, TYRE_R, -1.55] }, { tyre: true, p: [0.82, TYRE_R, -1.55] },
  ];
  const QUAD_PARTS = [
    { s: [0.42, 0.14, 0.56], p: [0, 0, 0], m: 1 },              // body
    { s: [0.3, 0.1, 0.32], p: [0, 0.12, -0.04], m: 2 },         // battery
    { s: [0.16, 0.12, 0.16], p: [0, -0.13, 0.22], m: 1 },       // camera
  ];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    QUAD_PARTS.push({ s: [0.06, 0.05, 0.64], p: [0.23 * sx, 0, 0.23 * sz], m: 1, ry: sx * sz > 0 ? Math.PI / 4 : -Math.PI / 4 });   // arm
    QUAD_PARTS.push({ cyl: [0.07, 0.09], p: [0.46 * sx, 0.05, 0.46 * sz], m: 0 });                                                  // motor
    QUAD_PARTS.push({ cyl: [0.28, 0.012], p: [0.46 * sx, 0.11, 0.46 * sz], m: 3 });                                                 // rotor disc
  }
  // the helicopter: a light utility type with a glazed nose, an engine hump with its exhaust (the hottest
  // thing on it), a long tail boom, skids, a four-blade main rotor and a two-blade tail rotor.
  // Materials: 0 engine, 1 body, 2 glass, 3 rotor blades, 4 skids, 5 exhaust. spin: 1 main rotor, 2 tail rotor
  const HELI_PARTS = [
    { s: [2.0, 1.9, 3.6], p: [0, 1.5, 0.3], m: 1 },                       // cabin
    { s: [1.8, 1.25, 1.3], p: [0, 1.25, 2.7], m: 1 },                     // nose
    { s: [1.6, 0.95, 0.9], p: [0, 1.55, 3.25], m: 2, rx: -0.35 },         // nose glazing
    { s: [0.04, 0.75, 1.5], p: [-1.02, 1.75, 0.9], m: 2 },                // side windows
    { s: [0.04, 0.75, 1.5], p: [1.02, 1.75, 0.9], m: 2 },
    { s: [1.25, 0.7, 2.5], p: [0, 2.8, -0.3], m: 0, high: true },         // engine hump
    { s: [0.55, 0.45, 0.7], p: [0, 2.75, -1.75], m: 5 },                  // exhaust
    { s: [0.5, 0.55, 5.6], p: [0, 2.1, -4.3], m: 1 },                     // tail boom
    { s: [0.12, 1.7, 0.95], p: [0, 2.95, -6.85], m: 1 },                  // tail fin
    { s: [1.9, 0.08, 0.55], p: [0, 2.15, -6.2], m: 1 },                   // tail plane
    { s: [0.12, 0.12, 4.2], p: [-1.08, 0.08, 0.4], m: 4, low: true },     // skids
    { s: [0.12, 0.12, 4.2], p: [1.08, 0.08, 0.4], m: 4, low: true },
    { s: [2.3, 0.1, 0.1], p: [0, 0.5, -0.7], m: 4 },                      // skid cross tubes
    { s: [2.3, 0.1, 0.1], p: [0, 0.5, 1.5], m: 4 },
    { cyl: [0.13, 0.55], p: [0, 3.4, 0], m: 0 },                          // rotor mast
    { s: [0.38, 0.06, 11.2], p: [0, 3.72, 0], m: 3, spin: 1, fly: true }, // main rotor (two crossed blade pairs)
    { s: [11.2, 0.06, 0.38], p: [0, 3.72, 0], m: 3, spin: 1, fly: true },
    { s: [0.06, 1.6, 0.2], p: [0.2, 2.95, -6.95], m: 3, spin: 2, fly: true },   // tail rotor
  ];
  const tyreGeo = new THREE.CylinderGeometry(TYRE_R, TYRE_R, 0.28, 12).rotateZ(Math.PI / 2);   // axle along x
  function rigMeshes(parts, mats) {
    return parts.map((q) => {
      const geo = q.tyre ? tyreGeo : q.cyl ? new THREE.CylinderGeometry(q.cyl[0], q.cyl[0], q.cyl[1], 12) : new THREE.BoxGeometry(q.s[0], q.s[1], q.s[2]);
      const m = new THREE.Mesh(geo, mats[q.tyre ? 3 : q.m]); m.frustumCulled = false;
      const r = q.tyre ? TYRE_R : q.cyl ? Math.max(0.05, q.cyl[1] / 2 + 0.03) : Math.min(q.s[0], q.s[1], q.s[2]) / 2 + 0.05;
      m.userData = { home: new THREE.Vector3(q.p[0], q.p[1], q.p[2]), rx: q.rx || 0, ry: q.ry || 0, r, tyre: !!q.tyre, low: !!q.low, high: !!q.high, spin: q.spin || 0, fly: !!q.fly };
      return m;
    });
  }
  const carG = new THREE.Group(), quadG = new THREE.Group(), heliG = new THREE.Group(); carG.visible = quadG.visible = heliG.visible = false; group.add(carG, quadG, heliG);
  const carMeshes = rigMeshes(CAR_PARTS, carMat), quadMeshes = rigMeshes(QUAD_PARTS, quadMat), heliMeshes = rigMeshes(HELI_PARTS, heliMat);
  // a separate technical (shared geometry and materials) for the fire mission
  function truckMesh() {
    const g = new THREE.Group();
    for (const m of carMeshes) {
      const c = new THREE.Mesh(m.geometry, m.material); c.position.copy(m.userData.home); c.rotation.set(m.userData.rx, m.userData.ry, 0); c.frustumCulled = false;
      c.userData = { r: m.userData.r, tyre: m.userData.tyre, low: m.userData.low, high: m.userData.high }; g.add(c);
    }
    return g;
  }
  function rigReset() {
    RIG.kind = ''; RIG.move = null; RIG.deb.length = 0; RIG.restT = 0;
    for (const [ms, g] of [[carMeshes, carG], [quadMeshes, quadG], [heliMeshes, heliG]]) for (const m of ms) { g.add(m); m.position.copy(m.userData.home); m.quaternion.identity(); m.rotation.set(m.userData.rx, m.userData.ry, 0); }
    carG.visible = quadG.visible = heliG.visible = false; mesh.visible = true; S.escaped = false;
  }
  function rigAxes() { RIG.f.set(Math.sin(RIG.yaw), 0, Math.cos(RIG.yaw)); RIG.r.set(Math.cos(RIG.yaw), 0, -Math.sin(RIG.yaw)); }
  function rigSpawn(kind, x, y, z, yaw) {
    rigReset(); RIG.kind = kind; RIG.c.set(x, y, z); RIG.yaw = yaw; RIG.t = grnd(0, 10); RIG.h0 = y; RIG.tilt = 0; RIG.floor = 0; RIG.ps = 0; RIG.o = new THREE.Vector3(x, y, z); rigAxes();
    RIG.pitch = RIG.roll = 0; RIG.vel.set(0, 0, 0); RIG.rpm = 0.5; RIG.rot = grnd(0, TAU);
    if (kind === 'car') { RIG.meshes = carMeshes; RIG.g = carG; RIG.lo = [-CAR_W / 2, 0.12, -CAR_L / 2]; RIG.hi = [CAR_W / 2, CAR_H, CAR_L / 2]; RIG.cy = 0.85; }
    else if (kind === 'heli') { RIG.meshes = heliMeshes; RIG.g = heliG; RIG.lo = [-1.2, 0.1, -7.3]; RIG.hi = [1.2, 3.2, 3.8]; RIG.cy = 1.5; }   // fuselage and tail boom
    else { RIG.meshes = quadMeshes; RIG.g = quadG; RIG.lo = [-0.85, -0.4, -0.85]; RIG.hi = [0.85, 0.4, 0.85]; RIG.cy = 0; }   // a forgiving box round the quadcopter
    S.type = kind; S.char = kind; S.alive = true; S.ragdoll = false; S.settled = false; S.roof = null; S.packGone = false;
    RIG.g.visible = true; mesh.visible = false; group.visible = true; rigPose();
  }
  function rigPose() {
    if (RIG.kind === 'heli') {
      RIG.g.position.copy(RIG.c); RIG.g.rotation.set(RIG.pitch, RIG.yaw, RIG.roll, 'YXZ');
      for (const m of heliMeshes) if (m.userData.spin === 1) m.rotation.set(0, RIG.rot, 0); else if (m.userData.spin === 2) m.rotation.set(RIG.rot * 2.3, 0, 0);
    } else RIG.g.position.copy(RIG.c), RIG.g.rotation.set(RIG.kind === 'quad' ? 0.05 * Math.sin(RIG.t * 0.9) + RIG.tilt : 0, RIG.yaw, RIG.kind === 'quad' ? 0.05 * Math.sin(RIG.t * 1.3) : 0, 'YXZ');
    RIG.g.updateMatrixWorld(true);
    chest.set(RIG.c.x, RIG.c.y + RIG.cy, RIG.c.z); headPos.copy(chest); S.root.copy(RIG.c);
    S.dist = chest.distanceTo(PLAYER.eye);
  }
  // the round's step against the machine's box (in its own frame): earliest entry along the segment
  function rigHit(a, b) {
    const ax = a.x - RIG.c.x, az = a.z - RIG.c.z, bx = b.x - RIG.c.x, bz = b.z - RIG.c.z;
    const p0 = [ax * RIG.r.x + az * RIG.r.z, a.y - RIG.c.y, ax * RIG.f.x + az * RIG.f.z], p1 = [bx * RIG.r.x + bz * RIG.r.z, b.y - RIG.c.y, bx * RIG.f.x + bz * RIG.f.z];
    const lo = RIG.lo, hi = RIG.hi;
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 3; k++) {
      const d = p1[k] - p0[k];
      if (Math.abs(d) < 1e-9) { if (p0[k] < lo[k] || p0[k] > hi[k]) return null; continue; }
      let ta = (lo[k] - p0[k]) / d, tb = (hi[k] - p0[k]) / d; if (ta > tb) { const q = ta; ta = tb; tb = q; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) return null;
    }
    hitRes.t = t0; hitRes.part = RIG.kind; hitRes.point.copy(a).lerp(b, t0); hitRes.centre = Math.sqrt(segSeg(a, b, chest, chest));
    return hitRes;
  }
  // the box corners (for the HUD brackets)
  const rigC = Array.from({ length: 8 }, () => V3());
  function rigCorners() {
    let i = 0;
    for (const lx of [RIG.lo[0], RIG.hi[0]]) for (const y of [RIG.lo[1], RIG.hi[1]]) for (const lz of [RIG.lo[2], RIG.hi[2]])
      rigC[i++].set(RIG.c.x + RIG.r.x * lx + RIG.f.x * lz, RIG.c.y + y, RIG.c.z + RIG.r.z * lx + RIG.f.z * lz);
    return rigC;
  }
  // ---- alerted: start the steady path (it then keeps going for the rest of the stage)
  function rigAlert() {
    if (!RIG.kind || !S.alive || RIG.move) return;
    if (RIG.kind === 'quad') { RIG.move = { type: 'bob', A: Math.min(QUAD_A, RIG.h0 - (RIG.floor || 0) - 4.5), ph: 0, h0: RIG.h0, ps: RIG.ps || 0 }; return; }
    if (RIG.kind === 'heli') { RIG.move = heliDeparture(); return; }
    RIG.move = carLoop() || carShuttle();
  }
  // the block beside the parked car: laps in the lanes just outside its kerbs, corners rounded
  function carLoop() {
    const c = RIG.c, aSp = GRID.aveSp, sSp = GRID.stSp, river = City.features.river;
    const hwA = (j) => (j === 0 ? GRID.mainHW : GRID.aveHW);
    let jA, kH;
    if (Math.abs(RIG.f.x) > 0.5) { const k = Math.round(-c.z / sSp); kH = c.z > -k * sSp ? k - 1 : k; jA = Math.floor(c.x / aSp); }
    else { const j = Math.round(c.x / aSp); jA = c.x > j * aSp ? j : j - 1; kH = Math.floor(-c.z / sSp); }
    if (jA <= -GRID.nAve || jA + 1 >= GRID.nAve || kH < 1 || kH + 1 >= GRID.nSt) return null;
    if (river && [kH, kH + 1].some((k) => k === river.k || k === river.k + 1)) return null;
    const lane = 2.6, xa = jA * aSp + hwA(jA) - lane, xb = (jA + 1) * aSp - hwA(jA + 1) + lane, zh = -kH * sSp - GRID.stHW + lane, zl = -(kH + 1) * sSp + GRID.stHW - lane;
    const C = [[xa, zh], [xb, zh], [xb, zl], [xa, zl]];
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = C[i], [x1, z1] = C[(i + 1) % 4], L = Math.hypot(x1 - x0, z1 - z0);
      if (rayLen(x0, 0.9, z0, x1 - x0, z1 - z0, L) < L - 0.5) return null;
    }
    return loopPath(C, 7, CAR_V);
  }
  // a closed lap through four corners (rounded with radius rr), started from the nearest point to the car and
  // heading the way it faces
  function loopPath(C, rr, vmax) {
    const c = RIG.c;
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const P = C[i], A0 = C[(i + 3) % 4], B0 = C[(i + 1) % 4];
      const li = Math.hypot(P[0] - A0[0], P[1] - A0[1]), lo = Math.hypot(B0[0] - P[0], B0[1] - P[1]);
      const a = [P[0] - (P[0] - A0[0]) / li * rr, P[1] - (P[1] - A0[1]) / li * rr], b = [P[0] + (B0[0] - P[0]) / lo * rr, P[1] + (B0[1] - P[1]) / lo * rr];
      for (let k = 0; k <= 6; k++) { const t = k / 6, u1 = 1 - t; pts.push([u1 * u1 * a[0] + 2 * u1 * t * P[0] + t * t * b[0], u1 * u1 * a[1] + 2 * u1 * t * P[1] + t * t * b[1]]); }
    }
    const cum = [0]; for (let i = 1; i <= pts.length; i++) { const p = pts[i % pts.length], q = pts[i - 1]; cum.push(cum[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1])); }
    const M = { type: 'loop', pts, cum, L: cum[pts.length], s: 0, dir: 1, v: 0, off: V3(), blend: 0, vmax };
    // start from the nearest point of the loop, heading the way the car faces
    let best = 1e9;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[(i + 1) % pts.length], p = pts[i], dx = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dx, dz) || 1;
      const t = clamp(((c.x - p[0]) * dx + (c.z - p[1]) * dz) / (L * L), 0, 1), x = p[0] + dx * t, z = p[1] + dz * t, d = Math.hypot(c.x - x, c.z - z);
      if (d < best) { best = d; M.s = cum[i] + t * L; M.dir = (dx * RIG.f.x + dz * RIG.f.z) >= 0 ? 1 : -1; }
    }
    loopAt(M, M.s, cvA); M.off.set(c.x - cvA.x, 0, c.z - cvA.z);
    return M;
  }
  function loopAt(M, s, out, tan) {
    s = ((s % M.L) + M.L) % M.L;
    let i = 0; while (i < M.pts.length - 1 && M.cum[i + 1] < s) i++;
    const p = M.pts[i], q = M.pts[(i + 1) % M.pts.length], L = (M.cum[i + 1] - M.cum[i]) || 1, t = (s - M.cum[i]) / L;
    out.set(p[0] + (q[0] - p[0]) * t, 0, p[1] + (q[1] - p[1]) * t);
    if (tan) tan.set(q[0] - p[0], 0, q[1] - p[1]).normalize();
    return out;
  }
  // ---- the helicopter: it idles on its pad with the rotor turning slowly. Missed once, it spools up, lifts
  // off, turns away from the shooter and flies off, speeding up and climbing, until it is out of range: then it
  // has escaped. It looks ahead as it goes: anything in the way, it climbs harder and turns a little.
  const HELI_V = 18, HELI_VK = 0.45, HELI_VMAX = 38, HELI_ACC = 2, HELI_CLIMB = 4.5, HELI_TOP = 245, HELI_ESC = 1900, HELI_WEAVE = 0.4, HELI_WT = 6.5;
  function heliDeparture() {
    const c = RIG.c, eye = PLAYER.eye, a0 = Math.atan2(c.x - eye.x, c.z - eye.z);
    let best = a0, bl = -1;
    for (const da of [0, 0.35, -0.35, 0.7, -0.7]) {   // the clearest heading roughly away from the shooter
      const a = a0 + da; _hdir.set(Math.sin(a), 0.2, Math.cos(a)).normalize();
      const L = City.raycast(_hs.set(c.x, c.y + 14, c.z), _hdir, 400) ? City.hit.t : 400;
      if (L > bl + 30) { bl = L; best = a; }
    }
    return { type: 'heli', ph: 'spool', t: 0, head: best, v: 0, vy: 0, y0: c.y };
  }
  function heliMove(dt) {
    const M = RIG.move, c = RIG.c;
    if (!M) { RIG.rpm = 0.5; RIG.rot += dt * TAU * RIG.rpm; return; }
    M.t += dt;
    if (M.ph === 'spool') { RIG.rpm = lerp(0.5, 4, sstep(0, 1.2, M.t)); if (M.t > 1.2) { M.ph = 'lift'; M.t = 0; } }
    else if (M.ph === 'lift') {
      M.vy = Math.min(6, M.vy + 5 * dt);
      let dy = M.head - RIG.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); RIG.yaw += clamp(dy, -0.7 * dt, 0.7 * dt);
      if (c.y > M.y0 + 12) { M.ph = 'go'; M.t = 0; }
    } else {
      M.v = Math.min(Math.min(HELI_VMAX, HELI_V + HELI_VK * M.t), M.v + HELI_ACC * dt);   // and it keeps getting faster
      const look = Math.max(60, M.v * 4);
      _hdir.set(Math.sin(M.head), 0, Math.cos(M.head));
      const block = City.raycast(_hs.set(c.x, c.y + 1, c.z), _hdir, look);
      if (block) for (const da of [0.3, -0.3, 0.6, -0.6]) { _hdir.set(Math.sin(M.head + da), 0, Math.cos(M.head + da)); if (!City.raycast(_hs, _hdir, look)) { M.head += Math.sign(da) * 0.4 * dt; break; } }
      M.vy = damp(M.vy, (block ? 9 : c.y < HELI_TOP ? HELI_CLIMB : 0) + 3 * Math.sin(M.t * TAU / 4.3) * sstep(4, 12, M.t), 1.5, dt);
      // it jinks as it goes: weaving either side of its heading, more as it gets up to speed
      const weave = HELI_WEAVE * sstep(4, 12, M.t) * Math.sin(M.t * TAU / HELI_WT);
      let dy = M.head + weave - RIG.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); RIG.yaw += clamp(dy, -0.6 * dt, 0.6 * dt);
      RIG.roll = damp(RIG.roll, -clamp(dy * 1.5, -0.4, 0.4), 2.5, dt);
    }
    RIG.vel.set(Math.sin(RIG.yaw) * M.v, M.vy, Math.cos(RIG.yaw) * M.v);
    c.addScaledVector(RIG.vel, dt);
    RIG.pitch = damp(RIG.pitch, M.ph === 'go' ? 0.1 + 0.1 * (M.v / HELI_VMAX) : 0, 2, dt);   // nose down, more as it speeds up
    RIG.rot += dt * TAU * RIG.rpm;
    rigAxes();
    if (Math.hypot(c.x - PLAYER.eye.x, c.z - PLAYER.eye.z) > HELI_ESC) S.escaped = true;
  }
  // no clear lap (river, the city's edge, something across a street): back and forth along its own street
  function carShuttle() {
    const f = RIG.f, c = RIG.c;
    const fw = Math.min(30, rayLen(c.x + f.x * 2.4, 0.8, c.z + f.z * 2.4, f.x, f.z, 40) - 4), bw = Math.min(30, rayLen(c.x - f.x * 2.4, 0.8, c.z - f.z * 2.4, -f.x, -f.z, 40) - 4);
    if (fw + bw < 8) return { type: 'still' };
    return { type: 'shuttle', o: c.clone(), f: f.clone(), a: -Math.max(0, bw), b: Math.max(0, fw), s: 0, to: 1, v: 0, wait: 0 };
  }
  function rigMove(dt) {
    RIG.t += dt;
    const M = RIG.move;
    if (RIG.kind === 'heli') { heliMove(dt); return; }
    if (RIG.kind === 'quad') {
      // hovering: a slow drift side to side and a gentle bob; alerted: up and down between two heights and
      // side to side across its run in, quicker (two patterns out of step, so it never quite repeats)
      const lx = -RIG.az, lz = RIG.ax, o = RIG.o || RIG.c;
      if (M) {
        M.ph += dt * TAU / QUAD_T; M.ps += dt * TAU / QUAD_ST;
        RIG.c.y = M.h0 + M.A * Math.sin(M.ph); RIG.tilt = 0.12 * Math.cos(M.ph);
        const sw = QUAD_S * Math.sin(M.ps); RIG.c.x = o.x + lx * sw; RIG.c.z = o.z + lz * sw; RIG.ps = M.ps;
      } else {
        RIG.ps = (RIG.ps || 0) + dt * TAU / 6;
        RIG.c.y = RIG.h0 + 1.0 * Math.sin(RIG.t * TAU / 4);
        const sw = 2.5 * Math.sin(RIG.ps); RIG.c.x = o.x + lx * sw; RIG.c.z = o.z + lz * sw;
      }
      RIG.yaw += dt * 0.15; rigAxes();
      return;
    }
    if (!M || M.type === 'still') return;
    if (M.type === 'loop') {
      M.v = Math.min(M.vmax, M.v + 2 * dt); M.s += M.dir * M.v * dt; M.blend = Math.min(1, M.blend + M.v * dt / 12);
      loopAt(M, M.s, cvA, cvB); if (M.dir < 0) cvB.negate();
      RIG.c.set(cvA.x + M.off.x * (1 - M.blend), 0, cvA.z + M.off.z * (1 - M.blend));
      const yt = Math.atan2(cvB.x, cvB.z); let dy = yt - RIG.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      RIG.yaw += dy * (1 - Math.exp(-5 * dt)); rigAxes();
      return;
    }
    // shuttle: drive to one end, pause, reverse to the other
    if (M.wait > 0) { M.wait -= dt; return; }
    const goal = M.to > 0 ? M.b : M.a, left = Math.abs(goal - M.s);
    M.v = Math.min(CAR_V, M.v + 2 * dt, Math.sqrt(4 * left));
    const st = Math.min(left, M.v * dt); M.s += Math.sign(goal - M.s) * st;
    RIG.c.copy(M.o).addScaledVector(M.f, M.s);
    if (left - st < 0.02) { M.to = -M.to; M.v = 0; M.wait = 0.8; }
  }
  // the way in for the route planner and the kill camera, from where it is now: along its street, from the
  // side with the longer clear run, at its height
  function refreshSpot() {
    const sp = S.spot; if (!sp || !RIG.kind) return;
    if (RIG.kind === 'heli') { heliSpot(sp); return; }
    const c = RIG.c, quad = RIG.kind === 'quad', ax = quad ? RIG.ax : RIG.f.x, az = quad ? RIG.az : RIG.f.z, y0 = quad ? c.y : 0.9;
    const off = quad ? 1.2 : 2.6, runF = rayLen(c.x + ax * off, y0, c.z + az * off, ax, az, 60), runB = rayLen(c.x - ax * off, y0, c.z - az * off, -ax, -az, 60);
    const dir = runF >= runB ? 1 : -1;
    const ex = (d) => new THREE.Vector3(c.x + ax * dir * d, quad ? y0 : 1.2 + 0.06 * d, c.z + az * dir * d);
    sp.entry = ex(9); sp.entry2 = ex(33);
    if (S.alive) { const g = gateFor(c.x, c.y + RIG.cy, c.z); if (g) sp.gate = g; }
  }
  // the helicopter's way in: on the pad, like a man on a tower roof (in over the parapet, the last stretch
  // level across the deck); in the air, a level run from behind it (the shooter's side) at its height
  function heliSpot(sp) {
    const c = RIG.c, eye = PLAYER.eye, tl = Math.hypot(eye.x - c.x, eye.z - c.z) || 1, tx = (eye.x - c.x) / tl, tz = (eye.z - c.z) / tl;
    const air = !!(RIG.move && RIG.move.ph !== 'spool'), y0 = c.y + RIG.cy;
    sp.air = air;
    if (air) { sp.entry = new THREE.Vector3(c.x + tx * 9, y0, c.z + tz * 9); sp.entry2 = new THREE.Vector3(c.x + tx * 33, y0, c.z + tz * 33); }
    else { delete sp.entry; delete sp.entry2; }
    if (S.alive) { const g = gateFor(c.x, y0, c.z) || (air ? new THREE.Vector3(c.x + tx * 60, y0 + 8, c.z + tz * 60) : null); if (g) sp.gate = g; }
  }
  const cvA = V3(), cvB = V3(), cD = V3(), cN = V3(), cQ = new THREE.Quaternion(), cQ2 = new THREE.Quaternion(), XAX = new THREE.Vector3(1, 0, 0);
  function rigExplode(point, dir) {
    if (!S.alive) return;
    S.alive = false; S.settled = false; RIG.restT = 0; RIG.thudT = 0;
    RIG.g.updateMatrixWorld(true);
    cvB.set(dir.x, 0, dir.z); if (cvB.lengthSq() < 1e-6) cvB.copy(RIG.f); cvB.normalize();
    const car = RIG.kind === 'car' || RIG.kind === 'heli', tyres = RIG.meshes.filter((m) => m.userData.tyre), kick = tyres.length ? tyres[Math.floor(grnd(0, tyres.length))] : null;   // the tyre that bounces off down the road
    RIG.meshes.forEach((m, i) => {
      const p = m.getWorldPosition(V3()), q = m.getWorldQuaternion(new THREE.Quaternion());
      group.add(m); m.position.copy(p); m.quaternion.copy(q);
      cvA.subVectors(p, RIG.c); cvA.y = 0; if (cvA.lengthSq() < 1e-4) cvA.set(grnd(-1, 1), 0, grnd(-1, 1)); cvA.normalize();
      const v = V3();
      if (car) {
        v.copy(cvA).multiplyScalar(grnd(3, 8)).addScaledVector(cvB, grnd(2, 6)); v.y = grnd(5, 12);
        if (m.userData.high) v.y += 6;                                      // the cab roof goes highest
        if (m.userData.low) { v.multiplyScalar(0.2); v.y = grnd(2, 3); }   // the chassis barely leaves the street
        if (m === kick) { v.copy(cvB).multiplyScalar(grnd(9, 12)).addScaledVector(cvA, 2); v.y = grnd(7, 9); }
        if (m.userData.fly) { v.copy(cvA).multiplyScalar(grnd(9, 15)); v.y = grnd(4, 10); }   // rotor blades whirl off
        v.add(RIG.vel);                                                                         // a helicopter's pieces carry on with it
      } else {
        // rotors and motors fly off; the body takes the round's push and drops
        v.copy(cvA).multiplyScalar(i < 3 ? grnd(0.5, 1.5) : grnd(4, 9)).addScaledVector(cvB, i < 3 ? grnd(2, 4) : grnd(1, 3)); v.y = i < 3 ? grnd(0, 2) : grnd(2, 6);
      }
      const w = V3(grnd(-1, 1), grnd(-1, 1), grnd(-1, 1)).normalize().multiplyScalar(m.userData.fly ? grnd(15, 25) : grnd(4, car ? 12 : 20));
      RIG.deb.push({ m, p, q, v, w, r: m.userData.r, tyre: m.userData.tyre, e: m.userData.tyre ? 0.62 : 0.28, rest: false, still: 0, ground: false, roll: 0 });
    });
  }
  function rigDebris(dt) {
    if (!RIG.deb.length) return;
    const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
    for (let k = 0; k < n; k++) for (const d of RIG.deb) {
      if (d.rest) continue;
      d.ground = false;
      d.v.y -= PHYS.g * h;
      const sp = d.v.length();
      let moved = false;
      if (sp > 1e-4) {
        cD.copy(d.v).multiplyScalar(1 / sp);
        if (City.raycast(d.p, cD, sp * h + d.r)) {
          const Hh = City.hit; cN.set(Hh.nx, Hh.ny, Hh.nz); if (cN.dot(cD) > 0) cN.negate();
          d.p.addScaledVector(cD, Math.max(0, Hh.t - d.r)); moved = true;
          const vn = d.v.dot(cN);
          if (vn < 0) {
            d.v.addScaledVector(cN, -(1 + d.e) * vn);
            if (-vn > 3 && RIG.thudT <= 0) { RIG.thudT = 0.08; if (Sfx.bodyThud) Sfx.bodyThud(Math.min(1, -vn / 12) * (d.tyre ? 0.4 : RIG.kind === 'quad' ? 0.35 : 0.8)); }
            if (cN.y > 0.6) {
              d.ground = true;
              if (-vn > 1.2) { const kf = d.tyre ? 0.95 : 0.7; d.v.x *= kf; d.v.z *= kf; if (!d.tyre) d.w.multiplyScalar(0.6); }
              else { d.v.y = 0; const kf = Math.exp(-(d.tyre ? 0.35 : 4) * h); d.v.x *= kf; d.v.z *= kf; if (!d.tyre) d.w.multiplyScalar(Math.exp(-6 * h)); }
            }
          }
        }
      }
      if (!moved) d.p.addScaledVector(d.v, h);
      // a tyre on the street stands up and rolls; everything else (and a tyre in the air) tumbles
      const hs = Math.hypot(d.v.x, d.v.z);
      if (d.tyre && d.ground && hs > 0.3) {
        cvA.set(d.v.z, 0, -d.v.x).multiplyScalar(1 / hs);
        d.roll += (hs / d.r) * h;
        cQ.setFromUnitVectors(XAX, cvA); cQ2.setFromAxisAngle(cvA, d.roll); cQ2.multiply(cQ);
        d.q.slerp(cQ2, 1 - Math.exp(-14 * h)); d.w.copy(cvA).multiplyScalar(hs / d.r);
      } else {
        const wl = d.w.length(); if (wl > 1e-4) { cQ.setFromAxisAngle(cvA.copy(d.w).multiplyScalar(1 / wl), wl * h); d.q.premultiply(cQ); }
      }
    }
    let moving = 0;
    for (const d of RIG.deb) {
      if (!d.rest) {
        if (d.v.lengthSq() < 0.09 && d.ground) { d.still += dt; d.w.multiplyScalar(0.9); if (d.still > 0.4) d.rest = true; } else d.still = 0;
        if (!d.rest) moving++;
      }
      d.m.position.copy(d.p); d.m.quaternion.copy(d.q);
    }
    RIG.restT += dt; RIG.thudT -= dt;
    if (moving === 0 || RIG.restT > 6) S.settled = true;
  }
  // the wreck's middle (the kill camera watches it) and its pieces (for the result brackets); tyres and
  // rotors that fly off are left out so the camera stays on the wreck
  const rigPts = [];
  function rigJoints() {
    rigPts.length = 0;
    if (S.alive || !RIG.deb.length) { rigPts.push(chest); return rigPts; }
    RIG.deb.forEach((d, i) => { if (!d.tyre && !d.m.userData.fly && (RIG.kind !== 'quad' || i < 3)) rigPts.push(d.p); });
    return rigPts;
  }
  // ---- highway technical: out in the open on the main avenue the shooter looks down, cruising slowly up one
  // side and back down the other (a long lap with U-turns at the ends). A straight shot if you lead it.
  function tryHighway(band) {
    const eye = PLAYER.eye, lane = 7, span = grnd(160, 220), d = grnd(240, 380);   // the whole lap stays about 250 to 600 m out
    const zNear = eye.z - d, zFar = zNear - span;
    for (const x of [lane, -lane]) if (rayLen(x, 0.9, zNear, 0, -1, span) < span - 0.5) return nope('hwLane');
    const out = gameRand() < 0.5, x = out ? lane : -lane, z = zNear - span * grnd(0.15, 0.85);
    rigSpawn('car', x, 0, z, out ? Math.PI : 0);
    RIG.move = loopPath([[lane, zNear], [lane, zFar], [-lane, zFar], [-lane, zNear]], lane, 4.5);
    S.spot = { kind: 'highway', gate: gateFor(x, 0.9, z) || new THREE.Vector3(x, 40, z + 60), glass: [] };
    refreshSpot();
    return true;
  }
  // ---- quadcopter spots, a different kind each time it turns up: low over a street, high in a street canyon,
  // over a rooftop, over the top of a tall tower. Always out of the shooter's sight everywhere it will move
  // (up and down, side to side across its run in), with room round it and a clear run in at its height.
  function quadHidden(x, y, z) {
    for (const [dx, dy, dz] of [[0, 0, 0], [0.8, 0, 0], [-0.8, 0, 0], [0, 0, 0.8], [0, 0, -0.8], [0, 0.4, 0], [0, -0.4, 0]]) if (visibleFrom(PLAYER.eye, _hs.set(x + dx, y + dy, z + dz))) return false;
    return true;
  }
  let quadBag = [];
  function quadSite() { if (!quadBag.length) quadBag = shuffled(['street', 'canyon', 'roof', 'tower']); return quadBag.pop(); }
  // (cx, h, cz) the hover point, floor the street or deck beneath, (ax, az) the axis of the run in
  function tryQuadAt(cx, h, cz, floor, ax, az, site, run = 40) {
    const A = Math.min(QUAD_A, h - floor - 4.5), lx = -az, lz = ax;
    if (A < 2) return nope('hqLow');
    for (const y of [h, h + A, h - A]) for (const sw of [-QUAD_S, 0, QUAD_S]) if (!quadHidden(cx + lx * sw, y, cz + lz * sw)) return nope('hqVisible');
    const ex = 2.2 + QUAD_S * Math.abs(lx), ez = 2.2 + QUAD_S * Math.abs(lz);
    if (!boxFree([cx - ex, h - A - 1.5, cz - ez, cx + ex, h + A + 1.5, cz + ez], null)) return nope('hqBox');
    const runA = rayLen(cx, h, cz, ax, az, 60), runB = rayLen(cx, h, cz, -ax, -az, 60);
    if (Math.max(runA, runB) < run) return nope('hqRun');
    const gate = gateFor(cx, h, cz); if (!gate) return nope('hqGate');
    rigSpawn('quad', cx, h, cz, grnd(0, TAU)); RIG.ax = ax; RIG.az = az; RIG.floor = floor;
    S.spot = { kind: 'quad', site, gate, glass: [] };
    refreshSpot();
    return true;
  }
  function tryQuad(c, site = 'street') {
    const cx = c.nx ? (c.wall + c.opp) / 2 : c.x, cz = c.nz ? (c.wall + c.opp) / 2 : c.z;
    return tryQuadAt(cx, site === 'canyon' ? grnd(26, 48) : grnd(10, 22), cz, 0, c.ax, c.az, site);
  }
  // over a roof deck: the run in along whichever axis has the longer clear stretch at its height
  function tryQuadRoof(R, site) {
    for (let k = 0; k < 4; k++) {
      const x = grnd(R.x0 + 3, R.x1 - 3), z = grnd(R.z0 + 3, R.z1 - 3);
      if (!freeOnRoof(R, x, z, 2.5, 1.5)) continue;
      const h = R.y + grnd(8, 12), alongX = rayLen(x, h, z, 1, 0, 60) + rayLen(x, h, z, -1, 0, 60) > rayLen(x, h, z, 0, 1, 60) + rayLen(x, h, z, 0, -1, 60);
      if (tryQuadAt(x, h, z, R.y, alongX ? 1 : 0, alongX ? 0 : 1, site, 30)) return true;
    }
    return false;
  }
  // high beside a tall tower, tucked in behind it: a few metres off one face, below the roofline, the run in
  // along the face
  function tryQuadTower(R) {
    const faces = shuffled([[R.x0, null, -1, 0], [R.x1, null, 1, 0], [null, R.z0, 0, -1], [null, R.z1, 0, 1]]);
    for (const [fx, fz, nx, nz] of faces) for (let k = 0; k < 2; k++) {
      const h = Math.max(26, R.y - grnd(4, 16)), off = 7;
      const x = fx != null ? fx + nx * off : grnd(R.x0 + 3, R.x1 - 3), z = fz != null ? fz + nz * off : grnd(R.z0 + 3, R.z1 - 3);
      if (tryQuadAt(x, h, z, 0, Math.abs(nz), Math.abs(nx), 'tower')) return true;
    }
    return false;
  }
  function spawnQuad(band) {
    const first = quadSite(), order = [first, ...['street', 'roof', 'canyon', 'tower'].filter((k) => k !== first)];
    for (const site of order) {
      if (site === 'street' || site === 'canyon') { const cands = streetSpots(band); for (let a = 0; a < Math.min(cands.length, 120); a++) if (tryQuad(cands[a], site)) return true; }
      else {
        const tall = site === 'tower', b = tall ? [band[0] - 60, band[1] + 200] : band;
        let pool = City.roofs.filter((R) => !R.garage && R.x1 - R.x0 > 10 && R.z1 - R.z0 > 10 && centreIn(R, b) && (tall ? R.y >= 75 && R.y <= 180 : R.y >= 12 && R.y < 75));
        pool = tall ? highFirst(pool) : shuffled(pool);
        for (let a = 0; a < Math.min(pool.length, 40); a++) if (tall ? tryQuadTower(pool[a]) : tryQuadRoof(pool[a], site)) return true;
      }
    }
    return false;
  }
  function hide() { group.visible = false; S.alive = false; }
  function centroid(out) {
    if (S.type !== 'man') { const Q = rigJoints(); out.set(0, 0, 0); for (const p of Q) out.add(p); return out.multiplyScalar(1 / Q.length); }
    out.set(0, 0, 0); const Q = S.ragdoll ? P : jp; for (let i = 0; i < NJ; i++) out.add(Q[i]); return out.multiplyScalar(1 / NJ);
  }
  rigReset(); S.type = 'man';
  hide();
  const debug = {
    // put the man on a given roof spot with a given behaviour / outfit (for probes)
    respawn(stage = 1, beh, variant) { return spawn(stage, { beh, variant }); },
    bones, A, LV,
  };
  return { group, spawn, alert, evade, calm, coverBand, update, segmentHit, distToSegment, launch, spook, hide, centroid, chest, head: headPos, S, CF, rangeFor, J, joints: () => (S.type !== 'man' ? rigJoints() : S.ragdoll ? P : jp), corners: rigCorners, refreshSpot, truckMesh, debug };
})();
