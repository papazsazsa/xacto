// ---------------------------------------------------------------------------
// Game: renderer, input, cameras, state machine, scoring, main loop
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);
renderer.domElement.id = 'game';
Post.init(renderer);

const scene = new THREE.Scene();
scene.add(City.group, Target.group, Bullet.root, FX.points);
const camera = new THREE.PerspectiveCamera(40, 1, 1, 7000);
camera.rotation.order = 'YXZ';

const MODES = [{ name: 'WHITE HOT', persist: 0.1 }, { name: 'BLACK HOT', persist: 0.1 }, { name: 'NIGHT VISION', persist: 0.35 }];
const MAGS = [4, 6, 8, 12, 16, 24, 32];
const G = {
  state: 'attract', stateT: 0, paused: false, auto: false,
  score: 0, scoreShown: 0, hi: 0, table: [], stage: 1, rounds: 5, maxRounds: 5,
  mag: 6, magI: 1, scopeR: 0.46, reticleOff: new THREE.Vector2(), lased: 0, crossWind: 0, timeLeft: 60,
  breath: 1, holding: false, gasp: 0,
  tgtScreen: { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 }, bodyBox: { vis: false, x0: 0, y0: 0, x1: 0, y1: 0 }, pipScreen: { vis: false, x: 0, y: 0 },
  tgtRange: 0, tti: 0, stick: new THREE.Vector2(), timeScale: 1, baseTS: 0.2,
  mode: Store.get('mode', 0), modeName: '', diff: {}, wind: new THREE.Vector3(),
  lastHit: null, lastMiss: '', tallyRows: [], initials: ['A', 'A', 'A'], initialPos: 0, toast: '', toastT: 0,
  hitPoint: new THREE.Vector3(), hitDir: new THREE.Vector3(), flash: 0, staticAmt: 0, fade: 0, scopeAmt: 0,
  // flight / demo bookkeeping (additive; HUD may read lock, whoosh, nearMisses, demo)
  demo: false, passedT: -1, shake: 0, nearCool: 0, locked: false, tof: 0, lastEv: '',
};
G.modeName = MODES[G.mode].name;
const DEFAULT_TABLE = [{ n: 'JCB', s: 60000 }, { n: 'MRK', s: 45000 }, { n: 'SGT', s: 30000 }, { n: 'ACE', s: 20000 }, { n: 'DOC', s: 10000 }];
G.table = Store.get('table', DEFAULT_TABLE);
G.hi = G.table[0] ? G.table[0].s : 0;

// ---- input -----------------------------------------------------------------
const Input = { keys: new Set(), dx: 0, dy: 0, wheel: 0, mx: 0.5, my: 0.5, inside: false, pressed: new Set(), touchAim: null };
const canvas = renderer.domElement;
const GAME_KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
window.addEventListener('keydown', (e) => {
  if (GAME_KEYS.includes(e.code)) e.preventDefault();
  if (!e.repeat) Input.pressed.add(e.code);
  Input.keys.add(e.code); Sfx.init();
});
window.addEventListener('keyup', (e) => Input.keys.delete(e.code));
window.addEventListener('blur', () => { Input.keys.clear(); if (G.state !== 'attract') G.paused = true; });
canvas.addEventListener('mousemove', (e) => {
  Input.dx += e.movementX || 0; Input.dy += e.movementY || 0;
  const r = canvas.getBoundingClientRect(); Input.mx = (e.clientX - r.left) / r.width; Input.my = (e.clientY - r.top) / r.height; Input.inside = true;
});
canvas.addEventListener('mouseleave', () => (Input.inside = false));
canvas.addEventListener('mousedown', (e) => {
  Sfx.init();
  if (document.pointerLockElement !== canvas && canvas.requestPointerLock) { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) { /* not allowed in this frame */ } }
  if (e.button === 0) Input.pressed.add('Fire');
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); Input.wheel += Math.sign(e.deltaY); }, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault(); Sfx.init();
  if (G.state === 'initials') {
    // touch initials: tap the upper third / lower third to change the letter, the middle to confirm
    const y = e.changedTouches[0].clientY / innerHeight;
    Input.pressed.add(y < 0.38 ? 'ArrowUp' : y > 0.72 ? 'ArrowDown' : 'Fire');
    return;
  }
  for (const t of e.changedTouches) {
    const x = t.clientX / innerWidth, y = t.clientY / innerHeight;
    if (x > 0.78 && y > 0.6) Input.pressed.add('Fire');
    else Input.touchAim = { id: t.identifier, x: t.clientX, y: t.clientY };
  }
  if (G.paused || G.demo || G.state === 'attract' || G.state === 'tally' || G.state === 'gameover' || G.state === 'killcam' || G.state === 'misscam') Input.pressed.add('Fire');
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) if (Input.touchAim && t.identifier === Input.touchAim.id) { Input.dx += (t.clientX - Input.touchAim.x) * 1.6; Input.dy += (t.clientY - Input.touchAim.y) * 1.6; Input.touchAim.x = t.clientX; Input.touchAim.y = t.clientY; }
}, { passive: false });
canvas.addEventListener('touchend', (e) => { for (const t of e.changedTouches) if (Input.touchAim && t.identifier === Input.touchAim.id) Input.touchAim = null; });
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state !== 'attract') G.paused = true; });
const pressed = (...codes) => codes.some((c) => Input.pressed.has(c));
const held = (...codes) => codes.some((c) => Input.keys.has(c));

// ---- aim / sway ---------------------------------------------------------------
const Aim = { yaw: 0, pitch: -0.035, sx: 0, sy: 0, ouX: new OU(1.6, 0.00045), ouY: new OU(1.6, 0.0004), bph: 0, hph: 0, recoil: 0, recoilV: 0, hbT: 0, vx: 0, vy: 0 };
const fwd = new THREE.Vector3(), rightV = new THREE.Vector3(), tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();

function setState(s) { G.state = s; G.stateT = 0; }
function toast(msg, t = 1.6) { G.toast = msg; G.toastT = t; }

