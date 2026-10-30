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
scene.add(City.group, Target.group, Bullet.root, FX.points, Mortar.group);
const camera = new THREE.PerspectiveCamera(40, 1, 1, 7000);
camera.rotation.order = 'YXZ';

const MODES = [{ name: 'WHITE HOT', persist: 0.1 }, { name: 'BLACK HOT', persist: 0.1 }, { name: 'NIGHT VISION', persist: 0.35 }];
const MAGS = [4, 6, 8, 12, 16, 24, 32];
const SCOPE_MAG_I = 0;   // the scope stays at 4x (wide enough to read the streets around him)
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


// ---- input -----------------------------------------------------------------
const Input = { keys: new Set(), dx: 0, dy: 0, wheel: 0, mx: 0.5, my: 0.5, inside: false, pressed: new Set(), touchAim: null, tap: null };
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
// Touch: on-screen buttons first (fire, pause, and the pause screen's sensor / sound / resume, laid out by the
// HUD in Hud.buttons); a drag anywhere else aims the scope, or moves the marker in flight; a quick tap in
// flight locks the round onto him when it lands on him, otherwise it puts the marker under the finger.
// On the between-shot screens any tap continues.
const TAP_MS = 280, TAP_PX = 14;
function touchButton(nx, ny) {
  const b = Hud.buttons;
  for (let i = b.length - 1; i >= 0; i--) { const r = b[i]; if (nx >= r.x0 && nx <= r.x1 && ny >= r.y0 && ny <= r.y1) return r.code; }
  return null;
}
let fullTried = false;
function goFull() {
  // phones: try for full screen and landscape on the first tap (refused inside some hosts; that's fine)
  if (fullTried || !MOBILE) return; fullTried = true;
  const el = document.documentElement, rq = el.requestFullscreen || el.webkitRequestFullscreen;
  try {
    const p = rq && rq.call(el, { navigationUI: 'hide' });
    if (p && p.then) p.then(() => { try { const q = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'); if (q && q.catch) q.catch(() => {}); } catch (err) { /* not supported */ } }).catch(() => {});
  } catch (err) { /* not allowed here */ }
}
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault(); Sfx.init(); Hud.setTouch(); goFull();
  if (G.state === 'initials') {
    // touch initials: tap the upper third / lower third to change the letter, the middle to confirm
    const y = e.changedTouches[0].clientY / innerHeight;
    Input.pressed.add(y < 0.38 ? 'ArrowUp' : y > 0.72 ? 'ArrowDown' : 'Fire');
    return;
  }
  const skip = G.paused || G.demo || G.state === 'attract' || G.state === 'tally' || G.state === 'gameover' || G.state === 'killcam' || G.state === 'misscam';
  for (const t of e.changedTouches) {
    const code = touchButton(t.clientX / innerWidth, t.clientY / innerHeight);
    if (code) { Input.pressed.add(code); continue; }
    if (skip) { Input.pressed.add('Fire'); continue; }
    if (!Input.touchAim) Input.touchAim = { id: t.identifier, x: t.clientX, y: t.clientY, x0: t.clientX, y0: t.clientY, t0: performance.now() };
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) if (Input.touchAim && t.identifier === Input.touchAim.id) { Input.dx += (t.clientX - Input.touchAim.x) * 1.6; Input.dy += (t.clientY - Input.touchAim.y) * 1.6; Input.touchAim.x = t.clientX; Input.touchAim.y = t.clientY; }
}, { passive: false });
function touchEnd(e) {
  Sfx.init();   // iOS unlocks audio on touchend
  for (const t of e.changedTouches) {
    const a = Input.touchAim;
    if (!a || t.identifier !== a.id) continue;
    if (e.type === 'touchend' && performance.now() - a.t0 < TAP_MS && Math.hypot(t.clientX - a.x0, t.clientY - a.y0) < TAP_PX) Input.tap = { x: t.clientX / innerWidth, y: t.clientY / innerHeight };
    Input.touchAim = null;
  }
}
canvas.addEventListener('touchend', touchEnd);
canvas.addEventListener('touchcancel', touchEnd);
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
    roll: Math.min(0.16, 0.03 + 0.016 * s), budget: Math.max(300, 440 - 15 * s), aMax: Math.max(130, 160 - 3 * s), tau: Math.min(0.15, 0.08 + 0.008 * s),
    // close in the round slows to vMin (turning circle vMin^2 / aMax: ~5 m at stage 1, ~9 m by stage 8)
    vc: Math.min(155, 130 + 3 * s), vMin: Math.min(38, 28 + 1.3 * s), slowNear: 60, slowFar: 260, windK: 1, bleed: 0.1,
    lockF: Math.min(0.2, 0.06 + 0.02 * s), seeker: Math.min(0.22, 0.04 + 0.025 * s), pipLag: Math.min(0.16, 0.05 + 0.015 * s),
    basket: Math.max(1.0, 2.2 - 0.12 * s), homeT: 0.4,
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
  // fire mission (every fifth stage): three technicals for the mortar instead of the usual target
  G.mission = FIRE_MISSION && !G.demo && G.stage % 5 === 0 && G.stage !== 10;   // (stage 10 is the helicopter)
  Mortar.clear();
  if (G.mission) { Target.hide(); Mortar.setup(); } else Target.spawn(G.stage);
  planHidden();
  // start looking roughly down the avenue, toward the target's side
  const tc = G.mission ? Mortar.center() : Target.chest;
  Aim.yaw = clamp(Math.atan2(-(tc.x - PLAYER.eye.x), -(tc.z - PLAYER.eye.z)) * 0.4, -0.5, 0.5);
  Aim.pitch = -0.035; G.magI = SCOPE_MAG_I; G.mag = MAGS[SCOPE_MAG_I];
  if (G.stage <= 1 || G.mission) {
    // the first target (and a fire mission's trucks): the scope starts just off him, in view from the first frame
    const dx = tc.x - PLAYER.eye.x, dy = tc.y - PLAYER.eye.y, dz = tc.z - PLAYER.eye.z;
    Aim.yaw = Math.atan2(-dx, -dz) + grnd(-1, 1) * 0.9 * DEG; Aim.pitch = Math.atan2(dy, Math.hypot(dx, dz)) + grnd(-1, 1) * 0.6 * DEG;
  }
  G.timeLeft = 60; G.breath = 1; G.gasp = 0;
  setState('brief');
  Sfx.windLevel && Sfx.windLevel(G.wind.length());
  if (!G.demo) Sfx.stageStart && Sfx.stageStart();
  return info;
}
// ?stage=N in the link starts a new game at stage N (handy for trying the fire mission: ?stage=5)
const START_STAGE = Math.max(1, Math.min(99, parseInt(QS.get('stage') || '1', 10) || 1));
function startGame() {
  G.score = 0; G.scoreShown = 0; G.stage = START_STAGE; G.rounds = G.maxRounds = 5; Sfx.coin();
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
  // a machine (it may be on the move): the way in, and the planned route, start from where it is now
  if (Target.S.type !== 'man' && Target.S.alive) { Target.refreshSpot(); planHidden(); }
  camera.getWorldDirection(fwd);
  const origin = tmpV.copy(PLAYER.eye).add(new THREE.Vector3(0, -0.06, 0));
  const range = G.lased > 0 ? G.lased : 1000;
  const dir = new THREE.Vector3();
  Bullet.solveLaunch(origin, fwd, range, dir);
  // the round leaves exactly along the scope's line. The steering marker starts on that line at his range
  // (so the round holds the course you aimed), or locked on him when the reticle was on him.
  G.lofted = 0;
  { const toM = tmpV2.subVectors(Target.chest, origin), along = toM.dot(dir), dM = Math.max(30, toM.length());
    const lat = Math.sqrt(Math.max(0, toM.lengthSq() - along * along));
    G.fireLock = Target.S.alive && along > 0 && lat < 1.6;
    G.fireAim = (G.fireAim || new THREE.Vector3()).copy(origin).addScaledVector(dir, dM); }
  const dTarget = Target.chest.distanceTo(PLAYER.eye);
  // flight time: a short supersonic dash while the fins brake it, then cruise
  // a supersonic dash (dash s at full speed), then the fins brake it to cruise
  const vc = G.diff.vc, dash = 0.1, brakeT = 0.3, brakeD = PHYS.v0 * dash + vc * brakeT + (PHYS.v0 - vc) * 0.09;
  const tof = dash + brakeT + Math.max(0, dTarget - brakeD) / vc;
  // slow motion: after the first fast moment the cruise runs at about half speed; as the round sheds speed
  // near the man the clock speeds back up toward real time (flightTimeScale), so the slow part never drags
  G.baseTS = clamp(tof / (3.4 + dTarget * 0.003), 0.35, 0.8);
  G.tof = tof;
  Bullet.fire(origin, dir, {
    aMax: G.diff.aMax, tau: G.diff.tau, budget: G.diff.budget, wind: G.wind, gust: G.diff.gust, turb: G.diff.turb, roll: G.diff.roll,
    lockT: Math.max(0.05, G.diff.lockF * tof), seeker: G.diff.seeker, basket: G.diff.basket, homeT: G.diff.homeT,
    vc, vMin: G.diff.vMin, slowNear: G.diff.slowNear, slowFar: G.diff.slowFar, brakeT, dash, windK: G.diff.windK, bleed: G.diff.bleed, ricochets: 3,
  });
  // once he has been missed he hears every shot after it (sound takes its time to reach him) and runs or ducks
  if (Target.S.alive && Target.S.wary > 0) Target.alert(0.3 + Target.S.dist / 343);
  FX.muzzle(origin.clone().addScaledVector(dir, 1.4), dir);
  Sfx.shot(); G.flash = 0.9; Aim.recoilV = 0.9;
  G.stick.set(0, 0); G.nearMisses = 0; G.nearCool = 0; G.shake = 0; G.passedT = -1; G.locked = false;
  camK.init = false; PLAN.ok = false; PLAN.tried = false; G.braked = false; G.tLock = false; G.stampT = 0; G.stampText = 'GUIDANCE ACTIVE'; G.ricoT = 0; G.pathReset = true; G.recede = 0; G.aimSpent = false; RP.u = 0; G.losK = 0;
  setState('shot');
}
function scoreHit(ev) {
  const range = Bullet.S.origin.distanceTo(ev.point);
  const ctrl = Bullet.S.budget / Bullet.S.budget0;
  const centre = ev.centre;
  G.lastHit = { range, centre, part: ev.part };
  G.tallyRows = [
    [`RANGE ${Math.round(range)} M`, Math.round(range * 2)],
    ev.part === 'car' ? ['TECHNICAL DESTROYED', 600] : ev.part === 'quad' ? ['DRONE DOWN', 600] : ev.part === 'heli' ? ['HELICOPTER DOWN', 1000] : [ev.part === 'head' ? 'HAT TRICK' : centre < 0.15 ? 'CENTER MASS' : 'OFF CENTER', ev.part === 'head' ? 700 : centre < 0.15 ? 500 : 100],
    [`CONTROL RESERVE ${Math.round(ctrl * 100)}%`, Math.round(ctrl * 800)],
  ];
  const bendDeg = Bullet.S.bend / DEG;
  if (bendDeg >= 3) G.tallyRows.push([`CURVE SHOT ${Math.round(bendDeg)} DEG`, Math.round(Math.min(bendDeg, 180)) * 12]);
  if (Target.S.spot) { const k = Target.S.spot.kind; if (k !== 'highway') G.tallyRows.push(k === 'awning' ? ['UNDER COVER', 1200] : k === 'ledge' ? ['ON THE LEDGE', 1200] : k === 'heli' ? (Target.S.spot.air ? ['AIRBORNE', 1500] : ['ON THE PAD', 800]) : ['BLIND SHOT', 800]); }
  else if (!clearLine(Bullet.S.origin, ev.point, -0.6)) G.tallyRows.push(['AROUND COVER', 600]);
  { const nr = 3 - Bullet.S.ricochets; if (nr > 0) G.tallyRows.push([nr > 1 ? `RICOCHET KILL X${nr}` : 'RICOCHET KILL', 1000 * nr]); }
  { const agl = Math.round(Target.S.root.y); if (agl >= 75) G.tallyRows.push([`HIGH RISE ${agl} M`, agl * 5]); }
  if (Target.S.wary > 0) G.tallyRows.push(['ALERTED TARGET', 500]);
  if (Target.S.type !== 'man' && G.tgtVel.length() > 1) G.tallyRows.push(['MOVING TARGET', 400]);
  if (Target.S.char === 'pack') G.tallyRows.push(['BACKPACK BLAST', 800]);
  if (G.nearMisses > 0) G.tallyRows.push([`CLOSE CALLS X${G.nearMisses}`, 150 * G.nearMisses]);
  G.tallyRows.push([`STAGE ${G.stage} BONUS`, 250 * G.stage]);
  G.tallyStep = G.tallyRows.length > 5 ? 0.3 : 0.45;
  G.score += G.tallyRows.reduce((a, r) => a + r[1], 0);
}
// the big pack (or a car, k > 1) goes up: a fireball, smoke, sparks, a blast that shatters nearby glass and
// shakes the camera
function packBlast(k = 1, at = null) {
  const c = tmpV2.copy(at || Target.chest); if (!at) Target.S.packGone = true;
  for (let i = 0; i < 44 * k; i++) {
    const a = Math.random() * TAU, e = Math.random() * 1.3 - 0.3, sp = (3 + Math.random() * 9) * Math.sqrt(k);
    FX.spawn(c.x, c.y, c.z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 2, Math.sin(a) * Math.cos(e) * sp, 0.5 + Math.random() * 0.7, 0.5, 2.2 + Math.random(), 1.15, 1.6, 3, 0);
  }
  for (let i = 0; i < 26 * k; i++) {
    const a = Math.random() * TAU, sp = 1 + Math.random() * 3;
    FX.spawn(c.x, c.y, c.z, Math.cos(a) * sp, 1 + Math.random() * 2, Math.sin(a) * sp, 2 + Math.random() * 1.6, 1.0, 4 + Math.random() * 2, 0.32, 1.2, 1.5, 0);
  }
  FX.sparks(c, UP, 70 * k, 40);
  City.breakGlassNear(c, 9 * k);
  Sfx.boom && Sfx.boom(); G.boomT = k > 1 ? 1.4 : 1.0;
}
function onBulletEvent(ev) {
  Sfx.flightStop(); G.lastEv = ev.type; G.whoosh = 0; G.toastT = 0;   // flight call-outs never overlap the result banner
  G.hitPoint.copy(ev.point); G.hitDir.copy(Bullet.S.v);
  if (G.hitDir.lengthSq() < 1e-6) G.hitDir.set(0, 0, -1); G.hitDir.normalize();
  camK.init = false;
  if (ev.type === 'hit') {
    const car = Target.S.type === 'car' || Target.S.type === 'heli', quad = Target.S.type === 'quad', blast = Target.S.type === 'man' && Target.S.char === 'pack';
    if (blast) packBlast(); else if (car) packBlast(2); else if (quad) packBlast(0.6);
    Target.launch(ev.point, G.hitDir, ev.part, blast ? 1.7 : 1);
    Sfx.hit(); G.flash = blast || car ? 1 : quad ? 0.6 : 0.35;
    Target.refreshSpot();   // a machine: the kill camera's fixed view is worked out from where it was hit
    G.rounds = G.maxRounds; // every kill refills the magazine
    scoreHit(ev);
    Bullet.hideRound();
    G.trailCleared = false; setState('killcam');
  } else {
    if (ev.type === 'impact') G.hitNormal = (G.hitNormal || new THREE.Vector3()).set(ev.normal.x, ev.normal.y, ev.normal.z);
    if (ev.type === 'impact') { FX.sparks(ev.point, tmpV.set(ev.normal.x, ev.normal.y, ev.normal.z), 45, 35); Sfx.impactThud(); }
    Sfx.miss();
    const md = Bullet.S.minDist;
    G.missP.copy(Bullet.S.closeP); G.missGap = Target.S.alive && md < 40 && md > 0.3;
    G.lastMiss = md < 50 ? `MISSED BY ${md.toFixed(1)} M` : ev.type === 'lost' ? 'ROUND LOST' : ev.kind === 7 ? 'TREE STRIKE' : ev.kind === 4 ? 'WIRE STRIKE' : ev.kind === 3 ? 'WATER TOWER' : ev.kind === 2 ? 'ROOF EQUIPMENT' : 'HIT STRUCTURE';
    if (Target.S.alive) { Target.S.wary = (Target.S.wary || 0) + 1; Target.evade(); }   // missed: he is on to you now
    Bullet.hideRound();
    setState('misscam');
  }
}

