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
float fbm2(vec2 p){ return 0.667*vnoise(p) + 0.333*vnoise(p*2.03 + 17.1); }
// box-filtered periodic pulse (anti-aliased procedural stripes)
float pint(float x, float a, float b){ return floor(x)*(b-a) + clamp(fract(x), a, b) - a; }
float fpulse(float x, float a, float b, float w){ w = max(w, 1e-4); return clamp((pint(x+0.5*w,a,b) - pint(x-0.5*w,a,b))/w, 0.0, 1.0); }
float band(float x, float c, float hw){ float fw = max(fwidth(x), 1e-4); return clamp((hw - abs(x - c))/fw + 0.5, 0.0, 1.0) * min(1.0, 2.0*hw/fw); }
float sstep(float a, float b, float x){ return smoothstep(a, b, x); }
// fog: clear to ~300 m, gathering from ~400 m (about 25 % at 1 km, 65 % at 2 km)
float fogF(vec3 wp){ float x = max(length(wp - uCam) - 300.0, 0.0) * uFogD * 1.75; return 1.0 - exp(-x*sqrt(x)); }
vec4 thermalOut(float t, vec3 wp, vec3 n){
  vec3 V = normalize(uCam - wp);
  t *= 0.88 + 0.12*abs(dot(V, n));               // emissivity falls off at grazing angles
  // hot sources punch through the haze (a person at 2 km must still be the hottest thing in view)
  t = mix(t, uHaze + 0.015, fogF(wp) * mix(1.0, 0.35, sstep(0.5, 0.75, t)));
  float facet = 0.5 + 0.5*dot(n, vec3(0.267, 0.802, 0.535));
  float d = length(wp - uCam);
  return vec4(t, facet, log2(1.0 + d) / 13.0, 1.0);
}
vec3 flatN(vec3 wp){ return normalize(cross(dFdx(wp), dFdy(wp))); }
// City surfaces: three depth layers. Contrast and facet-edge strength fall off toward the
// skyline, and a faint haze hangs over the streets.
vec4 thermalOutC(float t, vec3 wp, vec3 n){
  float d = length(wp - uCam);
  // middle and skyline layers lose contrast toward the dark night haze; street canyons hold a
  // faint low haze that stays below roughly street-canyon height
  float far = sstep(900.0, 3500.0, d) * 0.2;
  float low = exp(-max(wp.y, 0.0) / 7.0) * sstep(120.0, 900.0, d) * 0.3;
  t = mix(t, uHaze + 0.02, clamp(far + low, 0.0, 0.8));
  vec4 o = thermalOut(t, wp, n);
  o.g = 0.5 + (o.g - 0.5) * (1.0 - 0.75*sstep(250.0, 2200.0, d));
  return o;
}
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