// Per-stage difficulty. wind/gust in m/s (wind pushes the slow round sideways at windK m/s^2 per m/s),
// turb and aMax in m/s^2 (aMax at cruise speed), budget = total steering delta-v (m/s), vc = cruise speed after
// the fins brake the round (m/s), bleed = speed lost per m/s^2 of turn, tau = actuator lag (s, sim time),
// roll = roll-reference error (rad), lockF = seeker lock delay as a fraction of the time of flight,
// seeker = pipper sensor noise (m at the target), pipLag = pipper display lag (s, real time),
// cover = the approach angle band (degrees off the line of sight) the man's cover demands.
function difficulty(stage) {
  const s = Math.max(1, stage) - 1;
  return {
    wind: Math.min(4, 1.0 + 0.4 * s), gust: Math.min(1.4, 0.4 + 0.12 * s), turb: Math.min(3, 1.0 + 0.25 * s),
    roll: Math.min(0.16, 0.03 + 0.016 * s), budget: Math.max(150, 240 - 10 * s), aMax: Math.max(104, 125 - 2.5 * s), tau: Math.min(0.17, 0.09 + 0.01 * s),
    vc: Math.min(155, 130 + 3 * s), vMin: Math.min(80, 55 + 3 * s), windK: 1, bleed: 0.1,
    lockF: Math.min(0.2, 0.06 + 0.02 * s), seeker: Math.min(0.22, 0.04 + 0.025 * s), pipLag: Math.min(0.16, 0.05 + 0.015 * s),
    basket: Math.max(0.6, 1.5 - 0.11 * s), homeT: 0.3,
    cover: Target.coverBand ? Target.coverBand(stage) : [5, 10],
  };
}
function newStage() {
  const info = City.generate(newSeed());
  G.sector = info.sector || '';
  FX.clear(); Bullet.clearTrail(); Bullet.hideRound();
  G.diff = difficulty(G.stage);
  const th = (grnd() < 0.5 ? 0 : Math.PI) + grnd(-0.7, 0.7);
  G.wind.set(Math.cos(th), 0, Math.sin(th)).multiplyScalar(G.diff.wind * grnd(0.75, 1.1));
  FX.wind.copy(G.wind).multiplyScalar(0.6);
  Target.spawn(G.stage);
  // start looking roughly down the avenue, toward the target's side
  const tc = Target.chest;
  Aim.yaw = clamp(Math.atan2(-(tc.x - PLAYER.eye.x), -(tc.z - PLAYER.eye.z)) * 0.4, -0.5, 0.5);
  Aim.pitch = -0.035; G.magI = 1; G.mag = MAGS[1];
  G.timeLeft = 60; G.breath = 1; G.gasp = 0;
  setState('brief');
  Sfx.windLevel && Sfx.windLevel(G.wind.length());
  if (!G.demo) Sfx.stageStart && Sfx.stageStart();
  return info;
}
function startGame() {
  G.score = 0; G.scoreShown = 0; G.stage = 1; G.rounds = G.maxRounds = 5; Sfx.coin();
  newStage();
}
// Laser rangefinder with ~3.5 mrad beam divergence: the man counts as a return whenever he is inside the
// beam, so a slightly-off reticle at long range still ranges him instead of the wall 300 m behind.
function lase(o, d) {
  let range = 0;
  if (City.raycast(o, d, 4500)) range = City.hit.t;
  if (Target.S.alive) {
    tmpV2.subVectors(Target.chest, o); const dist = tmpV2.length();
    const cosA = tmpV2.dot(d) / Math.max(dist, 1e-6);
    if (cosA > Math.cos(0.0035) && (!range || dist < range + 3)) range = dist;
  }
  return range;
}
function fire() {
  if (G.rounds <= 0) return;
  G.rounds--;
  camera.getWorldDirection(fwd);
  const origin = tmpV.copy(PLAYER.eye).add(new THREE.Vector3(0, -0.06, 0));
  const range = G.lased > 0 ? G.lased : 1000;
  const dir = new THREE.Vector3();
  Bullet.solveLaunch(origin, fwd, range, dir);
  const dTarget = Target.chest.distanceTo(PLAYER.eye);
  // flight time: a short supersonic dash while the fins brake it, then cruise
  // a supersonic dash (dash s at full speed), then the fins brake it to cruise
  const vc = G.diff.vc, dash = 0.1, brakeT = 0.3, brakeD = PHYS.v0 * dash + vc * brakeT + (PHYS.v0 - vc) * 0.09;
  const tof = dash + brakeT + Math.max(0, dTarget - brakeD) / vc;
  // slow motion: after the first fast moment the flight runs at about a third (close) to a half (far) speed,
  // so a guided shot lasts roughly 6 to 8 seconds on screen
  G.baseTS = clamp(tof / (4.6 + dTarget * 0.0045), 0.25, 0.7);
  G.tof = tof;
  Bullet.fire(origin, dir, {
    aMax: G.diff.aMax, tau: G.diff.tau, budget: G.diff.budget, wind: G.wind, gust: G.diff.gust, turb: G.diff.turb, roll: G.diff.roll,
    lockT: Math.max(0.05, G.diff.lockF * tof), seeker: G.diff.seeker, basket: G.diff.basket, homeT: G.diff.homeT,
    vc, vMin: G.diff.vMin, brakeT, dash, windK: G.diff.windK, bleed: G.diff.bleed,
  });
  // the round is subsonic after braking: the report reaches the man first, and he runs for cover
  Target.alert && Target.alert(dTarget / 343);
  FX.muzzle(origin.clone().addScaledVector(dir, 1.4), dir);
  Sfx.shot(); G.flash = 0.9; Aim.recoilV = 0.9;
  G.stick.set(0, 0); G.nearMisses = 0; G.nearCool = 0; G.shake = 0; G.passedT = -1; G.locked = false;
  camK.init = false; PLAN.ok = false; PLAN.tried = false; G.braked = false; G.stampT = 0;
  setState('shot');
}
function scoreHit(ev) {
  const range = Bullet.S.origin.distanceTo(ev.point);
  const ctrl = Bullet.S.budget / Bullet.S.budget0;
  const centre = ev.centre;
  G.lastHit = { range, centre, part: ev.part };
  G.tallyRows = [
    [`RANGE ${Math.round(range)} M`, Math.round(range * 2)],
    [ev.part === 'head' ? 'HAT TRICK' : centre < 0.15 ? 'CENTER MASS' : 'OFF CENTER', ev.part === 'head' ? 700 : centre < 0.15 ? 500 : 100],
    [`CONTROL RESERVE ${Math.round(ctrl * 100)}%`, Math.round(ctrl * 800)],
    [`TIME BONUS ${Math.ceil(Math.max(0, G.timeLeft))} S`, Math.round(Math.max(0, G.timeLeft) * 10)],
  ];
  const bendDeg = Bullet.S.bend / DEG;
  if (bendDeg >= 3) G.tallyRows.push([`CURVE SHOT ${Math.round(bendDeg)} DEG`, Math.round(bendDeg) * 40]);
  if (!clearLine(Bullet.S.origin, ev.point, -0.6)) G.tallyRows.push(['AROUND COVER', 600]);
  if (G.nearMisses > 0) G.tallyRows.push([`CLOSE CALLS X${G.nearMisses}`, 150 * G.nearMisses]);
  G.tallyRows.push([`STAGE ${G.stage} BONUS`, 250 * G.stage]);
  G.tallyStep = G.tallyRows.length > 5 ? 0.3 : 0.45;
  G.score += G.tallyRows.reduce((a, r) => a + r[1], 0);
}
function onBulletEvent(ev) {
  Sfx.flightStop(); G.lastEv = ev.type; G.whoosh = 0; G.toastT = 0;   // flight call-outs never overlap the result banner
  G.hitPoint.copy(ev.point); G.hitDir.copy(Bullet.S.v);
  if (G.hitDir.lengthSq() < 1e-6) G.hitDir.set(0, 0, -1); G.hitDir.normalize();
  camK.init = false;
  if (ev.type === 'hit') {
    Target.launch(ev.point, G.hitDir, ev.part);
    Sfx.hit(); G.flash = 0.35;
    if (G.rounds < G.maxRounds) G.rounds++; // a hit refunds the round
    scoreHit(ev);
    Bullet.hideRound();
    G.trailCleared = false; setState('killcam');
  } else {
    if (ev.type === 'impact') G.hitNormal = (G.hitNormal || new THREE.Vector3()).set(ev.normal.x, ev.normal.y, ev.normal.z);
    if (ev.type === 'impact') { FX.sparks(ev.point, tmpV.set(ev.normal.x, ev.normal.y, ev.normal.z), 45, 35); Sfx.impactThud(); }
    Sfx.miss();
    const md = Bullet.S.minDist;
    G.missP.copy(Bullet.S.closeP); G.missGap = Target.S.alive && md < 40 && md > 0.3;
    G.lastMiss = md < 50 ? `MISSED BY ${md.toFixed(1)} M` : ev.type === 'lost' ? 'ROUND LOST' : ev.kind === 4 ? 'WIRE STRIKE' : ev.kind === 3 ? 'WATER TOWER' : ev.kind === 2 ? 'ROOF EQUIPMENT' : 'HIT STRUCTURE';
    if (md < 15) Target.spook();
    Bullet.hideRound();
    setState('misscam');
  }
}