// ---- cameras ---------------------------------------------------------------
const camK = { off: new THREE.Vector3(), look: new THREE.Vector3(), init: false, orbit: 0, roll: 0 };
function aimCamera(rdt) {
  // the scope holds steady (no breathing sway); only the recoil kick moves it
  Aim.sx = Aim.sy = 0; Aim.vx = Aim.vy = 0;
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
const PATH_N = 18, PATH_SEC = 1.2, PATH_PW = 1.4; G.pathBlockP = new THREE.Vector3(); G.blockScreen = { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 }; G.missA = { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 }; G.missB = { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 }; G.missP = new THREE.Vector3();
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
} G.pathPts = Array.from({ length: PATH_N }, () => new THREE.Vector3()); G.pathRel = Array.from({ length: PATH_N }, () => new THREE.Vector3()); G.pathDraw = Array.from({ length: PATH_N }, () => new THREE.Vector3()); G.bounceK = -1; G.pathScreen = Array.from({ length: PATH_N }, () => ({ vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 })); G.roundScreen = { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 };
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
const routeT = new THREE.Vector3(), TL1 = new THREE.Vector3(), TL2 = new THREE.Vector3();
// ---- pointing steer (STEER_MODE 'point'): the player moves an aim marker anchored in the world; the round
// turns its velocity toward it (faster the closer it gets), within its own limits (turn rate, lag, budget).
// Placing the marker on the man locks it to him, and it then follows him with a little lead.
const POINT = STEER_MODE === 'point';
G.aimP = new THREE.Vector3(); G.aimTgt = new THREE.Vector3(); G.aimLock = true; G.aimArmed = true; G.aimScreen = { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 };
const aimF = new THREE.Vector3(), aimR = new THREE.Vector3(), aimU = new THREE.Vector3(), aimE = new THREE.Vector3(), aimS1 = { vis: false, x: 0, y: 0, h: 0, ang: 0, off: false }, aimS2 = { vis: false, x: 0, y: 0, h: 0, ang: 0, off: false };
// A marker left off him is a waypoint. When the round is about to reach it (or has gone by): if it can see
// him from there the marker drops back onto him by itself, so the round curves past the waypoint and on
// into him; if it can't, the waypoint is used up and the round holds its heading until the marker moves.
function aimReached(p, v, w) {
  const sp = v.length() || 1; aimE.subVectors(w, p);
  return aimE.length() < Math.max(8, sp * 0.3) || aimE.dot(v) < 0;
}
let pvSnap = 0;
function previewSteer(p, v, out) {
  if (G.aimSpent && !G.aimLock) return out.set(0, 0);
  if (!pvSnap && !G.aimLock && aimReached(p, v, G.aimP)) pvSnap = Target.S.alive && clearLine(p, Target.chest, 0.3, true) ? 1 : 2;
  if (pvSnap === 2) return out.set(0, 0);
  return pointSteerAt(p, v, out, pvSnap ? G.aimLead : G.aimTgt);
}
G.aimLead = new THREE.Vector3();
function pointSteerAt(p, v, out, goal = G.aimTgt) {
  if (G.aimSpent && !G.aimLock && goal === G.aimTgt) return out.set(0, 0);
  const sp = v.length() || 1;
  aimF.copy(v).multiplyScalar(1 / sp); aimR.crossVectors(aimF, UP).normalize(); aimU.crossVectors(aimR, aimF);
  aimE.subVectors(goal, p); const d = aimE.length();
  if (d < 1.5) return out.set(0, 0);
  aimE.multiplyScalar(1 / d);
  const ex = aimE.dot(aimR), ey = aimE.dot(aimU), ez = aimE.dot(aimF), m = Math.hypot(ex, ey);
  if (m < 1e-6) return out.set(0, 0);
  const ang = Math.atan2(m, ez), T = clamp((d / sp) * 0.6, 0.12, 0.45), acc = sp * ang / T;
  const auth = Math.max(1, Bullet.authority());
  out.set((ex / m) * acc / auth, (ey / m) * acc / auth); if (out.length() > 1) out.normalize();
  return Bullet.unshape(out.x, out.y, out);
}
function aimUpdate(rdt, input) {
  const c = Target.chest;
  if (input) {
    const kx = (held('ArrowRight', 'KeyD') ? 1 : 0) - (held('ArrowLeft', 'KeyA') ? 1 : 0), ky = (held('ArrowUp', 'KeyW') ? 1 : 0) - (held('ArrowDown', 'KeyS') ? 1 : 0);
    // touch: the marker moves less per finger travel as the round closes in, so corrections stay small up close
    const tk = Hud.touch ? clamp(Bullet.S.p.distanceTo(c) / 150, 0.35, 1) : 1;
    const dxp = Input.dx * tk + kx * innerHeight * 0.45 * rdt, dyp = Input.dy * tk - ky * innerHeight * 0.45 * rdt;
    if (dxp || dyp) {
      camera.getWorldDirection(fwd);
      ndc.copy(G.aimP).project(camera);
      if (tmpV2.subVectors(G.aimP, camera.position).dot(fwd) <= 1 || Math.abs(ndc.x) > 1.3 || Math.abs(ndc.y) > 1.3) ndc.set(0, 0, 0.5);
      ndc.x = clamp(ndc.x + (dxp / innerWidth) * 2, -0.95, 0.95); ndc.y = clamp(ndc.y - (dyp / innerHeight) * 2, -0.95, 0.95);
      // keep the depth it had (it starts at his), but never past the first wall along the new line of sight
      if (G.aimDepth == null || G.aimLock) G.aimDepth = Math.max(20, tmpV2.subVectors(G.aimLock ? c : G.aimP, camera.position).dot(fwd));
      tmpV.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
      let along = G.aimDepth / Math.max(0.05, tmpV.dot(fwd));
      if (City.raycast(camera.position, tmpV, along)) along = Math.max(6, City.hit.t - 5);
      G.aimP.copy(camera.position).addScaledVector(tmpV, along);
      if (G.aimLock) G.aimArmed = false;   // dragged off him: it can't re-lock until it has been clearly away
      G.aimLock = false; G.aimSpent = false;
    }
    // dropping the marker back on him (within ~30 px at 720p, once it has been twice that far away) locks it to him
    if (!G.aimLock && Target.S.alive) {
      project(G.aimP, aimS1); project(c, aimS2);
      const px = aimS1.vis && aimS2.vis ? Math.hypot((aimS1.x - aimS2.x) * innerWidth, (aimS1.y - aimS2.y) * innerHeight) : 1e9;
      // touch: the marker snaps onto him from twice as far; a moving target half as far again
      const lr = 30 * innerHeight / 720 * (Hud.touch ? 2 : 1) * (G.tgtVel.length() > 1 ? 1.5 : 1);
      if (px > lr * 2) G.aimArmed = true;
      if (G.aimArmed && px < lr) G.aimLock = true;
    }
  }
  const tgo = Bullet.S.p.distanceTo(c) / Math.max(20, Bullet.S.v.length());
  G.aimLead.copy(c).addScaledVector(G.tgtVel, Math.min(1.5, tgo));
  if (!G.aimLock && Target.S.alive) {
    const B = Bullet.S, sees = clearLine(B.p, c, 0.3, true);
    if (!G.aimSpent && aimReached(B.p, B.v, G.aimP)) { if (sees) G.aimLock = true; else G.aimSpent = true; }
    else if (G.aimSpent && sees && B.p.distanceTo(c) < 70) G.aimLock = true;
  }
  if (G.aimLock && Target.S.alive) { G.aimP.copy(c); G.aimTgt.copy(G.aimLead); G.aimSpent = false; G.aimDepth = null; }
  else G.aimTgt.copy(G.aimP);
}
// touch: a quick tap in flight. On him (or his brackets) it locks the round onto him; anywhere else it puts
// the marker under the finger, at the depth it had, never past the first wall along that line.
function touchMarker(tp) {
  const c = Target.chest;
  if (Target.S.alive) {
    project(c, aimS2);
    if (aimS2.vis) {
      const d = Math.hypot((aimS2.x - tp.x) * innerWidth, (1 - aimS2.y - tp.y) * innerHeight);
      if (d < Math.max(44, aimS2.h * innerHeight * 0.9)) { G.aimLock = true; G.aimArmed = true; G.aimSpent = false; G.aimDepth = null; Sfx.tick(); return; }
    }
  }
  camera.getWorldDirection(fwd);
  if (G.aimDepth == null || G.aimLock) G.aimDepth = Math.max(20, tmpV2.subVectors(G.aimLock ? c : G.aimP, camera.position).dot(fwd));
  tmpV.set(tp.x * 2 - 1, 1 - tp.y * 2, 0.5).unproject(camera).sub(camera.position).normalize();
  let along = G.aimDepth / Math.max(0.05, tmpV.dot(fwd));
  if (City.raycast(camera.position, tmpV, along)) along = Math.max(6, City.hit.t - 5);
  G.aimP.copy(camera.position).addScaledVector(tmpV, along);
  if (G.aimLock) G.aimArmed = false;
  G.aimLock = false; G.aimSpent = false;
}
// ---- route planner (autopilot, attract demo, test bots): A* over a 2 m voxel grid around the man, from a
// gate above the skyline on the shooter's side down to him. Buildings are padded (more sideways than
// vertically, so the street under an awning stays open) and cells near walls cost extra, which keeps the
// route in the middle of streets. The result is smoothed and followed by pure pursuit on the marker.
const RP = { ok: false, pts: [], u: 0, ms: 0, cells: 0, expanded: 0 };
function planHidden() {
  const t0 = performance.now(); RP.ok = false; RP.pts = []; RP.u = 0;
  if (!Target.S.alive) return RP;
  const c = Target.chest, eye = PLAYER.eye, CS = 2, HR = 76;
  const ox = c.x - HR, oz = c.z - HR, nx = Math.ceil((2 * HR) / CS), nz = nx;
  let maxH = c.y + 10;
  City.forBoxesNear(c.x, c.z, HR + 4, (b) => { if (b.x1 > ox && b.x0 < ox + nx * CS && b.z1 > oz && b.z0 < oz + nz * CS && b.y1 < 400) maxH = Math.max(maxH, b.y1); });
  const top = Math.min(260, maxH + 20), ny = Math.ceil(top / CS), N = nx * ny * nz;
  const occ = new Uint8Array(N), I = (i, j, k) => (k * ny + j) * nx + i;
  const PH = 1.6, PV = 0.6;
  City.forBoxesNear(c.x, c.z, HR + 4, (b) => {
    if (b.kind === 5) return;
    const i0 = Math.max(0, Math.floor((b.x0 - PH - ox) / CS)), i1 = Math.min(nx - 1, Math.floor((b.x1 + PH - ox) / CS));
    const k0 = Math.max(0, Math.floor((b.z0 - PH - oz) / CS)), k1 = Math.min(nz - 1, Math.floor((b.z1 + PH - oz) / CS));
    const j0 = Math.max(0, Math.floor((b.y0 - PV) / CS)), j1 = Math.min(ny - 1, Math.floor((b.y1 + PV) / CS));
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) occ[I(i, j, k)] = 1;
  });
  // the last 12 m come in level: no diving at him from above (the round could not pull out in time)
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const wx = ox + (i + 0.5) * CS - c.x, wz = oz + (k + 0.5) * CS - c.z; if (wx * wx + wz * wz > 144) continue;
    for (let j = Math.max(0, Math.floor((c.y + 4.5) / CS)); j < ny; j++) occ[I(i, j, k)] = 1;
  }
  // window and car targets: the last 40 m are flown low and level, so the round meets the glass head-on
  { const sp0 = Target.S.spot;
    if (sp0 && sp0.entry2) {
      const jTop = Math.floor((Math.max(sp0.entry2.y, sp0.entry.y, c.y) + 4) / CS) + 1;
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const wx = ox + (i + 0.5) * CS - c.x, wz = oz + (k + 0.5) * CS - c.z; if (wx * wx + wz * wz > 1600) continue;
        for (let j = Math.max(0, jTop); j < ny; j++) occ[I(i, j, k)] = 1;
      }
    } }
  // goal: his chest, freed with its neighbours (he stands close to a wall)
  // (window and car targets: the route ends at a point straight out from the glass, then runs in level)
  const spot = Target.S.spot, gp = spot && spot.entry2 ? spot.entry2 : c;
  const gi = Math.floor((gp.x - ox) / CS), gj = Math.floor(gp.y / CS), gk = Math.floor((gp.z - oz) / CS);
  for (let k = gk - 1; k <= gk + 1; k++) for (let i = gi - 1; i <= gi + 1; i++) for (let j = gj; j <= gj + 1; j++) {
    if (i < 0 || k < 0 || i >= nx || k >= nz || j >= ny) continue;
    const wx = ox + (i + 0.5) * CS, wz = oz + (k + 0.5) * CS, wy = (j + 0.5) * CS; let inside = false;
    City.forBoxesNear(wx, wz, 2, (b) => { if (wx > b.x0 && wx < b.x1 && wz > b.z0 && wz < b.z1 && wy > b.y0 && wy < b.y1) inside = true; });
    if (!inside) occ[I(i, j, k)] = 0;
  }
  // distance to the nearest padded obstacle (in cells, up to 3), for the clearance cost
  const dist = new Uint8Array(N).fill(3), q = new Int32Array(N); let qh = 0, qt = 0;
  for (let n = 0; n < N; n++) if (occ[n]) { dist[n] = 0; q[qt++] = n; }
  const nxy = nx * ny;
  while (qh < qt) {
    const n = q[qh++], d = dist[n]; if (d >= 2) continue;
    const i = n % nx, j = Math.floor(n / nx) % ny, k = Math.floor(n / nxy);
    const nb = [i > 0 ? n - 1 : -1, i < nx - 1 ? n + 1 : -1, j > 0 ? n - nx : -1, j < ny - 1 ? n + nx : -1, k > 0 ? n - nxy : -1, k < nz - 1 ? n + nxy : -1];
    for (const m of nb) if (m >= 0 && dist[m] > d + 1) { dist[m] = d + 1; q[qt++] = m; }
  }
  // start: the spot's gate (open air on the shooter's side that a straight flight from the rifle reaches)
  const hx = eye.x - c.x, hz = eye.z - c.z, hl = Math.hypot(hx, hz) || 1, gt = Target.S.spot && Target.S.spot.gate;
  let si = clamp(Math.floor(((gt ? gt.x : c.x + (hx / hl) * (HR - 4)) - ox) / CS), 0, nx - 1), sk = clamp(Math.floor(((gt ? gt.z : c.z + (hz / hl) * (HR - 4)) - oz) / CS), 0, nz - 1);
  let sj = Math.min(ny - 1, Math.floor((gt ? gt.y : c.y + 30) / CS));
  while (sj < ny - 1 && (occ[I(si, sj, sk)] || dist[I(si, sj, sk)] < 3)) sj++;
  if (occ[I(si, sj, sk)]) { RP.ms = performance.now() - t0; return RP; }
  // A* (26-neighbour), binary heap
  const g = new Float32Array(N).fill(1e30), par = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const heap = new Int32Array(N), hf = new Float32Array(N); let hn = 0;
  const push = (n, f) => { let a = hn++; while (a > 0) { const p = (a - 1) >> 1; if (hf[p] <= f) break; heap[a] = heap[p]; hf[a] = hf[p]; a = p; } heap[a] = n; hf[a] = f; };
  const pop = () => { const top_ = heap[0], ln = heap[--hn], lf = hf[hn]; let a = 0; for (;;) { let b = 2 * a + 1; if (b >= hn) break; if (b + 1 < hn && hf[b + 1] < hf[b]) b++; if (hf[b] >= lf) break; heap[a] = heap[b]; hf[a] = hf[b]; a = b; } heap[a] = ln; hf[a] = lf; return top_; };
  const H = (i, j, k) => Math.hypot(i - gi, j - gj, k - gk);
  const s0 = I(si, sj, sk), goal = I(gi, gj, gk); g[s0] = 0; push(s0, H(si, sj, sk));
  const OFF = []; for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj || dk) OFF.push([di, dj, dk, Math.hypot(di, dj, dk)]);
  let found = false, exp = 0;
  while (hn > 0) {
    const n = pop(); if (closed[n]) continue; closed[n] = 1; exp++;
    if (n === goal) { found = true; break; }
    if (exp > 900000) break;
    const i = n % nx, j = Math.floor(n / nx) % ny, k = Math.floor(n / nxy);
    for (const [di, dj, dk, L] of OFF) {
      const a = i + di, b = j + dj, e = k + dk;
      if (a < 0 || b < 0 || e < 0 || a >= nx || b >= ny || e >= nz) continue;
      const m = I(a, b, e); if (occ[m] || closed[m]) continue;
      // straight-down or straight-up moves cost extra: descents come out as slopes the round can fly
      const w = L * (1 + 1.6 * (3 - dist[m]) / 3) * (dj && !di && !dk ? 2.4 : 1);
      const gn = g[n] + w; if (gn >= g[m]) continue;
      g[m] = gn; par[m] = n; push(m, gn + H(a, b, e));
    }
  }
  RP.cells = N; RP.expanded = exp;
  if (!found) { RP.ms = performance.now() - t0; return RP; }
  let pts = [];
  for (let n = goal; n >= 0; n = par[n]) { const i = n % nx, j = Math.floor(n / nx) % ny, k = Math.floor(n / nxy); pts.push(new THREE.Vector3(ox + (i + 0.5) * CS, (j + 0.5) * CS, oz + (k + 0.5) * CS)); }
  pts.reverse(); pts[pts.length - 1].copy(gp);
  if (gp !== c) { pts.push(spot.entry.clone(), c.clone()); }
  // smooth (Chaikin, ends kept) and resample to ~2 m
  for (let it = 0; it < 3; it++) {
    const o = [pts[0]];
    for (let a = 0; a < pts.length - 1; a++) { o.push(pts[a].clone().lerp(pts[a + 1], 0.25), pts[a].clone().lerp(pts[a + 1], 0.75)); }
    o.push(pts[pts.length - 1]); pts = o;
  }
  const res = [pts[0].clone()]; let acc = 0;
  for (let a = 1; a < pts.length; a++) { acc += pts[a].distanceTo(pts[a - 1]); if (acc >= 2) { res.push(pts[a].clone()); acc = 0; } }
  res.push(c.clone());
  RP.pts = res; RP.ok = true; RP.ms = performance.now() - t0;
  return RP;
}
// pure pursuit on the plan: writes the look-ahead point; false once it should just lock on him
function routeFollow(out, lookK = 0.5) {
  const B = Bullet.S, c = Target.chest;
  if (!RP.ok || !Target.S.alive) return false;
  const d = B.p.distanceTo(c);
  // lock on him once he is in plain reach (behind glass: only at the very end, the run-in lines it up)
  const spotE = Target.S.spot && Target.S.spot.entry;
  if (d < (spotE ? 5 : 26) && clearLine(B.p, c, 0.3, true)) return false;
  // still on the way in: fly to the gate first
  if (RP.u === 0 && B.p.distanceTo(RP.pts[0]) > 30) { out.copy(RP.pts[0]); return true; }
  let bi = RP.u, bd = 1e18;
  for (let i = RP.u; i < Math.min(RP.pts.length, RP.u + 25); i++) { const dd = RP.pts[i].distanceToSquared(B.p); if (dd < bd) { bd = dd; bi = i; } }
  RP.u = bi;
  const L = clamp(B.v.length() * lookK, 10, 40) * (d < (spotE ? 45 : 30) ? 0.5 : 1);   // tighter tracking on the final run
  let j = bi, acc = 0; while (j < RP.pts.length - 1 && acc < L) { acc += RP.pts[j].distanceTo(RP.pts[j + 1]); j++; }
  out.copy(RP.pts[j]);
  // street level: hold at least chest height until the last few metres
  if (out.distanceTo(c) > 6) out.y = Math.max(out.y, 2.2);
  return true;
}
// autopilot (attract demo, G.auto): the marker rides the plan, then locks on him
function autoMarker() {
  if (routeFollow(G.aimTgt)) { G.aimP.copy(G.aimTgt); G.aimLock = false; }
  else { const c = Target.chest; G.aimLock = true; G.aimP.copy(c); G.aimTgt.copy(c).addScaledVector(G.tgtVel, Math.min(1, Bullet.S.p.distanceTo(c) / Math.max(20, Bullet.S.v.length()))); }
  G.aimSpent = false;
}
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
  const termK = lerp(1, sstep(0, 1.2, G.tti || 1), G.losK || 0);
  const back = lerp(0.6, 1.2, k), side = lerp(0.1, 0.07, k), up = lerp(0.08, 0.2, k) * lerp(0.4, 1, termK);
  const want = tmpV.copy(f).multiplyScalar(-back).addScaledVector(u, up).addScaledVector(r, side);
  if (!camK.init) { camK.off.copy(want); camK.init = true; camK.roll = 0; camK.lookS = null; }
  // inside ~60 m of the man, once the round can actually see him, the view settles: it eases its look toward
  // him and stops following steering twitches (while he is still behind buildings it keeps looking ahead)
  const dMan = Target.S.alive ? B.p.distanceTo(Target.chest) : 1e9;
  G.losK = damp(G.losK || 0, Target.S.alive && clearLine(B.p, Target.chest, 0.3) ? 1 : 0, 3, rdt);
  const calm = sstep(60, 25, dMan) * G.losK;
  // the rig lags the round a little, so hard steering visibly drifts the round in frame
  camK.off.lerp(want, 1 - Math.exp(-7 * rdt));
  // shake: turbulence buffets the rig; near misses and launch give it a kick
  G.shake = Math.max(0, (G.shake || 0) - rdt * 2.5);
  const turbA = Math.hypot(B.turb.x, B.turb.y) / Math.max(1, G.diff.turb || 1);
  // launch: the view stays pointed exactly where you aimed while the round leaves the barrel (it flies
  // straight then anyway), then eases into following turns; the zoom opens quickly from the scope's
  const kb = sstep(0.45, 1.05, G.stateT), kz = sstep(0.0, 0.35, G.stateT);
  const amp = (0.004 * turbA + 0.02 * G.shake) * (1 - 0.85 * calm) * kb;
  const t = U.uTime.value;
  shakeV.copy(r).multiplyScalar(amp * (Math.sin(t * 61) + 0.6 * Math.sin(t * 37 + 1))).addScaledVector(u, amp * (Math.sin(t * 53 + 2) + 0.6 * Math.sin(t * 29)));
  camera.position.copy(B.p).add(camK.off).add(shakeV);
  // flying close past walls on a hairpin: never let the rig end up inside a building
  kcD.subVectors(camera.position, B.p); { const L = kcD.length(); if (L > 1e-3) { kcD.multiplyScalar(1 / L); if (City.raycast(B.p, kcD, L + 0.15)) camera.position.copy(B.p).addScaledVector(kcD, Math.max(0.12, City.hit.t - 0.15)); } }
  camera.up.copy(UP);
  // look into the turn: blend the straight-ahead point toward where the round will be in ~0.5 s
  // the path preview follows a smoothed stick, so it does not whip around with every twitch
  G.stickS = G.stickS || new THREE.Vector2(); G.stickS.x = damp(G.stickS.x, G.stick.x, 12, rdt); G.stickS.y = damp(G.stickS.y, G.stick.y, 12, rdt);
  if (POINT || G.auto || G.demo) { pvSnap = 0; Bullet.previewPath(null, PATH_SEC, PATH_N, G.pathPts, PATH_PW, previewSteer); }
  else Bullet.previewPath(G.stickS, PATH_SEC, PATH_N, G.pathPts, PATH_PW);
  // what gets drawn glides toward the new prediction (kept relative to the round, so it never lags behind it)
  { const kd = 1 - Math.exp(-10 * rdt);
    for (let i = 0; i < PATH_N; i++) { tmpV2.subVectors(G.pathPts[i], B.p); if (G.pathReset) G.pathRel[i].copy(tmpV2); else G.pathRel[i].lerp(tmpV2, kd); G.pathDraw[i].copy(B.p).add(G.pathRel[i]); }
    G.pathReset = false; }
  // where the held course runs into something (the man himself does not count)
  G.pathBlock = -1;
  for (let i = 0, a = B.p; i < PATH_N; a = G.pathPts[i], i++) {
    const b = G.pathPts[i]; kcD.subVectors(b, a); const L = kcD.length(); if (L < 1e-3 || i === B.pvBounceK) continue; kcD.multiplyScalar(1 / L);
    if (Target.S.alive && Target.distToSegment(a, b) < 0.6) break;
    if (City.raycast(a, kcD, L, true)) { G.pathBlock = i; G.pathBlockP.copy(a).addScaledVector(kcD, City.hit.t); break; }
  }
  lookV.copy(B.p).addScaledVector(f, 40);
  // the sample nearest 0.5 s ahead (samples sit at 2.2 * (k / N)^1.7 s)
  if (k > 0.5) { const pk = G.pathPts[Math.round(PATH_N * Math.pow(0.5 / PATH_SEC, 1 / PATH_PW)) - 1]; tmpV2.subVectors(pk, B.p); const dl = tmpV2.length(); if (dl > 1) lookV.lerp(tmpV2.multiplyScalar(40 / dl).add(B.p), 0.55 * (1 - calm)); }
  if (calm > 0) { tmpV2.subVectors(Target.chest, B.p); const dl = tmpV2.length(); if (dl > 1) lookV.lerp(tmpV2.multiplyScalar(40 / dl).add(B.p), 0.55 * calm); }
  // the look point itself is smoothed (the rig has inertia)
  if (!camK.lookS) camK.lookS = lookV.clone(); else { const kl = 1 - Math.exp(-9 * rdt); camK.lookS.lerp(lookV, kl); }
  camera.lookAt(camK.lookS);
  // bank into the turn (actual actuator force, plus a touch of the stick for responsiveness)
  const lat = B.aMax > 0 ? B.aCur.x / B.aMax : 0;
  camK.roll = damp(camK.roll, clamp(-lat * 0.42 - G.stick.x * 0.08, -0.5, 0.5) * (1 - 0.8 * calm) * kb, 5, rdt);
  camera.rotateZ(camK.roll);
  // dynamic FOV: wide at the muzzle (speed), narrowing in the terminal phase so the man fills more of the frame
  const term = sstep(0, 1.2, G.tti);
  let fov = lerp(64, 44, k) - (1 - term) * 12 * G.losK + G.shake * 3 + 8 * (1 - sstep(0.22, 0.55, G.stateT));
  // terminal rush: over the last ~80 m the lens tightens so the man grows to ~22% of frame height at impact
  const R = G.tgtRange || 1e9;
  if (R < 80 && Target.S.alive) {
    const want = 2 * Math.atan(1.8 / (2 * 0.22 * (R + 1.2))) / DEG;
    fov = lerp(fov, Math.max(20, want), sstep(80, 15, R) * G.losK);
  }
  fov = fitFov(fov, 26);
  // the first ~0.8 s blend from exactly where the scope was looking (position, direction, zoom) out to the
  // chase view behind the round, so firing never jumps the picture
  if (kb < 1 && G.fireCam) {
    const qc = camera.quaternion.clone();
    camera.quaternion.copy(G.fireCam.quat).slerp(qc, kb);
  }
  if (kz < 1 && G.fireCam) fov = Math.exp(lerp(Math.log(G.fireCam.fov), Math.log(fov), kz));
  camera.fov = fov; camera.near = 0.03; camera.far = 7000;
}