// Parapet ring: one instance per roof. Inner-wall vertices (aIn = 1) are pulled in
// by a fixed wall thickness in metres, independent of the instance's xz scale.
const VS_RING = /* glsl */`
attribute float aSeed; attribute float aStyle; attribute float aIn;
uniform float uRingT;
varying vec3 vW; varying vec3 vN; varying vec3 vL; varying vec3 vS; varying float vSeed; varying float vStyle; varying float vTop;
void main(){
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
  m = m * instanceMatrix;
  #endif
  vS = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
  vec3 p = position;
  if (aIn > 0.5) p.xz = sign(p.xz) * max(vec2(0.5) - vec2(uRingT) / max(vS.xz, vec2(1e-3)), vec2(0.0));
  vec4 wp = m * vec4(p, 1.0);
  vW = wp.xyz; vL = p;
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

// Buildings and structural boxes. No discard in here (keeps early-z on the
// city's biggest draw call). Temperatures are kept below ~0.45 so the man, the muzzle
// and the bullet own the top of the gain range. Styles:
//   0 glass curtain wall   1 brick residential   2 concrete office   3 plain structure
//   4 warm panel / sign    5 skybridge           7 corrugated metal shed
//   8 steel / cable (cold) 9 helipad slab        10 art-deco stone
//   11 parking structure   12 stair bulkhead (door + louvre)
const FS_BUILDING = /* glsl */`
void main(){
  vec3 n = normalize(vN);
  float seed = vSeed;
  int st = int(vStyle + 0.5);
  // per-building base temperature: wide spread so neighbours separate in every palette
  float base = (st == 0 ? 0.300 : st == 1 ? 0.350 : st == 7 ? 0.290 : st == 10 ? 0.342 : st == 11 ? 0.326 : 0.322) + 0.07*(seed - 0.5);
  float t = base;
  // detail that only resolves close up: fades in with screen-space size (metres per pixel)
  float mpp = max(length(fwidth(vW)), 1e-4);
  float nearK = 1.0 - sstep(0.05, 0.16, mpp);
  float midK = 1.0 - sstep(0.2, 0.7, mpp);
  float fwy = max(fwidth(vW.y), 1e-4);
  float fromTop = vTop - vW.y;
  bool xFace = abs(n.x) > 0.5;
  float faceW = xFace ? vS.z : vS.x;
  float u = ((xFace ? vL.z : vL.x) + 0.5) * faceW;
  float faceId = xFace ? (n.x > 0.0 ? 1.0 : 2.0) : (n.z > 0.0 ? 3.0 : 4.0);
  if (st == 8) {
    t = 0.27 + 0.02*seed;   // cold steel: darker than walls, but a readable mid-dark grey, never a black slab
  } else if (st == 13) {
    // exhaust caps / chimney pots: small hot accents, below the man
    t = mix(0.36, 0.47 + 0.05*seed, sstep(0.0, 0.6, 1.0 - fromTop/max(vS.y, 1e-3)) * 0.3 + 0.7*step(0.5, n.y));
    t = max(t, 0.42 + 0.04*seed);
  } else if (st == 14) {
    // equipment curb: roof warmed by the unit standing on it, fading toward the edges
    vec2 q = abs(vL.xz)*2.0;
    float r = max(q.x, q.y);
    t = n.y > 0.5 ? mix(0.30, 0.235, sstep(0.45, 1.0, r)) : 0.26;
  } else if (st == 15) {
    // street steam grate: warm slots
    vec2 q = vL.xz * vS.xz;
    float slot = fpulse(q.x/0.2, 0.0, 0.5, fwidth(q.x/0.2)) * (1.0 - sstep(0.15, 0.35, fwidth(q.x/0.2)));
    t = n.y > 0.5 ? 0.40 + 0.04*slot : 0.33;
  } else if (st == 9) {
    // helipad: painted circle + H on a cold deck
    t = 0.235;
    if (n.y > 0.5) {
      vec2 q = vL.xz * vS.xz; float R = 0.42*min(vS.x, vS.z);
      float r = length(q);
      float ring = band(r, R, 0.32);
      vec2 h = abs(q) / R;
      float H = (step(h.x, 0.42) * step(h.y, 0.55)) * max(step(0.28, h.x), step(h.y, 0.07));
      t = mix(t, 0.30, max(ring, H));
    }
  } else if (st == 3 || st == 4 || st == 5 || st == 12) {
    // plain structural elements: parapets, bulkheads, masts, bridges
    t = base - 0.012 + 0.015*(vnoise(vW.xz*0.5 + vW.y*0.3) - 0.5);
    if (n.y > 0.5) t = 0.235;
    else {
      // coping cap along the top edge
      t += 0.02*clamp((0.14 - fromTop)/fwy + 0.5, 0.0, 1.0) * midK;
      if (st == 12) {
        float y0 = vW.y - (vTop - vS.y);
        float doorF = 1.0 + floor(fract(seed*3.7)*4.0);
        float dc = faceW*0.5;
        float door = step(abs(faceId - doorF), 0.5) * clamp((0.55 - abs(u - dc))/fwidth(u) + 0.5, 0.0, 1.0) * clamp((2.15 - y0)/fwy + 0.5, 0.0, 1.0);
        float frameD = door * (1.0 - clamp((0.47 - abs(u - dc))/fwidth(u) + 0.5, 0.0, 1.0) * clamp((2.07 - y0)/fwy + 0.5, 0.0, 1.0));
        t = mix(t, 0.37, door * midK);                 // door leaks stairwell heat
        t = mix(t, 0.30, frameD * nearK);
        float louv = step(0.5, abs(faceId - doorF)) * step(abs(u - dc), 0.6) * step(abs(fromTop - 0.8), 0.35);
        t = mix(t, 0.33 - 0.03*fpulse(y0*7.0, 0.0, 0.5, fwidth(y0*7.0)), louv * nearK);
      }
    }
    if (st == 4 && abs(n.y) < 0.5) {
      // lit sign panel: lamps along the top edge heat the face, cools downward
      float yy = (vW.y - (vTop - vS.y)) / max(vS.y, 1e-3);
      float fr = max(band(yy, 0.04, 0.04), band(u/max(faceW, 1e-3), 0.02, 0.02) + band(u/max(faceW, 1e-3), 0.98, 0.02));
      t = 0.315 + 0.07*yy*yy;
      t = mix(t, 0.27, clamp(fr, 0.0, 1.0)*midK);
    }
    if (st == 5) { // skybridge: glazed band
      float yy = (vW.y - (vTop - vS.y));
      float g = band(yy, vS.y*0.52, vS.y*0.3);
      float lit = step(0.55, hash21(vec2(floor((vW.x+vW.z)/3.0), seed*40.0)));
      float spandrel = band(yy, vS.y*0.12, vS.y*0.06);
      t = mix(0.345, mix(0.27, 0.42, lit), g * step(abs(n.y), 0.5));
      t = mix(t, 0.37, spandrel * step(abs(n.y), 0.5));
      if (n.y > 0.5) t = 0.25;
      if (n.y < -0.5) t = 0.40;                       // heated corridor floor: warm underside
    }
  } else if (n.y > 0.5) {
    // roofs radiate to the cold sky: coldest surfaces in the city; membrane seams close up
    float g = fbm2(vW.xz*0.13 + seed*31.0);
    t = 0.212 + 0.03*(g - 0.5) + 0.02*(seed - 0.5);
    t += 0.012*(vnoise(vW.xz*0.7 + seed*5.0) - 0.5) * midK;      // gravel ballast
    vec2 sc = vW.xz / vec2(1.0, 6.0);
    t += 0.012*fpulse(sc.x, 0.0, 0.05, fwidth(sc.x))*nearK + 0.008*fpulse(sc.y, 0.0, 0.02, fwidth(sc.y))*nearK;
    // membrane panels (2 x 6 m) with their own tone, tar patches, roof drains
    t += 0.012*(hash21(floor(vW.xz / vec2(2.0, 6.0)) + seed*9.0) - 0.5)*midK;
    float tar = sstep(0.62, 0.66, vnoise(vW.xz*0.09 + seed*13.0));
    t = mix(t, t + 0.018, tar*midK);
    vec2 dq = mod(vW.xz + seed*37.0, 12.0) - 6.0;
    t -= 0.02*clamp((0.28 - length(dq))/max(fwidth(length(dq)), 1e-4) + 0.5, 0.0, 1.0)*nearK;
    if (st == 11) t += 0.03;                          // parking deck keeps a little heat
  } else if (n.y < -0.5) {
    t = base + 0.02;
  } else if (st == 11) {
    // parking structure: open decks, concrete upstands, columns, a few warm engines
    float ly = vW.y / 3.2; float fl = fwidth(ly);
    float open = fpulse(ly, 0.36, 0.92, fl) * clamp((fromTop - 0.4)/fwy + 0.5, 0.0, 1.0);
    float col = fpulse(u/7.5, 0.0, 0.07, fwidth(u/7.5));
    float car = step(0.55, hash21(vec2(floor(u/2.6), floor(ly) + seed*17.0))) * fpulse(u/2.6, 0.15, 0.85, fwidth(u/2.6)) * fpulse(ly, 0.36, 0.62, fl);
    t = base + 0.015*fpulse(ly, 0.0, 0.12, fl);
    t = mix(t, mix(0.262, 0.385, car*midK), open*(1.0 - col));
  } else {
    float colW = st == 0 ? 1.9 : st == 1 ? 3.0 : st == 7 ? 6.0 : st == 10 ? 2.6 : 2.8;
    float flH  = st == 0 ? 3.9 : st == 1 ? 3.5 : st == 7 ? 6.5 : st == 10 ? 3.8 : 3.8;
    float corner = st == 0 ? 0.7 : 1.5;
    float usable = max(faceW - 2.0*corner, 0.5);
    float N = max(1.0, floor(usable/colW + 0.5));
    float cx = (u - corner) / usable * N;
    float gf = 5.0;
    float cy = (vW.y - gf) / flH;
    vec2 fw = max(fwidth(vec2(cx, cy)), vec2(1e-4));
    float mx = st == 0 ? 0.07 : st == 1 ? 0.28 : st == 2 ? 0.08 : st == 10 ? 0.30 : 0.38;
    float my0 = st == 0 ? 0.32 : st == 1 ? 0.30 : st == 2 ? 0.36 : st == 7 ? 0.70 : 0.32;
    float my1 = st == 0 ? 0.80 : st == 1 ? 0.76 : st == 2 ? 0.78 : st == 7 ? 0.88 : 0.77;
    float wx = fpulse(cx, mx, 1.0 - mx, fw.x);
    float wy = fpulse(cy, my0, my1, fw.y);
    float inC = clamp(cx/fw.x + 0.5, 0.0, 1.0) * clamp((N - cx)/fw.x + 0.5, 0.0, 1.0);
    float topStop = (st == 1 || st == 10) ? 2.4 : 1.6;   // classic blocks keep room for a cornice
    float inR = clamp(cy/fw.y + 0.5, 0.0, 1.0) * clamp((vTop - topStop - vW.y)/fwy + 0.5, 0.0, 1.0);
    vec2 id = floor(vec2(cx, cy));
    float suite = hash31(vec3(floor(id.x/3.0), id.y, seed*113.0 + faceId));
    float h = hash31(vec3(id, seed*71.0 + faceId*13.0));
    float litFrac = (st == 7 ? 0.03 : 0.05) + 0.13*fract(seed*7.31);
    float lit = step(1.0 - litFrac, suite*0.75 + h*0.25);
    // glass is a dim mirror of the sky: mid-dark, colder toward the top of each pane
    float pane = clamp((fract(cy) - my0)/(my1 - my0), 0.0, 1.0);
    float glass = 0.248 + 0.02*h - 0.012*pane;
    float warm = 0.41 + 0.03*h;                        // occupied, heated rooms: warm, never white
    float wT = mix(glass, warm, lit);
    float open = step(0.985, hash31(vec3(id, seed*29.0 + faceId*7.0))) * step(0.5, fract(seed*19.3)) * float(st != 0 && st != 7);
    wT = mix(wT, 0.46 + 0.04*h, open);
    float lod = sstep(0.25, 0.9, max(fw.x, fw.y));
    float win = wx*wy*inC*inR;
    // window frames: thin warm surround, only once the frame spans a pixel
    float fx = 0.08/colW, fy = 0.08/flH;
    float glassA = fpulse(cx, mx + fx, 1.0 - mx - fx, fw.x) * fpulse(cy, my0 + fy, my1 - fy, fw.y) * inC * inR;
    float frame = clamp(win - glassA, 0.0, 1.0) * nearK;
    float meanWin = mix(0.245, 0.385, litFrac);
    // floor bands at every slab line (thermal bridges)
    float slab = fpulse(cy, -0.025, 0.025, fw.y) * inR;
    t = base + 0.02*slab*midK;
    if (st == 0) {
      // curtain wall: spandrel panels are warmer than the vision glass, mullions are thermal bridges
      float mulK = sstep(1.2, 2.5, 0.08/max(fw.x, 1e-4));          // mullion at least ~2 px wide
      t = base + 0.015*slab + 0.02*fpulse(cx, -0.04, 0.04, fw.x)*inR*mulK;
    } else if (st == 7) {
      // corrugated metal: low emissivity, vertical ribs
      float rib = vW.x*1.6 + vW.z*1.6;
      t = base + 0.014*fpulse(rib, 0.0, 0.5, fwidth(rib)) * (1.0 - sstep(0.12, 0.25, fwidth(rib)));
    } else if (st == 10) {
      // art-deco pilasters between the window stacks
      t = base + 0.02*(1.0 - fpulse(cx, 0.18, 0.82, fw.x)) + 0.02*slab*midK;
    }
    float wMean = mix(t, meanWin, (1.0 - 2.0*mx) * (my1 - my0));
    float tw = mix(t, wT, win);
    tw = mix(tw, base + 0.018, frame);
    // sills: a cold projecting ledge under each punched window
    if (st == 1 || st == 2 || st == 10) {
      float sill = fpulse(cx, mx - 0.04, 1.0 - mx + 0.04, fw.x) * fpulse(cy, my0 - 0.045, my0, fw.y) * inC * inR;
      tw = mix(tw, base - 0.03, sill * midK);
    }
    t = mix(tw, wMean, lod);
    if (st == 1) {
      // AC units under some windows
      float ac = step(0.94, hash31(vec3(id, seed*5.0 + faceId))) * fpulse(cx, 0.35, 0.65, fw.x) * fpulse(cy, 0.12, 0.27, fw.y) * inR * inC;
      t = mix(t, 0.40, ac * (1.0 - lod));
      // fire escape on one face of some walk-ups: platforms, rails and zig-zag stairs
      float feOn = step(0.4, fract(seed*5.13)) * step(abs(faceId - (1.0 + floor(fract(seed*3.7)*4.0))), 0.5);
      float k0 = floor(fract(seed*11.3) * max(N - 2.0, 1.0));
      float lx = (cx - k0) / 2.0;
      float inFE = feOn * step(0.0, lx) * step(lx, 1.0) * step(gf + flH*0.7, vW.y) * inR;
      if (inFE > 0.0) {
        float fy2 = cy - my0 + 0.12;
        float ly = fract(fy2);
        float plat = fpulse(fy2, 0.0, 0.085, fw.y);
        float rail = fpulse(fy2, 0.29, 0.33, fw.y);
        float post = fpulse(lx*4.0, 0.0, 0.08, fwidth(lx*4.0)) * step(ly, 0.33);
        float sx = mix(lx, 1.0 - lx, mod(floor(fy2), 2.0));
        float stair = max(band(sx - ly, 0.0, 0.055), band(sx - ly, 0.09, 0.025));
        float steel = max(max(plat, max(rail, post)*0.85), stair) * (1.0 - lod);
        t = mix(t, 0.245, steel * inFE);
      }
    }
    // cornice on classic blocks: cold projecting band with a warm lip
    if (st == 1 || st == 10) {
      float cor = clamp((fromTop - 0.35)/fwy + 0.5, 0.0, 1.0) * clamp((1.15 - fromTop)/fwy + 0.5, 0.0, 1.0);
      float lip = clamp((fromTop - 1.15)/fwy + 0.5, 0.0, 1.0) * clamp((1.32 - fromTop)/fwy + 0.5, 0.0, 1.0);
      t = mix(t, base - 0.025, cor);
      t = mix(t, base + 0.02, lip * midK);
    }
    // street level: storefronts, or roll-up doors on sheds
    float sfTop = st == 7 ? 4.6 : 4.1;
    float sf = clamp((vW.y - 0.6)/fwy + 0.5, 0.0, 1.0) * clamp((sfTop - vW.y)/fwy + 0.5, 0.0, 1.0);
    float shop = hash31(vec3(floor(u/(st == 7 ? 9.0 : 6.0)), seed*7.0, faceId));
    if (st == 7) {
      float door = fpulse(u/9.0, 0.22, 0.78, fwidth(u/9.0));
      float ribs = fpulse(vW.y*3.0, 0.0, 0.5, fwidth(vW.y*3.0));
      float dT = step(0.8, shop) > 0.5 ? 0.39 : 0.30 + 0.012*ribs*midK;
      t = mix(t, dT, sf * step(0.35, shop) * door);
    } else {
      float sfT = 0.33 + 0.09*shop;
      t = mix(t, sfT, sf * step(0.3, shop) * fpulse(u/6.0, 0.08, 0.92, fwidth(u/6.0)));
    }
    t += 0.012*n.x - 0.006*n.z;
    t += 0.02*(1.0 - sstep(0.0, 14.0, vW.y));
  }
  gl_FragColor = thermalOutC(t, vW, n);
}`;

// Open steel lattice (masts, crane trusses, scaffolding, bridge trusses). Uses discard,
// so it lives in its own draw call. Bars are only cut out while they are wider than a
// pixel; further away the panel turns solid at the averaged temperature (no speckle).
const FS_LATTICE = /* glsl */`
void main(){
  vec3 n = normalize(vN);
  bool xF = abs(n.x) > 0.5; bool yF = abs(n.y) > 0.5;
  float fwid = yF ? vS.x : (xF ? vS.z : vS.x);
  float u = yF ? (vL.x + 0.5)*vS.x : ((xF ? vL.z : vL.x) + 0.5)*fwid;
  float v = yF ? (vL.z + 0.5)*vS.z : vL.y*vS.y;
  float cell = yF ? min(vS.x, vS.z) : min(fwid, vS.y);
  cell = min(cell, 2.6);
  vec2 q = vec2(u, v)/cell; vec2 f = fract(q);
  float lw = 0.1;
  float px = max(fwidth(q.x), fwidth(q.y));
  float t0 = 0.295 + 0.03*(vSeed - 0.5);   // steel reads mid-dark grey, never a black void
  float t = t0;
  // cut the bars out only when they are several pixels wide; every cut-out bar is outlined by
  // the edge pass, so smaller ones would read as a bright smear
  if (px < 0.025) {
    float edge = max(max(step(f.x, lw), step(1.0-lw, f.x)), max(step(f.y, lw), step(1.0-lw, f.y)));
    float br = max(step(abs(f.x - f.y), lw), step(abs(f.x + f.y - 1.0), lw));
    if (max(edge, br) < 0.5) discard;
  } else {
    t = t0 - 0.012;                     // solid panel: bars averaged with the gaps
  }
  gl_FragColor = thermalOutC(t, vW, n);
}`;

// HVAC units: casings at wall temperature; only the fan discs run warm
const FS_HVAC = /* glsl */`
void main(){
  vec3 n = normalize(vN);
  float mpp = max(length(fwidth(vW)), 1e-4);
  float nearK = 1.0 - sstep(0.04, 0.12, mpp);
  float t = 0.335 + 0.03*(vSeed - 0.5);
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
    float lod = sstep(0.15, 0.6, fw/max(r, 1e-3));
    // fan guard: a ring and four spokes, close up only
    float ang = atan(across, lc);
    float spoke = fpulse(ang*0.6366, -0.06, 0.06, fwidth(ang*0.6366)) * nearK;
    float guard = band(d, r*0.62, 0.03) * nearK;
    t = mix(0.32, 0.46 + 0.06*vSeed, mix(disc, 0.35, lod));
    t = mix(t, 0.40, max(hub, max(spoke, guard)*disc)*(1.0 - lod));
  } else {
    // louvred casing with panel seams
    float y = vL.y * vS.y;
    float lv = y*3.5;
    t += 0.016*fpulse(lv, 0.0, 0.45, fwidth(lv)) * (1.0 - sstep(0.1, 0.25, fwidth(lv)));
    float uu = (abs(n.x) > 0.5 ? vL.z*vS.z : vL.x*vS.x);
    t -= 0.012*fpulse(uu/1.2, 0.0, 0.06, fwidth(uu/1.2)) * nearK;
  }
  gl_FragColor = thermalOutC(t, vW, n);
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