// ---- cameras ---------------------------------------------------------------
const camK = { off: new THREE.Vector3(), look: new THREE.Vector3(), init: false, orbit: 0, roll: 0 };
function aimCamera(rdt) {
  const breathMul = G.holding ? 0.16 : G.gasp > 0 ? 2.6 : 1;
  Aim.bph += rdt * TAU / (G.gasp > 0 ? 1.6 : 4.2);
  Aim.hph += rdt * TAU * (G.holding ? 1.45 : 1.15);
  const heart = Math.pow(Math.max(0, Math.sin(Aim.hph)), 12) * 0.00018;
  const tx = (0.0004 * Math.sin(0.5 * Aim.bph + 0.7) + Aim.ouX.step(rdt)) * breathMul;
  const ty = (0.0011 * Math.sin(Aim.bph) + Aim.ouY.step(rdt)) * breathMul + heart;
  Aim.vx = (tx - Aim.sx) / Math.max(rdt, 1e-3); Aim.vy = (ty - Aim.sy) / Math.max(rdt, 1e-3);
  Aim.sx = tx; Aim.sy = ty;
  // recoil spring
  Aim.recoilV += (-Aim.recoil * 160 - Aim.recoilV * 16) * rdt; Aim.recoil += Aim.recoilV * rdt;
  camera.position.copy(PLAYER.eye);
  const kickMax = 0.32 * ((40 / G.mag) * DEG) / 2;
  const kick = Math.min(Aim.recoil * 0.22, kickMax);
  camera.rotation.set(Aim.pitch + Aim.sy + kick, Aim.yaw + Aim.sx + kick * 0.18, 0);
  camera.fov = 40 / G.mag; camera.near = 1; camera.far = 7000;
  G.reticleOff.set(0, 0);
  Post.display.uniforms.uScopeOff.value.set(clamp(-Aim.vx * 6, -0.05, 0.05), clamp(-Aim.vy * 6, -0.05, 0.05) - Aim.recoil * 0.1);
}
// vertical FOV that keeps at least `minH` degrees of horizontal view on tall / portrait screens
function fitFov(fovV, minH) {
  const asp = Math.max(0.3, camera.aspect || 1);
  const needV = 2 * Math.atan(Math.tan((minH * DEG) / 2) / asp) / DEG;
  return clamp(Math.max(fovV, needV), 10, 100);
}
const shakeV = new THREE.Vector3(), lookV = new THREE.Vector3();
const PATH_N = 18; G.pathBlockP = new THREE.Vector3(); G.blockScreen = { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 }; G.missA = { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 }; G.missB = { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 }; G.missP = new THREE.Vector3();
// seeker window camera: rides the line from the man back toward the round, never farther than 80 m from him
const seekCam = new THREE.PerspectiveCamera(10, 1.6, 0.5, 7000);
// body-heat glow: a soft additive halo on the man so he reads as the hot spot at any range (hidden by
// whatever stands between him and the camera, so it vanishes when he ducks behind cover)
const manGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
  uniforms: { uHeat: { value: 0.32 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform float uHeat; varying vec2 vUv; void main(){ vec2 c = (vUv - 0.5) * 2.0; float r2 = dot(c, c); float v = exp(-r2 * 3.2) * (1.0 - smoothstep(0.65, 1.0, r2)); gl_FragColor = vec4(uHeat * v, 0.0, 0.0, 1.0); }',
  transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
}));
manGlow.frustumCulled = false; manGlow.renderOrder = 6; scene.add(manGlow);
G.coverScreen = { vis: false, x0: 0, y0: 0, x1: 0, y1: 0 };
const cvP = new THREE.Vector3();
function coverBox(out) {
  const app = Target.S.app; out.vis = false; if (!app || !app.box) return;
  const b = app.box; let x0 = 9, y0 = 9, x1 = -9, y1 = -9, n = 0;
  camera.getWorldDirection(fwd);
  for (let i = 0; i < 8; i++) {
    cvP.set(i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]);
    if (tmpV2.subVectors(cvP, camera.position).dot(fwd) <= 0.1) return;
    ndc.copy(cvP).project(camera); const x = (ndc.x + 1) / 2, y = (1 - ndc.y) / 2;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); n++;
  }
  out.vis = n === 8 && x1 > 0 && x0 < 1 && y1 > 0 && y0 < 1; out.x0 = x0; out.y0 = y0; out.x1 = x1; out.y1 = y1;
} G.pathPts = Array.from({ length: PATH_N }, () => new THREE.Vector3()); G.pathScreen = Array.from({ length: PATH_N }, () => ({ vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 })); G.roundScreen = { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 };
// Route for the autopilot, demo and test bots: straight at the man when the line is open, otherwise pure
// pursuit along the clear approach lane that Target found around his cover (the lane's line, extended back
// toward the shooter), with a look-ahead point that slides in toward him.
const routeP = new THREE.Vector3(), routeQ = new THREE.Vector3(), routeE = new THREE.Vector3();
function routeMode() {
  const B = Bullet.S, c = Target.chest, app = Target.S.app;
  if (!app || !Target.S.alive) return 'direct';
  const sAlong = routeP.subVectors(B.p, app.chest).dot(app.dir);
  if (sAlong < 24 || (B.p.distanceTo(c) < 40 && clearLine(B.p, c, -0.6))) return 'direct';
  return 'lane';
}
// before the lane: head for its entry point; from ~60 m out the aim point slides in along the lane, so the
// round turns early and arrives lined up with it
function routeAim(out) {
  const B = Bullet.S, app = Target.S.app;
  if (routeMode() === 'direct') return out.copy(Target.chest);
  const sAlong = routeP.subVectors(B.p, app.chest).dot(app.dir);
  return out.copy(app.chest).addScaledVector(app.dir, clamp(sAlong - 60, 0, app.len));
}
const routeT = new THREE.Vector3();
// The expert's plan: one smooth cubic curve from where the round is (after braking) into the clear lane,
// arriving along it. Candidate handle lengths are checked against the city (fat segments) and the one with
// the gentlest bend is kept. Followed by pure pursuit; the last ~24 m go straight at the man.
const PLAN = { ok: false, P: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], u: 0, n: 48, pts: [] };
for (let i = 0; i <= 48; i++) PLAN.pts.push(new THREE.Vector3());
const bz = (P, u, out) => { const a = 1 - u; return out.set(0, 0, 0).addScaledVector(P[0], a * a * a).addScaledVector(P[1], 3 * a * a * u).addScaledVector(P[2], 3 * a * u * u).addScaledVector(P[3], u * u * u); };
const plA = new THREE.Vector3(), plB = new THREE.Vector3(), plD = new THREE.Vector3(), plR = new THREE.Vector3(), plU = new THREE.Vector3();
function planRoute() {
  const B = Bullet.S, app = Target.S.app; PLAN.ok = false; PLAN.u = 0;
  if (!app) return;
  const P0 = B.p, T0 = plA.copy(B.v).normalize(), P3 = app.chest, D = P0.distanceTo(P3);
  let best = null;
  for (const h of [0, 0.07, 0.15]) for (const k0 of [0.15, 0.25, 0.35, 0.5, 0.65]) for (const k1 of [0.12, 0.2, 0.3, 0.42, 0.55]) {
    if (h > 0 && best && best.k < 0.004) break;
    const P = [P0.clone(), P0.clone().addScaledVector(T0, k0 * D).addScaledVector(UP, h * D), P3.clone().addScaledVector(app.dir, k1 * D), P3.clone()];
    // clear? sample the curve, cast fat segments (skip the last 3 m into the man)
    let clear = true, maxK = 0; const pts = [];
    for (let i = 0; i <= 32; i++) pts.push(bz(P, i / 32, new THREE.Vector3()));
    for (let i = 0; i < 32 && clear; i++) {
      plD.subVectors(pts[i + 1], pts[i]); let L = plD.length(); plD.multiplyScalar(1 / L);
      if (pts[i + 1].distanceTo(P3) < 3) L -= 3; if (L <= 0) continue;
      plR.crossVectors(plD, UP).normalize(); plU.crossVectors(plR, plD);
      for (const [ox, oy] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) {
        plB.copy(pts[i]).addScaledVector(plR, ox).addScaledVector(plU, oy);
        if (City.raycast(plB, plD, L)) { clear = false; break; }
      }
    }
    if (!clear) continue;
    // bend: largest turn per metre along the curve
    for (let i = 1; i < 32; i++) {
      plA.subVectors(pts[i], pts[i - 1]); plB.subVectors(pts[i + 1], pts[i]);
      const ang = plA.angleTo(plB), ds = (plA.length() + plB.length()) / 2; maxK = Math.max(maxK, ang / Math.max(ds, 1e-3));
    }
    plA.copy(B.v).normalize();
    if (!best || maxK < best.k) best = { k: maxK, P };
  }
  if (!best) return;
  for (let i = 0; i < 4; i++) PLAN.P[i].copy(best.P[i]);
  for (let i = 0; i <= PLAN.n; i++) bz(PLAN.P, i / PLAN.n, PLAN.pts[i]);
  PLAN.ok = true;
}
function routeStick(stick, gain = 0.75, look = 45) {
  const B = Bullet.S, app = Target.S.app;
  if (!app || !Target.S.alive) return Bullet.autopilot(Target.chest, stick, Math.max(gain, 0.9), G.tgtVel);
  if (!PLAN.ok && B.t > B.brakeT && !PLAN.tried) { PLAN.tried = true; planRoute(); }
  const dC = B.p.distanceTo(Target.chest);
  if (dC < 24 || (dC < 40 && clearLine(B.p, Target.chest, -0.6))) return Bullet.autopilot(Target.chest, stick, Math.max(gain, 0.9), G.tgtVel);
  if (PLAN.ok) {
    // nearest point on the plan (searching forward), then a look-ahead point ~45 m further along
    let bi = PLAN.u, bd = 1e18;
    for (let i = PLAN.u; i <= Math.min(PLAN.n, PLAN.u + 12); i++) { const d = PLAN.pts[i].distanceToSquared(B.p); if (d < bd) { bd = d; bi = i; } }
    PLAN.u = bi;
    let j = bi, acc = 0; while (j < PLAN.n && acc < look) { acc += PLAN.pts[j].distanceTo(PLAN.pts[j + 1]); j++; }
    routeT.copy(PLAN.pts[j]);
  } else routeAim(routeT);
  const { f, r, u } = Bullet.frame();
  routeE.subVectors(routeT, B.p); const Ld = Math.max(5, routeE.length()); routeE.multiplyScalar(1 / Ld);
  routeQ.copy(routeE).addScaledVector(f, -f.dot(routeE));
  const v2 = B.v.lengthSq(), auth = Math.max(1, Bullet.authority());
  // pure pursuit: lateral pull 2 v^2 sin(eta) / Ld toward the look-ahead point
  stick.set(clamp(2 * v2 * routeQ.dot(r) / Ld / auth, -1, 1), clamp(2 * v2 * routeQ.dot(u) / Ld / auth, -1, 1)); if (stick.length() > 1) stick.normalize();
  return Bullet.unshape(stick.x, stick.y, stick);
}
function chaseCamera(rdt) {
  const { f, r, u } = Bullet.frame();
  const B = Bullet.S;
  // launch: the camera starts beside the round as it leaves the muzzle, then swings in behind it
  const k = sstep(0, 0.9, G.stateT);
  const termK = sstep(0, G.baseTS * 1.4, G.tti || 1);
  const back = lerp(0.42, 1.2, k), side = lerp(0.3, 0.07, k), up = lerp(0.06, 0.2, k) * lerp(0.4, 1, termK);
  const want = tmpV.copy(f).multiplyScalar(-back).addScaledVector(u, up).addScaledVector(r, side);
  if (!camK.init) { camK.off.copy(want); camK.init = true; camK.roll = 0; }
  // the rig lags the round a little, so hard steering visibly drifts the round in frame
  camK.off.lerp(want, 1 - Math.exp(-7 * rdt));
  // shake: turbulence buffets the rig; near misses and launch give it a kick
  G.shake = Math.max(0, (G.shake || 0) - rdt * 2.5);
  const turbA = Math.hypot(B.turb.x, B.turb.y) / Math.max(1, G.diff.turb || 1);
  const amp = 0.004 * turbA + 0.02 * G.shake + 0.012 * (1 - k);
  const t = U.uTime.value;
  shakeV.copy(r).multiplyScalar(amp * (Math.sin(t * 61) + 0.6 * Math.sin(t * 37 + 1))).addScaledVector(u, amp * (Math.sin(t * 53 + 2) + 0.6 * Math.sin(t * 29)));
  camera.position.copy(B.p).add(camK.off).add(shakeV);
  camera.up.copy(UP);
  // look into the turn: blend the straight-ahead point toward where the round will be in ~0.5 s
  Bullet.previewPath(G.stick, 2.2, PATH_N, G.pathPts, 1.7);
  // where the held course runs into something (the man himself does not count)
  G.pathBlock = -1;
  for (let i = 0, a = B.p; i < PATH_N; a = G.pathPts[i], i++) {
    const b = G.pathPts[i]; kcD.subVectors(b, a); const L = kcD.length(); if (L < 1e-3) continue; kcD.multiplyScalar(1 / L);
    if (Target.S.alive && Target.distToSegment(a, b) < 0.6) break;
    if (City.raycast(a, kcD, L)) { G.pathBlock = i; G.pathBlockP.copy(a).addScaledVector(kcD, City.hit.t); break; }
  }
  lookV.copy(B.p).addScaledVector(f, 40);
  // the sample nearest 0.5 s ahead (samples sit at 2.2 * (k / N)^1.7 s)
  if (k > 0.5) { const pk = G.pathPts[Math.round(PATH_N * Math.pow(0.5 / 2.2, 1 / 1.7)) - 1]; tmpV2.subVectors(pk, B.p); const dl = tmpV2.length(); if (dl > 1) lookV.lerp(tmpV2.multiplyScalar(40 / dl).add(B.p), 0.55); }
  camera.lookAt(lookV);
  // bank into the turn (actual actuator force, plus a touch of the stick for responsiveness)
  const lat = B.aMax > 0 ? B.aCur.x / B.aMax : 0;
  camK.roll = damp(camK.roll, clamp(-lat * 0.42 - G.stick.x * 0.08, -0.5, 0.5), 5, rdt);
  camera.rotateZ(camK.roll);
  // dynamic FOV: wide at the muzzle (speed), narrowing in the terminal phase so the man fills more of the frame
  const term = sstep(0, G.baseTS * 1.4, G.tti);
  let fov = lerp(64, 40, k) - (1 - term) * 12 + G.shake * 3 + 18 * (1 - sstep(0.22, 0.55, G.stateT));
  // terminal rush: over the last ~80 m the lens tightens so the man grows to ~22% of frame height at impact
  const R = G.tgtRange || 1e9;
  if (R < 80 && Target.S.alive) {
    const want = 2 * Math.atan(1.8 / (2 * 0.22 * (R + 1.2))) / DEG;
    fov = lerp(fov, Math.max(20, want), sstep(80, 15, R));
  }
  camera.fov = fitFov(fov, 26); camera.near = 0.03; camera.far = 7000;
}