// ---- killcam / misscam: pick a camera spot with a clear view (City.raycast), then track smoothly ----
const killCentre = new THREE.Vector3(), kcA = new THREE.Vector3(), kcB = new THREE.Vector3(), kcD = new THREE.Vector3(), kcS = new THREE.Vector3();
const KC = { pos: new THREE.Vector3(), base: new THREE.Vector3(), anchor: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 7, angle: 0, cutAt: 2.4 };
function clearLine(a, b, pad = 0.25, throughGlass = false) {
  kcD.subVectors(b, a); const L = kcD.length(); if (L < 1e-3) return true;
  kcD.multiplyScalar(1 / L);
  return !City.raycast(a, kcD, L + pad, throughGlass);
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
  const spot = Target.S.spot;
  if (spot && spot.entry) {
    // a car or a quadcopter: watch the wreck fly from a fixed spot out along its street, high enough to see the
    // pieces land
    const out = kcS.subVectors(spot.entry2, spot.entry); out.y = 0;
    const L = out.length() || 1; out.multiplyScalar(1 / L);
    const sd = second ? -1 : 1, quad = spot.kind === 'quad' || spot.kind === 'heli', back = second ? 12 : 7;
    const y = quad ? Math.max(4, spot.entry.y + (second ? 4 : 1.5)) : (second ? 7 : 4);
    KC.base.copy(spot.entry).addScaledVector(out, back - 3); KC.base.y = y;
    KC.base.x += -out.z * sd * 1.3; KC.base.z += out.x * sd * 1.3; KC.dir.copy(out); KC.fixed = true;
    KC.anchor.copy(killCentre); KC.dist = KC.base.distanceTo(killCentre);
    camK.look.copy(killCentre); camK.orbit = 0; camK.init = true;
    return;
  }
  const fly = kcB.copy(killCentre).addScaledVector(kcS.set(G.hitDir.x, 0, G.hitDir.z).normalize(), 5).add(tmpV2.set(0, 1.2, 0));
  const flyP = new THREE.Vector3().copy(fly);
  const avoid = second ? KC.dir.clone() : null;
  let ok = pickView(killCentre, flyP, G.hitDir, second ? [11, 14, 8] : [6.5, 8.5, 5], second ? [3.5, 5.5, 2.2] : [2.0, 3.2, 1.5], avoid, KC.base);
  // tight spots (a street front, under an awning): drop the "where he flies" requirement and search wider
  if (!ok) ok = pickView(killCentre, killCentre.clone(), G.hitDir, [8, 5, 11, 14], [2.5, 1.4, 4.5, 7.5], avoid, KC.base);
  if (!ok) { KC.base.copy(killCentre).addScaledVector(G.hitDir, -5).add(tmpV2.set(0, 6, 0)); KC.dir.copy(G.hitDir).negate(); }
  KC.anchor.copy(killCentre); KC.dist = KC.base.distanceTo(killCentre);
  camK.look.copy(killCentre); camK.orbit = 0; camK.init = true;
}
function killCamera(rdt) {
  Target.centroid(killCentre);
  if (!camK.init) { KC.fixed = false; setupKillView(false); KC.cutAt = 2.4; KC.cut = false; }
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
  if (KC.hidden > 0.12 && KC.since > 0.5 && !KC.fixed) { setupKillView(true); KC.hidden = 0; KC.since = 0; }
  camK.orbit += rdt * 0.05;
  camK.look.lerp(killCentre, 1 - Math.exp(-6 * rdt));
  // the camera follows the tumbling man part of the way (dolly), then a spring arm keeps it out of walls
  if (KC.fixed) { KC.pos.copy(KC.base); if (G.state === 'tally') KC.pos.y += Math.min(1.2, G.stateT * 0.3); }   // car: hold the fixed view
  else {
    kcA.subVectors(camK.look, KC.anchor).multiplyScalar(0.9);
    KC.pos.copy(KC.base).add(kcA).sub(camK.look).applyAxisAngle(UP, camK.orbit).add(camK.look);
    if (G.state === 'tally') KC.pos.y += Math.min(2.5, G.stateT * 0.6);
    springArm(camK.look, KC.pos);
  }
  camera.position.copy(KC.pos);
  // the backpack blast shakes the kill camera for a second
  if ((G.boomT || 0) > 0) { G.boomT = Math.max(0, G.boomT - rdt); const k = 0.35 * G.boomT * G.boomT; camera.position.x += (Math.random() - 0.5) * k; camera.position.y += (Math.random() - 0.5) * k; camera.position.z += (Math.random() - 0.5) * k; }
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
  Aim.yaw = clamp(Aim.yaw, -1.0, 1.0); Aim.pitch = clamp(Aim.pitch, -0.45, 0.75);   // up to the rooftops above the eye line
  G.magI = SCOPE_MAG_I; G.mag = MAGS[SCOPE_MAG_I];   // fixed magnification
  G.holding = false;
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
    Input.pressed.clear(); Input.tap = null; Input.dx = Input.dy = Input.wheel = 0; return;
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
      // fire mission: lock the three trucks, then the bomb goes down the tube
      if (G.mission) { if (Mortar.aim(fire_, Input.tap)) { Sfx.mortarLoad(); setState('mload'); } break; }
      // the helicopter got away: the stage is lost (no kill, no refill) and the game moves on
      if (Target.S.escaped && !G.demo) { setState('escaped'); Sfx.deny && Sfx.deny(); break; }
      if (G.demo && G.stateT > 1.6) { fire(); break; }
      if (fire_) { fire(); break; }
      break;
    }
    case 'escaped':
      updateAim(rdt);
      if (G.stateT > 3.2 || (fire_ && G.stateT > 1.2)) { G.stage++; G.staticAmt = 1; Sfx.staticBurst(0.2); newStage(); }
      break;
    case 'mload':   // fire mission: loaded; tap (or click, space) to fire
      updateAim(rdt);
      if (G.stateT > 2.0 && (fire_ || Input.tap)) { Mortar.fire(); setState('mflight'); }   // after HANG IT...
      break;
    case 'mflight': {   // fire mission: ride the bomb up, the cones down, watch the trucks go
      gdt = rdt * Mortar.ts();
      Mortar.update(gdt, (c, k) => packBlast(k, c));
      Mortar.camera(rdt, camera);
      if (Mortar.done()) {
        G.tallyRows = [['TARGETS DESTROYED 3', 3000], ['FIRE MISSION', 1500], [`STAGE ${G.stage} BONUS`, 250 * G.stage]];
        G.tallyStep = 0.45; G.score += G.tallyRows.reduce((a, r) => a + r[1], 0);
        setState('tally'); G.tallyTick = 0;
      }
      break;
    }
    case 'shot':
      updateAim(rdt);
      gdt = rdt * 0.5;
      if (G.stateT > 0.2) {
        // the flight view grows out of the scope view: no cut, no kick
        G.fireCam = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov };
        const lk = !!G.fireLock; G.aimP.copy(lk ? Target.chest : G.fireAim); G.aimTgt.copy(G.aimP); G.aimLock = lk; G.aimSpent = false; G.aimDepth = null; G.aimArmed = true;
        G.shake = 0; G.whoosh = 1; Sfx.flightStart(); Sfx.slowDive && Sfx.slowDive(G.baseTS); camK.init = false; setState('flight');
      }
      break;
    case 'flight': {
      // steering input: mouse displaces a self-centring stick, keys push it toward the stops
      const kx = (held('ArrowRight', 'KeyD') ? 1 : 0) - (held('ArrowLeft', 'KeyA') ? 1 : 0);
      const ky = (held('ArrowUp', 'KeyW') ? 1 : 0) - (held('ArrowDown', 'KeyS') ? 1 : 0);
      if (!POINT) {
        G.stick.x += Input.dx * 0.011; G.stick.y -= Input.dy * 0.011;
        if (kx) G.stick.x = damp(G.stick.x, kx, 6, rdt); if (ky) G.stick.y = damp(G.stick.y, ky, 6, rdt);
        if (!kx && !Input.dx) G.stick.x = damp(G.stick.x, 0, 2.4, rdt);
        if (!ky && !Input.dy) G.stick.y = damp(G.stick.y, 0, 2.4, rdt);
        if (G.stick.length() > 1) G.stick.normalize();
      }
      const botOn = !!(window.__X && window.__X.bot);
      if (G.auto || G.demo) autoMarker();
      else if (POINT) { if (Input.tap && !botOn) touchMarker(Input.tap); aimUpdate(rdt, !botOn); if (botOn) { window.__X.bot(G, rdt); aimUpdate(rdt, false); } }
      else if (botOn) window.__X.bot(G, rdt);
      if (POINT || G.auto || G.demo) pointSteerAt(Bullet.S.p, Bullet.S.v, G.stick);
      // last-ditch terminal lock: close in, roughly pointed at him, with an open line to him (glass counts as
      // open), the round's own seeker takes over and steers itself in with extra fin authority. The reach and
      // the cone tighten with the stage.
      { const Bs = Bullet.S, c = Target.chest;
        if (Target.S.alive && Bs.budget > 0 && Bs.t > Bs.dash + Bs.brakeT) {
          const s1 = Math.max(1, G.stage) - 1, tch = Hud.touch, mv = G.tgtVel.length() > 1, reach = Math.max(14, 24 - 1.4 * s1) * (tch ? 1.5 : 1) * (mv ? 1.25 : 1), cone = (Math.max(18, 34 - 2 * s1) + (tch ? 12 : 0) + (mv ? 8 : 0)) * DEG;
          const dd = Bs.p.distanceTo(c); TL1.subVectors(c, Bs.p).normalize(); TL2.copy(Bs.v).normalize();
          const sees = dd < reach + 2 && clearLine(Bs.p, c, 0.15, true);
          if (!G.tLock && dd < reach && Math.acos(clamp(TL1.dot(TL2), -1, 1)) < cone && sees) { G.tLock = true; Sfx.lock(); G.stampText = 'TERMINAL LOCK'; G.stampT = 0.8; }
          if (G.tLock && !sees) G.tLock = false;
          if (G.tLock) { Bs.assistK = 1.6; TL1.copy(c).addScaledVector(G.tgtVel, Math.min(0.6, dd / Math.max(20, Bs.v.length()))); pointSteerAt(Bs.p, Bs.v, G.stick, TL1); }
          else Bs.assistK = 1;
        } else Bs.assistK = 1;
      }
      const B = Bullet.S;
      const remaining = Target.chest.distanceTo(B.p);
      const sp = Math.max(1, B.v.length());
      tmpV.subVectors(Target.chest, B.p); const along = tmpV.dot(B.v) / sp;
      // straight-line time to him at the current speed (it counts down as the round closes)
      G.tti = remaining / Math.min(sp, Math.max(1, B.vc)); G.ttiReal = G.tti / Math.max(0.05, G.baseTS);
      // time scale: the first moment runs at full speed (the supersonic dash out of the barrel), then time
      // eases down into slow motion over about half a second (the slow-down sound follows the same curve).
      // As the round sheds speed near him the clock speeds back up (apparent speed falls more gently than
      // the true speed), so the slow, twisting last stretch stays lively.
      const ramp = sstep(0.3, 0.85, G.stateT);
      // the braking beat: a scan-line ripple and a stamp as the fins come out and steering goes live
      if (!G.braked && G.stateT > 0.3) { G.braked = true; G.staticAmt = Math.max(G.staticAmt, 0.14); if (G.stampText !== 'RICOCHET' || G.stampT <= 0) { G.stampT = 0.9; G.stampText = 'GUIDANCE ACTIVE'; } }
      const slowTS = Math.min(0.85, Math.max(G.baseTS, G.baseTS * Math.sqrt(Math.max(1, B.vc) / sp)));
      G.timeScale = lerp(1, slowTS, ramp);
      // a ricochet gets a short extra slow-down so you see it happen
      G.ricoT = Math.max(0, (G.ricoT || 0) - rdt); G.timeScale *= 1 - 0.5 * clamp(G.ricoT / 0.6, 0, 1);
      // moving away from him: a miss once it has gone on for a while (quickly once the round can't steer)
      G.recede = along < 0 ? (G.recede || 0) + rdt : 0;
      gdt = rdt * G.timeScale;
      let ev = Bullet.step(gdt, G.stick);
      if (B.glassNew) {
        B.glassNew = false; Sfx.glass && Sfx.glass(); G.shake = Math.max(G.shake, 0.4); G.ricoT = Math.max(G.ricoT || 0, 0.45);
        tmpV2.copy(B.v).normalize();
        for (let i = 0; i < 46; i++) {
          const sp = 3 + Math.random() * 9;
          FX.spawn(B.glassP.x, B.glassP.y, B.glassP.z, tmpV2.x * sp + (Math.random() - 0.5) * 5, tmpV2.y * sp + Math.random() * 3, tmpV2.z * sp + (Math.random() - 0.5) * 5,
            0.6 + Math.random() * 0.8, 0.05, 0.035, 0.42, 0.25, -9, 2);
        }
      }
      if (B.ricoNew) {
        B.ricoNew = false; FX.sparks(B.ricoP, B.ricoN, 30, 30); Sfx.ricochet && Sfx.ricochet();
        G.stampText = 'RICOCHET'; G.stampT = 0.9; G.shake = Math.max(G.shake, 0.5); G.ricoT = 0.6; G.recede = 0; G.pathReset = true;
      }
      // the round has flown past the man (or the flight is dragging on): end it as a miss, never soft-lock
      if (!ev && (G.recede > (B.budget > 0 ? 3.5 : 0.7) || G.stateT > 45)) ev = Bullet.abort();
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
        if (G.rounds <= 0) { setState('gameover'); Sfx.gameOver && Sfx.gameOver(); } else { G.staticAmt = 0.4; Sfx.staticBurst(0.15); Target.calm(); setState('aim'); }
      }
      break;
    case 'tally': {
      if (G.mission) Mortar.camera(rdt, camera); else killCamera(rdt);
      const row = Math.floor((G.stateT - 0.5) / (G.tallyStep || 0.45));
      if (row >= 0 && row <= G.tallyRows.length && row >= (G.tallyTick || 0)) { G.tallyTick = row + 1; if (row === G.tallyRows.length && Sfx.bonus) Sfx.bonus(); else Sfx.tick(); }
      if ((fire_ && G.stateT > 1.0) || G.stateT > 7) { G.stage++; G.staticAmt = 1; Sfx.staticBurst(0.2); newStage(); }
      break;
    }
    case 'gameover':
      aimCamera(rdt);
      if (G.stateT > 1.5 && (fire_ || G.stateT > 8)) {
        setState('attract');
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
  if (gdt > 1e-5 && Target.S.alive) G.tgtVel.subVectors(Target.chest, tgtPrev).multiplyScalar(1 / gdt).clampLength(0, Target.S.type === 'heli' ? 30 : 8);
  else if (!Target.S.alive) G.tgtVel.set(0, 0, 0);
  City.updateTraffic(gdt);
  FX.update(gdt, camera.position);
  Bullet.updateVisual(gdt, camera);

  // HUD projections
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  project(Target.chest, G.tgtScreen);
  if (G.mission) { Mortar.screen(camera); G.tgtScreen.vis = false; G.tgtScreen.off = false; }   // fire mission: the trucks have their own brackets
  // a car or a quadcopter: its brackets frame its whole box on screen
  G.tgtScreen.bw = 0;
  if (Target.S.type !== 'man' && Target.S.alive && G.tgtScreen.vis) {
    let x0 = 9, x1 = -9, y0 = 9, y1 = -9, ok = true;
    camera.getWorldDirection(fwd);
    for (const p of Target.corners()) {
      if (tmpV2.subVectors(p, camera.position).dot(fwd) <= 0.5) { ok = false; break; }
      ndc.copy(p).project(camera); x0 = Math.min(x0, ndc.x); x1 = Math.max(x1, ndc.x); y0 = Math.min(y0, ndc.y); y1 = Math.max(y1, ndc.y);
    }
    if (ok) { G.tgtScreen.bw = (x1 - x0) / 2; G.tgtScreen.bh = (y1 - y0) / 2; }
  }
  if (G.state === 'killcam' || G.state === 'misscam') bodyBox(G.bodyBox); else G.bodyBox.vis = false;
  if (G.state === 'flight' && Bullet.S.active) {
    project(Bullet.S.p, G.roundScreen); for (let i = 0; i < PATH_N; i++) project(G.pathDraw[i], G.pathScreen[i]);
    G.bounceK = Bullet.S.pvBounceK;
    if (G.pathBlock >= 0) project(G.pathBlockP, G.blockScreen); else G.blockScreen.vis = false;
  } else { for (const p of G.pathScreen) p.vis = false; G.roundScreen.vis = false; G.blockScreen.vis = false; }
  if (G.state === 'misscam' && G.missGap) { project(Target.chest, G.missA); project(G.missP, G.missB); } else G.missA.vis = G.missB.vis = false;
  if (G.state === 'flight') coverBox(G.coverScreen); else G.coverScreen.vis = false;
  if (POINT && G.state === 'flight' && Bullet.S.active) project(G.aimLock ? Target.chest : G.aimP, G.aimScreen); else G.aimScreen.vis = false;
  // on-screen hint (early stages): which side of his cover is open
  G.coverBlocked = G.state === 'flight' && Bullet.S.active && Target.S.alive && !clearLine(Bullet.S.p, Target.chest, -0.6);
  // is he behind something from where the camera is (scope or chase cam)? the HUD marks him HIDDEN
  G.tgtHidden = Target.S.alive && (G.state === 'aim' || G.state === 'brief' || G.state === 'flight') && !clearLine(camera.position, Target.chest, -0.4);
  G.coverSide = Target.S.app ? Target.S.app.side : '';
  updatePipper(rdt);

  Input.pressed.clear(); Input.tap = null; Input.dx = Input.dy = Input.wheel = 0;
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
    G.nearCool = 1.1; G.whoosh = 1; G.shake = Math.max(G.shake, 0.8); G.nearMisses = Math.min(5, G.nearMisses + 1);
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
  const t = Target.S.spot && Target.S.spot.gate ? Target.S.spot.gate : Target.chest; const dx = t.x - PLAYER.eye.x, dy = t.y - PLAYER.eye.y, dz = t.z - PLAYER.eye.z;
  const wy = Math.atan2(-dx, -dz), wp = Math.atan2(dy, Math.hypot(dx, dz));
  Aim.yaw = damp(Aim.yaw, wy, 2.6, rdt); Aim.pitch = damp(Aim.pitch, wp, 2.6, rdt);
}

