// ---------------------------------------------------------------------------
// Thermal materials. Every scene material writes:
//   R = apparent temperature (0 cold sky .. 1 hot skin)
//   G = facet code (normal-derived; used for vector edge lines in post)
//   B = log depth (for edge lines + fog)
// ---------------------------------------------------------------------------
const GLSL_LIB = /* glsl */`
uniform float uTime; uniform vec3 uCam; uniform float uFogD; uniform float uHaze;
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash31(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1.0,0.0)), u.x), mix(hash21(i+vec2(0.0,1.0)), hash21(i+vec2(1.0,1.0)), u.x), u.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s; }
// box-filtered periodic pulse (anti-aliased procedural stripes)
float pint(float x, float a, float b){ return floor(x)*(b-a) + clamp(fract(x), a, b) - a; }
float fpulse(float x, float a, float b, float w){ w = max(w, 1e-4); return clamp((pint(x+0.5*w,a,b) - pint(x-0.5*w,a,b))/w, 0.0, 1.0); }
float band(float x, float c, float hw){ float fw = max(fwidth(x), 1e-4); return clamp((hw - abs(x - c))/fw + 0.5, 0.0, 1.0) * min(1.0, 2.0*hw/fw); }
float sstep(float a, float b, float x){ return smoothstep(a, b, x); }
float fogF(vec3 wp){ return 1.0 - exp(-length(wp - uCam) * uFogD); }
vec4 thermalOut(float t, vec3 wp, vec3 n){
  vec3 V = normalize(uCam - wp);
  t *= 0.88 + 0.12*abs(dot(V, n));               // emissivity falls off at grazing angles
  t = mix(t, uHaze, fogF(wp));
  float facet = 0.5 + 0.5*dot(n, vec3(0.267, 0.802, 0.535));
  float d = length(wp - uCam);
  return vec4(t, facet, log2(1.0 + d) / 13.0, 1.0);
}
vec3 flatN(vec3 wp){ return normalize(cross(dFdx(wp), dFdy(wp))); }
`;