// ---- killcam / misscam: pick a camera spot with a clear view (City.raycast), then track smoothly ----
const killCentre = new THREE.Vector3(), kcA = new THREE.Vector3(), kcB = new THREE.Vector3(), kcD = new THREE.Vector3(), kcS = new THREE.Vector3();
const KC = { pos: new THREE.Vector3(), base: new THREE.Vector3(), anchor: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 7, angle: 0, cutAt: 2.4 };
function clearLine(a, b, pad = 0.25) {
  kcD.subVectors(b, a); const L = kcD.length(); if (L < 1e-3) return true;
  kcD.multiplyScalar(1 / L);
  return !City.raycast(a, kcD, L + pad);
}
// Score candidate spots around `centre`; `fly` is where the subject is heading. Returns false when nothing is clear.
function pickView(centre, fly, flyDir, dists, heights, avoidDir, out) {
  let best = -1e9;
  const hd = kcS.set(flyDir.x, 0, flyDir.z); if (hd.lengthSq() < 1e-6) hd.set(0, 0, -1); hd.normalize();
  const sideX = -hd.z, sideZ = hd.x;
  for (const dist of dists) for (let ai = 0; ai < 16; ai++) for (const h of heights) {
    const a = (ai / 16) * TAU;
    const dx = Math.cos(a) * sideX + Math.sin(a) * hd.x, dz = Math.cos(a) * sideZ + Math.sin(a) * hd.z;
    kcA.set(centre.x + dx * dist, centre.y + h, centre.z + dz * dist);
    if (kcA.y < 0.6) continue;
    if (!clearLine(centre, kcA) || !clearLine(fly, kcA)) continue;
    // margin: the frame edges near the camera must be open too (no HVAC box filling the screen)
    kcB.set(kcA.x - dz * 1.1, kcA.y, kcA.z + dx * 1.1); if (!clearLine(centre, kcB, 0)) continue;
    kcB.set(kcA.x + dz * 1.1, kcA.y, kcA.z - dx * 1.1); if (!clearLine(centre, kcB, 0)) continue;
    kcB.set(kcA.x, kcA.y - 0.9, kcA.z); if (!clearLine(centre, kcB, 0)) continue;
    const along = dx * hd.x + dz * hd.z;               // >0: camera ahead of the flight, man flies toward it
    let sc = (1 - Math.abs(along)) * 1.0 - Math.max(0, along) * 0.9 + Math.max(0, -along) * 0.15 - Math.abs(h - 2) * 0.12 - Math.abs(dist - dists[0]) * 0.04;
    if (avoidDir) sc -= Math.max(0, dx * avoidDir.x + dz * avoidDir.z) * 1.4;
    // backdrop: open skyline or street drop behind the subject scores, a wall right behind him does not
    kcD.subVectors(centre, kcA); kcD.y = Math.max(kcD.y, -0.2 * Math.hypot(kcD.x, kcD.z)); kcD.normalize();
    sc += (City.raycast(centre, kcD, 70) ? clamp(City.hit.t / 70, 0, 1) : 1) * 0.7;
    if (sc > best) { best = sc; out.copy(kcA); KC.dir.set(dx, 0, dz); }
  }
  return best > -1e9;
}
// keep the camera out of geometry: pull it toward the subject if something is in between
function springArm(look, pos) {
  kcD.subVectors(pos, look); const L = kcD.length(); if (L < 1e-3) return pos;
  kcD.multiplyScalar(1 / L);
  if (City.raycast(look, kcD, L + 0.3)) {
    const t = City.hit.t - 0.4;
    if (t >= 3.2) { pos.copy(look).addScaledVector(kcD, t); return pos; }
    // too close to a wall: crane up over it instead of jamming the lens into the subject
    for (let k = 1; k <= 6; k++) {
      kcD.subVectors(pos, look); kcD.y += 1.6 * k; const L2 = kcD.length(); kcD.multiplyScalar(1 / L2);
      if (!City.raycast(look, kcD, L2 + 0.3)) { pos.copy(look).addScaledVector(kcD, L2); return pos; }
    }
    pos.copy(look).addScaledVector(kcD, Math.max(1.5, Math.min(L, City.hit.t - 0.4)));
  }
  return pos;
}
function setupKillView(second) {
  Target.centroid(killCentre);
  const fly = kcB.copy(killCentre).addScaledVector(kcS.set(G.hitDir.x, 0, G.hitDir.z).normalize(), 5).add(tmpV2.set(0, 1.2, 0));
  const flyP = new THREE.Vector3().copy(fly);
  const avoid = second ? KC.dir.clone() : null;
  const ok = pickView(killCentre, flyP, G.hitDir, second ? [11, 14, 8] : [6.5, 8.5, 5], second ? [3.5, 5.5, 2.2] : [2.0, 3.2, 1.5], avoid, KC.base);
  if (!ok) { KC.base.copy(killCentre).addScaledVector(G.hitDir, -5).add(tmpV2.set(0, 6, 0)); KC.dir.copy(G.hitDir).negate(); }
  KC.anchor.copy(killCentre); KC.dist = KC.base.distanceTo(killCentre);
  camK.look.copy(killCentre); camK.orbit = 0; camK.init = true;
}
function killCamera(rdt) {
  Target.centroid(killCentre);
  if (!camK.init) { setupKillView(false); KC.cutAt = 2.4; KC.cut = false; }
  if (!KC.cut && G.state === 'killcam' && G.stateT > KC.cutAt) { KC.cut = true; setupKillView(true); Sfx.tick(); KC.since = 0; }
  // occlusion watchdog: if the man stays hidden behind geometry, cut to a fresh clear angle
  KC.since = (KC.since || 0) + rdt;
  {
    const J = Target.joints(), jj = Target.J;
    let blocked = 0;
    for (const p of [J[jj.head], J[jj.pelvis], J[jj.lHa], J[jj.rHa]]) if (p && !clearLine(p, camera.position, -0.4)) blocked++;
    if (blocked >= 2) KC.hidden = (KC.hidden || 0) + rdt; else KC.hidden = 0;
  }
  // hard cut (no static) to a clear angle when he is hidden
  if (KC.hidden > 0.12 && KC.since > 0.5) { setupKillView(true); KC.hidden = 0; KC.since = 0; }
  camK.orbit += rdt * 0.05;
  camK.look.lerp(killCentre, 1 - Math.exp(-6 * rdt));
  // the camera follows the tumbling man part of the way (dolly), then a spring arm keeps it out of walls
  kcA.subVectors(camK.look, KC.anchor).multiplyScalar(0.9);
  KC.pos.copy(KC.base).add(kcA).sub(camK.look).applyAxisAngle(UP, camK.orbit).add(camK.look);
  if (G.state === 'tally') KC.pos.y += Math.min(2.5, G.stateT * 0.6);
  springArm(camK.look, KC.pos);
  camera.position.copy(KC.pos);
  camera.up.copy(UP); camera.lookAt(camK.look);
  const d = camera.position.distanceTo(camK.look);
  if (G.state === 'tally') {
    // slide the subject into the left third so the tally panel (right side) never covers him
    const k = sstep(0, 0.9, G.stateT), asp = Math.max(0.5, camera.aspect || 1);
    camera.getWorldDirection(kcD); kcS.crossVectors(kcD, UP).normalize();
    const tanH = Math.tan(((camera.fov || 40) * DEG) / 2) * asp;
    camera.lookAt(kcA.copy(camK.look).addScaledVector(kcS, 0.55 * d * tanH * k));
  }
  camera.fov = fitFov(clamp(2 * Math.atan(1.7 / Math.max(1, d)) / DEG, 22, 55), 30); camera.near = 0.05; camera.far = 7000;
}
const missLook = new THREE.Vector3();
function missCamera(rdt) {
  if (!camK.init) {
    camK.init = true;
    // focus: where the round struck near him, or (a pass) the point where it came closest to him
    const strikeNear = Target.S.alive && G.lastEv === 'impact' && Target.chest.distanceTo(G.hitPoint) < 60;
    const strikeP = tmpV2.copy(G.hitPoint).addScaledVector(G.hitNormal || UP, 0.5);
    // a close pass (under 40 m) is shown as the measured gap, even if the round then struck something
    if (G.missGap) strikeP.copy(G.missP);
    G.missFocus = (G.missFocus || new THREE.Vector3()).copy(strikeP);
    const near = strikeNear || !!G.missGap;
    // a pass: stand close to the man so he fills the foreground, looking out along the gap
    if (G.missGap) {
      // side-on to the gap, so the man and the point where the round went by are both in frame
      missLook.copy(Target.chest).lerp(strikeP, 0.4);
      const gd = Target.chest.distanceTo(strikeP);
      kcS.subVectors(strikeP, Target.chest).setY(0); if (kcS.lengthSq() < 1e-6) kcS.set(1, 0, 0); kcS.normalize();
      const nx = -kcS.z, nz = kcS.x;
      let okP = false;
      for (const D of [Math.max(8, gd * 0.95), Math.max(11, gd * 1.3), Math.max(6, gd * 0.7)]) {
        for (const h of [5, 7.5, 2.6]) for (const sg of [1, -1]) {
          kcA.copy(missLook); kcA.x += nx * D * sg; kcA.z += nz * D * sg; kcA.y += h;
          if (clearLine(Target.chest, kcA, 0.3) && clearLine(strikeP, kcA, 0.3)) { KC.base.copy(kcA); okP = true; break; }
        }
        if (okP) break;
      }
      if (!okP) {
        // over his shoulder: behind the man, looking out toward where the round went by
        KC.base.subVectors(Target.chest, strikeP).setY(0).normalize().multiplyScalar(7).add(Target.chest); KC.base.y += 2.6;
        springArm(Target.chest, KC.base); okP = KC.base.distanceTo(Target.chest) > 2.5;
      }
      if (okP) { camK.look.copy(missLook); G.missClose = true; return; }
    }
    G.missClose = false;
    if (near) missLook.copy(Target.chest).add(strikeP).multiplyScalar(0.5);
    else missLook.copy(strikeP);
    const span = near ? Target.chest.distanceTo(strikeP) : 0;
    const dist = clamp(13 + span * 0.8, 13, 30);
    // pick a clear vantage beside and behind the round's path so the struck object reads in context
    // near miss: the vantage must see both the man and the strike point
    const ok = near ? (pickView(Target.chest, strikeP, G.hitDir, [dist, dist * 1.3, dist * 0.8], [4, 7, 2.5], null, KC.base) || pickView(missLook, strikeP, G.hitDir, [dist, dist * 1.3], [4, 7], null, KC.base))
      : pickView(missLook, strikeP, G.hitDir, [dist, dist * 1.3, dist * 0.8], [3.5, 6, 2], null, KC.base);
    if (!ok) { KC.base.copy(missLook).addScaledVector(G.hitDir, -dist).add(tmpV2.set(0, 4, 0)); springArm(missLook, KC.base); }
    camK.look.copy(missLook);
  }
  const F = G.missFocus || G.hitPoint;
  const near_ = Target.S.alive && Target.chest.distanceTo(F) < 60;
  if (near_) camK.look.lerp(missLook.copy(Target.chest).lerp(F, G.missClose ? 0.35 : 0.5), 1 - Math.exp(-3 * rdt));
  camera.position.copy(KC.base).addScaledVector(UP, G.stateT * 0.25);
  camera.up.copy(UP); camera.lookAt(camK.look);
  if (G.missClose) {
    // fit both the man and the point the round passed (angle between them seen from the camera)
    kcA.subVectors(Target.chest, camera.position).normalize(); kcB.subVectors(F, camera.position).normalize();
    const span = Math.acos(clamp(kcA.dot(kcB), -1, 1)) / DEG;
    camera.fov = fitFov(clamp(span * 1.45 + 8, 26, 80), 34); camera.near = 0.05; camera.far = 7000;
    return;
  }
  const half = near_ ? Math.max(4, Target.chest.distanceTo(F) * 0.5 + 2.5) : 9;
  camera.fov = fitFov(clamp(2 * Math.atan(half / 0.8 / Math.max(1, camera.position.distanceTo(camK.look))) / DEG, 24, 75), 30); camera.near = 0.05; camera.far = 7000;
}
// Title backdrop: glide at rooftop height toward the downtown towers, so they stand against the sky
const attractK = { seed: -1, fx: 0, fz: -1500, top: 200, pos: new THREE.Vector3(), init: false };
function attractFocus() {
  if (attractK.seed === City.info.seed) return;
  attractK.seed = City.info.seed; attractK.init = false;
  const tall = City.boxes.filter((b) => b.kind === 1 && b.z1 < -300).sort((a, b) => b.y1 - a.y1).slice(0, 4);
  if (!tall.length) return;
  let x = 0, z = 0; for (const b of tall) { x += (b.x0 + b.x1) / 2; z += (b.z0 + b.z1) / 2; }
  attractK.fx = x / tall.length; attractK.fz = z / tall.length; attractK.top = tall[0].y1;
}
function attractCamera(rdt = 1 / 60) {
  attractFocus();
  const t = U.uTime.value, u = 0.5 + 0.5 * Math.sin(t * 0.021);
  const fx = attractK.fx, fz = attractK.fz;
  const want = tmpV.set(fx + 260 * Math.sin(t * 0.037), 105 + 20 * Math.sin(t * 0.029), fz + 1000 - 420 * u);
  // never sit inside a building: rise above anything under the camera
  let floor = 0; City.forBoxesNear(want.x, want.z, 6, (b) => { if (want.x > b.x0 - 4 && want.x < b.x1 + 4 && want.z > b.z0 - 4 && want.z < b.z1 + 4) floor = Math.max(floor, b.y1 + 12); });
  want.y = Math.max(want.y, floor);
  if (!attractK.init) { attractK.pos.copy(want); attractK.init = true; }
  attractK.pos.lerp(want, 1 - Math.exp(-1.5 * rdt));
  camera.position.copy(attractK.pos);
  camera.up.copy(UP); camera.lookAt(fx + 60 * Math.sin(t * 0.05), Math.min(attractK.top * 0.62, 230), fz);
  camera.fov = fitFov(46, 40); camera.near = 0.5; camera.far = 7000;
}