// Faceted shapes with per-face temperature: sloped faces radiate to the sky (cold),
// vertical faces read as glazing (sawtooth north lights) or warm stone (crowns).
//   uKind 0: pyramid / crown cap   1: sawtooth roof   2: cooling tower shell   3: dish
const FS_SHAPE = /* glsl */`
uniform float uT; uniform float uKind;
void main(){
  vec3 n = flatN(vW);
  int k = int(uKind + 0.5);
  float t = uT + 0.05*(vSeed - 0.5);
  if (k == 1) {
    if (abs(n.y) < 0.3) {
      float y = vL.y;
      float g = fpulse(vW.x/1.5 + vW.z/1.5, 0.08, 0.92, fwidth(vW.x/1.5 + vW.z/1.5));
      float lit = step(0.72, hash21(vec2(floor((vW.x + vW.z)/12.0), vSeed*31.0)));
      t = mix(0.30, mix(0.25, 0.40, lit), g * step(0.12, y) * step(y, 0.9));
    } else t = 0.215 + 0.012*fpulse(vW.x/0.9 + vW.z/0.9, 0.0, 0.4, fwidth(vW.x/0.9 + vW.z/0.9));
  } else if (k == 2) {
    // hyperboloid cooling tower: warm, hottest near the lip (exhaust heats the shell)
    t = uT + 0.10*vL.y*vL.y + 0.02*(vSeed - 0.5);
    float y = vW.y / 2.2;
    t += 0.012*fpulse(y, 0.0, 0.12, fwidth(y));
    if (!gl_FrontFacing) t = 0.44 + 0.08*vL.y;
  } else if (k == 3) {
    // dish: grey bowl, darker inner face (it sees the cold sky), bright rim line
    float rim = 1.0 - sstep(0.88, 0.97, vL.y);
    t = gl_FrontFacing ? uT : uT - 0.035;
    t = mix(uT + 0.04, t, rim);
  } else {
    t += (n.y > 0.35 ? -0.03 : 0.02) + 0.015*fpulse(vW.y/2.0, 0.0, 0.15, fwidth(vW.y/2.0));
  }
  gl_FragColor = thermalOutC(t, vW, n);
}`;