// ---- render -------------------------------------------------------------------
function render() {
  // test hook: a free camera for looking at things up close (window.__X.look)
  if (G.dbgView) { const v = G.dbgView; camera.position.copy(v.p); camera.up.set(0, 1, 0); camera.lookAt(v.t); camera.fov = v.fov || 40; camera.updateProjectionMatrix(); camera.updateMatrixWorld(); }
  const scopeOn = ['brief', 'aim', 'shot', 'gameover', 'initials', 'mload', 'escaped'].includes(G.state) ? 1 : 0;
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
  G, Aim, City, Target, Bullet, Post, Hud, FX, Sfx, scene, renderer, camera, fontsReady, Input, Mortar,
  advance(sec, step = 1 / 60, draw = true) { const n = Math.max(1, Math.round(sec / step)); for (let i = 0; i < n; i++) tick(step); if (draw) render(); },
  key(code) { Input.pressed.add(code); },
  look(p, t, fov) { G.dbgView = p ? { p: p.clone(), t: t.clone(), fov } : null; },
  start() { startGame(); },
  aimAtTarget(lead = 0) {
    const t = Target.chest; const dx = t.x - PLAYER.eye.x, dy = t.y - PLAYER.eye.y, dz = t.z - PLAYER.eye.z;
    Aim.yaw = Math.atan2(-dx, -dz) + lead; Aim.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  },
  setMag(i) { G.magI = i; G.mag = MAGS[i]; },
  spawnWith(o) { const ok = Target.spawn(G.stage, o); planHidden(); return ok; },
  spawnKind(k) { const ok = Target.spawn(G.stage, { kind: k }); planHidden(); return ok && Target.S.spot && Target.S.spot.kind === k; },
  aimAt(t) { const dx = t.x - PLAYER.eye.x, dy = t.y - PLAYER.eye.y, dz = t.z - PLAYER.eye.z; Aim.yaw = Math.atan2(-dx, -dz); Aim.pitch = Math.atan2(dy, Math.hypot(dx, dz)); },
  fire() { fire(); },
  // headless simulation without rendering (difficulty probes)
  sim(sec, step = 1 / 60) { const n = Math.max(1, Math.round(sec / step)); for (let i = 0; i < n; i++) tick(step); },
  startAt(stage) { G.score = 0; G.rounds = G.maxRounds = 5; G.stage = stage; newStage(); setState('aim'); },
  demo() { startDemo(); }, endDemo() { endDemo(); }, difficulty,
  clearLine(a, b, pad) { return clearLine(a, b, pad); },
  routeTgt: routeT, RP, planHidden, routeFollow, pointSteerAt,
  setAim(p, lock = false) { if (p) G.aimP.copy(p); G.aimLock = lock; G.aimSpent = false; }, routeAimPoint(out) { return routeAim(out); },
  bot: null, routeStick(stick, gain, look) { return routeStick(stick || G.stick, gain, look); }, planOk() { return PLAN.ok; },
  setState, setMode(m) { G.mode = m; G.modeName = MODES[m].name; },
};