// ---- projections for the HUD ------------------------------------------------
const ndc = new THREE.Vector3();
function project(p, out) {
  ndc.copy(p).project(camera);
  camera.getWorldDirection(fwd);
  const inFront = tmpV2.subVectors(p, camera.position).dot(fwd) > 0;
  out.x = (ndc.x + 1) / 2; out.y = (ndc.y + 1) / 2;
  out.vis = inFront && Math.abs(ndc.x) < 1.05 && Math.abs(ndc.y) < 1.05;
  out.off = !out.vis;
  out.ang = Math.atan2((inFront ? 1 : -1) * ndc.y / camera.aspect, (inFront ? 1 : -1) * ndc.x);
  const d = p.distanceTo(camera.position);
  out.h = 1.8 / (2 * d * Math.tan((camera.fov * DEG) / 2));
  return out;
}
const pip = new THREE.Vector3();
// screen box (0..1, y down) around every joint of the man, padded for the head and hat
function bodyBox(out) {
  camera.getWorldDirection(fwd);
  let x0 = 9, y0 = 9, x1 = -9, y1 = -9, n = 0;
  for (const p of Target.joints()) {
    if (tmpV2.subVectors(p, camera.position).dot(fwd) <= 0.05) continue;
    ndc.copy(p).project(camera);
    const x = (ndc.x + 1) / 2, y = (1 - ndc.y) / 2;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); n++;
  }
  out.vis = n > 0 && x1 > 0 && x0 < 1 && y1 > 0 && y0 < 1;
  if (out.vis) {
    const d = Target.chest.distanceTo(camera.position), m = 0.3 / (2 * Math.max(0.5, d) * Math.tan((camera.fov * DEG) / 2));
    out.x0 = x0 - m / camera.aspect; out.x1 = x1 + m / camera.aspect; out.y0 = y0 - m; out.y1 = y1 + m;
  }
  return out;
}