// Cars: hot engine bay & exhaust, cold glass
const FS_CAR = /* glsl */`
void main(){
  vec3 n = normalize(vN);
  vec3 l = vL;
  float t = 0.37 + 0.04*(vSeed - 0.5);
  if (l.y > 1.06) t = (n.y > 0.5) ? 0.33 : 0.27;
  if (l.z > 0.9 && l.y > 0.3 && l.y <= 1.06) t = mix(t, 0.50, sstep(0.9, 2.0, l.z));
  if (l.z > 2.1 && n.z > 0.5) t = 0.54;
  if (n.z < -0.5 && l.y < 0.62 && abs(l.x - 0.5) < 0.22) t = 0.64;
  if (l.y < 0.68 && abs(l.x) > 0.8) t = 0.44;
  gl_FragColor = thermalOutC(t, vW, n);
}`;

// Ground: roads, sidewalks, markings, manholes, river, parks
const FS_GROUND = /* glsl */`
uniform vec4 uGrid; uniform vec2 uGrid2; uniform vec4 uRiver; uniform vec4 uPark0; uniform vec4 uPark1;
float inRect(vec2 p, vec4 r){ return step(r.x, p.x) * step(p.x, r.z) * step(r.y, p.y) * step(p.y, r.w); }
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
  float n1 = fbm2(p*0.06);
  float t = 0.30 + 0.02*(n1 - 0.5);
  float water = uRiver.z * step(uRiver.x, p.y) * step(p.y, uRiver.y) * (1.0 - step(adx, hwA + sw));
  float park = max(inRect(p, uPark0), inRect(p, uPark1)) * (1.0 - walk) * (1.0 - road);
  if (water > 0.5) {
    // river: warmer than the night air, but a near-mirror for the cold sky at grazing angles
    vec3 V = normalize(uCam - vW);
    float fr = 0.03 + 0.97*pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
    vec2 wp = vec2(p.x*0.05 + uTime*0.04, p.y*0.6);
    float rip = vnoise(wp) * vnoise(wp*2.7 + 3.1);
    t = mix(0.35 + 0.02*rip, 0.14 + 0.08*rip, fr*0.9);
  } else if (park > 0.5) {
    // grass radiates to the sky: colder than paving; gravel paths a touch warmer
    t = 0.255 + 0.025*(fbm2(p*0.35) - 0.5);
    float d1 = abs(fract((p.x + p.y)/38.0) - 0.5)*38.0, d2 = abs(fract((p.x - p.y)/38.0) - 0.5)*38.0;
    float path = max(band(d1, 0.0, 1.1), band(d2, 0.0, 1.1));
    t = mix(t, 0.30, path);
  } else if (road > 0.5) {
    t = 0.365 + 0.03*(n1 - 0.5) + 0.01*(vnoise(p*1.1) - 0.5);
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
      t += 0.014*(0.5 + 0.5*cos(6.2832*(lane - 0.5)));
      // manholes
      vec2 mh = vec2(mod(ax + 1.7, 3.4) - 1.7, mod(p.y, 41.0) - 20.5);
      float md = length(mh);
      t = mix(t, 0.44, clamp((0.42 - md)/max(fwidth(md),1e-4) + 0.5, 0.0, 1.0) * step(0.7, hash21(floor(vec2(ax/3.4, p.y/41.0)))));
    } else if (onS > 0.5 && onA < 0.5) {
      paint += band(sdz, 0.15, 0.06) * fpulse(p.x/7.0, 0.0, 0.4, fwidth(p.x/7.0));
    }
    t -= 0.04*clamp(paint, 0.0, 1.0);
  } else if (walk > 0.5) {
    t = 0.318 + 0.012*(n1 - 0.5);
    vec2 g = p/1.6; vec2 fw = fwidth(g);
    t -= 0.012*max(fpulse(g.x, 0.0, 0.05, fw.x), fpulse(g.y, 0.0, 0.05, fw.y));
    float curbA = band(adx, hwA + 0.15, 0.15) * (1.0 - noAve);
    t += 0.03*curbA;
  }
  gl_FragColor = thermalOutC(t, vW, vec3(0.0, 1.0, 0.0));
}`;

