import * as THREE from 'three';

// ---------------------------------------------------------------------------
// XACTO core: math helpers, RNG, shared uniforms, world constants
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2, DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const QS = new URLSearchParams(location.search);
const TEST = QS.has('test');
const BASE_SEED = parseInt(QS.get('seed') || '', 10) || 0;

// City RNG is re-seeded every time a new city is generated.
let cityRand = mulberry32(1987);
const crnd = (a = 0, b = 1) => a + (b - a) * cityRand();
const reseedCity = (s) => { cityRand = mulberry32(s >>> 0); };
// Gameplay RNG
const gameRand = TEST ? mulberry32((BASE_SEED || 1987) * 31 + 7) : Math.random;
const grnd = (a = 0, b = 1) => a + (b - a) * gameRand();
const newSeed = () => (TEST ? ((BASE_SEED || 1987) + (newSeed.n = (newSeed.n || 0) + 1) * 7919) : ((Math.random() * 0x7fffffff) | 0));

function gauss(r = Math.random) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * r()); }
// Exact discretisation of an Ornstein-Uhlenbeck process (stationary std = sigma)
class OU {
  constructor(tau, sigma, r) { this.tau = tau; this.sigma = sigma; this.r = r || gameRand; this.x = 0; }
  step(dt) { const a = Math.exp(-dt / this.tau); this.x = this.x * a + this.sigma * Math.sqrt(Math.max(0, 1 - a * a)) * gauss(this.r); return this.x; }
  reset(v = 0) { this.x = v; }
}
const Store = {
  get(k, d) { try { const v = localStorage.getItem('xacto.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('xacto.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

// Shared uniforms (referenced by every thermal material)
const U = {
  uTime: { value: 0 },
  uCam: { value: new THREE.Vector3() },
  uFogD: { value: 0.00036 },
  uHaze: { value: 0.30 },
};

// City grid layout (metres). Main avenue runs along -Z from the player.
const GRID = { aveSp: 150, mainHW: 18, aveHW: 11, stSp: 95, stHW: 8, sw: 5, nAve: 7, nSt: 34 };
// .50 BMG-ish ballistics: quadratic drag dv/dt = -k|v|v
const PHYS = { g: 9.81, v0: 880, k: 3.0e-4 };
const PLAYER = { eye: new THREE.Vector3(0, 71.35, 14.6), roofY: 70 };
const UP = new THREE.Vector3(0, 1, 0);