// ---- update ------------------------------------------------------------------
function updateAim(rdt) {
  const fovR = (40 / G.mag) * DEG;
  const sens = fovR / Math.max(300, innerHeight) * 0.9;
  Aim.yaw -= Input.dx * sens; Aim.pitch -= Input.dy * sens;
  const kr = fovR * 0.55 * rdt;
  if (held('ArrowLeft', 'KeyA')) Aim.yaw += kr; if (held('ArrowRight', 'KeyD')) Aim.yaw -= kr;
  if (held('ArrowUp', 'KeyW')) Aim.pitch += kr; if (held('ArrowDown', 'KeyS')) Aim.pitch -= kr;
  // edge panning when the pointer isn't locked
  if (document.pointerLockElement !== canvas && Input.inside && !Input.touchAim) {
    const ex = Input.mx < 0.04 ? -1 : Input.mx > 0.96 ? 1 : 0, ey = Input.my < 0.05 ? -1 : Input.my > 0.95 ? 1 : 0;
    Aim.yaw -= ex * fovR * 0.5 * rdt; Aim.pitch -= ey * fovR * 0.5 * rdt;
  }
  Aim.yaw = clamp(Aim.yaw, -1.0, 1.0); Aim.pitch = clamp(Aim.pitch, -0.45, 0.2);
  if (Input.wheel || pressed('KeyE', 'KeyQ', 'KeyZ', 'KeyX')) {
    const d = Input.wheel !== 0 ? -Math.sign(Input.wheel) : pressed('KeyE', 'KeyX') ? 1 : -1;
    const ni = clamp(G.magI + d, 0, MAGS.length - 1); if (ni !== G.magI) { G.magI = ni; Sfx.blip(600 + ni * 120, 0.03, 'square', 0.04); }
  }
  G.mag = damp(G.mag, MAGS[G.magI], 10, rdt);
  // breath
  const wantHold = held('ShiftLeft', 'ShiftRight') && G.gasp <= 0 && G.breath > 0;
  G.holding = wantHold;
  if (G.holding) { G.breath -= rdt / 6; Aim.hbT -= rdt; if (Aim.hbT < 0) { Aim.hbT = 0.75; Sfx.heartbeat(0.8); } if (G.breath <= 0) { G.breath = 0; G.gasp = 2.5; G.holding = false; } }
  else { G.breath = Math.min(1, G.breath + rdt / 4.5); }
  if (G.gasp > 0) G.gasp -= rdt;
  aimCamera(rdt);
  camera.updateMatrixWorld();
  camera.getWorldDirection(fwd);
  G.lased = lase(PLAYER.eye, fwd);
  rightV.crossVectors(fwd, UP).normalize();
  G.crossWind = G.wind.dot(rightV);
}

