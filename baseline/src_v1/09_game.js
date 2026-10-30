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

const MODES = [{ name: 'WHITE HOT', persist: 0.18 }, { name: 'BLACK HOT', persist: 0.18 }, { name: 'NIGHT VISION', persist: 0.42 }];
const MAGS = [4, 6, 8, 12, 16, 24, 32];
const G = {
  state: 'attract', stateT: 0, paused: false, auto: false,
  score: 0, scoreShown: 0, hi: 0, table: [], stage: 1, rounds: 5, maxRounds: 5,
  mag: 6, magI: 1, scopeR: 0.46, reticleOff: new THREE.Vector2(), lased: 0, crossWind: 0, timeLeft: 60,
  breath: 1, holding: false, gasp: 0,
  tgtScreen: { vis: false, off: false, x: 0, y: 0, h: 0, ang: 0 }, pipScreen: { vis: false, x: 0, y: 0 },
  tgtRange: 0, tti: 0, stick: new THREE.Vector2(), timeScale: 1, baseTS: 0.2,
  mode: Store.get('mode', 0), modeName: '', diff: {}, wind: new THREE.Vector3(),
  lastHit: null, lastMiss: '', tallyRows: [], initials: ['A', 'A', 'A'], initialPos: 0, toast: '', toastT: 0,
  hitPoint: new THREE.Vector3(), hitDir: new THREE.Vector3(), flash: 0, staticAmt: 0, fade: 0, scopeAmt: 0,
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
  for (const t of e.changedTouches) {
    const x = t.clientX / innerWidth, y = t.clientY / innerHeight;
    if (x > 0.78 && y > 0.6) Input.pressed.add('Fire');
    else Input.touchAim = { id: t.identifier, x: t.clientX, y: t.clientY };
  }
  if (G.state === 'attract' || G.state === 'tally' || G.state === 'gameover') Input.pressed.add('Fire');
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

function difficulty(stage) {
  return {
    wind: Math.min(13, 2 + 1.35 * (stage - 1)), gust: 0.5 + 0.22 * stage, turb: Math.min(5.5, 1.1 + 0.4 * stage),
    roll: Math.min(0.38, 0.05 + 0.035 * stage), budget: Math.max(7, 18 - 1.2 * (stage - 1)), aMax: 28, tau: Math.min(0.3, 0.12 + 0.015 * stage),
  };
}
function newStage() {
  const info = City.generate(newSeed());
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
  return info;
}
function startGame() {
  G.score = 0; G.scoreShown = 0; G.stage = 1; G.rounds = G.maxRounds = 5; Sfx.coin();
  newStage();
}
function lase(o, d) {
  let range = 0;
  if (City.raycast(o, d, 4500)) range = City.hit.t;
  tmpV2.copy(o).addScaledVector(d, range || 4500);
  const th = Target.segmentHit(o, tmpV2);
  if (th) range = th.t * (range || 4500);
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
  const tof = (Math.exp(PHYS.k * dTarget) - 1) / (PHYS.k * PHYS.v0);
  G.baseTS = clamp(tof / (5.5 + dTarget * 0.0022), 0.035, 0.35);
  Bullet.fire(origin, dir, { aMax: G.diff.aMax, tau: G.diff.tau, budget: G.diff.budget, wind: G.wind, gust: G.diff.gust, turb: G.diff.turb, roll: G.diff.roll });
  Sfx.shot(); G.flash = 0.9; Aim.recoilV = 0.9;
  G.stick.set(0, 0);
  setState('shot');
}
function scoreHit(ev) {
  const range = Bullet.S.origin.distanceTo(ev.point);
  const ctrl = Bullet.S.budget / Bullet.S.budget0;
  const centre = ev.centre;
  G.lastHit = { range, centre, part: ev.part };
  G.tallyRows = [
    [`RANGE ${Math.round(range)} M`, Math.round(range * 2)],
    [centre < 0.15 ? 'CENTER MASS' : 'OFF CENTER', centre < 0.15 ? 500 : 100],
    [`CTRL RESERVE ${Math.round(ctrl * 100)}%`, Math.round(ctrl * 800)],
    [`TIME BONUS ${Math.ceil(G.timeLeft)} S`, Math.round(G.timeLeft * 10)],
    [`STAGE ${G.stage} BONUS`, 250 * G.stage],
  ];
  G.score += G.tallyRows.reduce((a, r) => a + r[1], 0);
}
function onBulletEvent(ev) {
  Sfx.flightStop();
  if (ev.type === 'hit') {
    G.hitPoint.copy(ev.point); G.hitDir.copy(Bullet.S.v).normalize();
    Target.launch(ev.point, G.hitDir, ev.part);
    Sfx.hit(); G.flash = 0.35;
    if (G.rounds < G.maxRounds) G.rounds++; // a hit refunds the round
    scoreHit(ev);
    Bullet.hideRound();
    camK.init = false;
    setState('killcam');
  } else {
    G.hitPoint.copy(ev.point); G.hitDir.copy(Bullet.S.v).normalize();
    if (ev.type === 'impact') { FX.sparks(ev.point, tmpV.set(ev.normal.x, ev.normal.y, ev.normal.z), 45, 35); Sfx.impactThud(); }
    Sfx.miss();
    const md = Bullet.S.minDist;
    G.lastMiss = md < 50 ? `MISSED BY ${md.toFixed(1)} M` : ev.type === 'lost' ? 'ROUND LOST' : 'HIT STRUCTURE';
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
  camera.rotation.set(Aim.pitch + Aim.sy + Aim.recoil * 0.05, Aim.yaw + Aim.sx, 0);
  camera.fov = 40 / G.mag; camera.near = 1; camera.far = 7000;
  G.reticleOff.set(0, 0);
  Post.display.uniforms.uScopeOff.value.set(clamp(-Aim.vx * 6, -0.05, 0.05), clamp(-Aim.vy * 6, -0.05, 0.05) - Aim.recoil * 0.1);
}
function chaseCamera(rdt) {
  const { f, r, u } = Bullet.frame();
  const want = tmpV.copy(f).multiplyScalar(-1.15).addScaledVector(u, 0.2).addScaledVector(r, 0.04);
  if (!camK.init) { camK.off.copy(want); camK.init = true; }
  camK.off.lerp(want, 1 - Math.exp(-10 * rdt));
  camera.position.copy(Bullet.S.p).add(camK.off);
  camera.up.copy(UP);
  camera.lookAt(tmpV2.copy(Bullet.S.p).addScaledVector(f, 40));
  camK.roll = damp(camK.roll, -G.stick.x * 0.22, 6, rdt);
  camera.rotateZ(camK.roll);
  camera.fov = 34; camera.near = 0.03; camera.far = 7000;
}
const killCentre = new THREE.Vector3();
function killCamera(rdt) {
  Target.centroid(killCentre);
  if (!camK.init) {
    const side = tmpV.crossVectors(G.hitDir, UP).normalize();
    camK.off.copy(G.hitDir).multiplyScalar(-6.5).addScaledVector(side, 3.2).add(new THREE.Vector3(0, 1.4, 0));
    camK.look.copy(killCentre); camK.init = true; camK.orbit = 0;
  }
  camK.orbit += rdt * 0.18;
  camK.look.lerp(killCentre, 1 - Math.exp(-5 * rdt));
  const o = tmpV.copy(camK.off).applyAxisAngle(UP, camK.orbit);
  const dist = clamp(killCentre.distanceTo(G.hitPoint) * 0.5, 0, 25);
  camera.position.copy(camK.look).add(o.multiplyScalar(1 + dist / 7));
  camera.position.y = Math.max(camera.position.y, killCentre.y + 0.8, 1.2);
  camera.up.copy(UP); camera.lookAt(camK.look);
  camera.fov = 42; camera.near = 0.05; camera.far = 7000;
}
function missCamera(rdt) {
  if (!camK.init) {
    camK.off.copy(G.hitDir).multiplyScalar(-16).add(new THREE.Vector3(0, 3, 0));
    camK.init = true;
  }
  camera.position.copy(G.hitPoint).add(camK.off);
  camera.up.copy(UP); camera.lookAt(G.hitPoint);
  camera.fov = 30; camera.near = 0.05; camera.far = 7000;
}
function attractCamera() {
  const t = U.uTime.value;
  camera.position.set(260 * Math.sin(t * 0.045), 105 + 30 * Math.sin(t * 0.031), -200 - 260 * (0.5 + 0.5 * Math.sin(t * 0.023)));
  camera.up.copy(UP); camera.lookAt(60 * Math.sin(t * 0.05), 70, -1500);
  camera.fov = 40; camera.near = 0.5; camera.far = 7000;
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
  if (G.paused) { Input.pressed.clear(); Input.dx = Input.dy = Input.wheel = 0; return; }
  G.stateT += rdt;
  G.scoreShown = G.scoreShown < G.score ? Math.min(G.score, G.scoreShown + Math.max(37, (G.score - G.scoreShown) * 4 * rdt)) : G.score;
  let gdt = rdt;
  const fire_ = pressed('Space', 'Enter', 'Fire');

  switch (G.state) {
    case 'attract':
      attractCamera();
      if (fire_) startGame();
      break;
    case 'brief':
      updateAim(rdt);
      if (G.stateT > 3.2 || (fire_ && G.stateT > 0.6)) setState('aim');
      break;
    case 'aim': {
      updateAim(rdt);
      G.timeLeft -= rdt;
      if (fire_) { fire(); break; }
      if (G.timeLeft <= 0) {
        G.rounds--; Sfx.deny(); toast('TARGET ESCAPED', 2.5);
        if (G.rounds <= 0) { setState('gameover'); break; }
        Target.spawn(G.stage); G.timeLeft = 60;
      }
      break;
    }
    case 'shot':
      updateAim(rdt);
      gdt = rdt * 0.5;
      if (G.stateT > 0.28) { G.staticAmt = 1; Sfx.staticBurst(0.18); Sfx.flightStart(); camK.init = false; setState('flight'); }
      break;
    case 'flight': {
      // steering input: mouse displaces a self-centring stick, keys push it to the stops
      const kx = (held('ArrowRight', 'KeyD') ? 1 : 0) - (held('ArrowLeft', 'KeyA') ? 1 : 0);
      const ky = (held('ArrowUp', 'KeyW') ? 1 : 0) - (held('ArrowDown', 'KeyS') ? 1 : 0);
      G.stick.x += Input.dx * 0.012; G.stick.y -= Input.dy * 0.012;
      if (kx) G.stick.x = damp(G.stick.x, kx, 9, rdt); if (ky) G.stick.y = damp(G.stick.y, ky, 9, rdt);
      if (!kx && !Input.dx) G.stick.x = damp(G.stick.x, 0, 2.2, rdt);
      if (!ky && !Input.dy) G.stick.y = damp(G.stick.y, 0, 2.2, rdt);
      if (G.stick.length() > 1) G.stick.normalize();
      if (G.auto) Bullet.autopilot(Target.chest, G.stick, 0.7);
      const remaining = Target.chest.distanceTo(Bullet.S.p);
      G.timeScale = G.baseTS * (remaining < 70 ? lerp(0.3, 1, remaining / 70) : 1);
      gdt = rdt * G.timeScale;
      const ev = Bullet.step(gdt, G.stick);
      G.tgtRange = remaining; G.tti = remaining / Math.max(1, Bullet.S.v.length());
      Sfx.flightUpdate(Bullet.S.v.length() / PHYS.v0, G.timeScale, clamp(1 - remaining / 120, 0, 1));
      if (ev) { onBulletEvent(ev); gdt = rdt * 0.1; break; }
      chaseCamera(rdt);
      break;
    }
    case 'killcam': {
      G.timeScale = lerp(0.12, 1, sstep(0.3, 2.6, G.stateT));
      gdt = rdt * G.timeScale;
      killCamera(rdt);
      if (G.stateT > 5.5 || (fire_ && G.stateT > 1.2)) { setState('tally'); G.tallyTick = 0; }
      break;
    }
    case 'misscam':
      G.timeScale = lerp(0.2, 1, sstep(0, 1.5, G.stateT)); gdt = rdt * G.timeScale;
      missCamera(rdt);
      if (G.stateT > 2.6 || (fire_ && G.stateT > 0.8)) {
        Bullet.clearTrail();
        if (G.rounds <= 0) setState('gameover'); else { G.staticAmt = 0.8; Sfx.staticBurst(0.15); setState('aim'); }
      }
      break;
    case 'tally': {
      killCamera(rdt);
      const row = Math.floor((G.stateT - 0.5) / 0.45);
      if (row >= 0 && row <= G.tallyRows.length && row >= (G.tallyTick || 0)) { G.tallyTick = row + 1; Sfx.tick(); }
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
      if (pressed('ArrowUp', 'KeyW')) { G.initials[G.initialPos] = A[(i + 1) % A.length]; Sfx.tick(); }
      if (pressed('ArrowDown', 'KeyS')) { G.initials[G.initialPos] = A[(i - 1 + A.length) % A.length]; Sfx.tick(); }
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
  // world simulation (slow motion aware)
  Target.update(gdt);
  City.updateTraffic(gdt);
  FX.update(gdt, camera.position);
  Bullet.updateVisual(gdt, camera);

  // HUD projections
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  project(Target.chest, G.tgtScreen);
  if (G.state === 'flight' && Bullet.S.active) {
    Bullet.predict(Target.chest, pip); project(pip, G.pipScreen);
  } else G.pipScreen.vis = false;

  Input.pressed.clear(); Input.dx = Input.dy = Input.wheel = 0;
}

// ---- render -------------------------------------------------------------------
function render() {
  const scopeOn = ['brief', 'aim', 'shot', 'gameover', 'initials'].includes(G.state) ? 1 : 0;
  G.scopeAmt = scopeOn;
  const d = Post.display.uniforms, s = Post.sensor.uniforms;
  d.uMode.value = G.mode; d.uScope.value = G.scopeAmt; d.uScopeR.value = G.scopeR; d.uFlash.value = G.flash * 0.6;
  d.uStatic.value = G.staticAmt; d.uFade.value = G.fade;
  s.uPersist.value = G.state === 'flight' ? 0.08 : MODES[G.mode].persist;
  s.uNoise.value = G.mode === 2 ? 0.03 : 0.018;
  U.uCam.value.copy(camera.position);
  City.sky.position.copy(camera.position);
  const pxScale = (innerHeight * Post.pr) / (2 * Math.tan((camera.fov * DEG) / 2));
  FX.setScale(pxScale); City.setPointScale(pxScale);
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
  G, Aim, City, Target, Bullet, Post, camera, fontsReady,
  advance(sec, step = 1 / 60) { const n = Math.max(1, Math.round(sec / step)); for (let i = 0; i < n; i++) tick(step); render(); },
  key(code) { Input.pressed.add(code); },
  start() { startGame(); },
  aimAtTarget(lead = 0) {
    const t = Target.chest; const dx = t.x - PLAYER.eye.x, dy = t.y - PLAYER.eye.y, dz = t.z - PLAYER.eye.z;
    Aim.yaw = Math.atan2(-dx, -dz) + lead; Aim.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  },
  setMag(i) { G.magI = i; G.mag = MAGS[i]; },
  fire() { fire(); },
  setState, setMode(m) { G.mode = m; G.modeName = MODES[m].name; },
};