const FS_SKY = /* glsl */`
void main(){
  vec3 d = normalize(vW - uCam);
  float h = d.y;
  float hc = clamp(h, 0.0, 1.0);
  float t = mix(uHaze, 0.08, sstep(0.0, 0.7, sqrt(hc)));     // faint glow of city heat along the horizon
  if (h > 0.0) {
    // cloud deck: real shapes, underlit by the city, darker and thinner toward the zenith
    vec2 cp = d.xz / (h + 0.1) * 0.9 + vec2(uTime*0.002, uTime*0.0007);
    float c = sstep(0.46, 0.78, fbm(cp*vec2(0.7, 1.2)));
    float lit = mix(0.17, 0.10, sstep(0.0, 0.45, h));
    t = mix(t, max(t, lit + 0.05*fbm(cp*3.1 + 4.0)), c * (1.0 - sstep(0.25, 0.75, h)));
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
    float heat = aKind < 0.5 ? mix(0.0, 0.72, blink) : 0.46;
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

// City copy of FS_SOLID (tanks, cones, trees) with depth layering
const FS_SOLID_C = FS_SOLID.replace('thermalOut(t, vW, n)', 'thermalOutC(t, vW, n)');

// Tanks: hoop bands only, smooth shading code so the post pass draws the silhouette, not every stave
const FS_TANK = /* glsl */`
uniform float uT;
void main(){
  vec3 n = normalize(vN);
  float t = uT + 0.03*(vSeed - 0.5);
  float y = vL.y * vS.y;
  t += 0.02*fpulse(y/1.6, 0.0, 0.08, fwidth(y/1.6)) * (1.0 - sstep(0.15, 0.4, fwidth(y/1.6)));
  t -= 0.025*(1.0 - vL.y);
  gl_FragColor = thermalOutC(t, vW, n);
}`;
// Night-time grade: dark horizon haze (sky glow and distant city settle near black-grey)
U.uHaze.value = 0.235;