function tick(rdt) {
  U.uTime.value += rdt;
  G.toastT -= rdt; G.flash = Math.max(0, G.flash - rdt * 4); G.staticAmt = Math.max(0, G.staticAmt - rdt * 5);
  if (pressed('KeyP', 'Escape') && G.state !== 'attract') G.paused = !G.paused;
  if (pressed('KeyT')) { G.mode = (G.mode + 1) % MODES.length; G.modeName = MODES[G.mode].name; Store.set('mode', G.mode); toast(`SENSOR ${G.modeName}`); Sfx.blip(1100, 0.04); }
  if (pressed('KeyM')) toast(Sfx.toggleMute() ? 'SOUND OFF' : 'SOUND ON');
  if (G.paused) {
    // click / tap / space also resumes (and is swallowed, so it never fires a round)
    if (pressed('Fire', 'Space', 'Enter')) G.paused = false;
    Input.pressed.clear(); Input.dx = Input.dy = Input.wheel = 0; return;
  }
  G.stateT += rdt;
  G.scoreShown = G.scoreShown < G.score ? Math.min(G.score, G.scoreShown + Math.max(37, (G.score - G.scoreShown) * 4 * rdt)) : G.score;
  let gdt = rdt;
  const fire_ = pressed('Space', 'Enter', 'Fire');
  // attract-mode demo: any key or click hands the game to the player
  if (G.demo) {
    if (fire_ && G.state !== 'attract') { endDemo(); startGame(); Input.pressed.clear(); return; }
    Input.dx = Input.dy = Input.wheel = 0; Input.keys.clear();
    G.toast = 'DEMO PLAY   PRESS SPACE'; G.toastT = 0.2;
  }

  switch (G.state) {
    case 'attract':
      attractCamera(rdt);
      if (fire_) startGame();
      else if (G.stateT > 12 && !TEST) startDemo();
      break;
    case 'brief':
      if (G.demo) demoAim(rdt);
      updateAim(rdt);
      if (G.stateT > 3.2 || (fire_ && G.stateT > 0.6)) setState('aim');
      break;
    case 'aim': {
      if (G.demo) demoAim(rdt);
      updateAim(rdt);
      G.timeLeft -= rdt;
      if (G.demo && G.stateT > 1.6) { fire(); break; }
      if (fire_) { fire(); break; }
      if (G.timeLeft <= 0) {
        G.rounds--; Sfx.deny(); toast('TARGET ESCAPED', 2.5);
        if (G.rounds <= 0) { setState('gameover'); Sfx.gameOver && Sfx.gameOver(); break; }
        Target.spawn(G.stage); G.timeLeft = 60;
      }
      break;
    }
    case 'shot':
      updateAim(rdt);
      gdt = rdt * 0.5;
      if (G.stateT > 0.2) { G.staticAmt = 0.18; G.shake = 1; G.whoosh = 1; Sfx.staticBurst(0.12); Sfx.flightStart(); Sfx.slowDive && Sfx.slowDive(G.baseTS); camK.init = false; setState('flight'); }
      break;
    case 'flight': {
      // steering input: mouse displaces a self-centring stick, keys push it toward the stops
      const kx = (held('ArrowRight', 'KeyD') ? 1 : 0) - (held('ArrowLeft', 'KeyA') ? 1 : 0);
      const ky = (held('ArrowUp', 'KeyW') ? 1 : 0) - (held('ArrowDown', 'KeyS') ? 1 : 0);
      G.stick.x += Input.dx * 0.011; G.stick.y -= Input.dy * 0.011;
      if (kx) G.stick.x = damp(G.stick.x, kx, 6, rdt); if (ky) G.stick.y = damp(G.stick.y, ky, 6, rdt);
      if (!kx && !Input.dx) G.stick.x = damp(G.stick.x, 0, 2.4, rdt);
      if (!ky && !Input.dy) G.stick.y = damp(G.stick.y, 0, 2.4, rdt);
      if (G.stick.length() > 1) G.stick.normalize();
      if (G.auto || G.demo) routeStick(G.stick, 0.75);
      else if (window.__X && window.__X.bot) window.__X.bot(G, rdt);
      const B = Bullet.S;
      const remaining = Target.chest.distanceTo(B.p);
      const sp = Math.max(1, B.v.length());
      tmpV.subVectors(Target.chest, B.p); const along = tmpV.dot(B.v) / sp;
      // while it is still braking, count with the cruise speed it is settling to (so the readout only counts down)
      G.tti = Math.max(0, along) / Math.min(sp, Math.max(1, B.vc)); G.ttiReal = G.tti / Math.max(0.05, G.baseTS);
      // time scale: the first moment runs at full speed (the supersonic dash out of the barrel), then time
      // eases down into slow motion over about half a second (the slow-down sound follows the same curve),
      // with an extra slow-down in the last moments before impact
      const ramp = sstep(0.3, 0.85, G.stateT);
      // the braking beat: a scan-line ripple and a stamp as the fins come out and steering goes live
      if (!G.braked && G.stateT > 0.3) { G.braked = true; G.staticAmt = Math.max(G.staticAmt, 0.14); G.stampT = 0.9; }
      const term = lerp(0.45, 1, sstep(0.02, 0.35, G.tti));
      G.timeScale = lerp(1, G.baseTS, ramp) * term;
      if (along < -2) { if (G.passedT < 0) G.passedT = G.stateT; G.timeScale = G.baseTS * 2; }
      gdt = rdt * G.timeScale;
      let ev = Bullet.step(gdt, G.stick);
      // the round has flown past the man (or the flight is dragging on): end it as a miss, never soft-lock
      if (!ev && ((G.passedT >= 0 && G.stateT - G.passedT > 0.5) || G.stateT > 25)) ev = Bullet.abort();
      G.tgtRange = remaining;
      Sfx.flightUpdate(Math.min(1.2, sp / Math.max(1, B.vc)), G.timeScale, clamp(1 - remaining / 120, 0, 1));
      if (ev) { onBulletEvent(ev); gdt = rdt * 0.1; break; }
      // seeker lock announcement
      if (!G.locked && B.lock >= 1) { G.locked = true; Sfx.lock(); G.lockT = 1.0; }
      G.lockT = Math.max(0, (G.lockT || 0) - rdt); G.stampT = Math.max(0, (G.stampT || 0) - rdt);
      nearMissCheck(rdt);
      chaseCamera(rdt);
      break;
    }
    case 'killcam': {
      // impact freeze, long slow-motion hang, then ramp back to real time
      G.timeScale = G.stateT < 0.1 ? 0.03 : lerp(0.2, 1, sstep(0.35, 2.4, G.stateT));
      if (G.stateT > (Bullet.S.bend > 4 * DEG ? 2.2 : 0.5) && !G.trailCleared) { Bullet.clearTrail(); G.trailCleared = true; }
      gdt = rdt * G.timeScale;
      killCamera(rdt);
      if (G.demo && G.stateT > 4.2) { endDemo(); break; }
      G.restT = Target.S.settled ? (G.restT || 0) + rdt : 0;
      if (G.stateT > 5.6 || (G.restT > 0.7 && G.stateT > 2.2) || (fire_ && G.stateT > 1.2)) { setState('tally'); G.tallyTick = 0; G.restT = 0; }
      break;
    }
    case 'misscam':
      G.timeScale = lerp(0.15, 1, sstep(0, 1.6, G.stateT)); gdt = rdt * G.timeScale;
      missCamera(rdt);
      if (G.demo && G.stateT > 2.4) { endDemo(); break; }
      if (G.stateT > 2.4 || (fire_ && G.stateT > 0.8)) {
        Bullet.clearTrail();
        if (G.rounds <= 0) { setState('gameover'); Sfx.gameOver && Sfx.gameOver(); } else { G.staticAmt = 0.4; Sfx.staticBurst(0.15); setState('aim'); }
      }
      break;
    case 'tally': {
      killCamera(rdt);
      const row = Math.floor((G.stateT - 0.5) / (G.tallyStep || 0.45));
      if (row >= 0 && row <= G.tallyRows.length && row >= (G.tallyTick || 0)) { G.tallyTick = row + 1; if (row === G.tallyRows.length && Sfx.bonus) Sfx.bonus(); else Sfx.tick(); }
      if ((fire_ && G.stateT > 1.0) || G.stateT > 7) { G.stage++; G.staticAmt = 1; Sfx.staticBurst(0.2); newStage(); }
      break;
    }
    case 'gameover':
      aimCamera(rdt);
      if (G.stateT > 1.5 && (fire_ || G.stateT > 8)) {
        const rank = G.table.findIndex((e) => G.score > e.s);
        if (G.score > 0 && (rank >= 0 || G.table.length < 5)) { G.initials = ['A', 'A', 'A']; G.initialPos = 0; setState('initials'); }
        else setState('attract');
      }
      break;
    case 'initials': {
      aimCamera(rdt);
      const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
      const i = A.indexOf(G.initials[G.initialPos]);
      if (pressed('ArrowUp', 'KeyW') || Input.wheel < 0) { G.initials[G.initialPos] = A[(i + 1) % A.length]; Sfx.tick(); }
      else if (pressed('ArrowDown', 'KeyS') || Input.wheel > 0) { G.initials[G.initialPos] = A[(i - 1 + A.length) % A.length]; Sfx.tick(); }
      if (pressed('ArrowLeft') && G.initialPos > 0) G.initialPos--;
      if (fire_ || pressed('ArrowRight')) {
        Sfx.blip(1200, 0.05);
        if (G.initialPos < 2) G.initialPos++;
        else if (fire_) {
          G.table.push({ n: G.initials.join(''), s: G.score }); G.table.sort((a, b) => b.s - a.s); G.table = G.table.slice(0, 5);
          Store.set('table', G.table); G.hi = G.table[0].s; setState('attract');
        }
      }
      break;
    }
  }
  // ragdoll contact sounds (rising edge of contact, throttled)
  if (Target.S.ragdoll && !Target.S.settled) {
    G.thudCool = (G.thudCool || 0) - rdt;
    if (Target.S.anyContact && !G.wasContact && G.thudCool <= 0) {
      G.thudCool = 0.12; const c = Target.centroid(tmpV2);
      Sfx.bodyThud && Sfx.bodyThud(0.7); FX.dust && FX.dust(c, 0.6);
    }
    G.wasContact = Target.S.anyContact;
    if (Target.S.hatRest && !G.hatLanded) { G.hatLanded = true; Sfx.hatLand && Sfx.hatLand(); }
  } else { G.wasContact = false; G.hatLanded = false; }
  // world simulation (slow motion aware)
  tgtPrev.copy(Target.chest);
  Target.update(gdt);
  if (gdt > 1e-5 && Target.S.alive) G.tgtVel.subVectors(Target.chest, tgtPrev).multiplyScalar(1 / gdt).clampLength(0, 8);
  else if (!Target.S.alive) G.tgtVel.set(0, 0, 0);
  City.updateTraffic(gdt);
  FX.update(gdt, camera.position);
  Bullet.updateVisual(gdt, camera);

  // HUD projections
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  project(Target.chest, G.tgtScreen);
  if (G.state === 'killcam' || G.state === 'misscam') bodyBox(G.bodyBox); else G.bodyBox.vis = false;
  if (G.state === 'flight' && Bullet.S.active) {
    project(Bullet.S.p, G.roundScreen); for (let i = 0; i < PATH_N; i++) project(G.pathPts[i], G.pathScreen[i]);
    if (G.pathBlock >= 0) project(G.pathBlockP, G.blockScreen); else G.blockScreen.vis = false;
  } else { for (const p of G.pathScreen) p.vis = false; G.roundScreen.vis = false; G.blockScreen.vis = false; }
  if (G.state === 'misscam' && G.missGap) { project(Target.chest, G.missA); project(G.missP, G.missB); } else G.missA.vis = G.missB.vis = false;
  if (G.state === 'flight') coverBox(G.coverScreen); else G.coverScreen.vis = false;
  // on-screen hint (early stages): which side of his cover is open
  G.coverBlocked = G.state === 'flight' && Bullet.S.active && Target.S.alive && !clearLine(Bullet.S.p, Target.chest, -0.6);
  G.coverSide = Target.S.app ? Target.S.app.side : '';
  updatePipper(rdt);

  Input.pressed.clear(); Input.dx = Input.dy = Input.wheel = 0;
}