const VS_STD = /* glsl */`
attribute float aSeed; attribute float aStyle;
varying vec3 vW; varying vec3 vN; varying vec3 vL; varying vec3 vS; varying float vSeed; varying float vStyle; varying float vTop;
void main(){
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
  m = m * instanceMatrix;
  #endif
  vec4 wp = m * vec4(position, 1.0);
  vW = wp.xyz; vL = position;
  vS = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
  vN = normalize(mat3(m) * (normal / max(vS*vS, vec3(1e-6))));
  vSeed = aSeed; vStyle = aStyle;
  vTop = (m * vec4(0.0, 1.0, 0.0, 1.0)).y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const VARY = 'varying vec3 vW; varying vec3 vN; varying vec3 vL; varying vec3 vS; varying float vSeed; varying float vStyle; varying float vTop;\n';

function thermalMat(frag, extra = {}, opts = {}) {
  return new THREE.ShaderMaterial(Object.assign({
    uniforms: Object.assign({}, U, extra),
    vertexShader: VS_STD,
    fragmentShader: GLSL_LIB + VARY + frag,
  }, opts));
}

// Buildings: procedural window grid, floor slabs, storefronts, roofs.
const FS_BUILDING = /* glsl */`
void main(){
  vec3 n = normalize(vN);
  float seed = vSeed;
  int st = int(vStyle + 0.5);
  float base = 0.335 + 0.06*(seed - 0.5);
  float t = base;
  if (st >= 3) {
    // plain structural elements: parapets, bulkheads, masts, bridges
    t = (st == 4 ? 0.40 : base - 0.012) + 0.02*(fbm(vW.xz*0.5 + vW.y*0.3) - 0.5);
    if (n.y > 0.5) t -= 0.06;
    if (st == 5) { // skybridge: glazed band
      float yy = (vW.y - (vTop - vS.y));
      float g = band(yy, vS.y*0.5, vS.y*0.28);
      float lit = step(0.5, hash21(vec2(floor((vW.x+vW.z)/3.0), seed*40.0)));
      t = mix(0.37, mix(0.25, 0.5, lit), g * step(abs(n.y), 0.5));
    }
  } else if (n.y > 0.5) {
    float g = fbm(vW.xz*0.13 + seed*31.0);
    t = 0.215 + 0.035*(g - 0.5);
    vec2 sc = vW.xz / vec2(2.4, 7.0);
    t += 0.010*fpulse(sc.x, 0.0, 0.08, fwidth(sc.x));
  } else if (n.y < -0.5) {
    t = base + 0.02;
  } else {
    bool xFace = abs(n.x) > 0.5;
    float faceW = xFace ? vS.z : vS.x;
    float u = ((xFace ? vL.z : vL.x) + 0.5) * faceW;
    float colW = st == 0 ? 1.9 : (st == 1 ? 3.3 : 3.0);
    float flH  = st == 0 ? 3.9 : (st == 1 ? 3.1 : 4.2);
    float corner = st == 0 ? 0.7 : 1.5;
    float usable = max(faceW - 2.0*corner, 0.5);
    float N = max(1.0, floor(usable/colW + 0.5));
    float cx = (u - corner) / usable * N;
    float gf = 5.0;
    float cy = (vW.y - gf) / flH;
    vec2 fw = max(fwidth(vec2(cx, cy)), vec2(1e-4));
    float fwy = max(fwidth(vW.y), 1e-4);
    float mx = st == 0 ? 0.07 : (st == 1 ? 0.30 : 0.16);
    float my0 = st == 0 ? 0.10 : 0.30, my1 = st == 0 ? 0.90 : 0.80;
    float wx = fpulse(cx, mx, 1.0 - mx, fw.x);
    float wy = fpulse(cy, my0, my1, fw.y);
    float inC = clamp(cx/fw.x + 0.5, 0.0, 1.0) * clamp((N - cx)/fw.x + 0.5, 0.0, 1.0);
    float inR = clamp(cy/fw.y + 0.5, 0.0, 1.0) * clamp((vTop - 1.6 - vW.y)/fwy + 0.5, 0.0, 1.0);
    vec2 id = floor(vec2(cx, cy));
    float faceId = xFace ? (n.x > 0.0 ? 1.0 : 2.0) : (n.z > 0.0 ? 3.0 : 4.0);
    float suite = hash31(vec3(floor(id.x/3.0), id.y, seed*113.0 + faceId));
    float h = hash31(vec3(id, seed*71.0 + faceId*13.0));
    float litFrac = 0.10 + 0.28*fract(seed*7.31);
    float lit = step(1.0 - litFrac, suite*0.75 + h*0.25);
    float glass = 0.232 + 0.02*h;
    float warm = 0.47 + 0.15*h;
    float wT = mix(glass, warm, lit);
    float lod = sstep(0.3, 1.0, max(fw.x, fw.y));
    wT = mix(wT, mix(glass, warm, litFrac*0.7), lod);
    float win = wx*wy*inC*inR;
    float c = fract((my1 + my0 + 1.0)*0.5);
    float slab = fpulse(cy, c - 0.05, c + 0.05, fw.y) * inR;
    t = base + 0.03*slab;
    t = mix(t, wT, win);
    // AC units hanging under some residential windows
    if (st == 1) {
      float ac = step(0.93, hash31(vec3(id, seed*5.0 + faceId))) * fpulse(cx, 0.35, 0.65, fw.x) * fpulse(cy, 0.12, 0.27, fw.y) * inR * inC;
      t = mix(t, 0.62, ac * (1.0 - lod));
    }
    // street level storefronts
    float sf = clamp((vW.y - 0.6)/fwy + 0.5, 0.0, 1.0) * clamp((4.1 - vW.y)/fwy + 0.5, 0.0, 1.0);
    float shop = hash31(vec3(floor(u/6.0), seed*7.0, faceId));
    t = mix(t, 0.37 + 0.17*shop, sf * step(0.3, shop) * fpulse(u/6.0, 0.08, 0.92, fwidth(u/6.0)));
    t += 0.016*n.x - 0.008*n.z;
    t += 0.03*(1.0 - sstep(0.0, 14.0, vW.y));
  }
  gl_FragColor = thermalOut(t, vW, n);
}`;

// HVAC units: warm casings, hot fan discs on top
const FS_HVAC = /* glsl */`
void main(){
  vec3 n = normalize(vN);
  float t = 0.46 + 0.08*(vSeed - 0.5);
  if (n.y > 0.5) {
    vec2 c = vL.xz * vS.xz;
    float along = vS.x > vS.z ? c.x : c.y;
    float across = vS.x > vS.z ? c.y : c.x;
    float L = max(vS.x, vS.z), r = min(vS.x, vS.z)*0.36;
    float k = floor(L / (2.6*r)); k = max(k, 1.0);
    float cell = L / k;
    float lc = mod(along + 0.5*L, cell) - 0.5*cell;
    float d = length(vec2(lc, across));
    float fw = max(fwidth(d), 1e-4);
    float disc = clamp((r - d)/fw + 0.5, 0.0, 1.0);
    float hub = clamp((r*0.25 - d)/fw + 0.5, 0.0, 1.0);
    t = mix(0.42, 0.80 + 0.1*vSeed, disc);
    t = mix(t, 0.55, hub);
  } else {
    float y = vL.y * vS.y;
    t += 0.05*fpulse(y*5.0, 0.0, 0.45, fwidth(y*5.0));
  }
  gl_FragColor = thermalOut(t, vW, n);
}`;

// Generic low-poly solid with flat facets (tanks, cones, cranes, figure parts)
const FS_SOLID = /* glsl */`
uniform float uT; uniform float uStripe;
void main(){
  vec3 n = flatN(vW);
  float t = uT + 0.05*(vSeed - 0.5);
  if (uStripe > 0.0) {
    float a = atan(vL.z, vL.x) * 12.0 / 3.14159;
    t += 0.018*fpulse(a, 0.0, 0.18, fwidth(a));
    float y = vL.y * vS.y;
    t += 0.03*fpulse(y/1.6, 0.0, 0.08, fwidth(y/1.6));
    t -= 0.035*(1.0 - vL.y);
  }
  gl_FragColor = thermalOut(t, vW, n);
}`;

// Cars: hot engine bay & exhaust, cold glass
const FS_CAR = /* glsl */`
void main(){
  vec3 n = normalize(vN);
  vec3 l = vL;
  float t = 0.40 + 0.05*(vSeed - 0.5);
  if (l.y > 1.06) t = (n.y > 0.5) ? 0.35 : 0.27;
  if (l.z > 0.9 && l.y > 0.3 && l.y <= 1.06) t = mix(t, 0.74, sstep(0.9, 2.0, l.z));
  if (l.z > 2.1 && n.z > 0.5) t = 0.86;
  if (n.z < -0.5 && l.y < 0.62 && abs(l.x - 0.5) < 0.22) t = 0.95;
  if (l.y < 0.68 && abs(l.x) > 0.8) t = 0.6;
  gl_FragColor = thermalOut(t, vW, n);
}`;

// Ground: roads, sidewalks, markings, manholes
const FS_GROUND = /* glsl */`
uniform vec4 uGrid; uniform vec2 uGrid2;
void main(){
  vec2 p = vW.xz;
  float aveSp = uGrid.x, mainHW = uGrid.y, aveHW = uGrid.z, stSp = uGrid.w, stHW = uGrid2.x, sw = uGrid2.y;
  float ai = floor(p.x/aveSp + 0.5);
  float ax = p.x - ai*aveSp; float adx = abs(ax);
  bool isMain = abs(ai) < 0.5;
  float hwA = isMain ? mainHW : aveHW;
  float noAve = (isMain && p.y > stHW) ? 1.0 : 0.0;
  float si = floor(-p.y/stSp + 0.5);
  float sz = p.y + si*stSp; float sdz = abs(sz);
  float onA = (1.0 - noAve) * (1.0 - step(hwA, adx));
  float onS = (1.0 - step(stHW, sdz)) * step(p.y, stHW + 1.0) ;
  float road = max(onA, onS);
  float walkA = (1.0 - noAve) * (1.0 - step(hwA + sw, adx));
  float walk = max(walkA, (1.0 - step(stHW + sw, sdz)) * step(p.y, stHW + sw + 1.0)) * (1.0 - road);
  float n1 = fbm(p*0.06);
  float t = 0.30 + 0.02*(n1 - 0.5);
  if (road > 0.5) {
    t = 0.392 + 0.035*(n1 - 0.5) + 0.012*(vnoise(p*1.1) - 0.5);
    float paint = 0.0;
    if (onA > 0.5 && onS < 0.5) {
      paint += band(adx, 0.22, 0.07);
      float lane = adx / 3.4;
      float dash = fpulse(p.y/9.0, 0.0, 0.35, fwidth(p.y/9.0));
      for (int k = 1; k <= 4; k++) { if (float(k)*3.4 < hwA - 1.0) paint += band(adx, float(k)*3.4, 0.07) * dash; }
      float cw = step(stHW + 0.8, sdz) * step(sdz, stHW + 4.6);
      paint += cw * fpulse(ax/1.1, 0.0, 0.5, fwidth(ax/1.1));
      paint += band(sdz, stHW + 5.2, 0.2) * step(0.0, ax * sign(sz + 0.001));
      // tyre tracks are warmer
      t += 0.012*(0.5 + 0.5*cos(6.2832*(lane - 0.5)));
      // manholes
      vec2 mh = vec2(mod(ax + 1.7, 3.4) - 1.7, mod(p.y, 41.0) - 20.5);
      float md = length(mh);
      t = mix(t, 0.56, clamp((0.42 - md)/max(fwidth(md),1e-4) + 0.5, 0.0, 1.0) * step(0.7, hash21(floor(vec2(ax/3.4, p.y/41.0)))));
    } else if (onS > 0.5 && onA < 0.5) {
      paint += band(sdz, 0.15, 0.06) * fpulse(p.x/7.0, 0.0, 0.4, fwidth(p.x/7.0));
    }
    t -= 0.04*clamp(paint, 0.0, 1.0);
  } else if (walk > 0.5) {
    t = 0.325 + 0.012*(n1 - 0.5);
    vec2 g = p/1.6; vec2 fw = fwidth(g);
    t -= 0.012*max(fpulse(g.x, 0.0, 0.05, fw.x), fpulse(g.y, 0.0, 0.05, fw.y));
    float curbA = band(adx, hwA + 0.15, 0.15) * (1.0 - noAve);
    t += 0.03*curbA;
  }
  gl_FragColor = thermalOut(t, vW, vec3(0.0, 1.0, 0.0));
}`;

const FS_SKY = /* glsl */`
void main(){
  vec3 d = normalize(vW - uCam);
  float h = d.y;
  float t = mix(uHaze, 0.045, pow(clamp(h, 0.0, 1.0), 0.42));
  if (h > 0.0) {
    vec2 cp = d.xz / (h + 0.06) * 1.4 + vec2(uTime*0.003, uTime*0.001);
    float c = smoothstep(0.48, 0.85, fbm(cp));
    t += c * 0.075 * (1.0 - smoothstep(0.0, 0.7, h));
  } else t = uHaze;
  gl_FragColor = vec4(t, 0.5, 1.0, 1.0);
}`;

// Point lights (aviation beacons, lamp heads) – always at least a few pixels wide
const LightPoints = (() => {
  const VS = /* glsl */`
  uniform float uTime; uniform float uScale; uniform vec3 uCam; uniform float uFogD; uniform float uHaze;
  attribute float aPhase; attribute float aKind; attribute float aSize;
  varying float vHeat;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = -mv.z;
    float blink = aKind < 0.5 ? step(fract(uTime*0.5 + aPhase), 0.14) : 1.0;
    float heat = aKind < 0.5 ? mix(0.0, 0.85, blink) : 0.55;
    float f = 1.0 - exp(-d * uFogD * 0.8);
    vHeat = heat * (1.0 - f);
    gl_PointSize = clamp(aSize * uScale / d, 2.2, 48.0);
    gl_Position = projectionMatrix * mv;
  }`;
  const FS = /* glsl */`
  varying float vHeat;
  void main(){
    vec2 c = gl_PointCoord - 0.5; float r = length(c)*2.0;
    float a = exp(-r*r*5.0);
    if (r > 1.0) discard;
    gl_FragColor = vec4(vHeat * a, 0.0, 0.0, 1.0);
  }`;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uCam: U.uCam, uFogD: U.uFogD, uHaze: U.uHaze, uScale: { value: 500 } },
    vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return { mat };
})();