// Predicted-impact pipper as the player sees it: only after seeker lock, with sensor noise (metres at the
// target plane, so it is the same size at every range) and a display lag. The steering physics never use it.
const pipRaw = new THREE.Vector3(), tgtPrev = new THREE.Vector3();
G.tgtVel = new THREE.Vector3(); G.pipW = new THREE.Vector3(); G.lock = 0; G.whoosh = 0; G.nearMisses = 0;
function updatePipper(rdt) {
  const B = Bullet.S;
  G.lock = G.state === 'flight' && B.active ? B.lock : 0;
  if (G.state !== 'flight' || !B.active || B.lock < 1) { G.pipScreen.vis = false; G.pipInit = false; return; }
  Bullet.predict(Target.chest, pipRaw);
  const { r, u } = Bullet.frame();
  pipRaw.addScaledVector(r, B.pipErr.x).addScaledVector(u, B.pipErr.y);
  if (!G.pipInit) { G.pipW.copy(pipRaw); G.pipInit = true; }
  G.pipW.lerp(pipRaw, 1 - Math.exp(-rdt / Math.max(0.02, G.diff.pipLag || 0.08)));
  project(G.pipW, G.pipScreen);
}

// Near misses: the round threads past a structure within a few metres -> whoosh, camera kick, bonus
const NM_DIRS = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
function nearMissCheck(rdt) {
  G.nearCool = (G.nearCool || 0) - rdt; G.whoosh = Math.max(0, G.whoosh - rdt * 2.5);
  // skip the shooter's own rooftop and the final approach over the target's roof (that would trigger every time)
  if (G.nearCool > 0 || Bullet.S.travelled < 35 || G.tgtRange < 45) return;
  const { r, u } = Bullet.frame();
  NM_DIRS[0].copy(r); NM_DIRS[1].copy(r).negate(); NM_DIRS[2].copy(u); NM_DIRS[3].copy(u).negate();
  let dmin = 1e9;
  for (const d of NM_DIRS) if (City.raycast(Bullet.S.p, d, 4) && City.hit.id !== -2) dmin = Math.min(dmin, City.hit.t);
  if (dmin < 3.2) {
    G.nearCool = 0.6; G.whoosh = 1; G.shake = Math.max(G.shake, 0.8); G.nearMisses = Math.min(5, G.nearMisses + 1);
    if (Sfx.whoosh) Sfx.whoosh(1 - dmin / 3.2); else Sfx.staticBurst(0.06);
    toast('CLOSE CALL', 0.6);
  }
}

// ---- attract-mode demo: the autopilot plays a stage ----------------------------
function startDemo() {
  G.demoSave = { score: G.score, stage: G.stage };
  G.demo = true; G.score = G.scoreShown = 0; G.stage = 1 + Math.floor(grnd(0, 4)); G.rounds = G.maxRounds = 5;
  newStage(); G.staticAmt = 0.6;
}
function endDemo() {
  G.demo = false; G.auto = false;
  if (G.demoSave) { G.score = G.scoreShown = G.demoSave.score; G.stage = G.demoSave.stage; }
  Bullet.abort(); Bullet.hideRound(); Bullet.clearTrail(); Sfx.flightStop(); Target.hide(); FX.clear();
  G.toastT = 0; G.staticAmt = 0.6; setState('attract');
}
function demoAim(rdt) {
  const t = Target.chest; const dx = t.x - PLAYER.eye.x, dy = t.y - PLAYER.eye.y, dz = t.z - PLAYER.eye.z;
  const wy = Math.atan2(-dx, -dz), wp = Math.atan2(dy, Math.hypot(dx, dz));
  Aim.yaw = damp(Aim.yaw, wy, 2.6, rdt); Aim.pitch = damp(Aim.pitch, wp, 2.6, rdt);
  if (G.stateT > 0.8 && G.magI < 4 && Math.floor(G.stateT * 3) !== Math.floor((G.stateT - rdt) * 3)) G.magI++;
}

// ---- render -------------------------------------------------------------------
function render() {
  const scopeOn = ['brief', 'aim', 'shot', 'gameover', 'initials'].includes(G.state) ? 1 : 0;
  G.scopeAmt = scopeOn;
  const d = Post.display.uniforms, s = Post.sensor.uniforms;
  d.uMode.value = G.mode; d.uScope.value = G.scopeAmt; d.uScopeR.value = G.scopeR; d.uFlash.value = G.flash * 0.6;
  d.uStatic.value = G.staticAmt; d.uFade.value = G.fade;
  s.uPersist.value = G.state === 'flight' ? 0.08 : MODES[G.mode].persist;
  s.uNoise.value = G.mode === 2 ? 0.03 : 0.024;
  U.uCam.value.copy(camera.position);
  City.sky.position.copy(camera.position);
  const pxScale = (innerHeight * Post.pr) / (2 * Math.tan((camera.fov * DEG) / 2));
  FX.setScale(pxScale); City.setPointScale(pxScale);
  // body-heat glow (scope and flight only), about 2 % of the screen tall, never smaller than him
  const glowOn = Target.S.alive && Target.group.visible && (G.state === 'aim' || G.state === 'brief' || G.state === 'shot' || G.state === 'flight');
  manGlow.visible = glowOn;
  if (glowOn) {
    const dg = Math.max(1, camera.position.distanceTo(Target.chest));
    const sz = Math.max(2.4, dg * 2 * Math.tan(camera.fov * DEG / 2) * 0.022);
    manGlow.position.copy(Target.chest); manGlow.position.y += 0.1; manGlow.quaternion.copy(camera.quaternion); manGlow.scale.set(sz, sz, 1);
    // only while he is small on screen (a magnified view already shows him plainly)
    const hFrac = 1.8 / (2 * dg * Math.tan(camera.fov * DEG / 2));
    manGlow.material.uniforms.uHeat.value = 0.3 * clamp((dg - 25) / 60, 0, 1) * clamp((0.065 - hFrac) / 0.04, 0, 1);
  }
  Hud.draw(G);
  const ir = G.state === 'flight' && Bullet.S.active && Target.S.alive && Hud.insetRect;
  if (ir) {
    const c = Target.chest, d = Bullet.S.p.distanceTo(c), dc = Math.min(d, 80);
    seekCam.position.copy(Bullet.S.p).sub(c).normalize().multiplyScalar(dc).add(c);
    seekCam.up.copy(UP); seekCam.lookAt(c.x, c.y - 0.15, c.z);
    seekCam.fov = clamp(2 * Math.atan(2.9 / Math.max(1, dc)) / DEG, 2.5, 55); seekCam.aspect = (ir.x1 - ir.x0) / (ir.y1 - ir.y0);
    seekCam.near = Math.min(0.5, dc * 0.1); seekCam.updateProjectionMatrix(); seekCam.updateMatrixWorld();
    const gv = manGlow.visible; manGlow.visible = false; Post.renderInset(scene, seekCam, ir); manGlow.visible = gv;
  } else Post.renderInset(null);
  Post.render(scene, camera, Hud.tex);
}

function onResize() {
  Post.resize(innerWidth, innerHeight);
  Hud.resize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
onResize();

// ---- boot -------------------------------------------------------------------
City.generate(newSeed());
Target.spawn(1); Target.hide();
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const rdt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
  tick(rdt); render(); Post.adapt(rdt);
}
const fontsReady = (document.fonts && document.fonts.load) ? Promise.all([document.fonts.load('20px "Press Start 2P"'), document.fonts.load('20px "VT323"')]).catch(() => {}) : Promise.resolve();
if (!TEST) fontsReady.then(() => requestAnimationFrame(loop));

// ---- test / debug hooks --------------------------------------------------------
window.__X = {
  G, Aim, City, Target, Bullet, Post, Hud, FX, Sfx, scene, renderer, camera, fontsReady,
  advance(sec, step = 1 / 60, draw = true) { const n = Math.max(1, Math.round(sec / step)); for (let i = 0; i < n; i++) tick(step); if (draw) render(); },
  key(code) { Input.pressed.add(code); },
  start() { startGame(); },
  aimAtTarget(lead = 0) {
    const t = Target.chest; const dx = t.x - PLAYER.eye.x, dy = t.y - PLAYER.eye.y, dz = t.z - PLAYER.eye.z;
    Aim.yaw = Math.atan2(-dx, -dz) + lead; Aim.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  },
  setMag(i) { G.magI = i; G.mag = MAGS[i]; },
  fire() { fire(); },
  // headless simulation without rendering (difficulty probes)
  sim(sec, step = 1 / 60) { const n = Math.max(1, Math.round(sec / step)); for (let i = 0; i < n; i++) tick(step); },
  startAt(stage) { G.score = 0; G.rounds = G.maxRounds = 5; G.stage = stage; newStage(); setState('aim'); },
  demo() { startDemo(); }, endDemo() { endDemo(); }, difficulty,
  bot: null, routeStick(stick, gain, look) { return routeStick(stick || G.stick, gain, look); }, planOk() { return PLAN.ok; },
  setState, setMode(m) { G.mode = m; G.modeName = MODES[m].name; },
};
