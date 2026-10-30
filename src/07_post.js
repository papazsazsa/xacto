// ---------------------------------------------------------------------------
// Post: thermal sensor + CRT display pipeline
//   scene (temp, facet, depth) at dynamic resolution
//     -> blur pyramid (1/4, 1/8)
//     -> AGC: 1x1 GPU statistics of the 1/8 level, temporally adapted (no readback)
//     -> sensor pass (detail enhancement, vector edge mask, phosphor persistence)
//   display pass at fixed display resolution (palette, AGC, edges, noise, bloom,
//   scope optics with iris / zoom blur, HUD composite + glow, scanlines, curvature)
// ---------------------------------------------------------------------------
const Post = (() => {
  let renderer, W = 1, H = 1, pr = 1, maxPr = 1.5, floatOK = true;
  let rtScene, q1a, q1b, q2a, q2b, sens = [], cur = 0, agc = [], agcCur = 0;
  let lastT = -1, fresh = true, scopeE = 0, zoomV = 0, lastFov = 0, lastState = '', cutT = 0, expoV = 1, muzT = -1;
  const lastPos = new THREE.Vector3(), lastDir = new THREE.Vector3(), tmpD = new THREE.Vector3();
  const quadScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri); quad.frustumCulled = false; quadScene.add(quad);
  const VS = 'varying vec2 vUv; void main(){ vUv = position.xy*0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const HASH = 'float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }\n';
  const sh = (fs, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false });

  const down = sh(`uniform sampler2D tIn; uniform vec2 uTex; varying vec2 vUv;
    void main(){ vec2 o = uTex; float s = texture(tIn, vUv + vec2(-o.x,-o.y)).r + texture(tIn, vUv + vec2(o.x,-o.y)).r + texture(tIn, vUv + vec2(-o.x,o.y)).r + texture(tIn, vUv + vec2(o.x,o.y)).r; gl_FragColor = vec4(s*0.25, 0.0, 0.0, 1.0); }`,
    { tIn: { value: null }, uTex: { value: new THREE.Vector2() } });
  const blur = sh(`uniform sampler2D tIn; uniform vec2 uDir; varying vec2 vUv;
    void main(){ float w[5]; w[0]=0.2270270270; w[1]=0.1945945946; w[2]=0.1216216216; w[3]=0.0540540541; w[4]=0.0162162162;
      float s = texture(tIn, vUv).r * w[0];
      for (int i = 1; i < 5; i++){ s += texture(tIn, vUv + uDir*float(i)).r * w[i]; s += texture(tIn, vUv - uDir*float(i)).r * w[i]; }
      gl_FragColor = vec4(s, 0.0, 0.0, 1.0); }`,
    { tIn: { value: null }, uDir: { value: new THREE.Vector2() } });

  // Scene statistics for a small, slow exposure trim (mean, spread of 64 taps of the 1/8
  // image, scope field only when the scope is up). The grade itself is a fixed thermal curve:
  // a scene-mean AGC stretched walls toward white whenever nothing hot was in view.
  const agcMat = sh(`uniform sampler2D tIn, tPrev; uniform float uK, uScope, uScopeR, uAspect, uMinSpan; varying vec2 vUv;
    void main(){
      float s = 0.0, s2 = 0.0, mn = 9.0, mx = -9.0;
      for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++){
        vec2 g = (vec2(float(i), float(j)) + 0.5)/8.0*2.0 - 1.0;
        vec2 uv = mix(0.5 + g*0.45, vec2(0.5 + g.x*0.68*uScopeR/uAspect, 0.5 + g.y*0.68*uScopeR), uScope);
        float v = texture(tIn, uv).r; s += v; s2 += v*v; mn = min(mn, v); mx = max(mx, v);
      }
      float m = s/64.0, sd = sqrt(max(s2/64.0 - m*m, 0.0));
      vec2 cur = vec2(m, sd), prev = texture(tPrev, vec2(0.5)).rg;
      gl_FragColor = vec4(mix(prev, cur, uK), 0.0, 1.0);
    }`,
  { tIn: { value: null }, tPrev: { value: null }, uK: { value: 1 }, uScope: { value: 0 }, uScopeR: { value: 0.46 }, uAspect: { value: 1.7 }, uMinSpan: { value: 0.34 } });

  const sensor = sh(`uniform sampler2D tScene, tLow, tPrev; uniform vec2 uPx, uDepthEdge; uniform float uTime, uDDE, uNoise, uPersist, uPersistE, uEdge, uFovK; varying vec2 vUv;
    void main(){
      vec4 c = texture(tScene, vUv);
      float t = c.r;
      float low = texture(tLow, vUv).r;
      t += clamp(t - low, -0.05, 0.05) * uDDE;                 // digital detail enhancement (tight clamp: no halos)
      // vector edges: facet changes (forward diff) + near-side depth silhouettes
      vec4 r = texture(tScene, vUv + vec2(uPx.x, 0.0)), u = texture(tScene, vUv + vec2(0.0, uPx.y));
      vec4 l = texture(tScene, vUv - vec2(uPx.x, 0.0)), d = texture(tScene, vUv - vec2(0.0, uPx.y));
      float dg = max(abs(r.g - c.g), abs(u.g - c.g));
      float dd = max(max(r.b - c.b, l.b - c.b), max(u.b - c.b, d.b - c.b));
      float edge = max(smoothstep(0.035, 0.09, dg), smoothstep(uDepthEdge.x, uDepthEdge.y, dd));
      // distance fade measured in apparent (magnified) distance so zoomed views keep their lines
      float dist = (exp2(c.b*13.0) - 1.0) * uFovK;
      // far lines fade out (no stacked-transparency skyline); near obstacles get a stronger outline
      edge *= (1.0 - smoothstep(260.0, 1700.0, dist)) * (1.0 + 0.7*(1.0 - smoothstep(25.0, 160.0, dist)));
      float prev = texture(tPrev, vUv).r;
      // phosphor persistence: only hot energy lingers, decay is frame-rate independent
      float p = uPersistE * smoothstep(0.58, 0.9, prev);
      t = max(t, mix(t, prev, p));
      gl_FragColor = vec4(t, edge, 0.0, 1.0);
    }`,
  { tScene: { value: null }, tLow: { value: null }, tPrev: { value: null }, uPx: { value: new THREE.Vector2() }, uDepthEdge: { value: new THREE.Vector2(0.0018, 0.005) },
    uTime: U.uTime, uDDE: { value: 0.45 }, uNoise: { value: 0.024 }, uPersist: { value: 0.2 }, uPersistE: { value: 0 }, uEdge: { value: 0.085 }, uFovK: { value: 1 } });

  const display = sh(HASH + `uniform sampler2D tS, tQ1, tQ2, tHud, tAgc, tInset; uniform vec2 uRes, uSRes, uHudPx, uInsetRes; uniform vec4 uInsetRect; uniform float uInsetOn, uInsetGrain, uInsetFlat;
    uniform float uMode, uScope, uScopeR, uFlash, uStatic, uFade, uTime, uCurv, uBloom, uNoise, uAgcAmt, uZoom, uIris, uEdgeAmt, uLines, uBezel, uGrainRows;
    uniform float uExpo, uMuzzle, uHudSharp;
    uniform vec2 uScopeOff; varying vec2 vUv;
    // Fixed thermal grade: apparent temperature -> display level y (white hot, ~217*y of 255):
    //   sky 0.08 -> 0.02 | horizon glow 0.235 -> 0.17 | roofs 0.205 -> 0.12 | glass 0.27 -> 0.27
    //   walls 0.30-0.385 -> 0.37-0.60 | accents / lit windows 0.41-0.52 -> 0.68-0.82 | steam caps near 0.86
    //   man: clothing 0.63-0.70 -> 0.92-0.99, skin 0.8+ -> 1.12+ | round 1.05 -> 1.38
    float grade(float t){
      if (t < 0.10) return 0.03*clamp((t - 0.04)/0.06, 0.0, 1.0);
      if (t < 0.20) return mix(0.03, 0.11, (t - 0.10)/0.10);
      if (t < 0.235) return mix(0.11, 0.17, (t - 0.20)/0.035);
      if (t < 0.27) return mix(0.17, 0.27, (t - 0.235)/0.035);
      if (t < 0.30) return mix(0.27, 0.37, (t - 0.27)/0.03);
      if (t < 0.385) return mix(0.37, 0.60, (t - 0.30)/0.085);
      if (t < 0.42) return mix(0.60, 0.69, (t - 0.385)/0.035);
      if (t < 0.52) return mix(0.69, 0.82, (t - 0.42)/0.10);
      if (t < 0.66) return mix(0.82, 0.88, (t - 0.52)/0.14);   // highlight compression: steam, exhausts
      if (t < 0.72) return mix(0.88, 0.99, (t - 0.66)/0.06);   // people start here
      return 0.99 + (t - 0.72)*1.4;
    }
    vec3 palette(float y){
      if (uMode < 0.5) return mix(vec3(0.008, 0.010, 0.014), vec3(0.88, 0.94, 0.98), clamp(y, 0.0, 1.0)) + vec3(max(y - 1.0, 0.0)*1.5);
      // black hot: the cold sky settles to a soft grey, not a white plane
      if (uMode < 1.5) return mix(vec3(0.78, 0.81, 0.84), vec3(0.008, 0.009, 0.011), clamp(y, 0.0, 1.0));
      // intensifier green: lifted mids, only the hottest points flare
      float yn = clamp(y, 0.0, 1.3);
      vec3 g = mix(vec3(0.003, 0.018, 0.006), vec3(0.20, 0.80, 0.29), min(yn*0.92, 1.0));
      return mix(g, vec3(0.80, 1.0, 0.72), smoothstep(0.95, 1.12, yn));
    }
    vec3 inkCol(){ return uMode < 0.5 ? vec3(0.96, 0.99, 1.0) : (uMode < 1.5 ? vec3(0.96, 0.99, 1.0) : vec3(0.72, 1.0, 0.70)); }
    void main(){
      vec2 cc = vUv*2.0 - 1.0; cc *= 1.0 + uCurv*vec2(cc.y*cc.y, cc.x*cc.x); vec2 uv = cc*0.5 + 0.5;
      float aspect = uRes.x/uRes.y, px = 1.0/uRes.y;
      // rounded tube face
      vec2 bq = abs(cc)*vec2(aspect, 1.0) - vec2(aspect, 1.0) + 0.055;
      float bd = length(max(bq, 0.0)) + min(max(bq.x, bq.y), 0.0) - 0.055;
      float inScreen = 1.0 - smoothstep(-2.5*px, 0.5*px, bd);
      vec2 sp = vec2((uv.x - 0.5)*aspect, uv.y - 0.5);
      float r = length(sp);
      float R = uScopeR * mix(0.08, 1.0, uIris);
      vec2 suv = uv;
      if (uScope > 0.0) { float k = 0.07*uScope; vec2 q = sp*(1.0 - k*(r*r)/(R*R)); suv = vec2(q.x/aspect + 0.5, q.y + 0.5); }
      vec4 S = texture(tS, suv);
      float t = S.r;
      float b1 = texture(tQ1, suv).r, b2 = texture(tQ2, suv).r;
      t = mix(t, b1, clamp(uZoom, 0.0, 0.75)*uScope);              // zoom transition blur
      // small slow exposure trim from the scene mean, then exposure pivots on the roof/black point
      vec2 ag = texture(tAgc, vec2(0.5)).rg;
      float trim = clamp((ag.x - 0.27)*0.4, -0.02, 0.02) * uAgcAmt;
      float gk = uExpo, go = 0.2 + trim;
      float v = grade(go + (t - go)*gk);
      // soft 1-2 px halo around the hottest figures (the man, the round): lifts the ring around
      // them in white hot, darkens it in black hot, glows in night vision
      vec2 hp1 = 1.6/uSRes;
      float tn = max(max(texture(tS, suv + vec2(hp1.x, 0.0)).r, texture(tS, suv - vec2(hp1.x, 0.0)).r),
                     max(texture(tS, suv + vec2(0.0, hp1.y)).r, texture(tS, suv - vec2(0.0, hp1.y)).r));
      tn = max(tn, max(texture(tS, suv + hp1*0.7071).r, texture(tS, suv - hp1*0.7071).r));
      float halo = smoothstep(0.97, 1.1, grade(go + (tn - go)*gk));
      v = max(v, mix(v, 0.8, halo*0.55));
      float n1 = grade(go + (b1 - go)*gk), n2 = grade(go + (b2 - go)*gk);
      bool nv = uMode > 1.5;
      float bloom = nv ? (max(n1 - 0.96, 0.0)*0.8 + max(n2 - 0.93, 0.0)*1.2)             // intensifier halos only around the hottest points
                       : (max(n1 - 0.97, 0.0)*0.6 + max(n2 - 0.93, 0.0)*0.7);
      bloom *= uBloom;
      // muzzle: bright content smears upward for a few frames
      if (uMuzzle > 0.001) {
        float s1 = texture(tS, suv - vec2(0.0, 0.016*uMuzzle)).r, s2 = texture(tS, suv - vec2(0.0, 0.04*uMuzzle)).r, s3 = texture(tS, suv - vec2(0.0, 0.07*uMuzzle)).r;
        float vs = max(max(grade(go + (s1 - go)*gk)*0.75, grade(go + (s2 - go)*gk)*0.5), grade(go + (s3 - go)*gk)*0.3);
        v = max(v, min(vs*uMuzzle*1.4, 0.95));
        // hot propellant gas billowing up from the bottom of the view, with a whole-frame gain lift
        vec2 gq = (uv - vec2(0.5, -0.02))*vec2(aspect, 1.0);
        float gas = 0.72 + 0.28*sin(gq.x*19.0 + uTime*27.0 + 2.2*sin(gq.y*13.0 - uTime*17.0));
        float rb = uMuzzle * exp(-length(gq*vec2(1.0, 1.25))*2.6) * gas;
        float bump = clamp(rb*1.6, 0.0, 1.0)*0.75 + uMuzzle*0.07 + smoothstep(0.9, 0.995, uMuzzle)*0.55;
        v = max(v, mix(v, 0.9, clamp(bump, 0.0, 1.0)));
      }
      // vector edges: bright lines on cool surfaces, dark engraved lines inside hot silhouettes
      // (engraving is capped so small hot figures - mostly edge pixels - stay white)
      v += min(S.g, 1.0) * uEdgeAmt * (1.0 - 0.6*uZoom) * mix(1.0, -0.35, smoothstep(0.85, 0.98, v));
      // sensor grain at a fixed size on screen (about uGrainRows rows, whatever the render resolution), blended
      // between grain cells the way an upscaled low-resolution sensor looks, so phones and desktops match
      float gy = min(uSRes.y, uGrainRows); vec2 gp = suv * vec2(gy * uSRes.x / uSRes.y, gy);
      vec2 sp_px = floor(gp), gf = gp - sp_px, to = fract(uTime*7.31)*vec2(311.7, 183.3);
      float n = (mix(mix(hash(sp_px + to), hash(sp_px + vec2(1.0, 0.0) + to), gf.x), mix(hash(sp_px + vec2(0.0, 1.0) + to), hash(sp_px + vec2(1.0) + to), gf.x), gf.y) - 0.5) * 1.4;
      float col = hash(vec2(sp_px.x, 3.7)) - 0.5;
      float namp = uNoise * 1.6;
      if (nv) {
        // image-intensifier scintillation: heavier grain in the shadows plus sparse flickering sparkles
        namp *= 1.0 + 0.9*(1.0 - clamp(v, 0.0, 1.0));
        v += step(0.9965, hash(sp_px*1.37 + floor(uTime*30.0)*vec2(7.1, 3.3))) * 0.5;
        col *= 0.3;
      }
      v += (n + col*0.4) * namp;
      if (uStatic > 0.0) {
        float s = hash(floor(gl_FragCoord.xy/1.5) + fract(uTime*13.17)*vec2(173.0, 311.0));
        float bar = smoothstep(0.0, 0.08, abs(fract(uv.y*1.5 - uTime*2.0) - 0.5));
        v = mix(v, s*0.9*bar + 0.05, uStatic);
      }
      vec3 c = palette(v);
      vec3 ink = inkCol();
      c += ink * bloom * (uMode > 0.5 && uMode < 1.5 ? 0.5 : 1.0);
      // scope optics
      if (uScope > 0.0) {
        float aa = 1.5*px;
        float inside = 1.0 - smoothstep(R - aa, R + aa, r);
        float rim = smoothstep(R*0.62, R, r);
        vec2 eo = uScopeOff*R*2.2;
        float eye = smoothstep(R*0.80, R*1.05, length(sp - eo));        // eyebox crescent follows sway
        float lens = (1.0 - 0.42*rim*rim) * (1.0 - 0.82*eye);
        // glass: faint coated reflection arc, upper left
        float ga = smoothstep(R*0.80, R*0.93, r) * (1.0 - smoothstep(R*0.93, R*0.99, r));
        float gdir = max(dot(normalize(sp + 1e-5), normalize(vec2(-0.6, 0.8))), 0.0);
        vec3 inner = c*lens + ink*0.035*ga*pow(gdir, 6.0);
        // tube wall + machined rim just outside the field stop
        float wr = (r - R)/max(R, 1e-3);
        float lit = 0.5 + 0.5*dot(normalize(sp + 1e-5), normalize(vec2(-0.45, 0.9)));
        float wall = (1.0 - smoothstep(0.0, 0.05, wr)) * (0.035 + 0.05*lit);
        float lip = (1.0 - smoothstep(0.0, 2.0*px/R, abs(wr - 0.052))) * (0.05 + 0.10*lit);
        // bezel field: dark panel with a soft centre lift
        float field = uBezel * (0.022 + 0.018*(1.0 - smoothstep(0.2, 1.1, r)));
        vec3 outer = ink*(wall + lip + field);
        c = mix(c, mix(outer, inner, inside), uScope);
      }
      // side window (the MQ-DARC drone feed): its own thermal render, same grade, drawn over the scope's
      // bezel; the drone feed is coarser, grainier and flatter than the scope
      if (uInsetOn > 0.5) {
        vec2 chi = vUv*2.0 - 1.0; chi *= 1.0 + 0.3*uCurv*vec2(chi.y*chi.y, chi.x*chi.x);
        vec2 iu = (chi*0.5 + 0.5 - uInsetRect.xy) / (uInsetRect.zw - uInsetRect.xy);
        if (iu.x > 0.0 && iu.x < 1.0 && iu.y > 0.0 && iu.y < 1.0) {
          vec4 I = texture(tInset, iu);
          vec2 ip = 1.0 / uInsetRes;
          float eg = max(abs(texture(tInset, iu + vec2(ip.x, 0.0)).g - I.g), abs(texture(tInset, iu + vec2(0.0, ip.y)).g - I.g));
          float vi = grade(go + (I.r - go) * gk);
          vi += smoothstep(0.035, 0.09, eg) * 0.12 * mix(1.0, -0.35, smoothstep(0.85, 0.98, vi));
          vi += (hash(floor(iu * uInsetRes) + fract(uTime * 7.31) * vec2(311.7, 183.3)) - 0.5) * uNoise * 2.2 * uInsetGrain;
          vi = mix(vi, 0.4, uInsetFlat) + uInsetFlat * 0.035 * sin(iu.y * 46.0 - uTime * 2.6);
          c = palette(vi);
        }
      }
      // intensifier tube field when the scope is down (chase / kill cameras)
      if (nv) c *= 1.0 - (1.0 - uScope) * 0.55 * smoothstep(0.45, 1.0, length(sp)/max(0.5*aspect, 0.5));
      // (muzzle flash is applied to the scope image above, before the optics: the bezel,
      //  side panels and HUD keep their black level)
      // HUD: sharpened bilinear lookup keeps pixel-font texels crisp through the curvature warp
      vec2 chh = vUv*2.0 - 1.0; chh *= 1.0 + 0.3*uCurv*vec2(chh.y*chh.y, chh.x*chh.x); vec2 uvh = chh*0.5 + 0.5;
      vec2 hsz = 1.0/uHudPx, hp = uvh*hsz - 0.5, hi0 = floor(hp), hf = clamp((hp - hi0 - 0.5)*uHudSharp + 0.5, 0.0, 1.0);
      vec4 hud = texture(tHud, (hi0 + hf + 0.5)/hsz);
      float glow = 0.0;
      vec2 o1 = uHudPx*1.6, o2 = uHudPx*vec2(3.2, -3.2);
      glow += texture(tHud, uvh + o1).r + texture(tHud, uvh - o1).r + texture(tHud, uvh + vec2(o1.x, -o1.y)).r + texture(tHud, uvh - vec2(o1.x, -o1.y)).r;
      glow += texture(tHud, uvh + o2).r + texture(tHud, uvh - o2).r;
      glow /= 6.0;
      c = mix(c, vec3(0.0), clamp(hud.g, 0.0, 1.0) * 0.92);
      c = mix(c, ink, clamp(hud.r, 0.0, 1.0));
      c = mix(c, vec3(1.0, 0.12, 0.08), clamp(hud.b, 0.0, 1.0));   // the target brackets: the one red on screen
      c += ink * glow * 0.3 * (1.0 - hud.r);
      c = c*(1.0 + 1.6*uFlash);                                        // hit flash punches highlights; HUD black level stays locked
      // scanlines: >= 3 display px per line, sinusoidal (no moire), bright lines bloom over the gaps
      float lines = uRes.y / max(3.0, uRes.y/270.0);
      float sl = 0.5 + 0.5*cos(6.2831853*uv.y*lines);
      float lum = clamp(dot(c, vec3(0.3, 0.5, 0.2)), 0.0, 1.0);
      c *= (1.0 - uLines*(1.0 - 0.6*lum)*(1.0 - sl)*(1.0 - 0.75*clamp(hud.r + hud.g + hud.b, 0.0, 1.0))) * (1.0 + uLines*0.35);
      // tube glass: soft sheen and vignette
      vec2 vg = uv*(1.0 - uv.yx); float vig = pow(clamp(vg.x*vg.y*16.0, 0.0, 1.0), 0.16);
      c += ink * 0.012 * (1.0 - smoothstep(0.0, 0.9, length((uv - vec2(0.22, 0.86))*vec2(aspect*0.6, 1.4))));
      c *= vig * inScreen * (1.0 - uFade);
      c += (hash(gl_FragCoord.xy + fract(uTime)*91.0) - 0.5) / 255.0;    // dither
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
  {
    tS: { value: null }, tQ1: { value: null }, tQ2: { value: null }, tHud: { value: null }, tAgc: { value: null },
    uRes: { value: new THREE.Vector2() }, uSRes: { value: new THREE.Vector2() }, uHudPx: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uMode: { value: 0 }, uScope: { value: 0 }, uScopeR: { value: 0.46 }, uFlash: { value: 0 }, uStatic: { value: 0 }, uFade: { value: 0 },
    uTime: U.uTime, uCurv: { value: 0.02 }, uScopeOff: { value: new THREE.Vector2() }, uBloom: { value: 1 }, uNoise: { value: 0.024 }, uGrainRows: { value: 340 },
    uAgcAmt: { value: 1 }, uZoom: { value: 0 }, uIris: { value: 1 }, uEdgeAmt: { value: 0.15 }, uLines: { value: 0.26 }, uBezel: { value: 1 },
    uExpo: { value: 1 }, uMuzzle: { value: 0 }, uHudSharp: { value: 2.5 },
    tInset: { value: null }, uInsetOn: { value: 0 }, uInsetGrain: { value: 1 }, uInsetFlat: { value: 0 }, uInsetRect: { value: new THREE.Vector4(0, 0, 0, 0) }, uInsetRes: { value: new THREE.Vector2(1, 1) },
  });

  function mkRT(w, h, samples = 0) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: samples > 0, samples,
      generateMipmaps: false,
    });
  }
  function init(r) {
    renderer = r;
    floatOK = !!(r.capabilities.isWebGL2 && (r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float')));
    maxPr = Math.min(window.devicePixelRatio || 1, MOBILE ? 1.5 : 1.75);
    if (QS.get('pr')) maxPr = parseFloat(QS.get('pr')) || 1;
    pr = maxPr;
    // 8-bit fallback: depth is quantised to 1/255, so raise the silhouette threshold above one step
    if (!floatOK) { sensor.uniforms.uDepthEdge.value.set(0.0065, 0.012); display.uniforms.uAgcAmt.value = 0.6; }
    agc = [mkRT(1, 1), mkRT(1, 1)];
  }
  function alloc() {
    [rtScene, q1a, q1b, q2a, q2b, ...sens].forEach((t) => t && t.dispose());
    const w = Math.max(16, Math.round(W * pr)), h = Math.max(16, Math.round(H * pr));
    rtScene = new THREE.WebGLRenderTarget(w, h, { type: floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: 4, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    q1a = mkRT(w >> 2, h >> 2); q1b = mkRT(w >> 2, h >> 2); q2a = mkRT(w >> 3, h >> 3); q2b = mkRT(w >> 3, h >> 3);
    sens = [mkRT(w, h), mkRT(w, h)];
    fresh = true;
  }
  // The canvas (display pass + HUD) stays at the device ratio; only the scene / sensor
  // resolution changes with dynamic resolution, so text and scanlines never go soft.
  function resize(w, h) {
    W = w; H = h;
    renderer.setPixelRatio(maxPr); renderer.setSize(W, H, true);
    alloc();
  }
  function pass(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam); }
  // Seeker window: render the scene from a second camera into a small target (thermal materials write
  // temperature / facet / depth, graded in the display pass). Pass null to switch it off.
  let rtInset = null; const _uc = new THREE.Vector3();
  function renderInset(scene, cam, rect, opt = {}) {
    const d = display.uniforms;
    if (!cam || !rect) { d.uInsetOn.value = 0; return; }
    const rs = opt.res || 1;
    const w = Math.max(32, Math.round((rect.n1 - rect.n0) * W * pr * rs)), h = Math.max(24, Math.round((rect.m1 - rect.m0) * H * pr * rs));
    d.uInsetGrain.value = opt.grain || 1; d.uInsetFlat.value = opt.flat || 0;
    const same = rtInset && rtInset.width === w && rtInset.height === h;
    if (!same) { if (rtInset) rtInset.dispose(); rtInset = new THREE.WebGLRenderTarget(w, h, { type: floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: 4, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }); }
    // opt.skip: keep showing the last drone frame (phones refresh the feed at a third of the frame rate)
    if (opt.skip && same && d.uInsetOn.value) { d.uInsetRect.value.set(rect.n0, 1 - rect.m1, rect.n1, 1 - rect.m0); return; }
    _uc.copy(U.uCam.value); U.uCam.value.copy(cam.position);
    renderer.setRenderTarget(rtInset); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, cam);
    U.uCam.value.copy(_uc);
    d.tInset.value = rtInset.texture; d.uInsetRes.value.set(w, h); d.uInsetOn.value = 1;
    d.uInsetRect.value.set(rect.n0, 1 - rect.m1, rect.n1, 1 - rect.m0);
  }
  function render(scene, camera, hudTex) {
    const now = U.uTime.value;
    const dt = lastT < 0 ? 1 : clamp(now - lastT, 0, 1); lastT = now;
    const d = display.uniforms, sn = sensor.uniforms;
    // scene cuts (camera jumps, state changes) reset persistence and fast-adapt the AGC
    camera.getWorldDirection(tmpD);
    const st = (typeof G !== 'undefined' && G) ? G.state : '';
    const cut = fresh || st !== lastState || camera.position.distanceTo(lastPos) > 30 || tmpD.dot(lastDir) < 0.985;
    lastPos.copy(camera.position); lastDir.copy(tmpD); lastState = st;
    if (cut) cutT = 0.35; else cutT -= dt;
    // phosphor decay normalised to 60 Hz; long gaps (hitches, test stepping) leave no ghost copies.
    // Around the falling man the trail is capped at 15 % per frame: at most about 3 faint ghosts.
    const ragdoll = st === 'killcam' || st === 'misscam' || st === 'tally';
    const pv = Math.min(clamp(sn.uPersist.value, 0, 0.95), ragdoll ? 0.15 : 0.95);
    sn.uPersistE.value = cut || dt > 0.1 ? 0 : Math.pow(pv, dt * 60);
    // exposure: the chase and kill cameras see big sunlit-warm walls up close; pull them down
    // so the top of the range stays reserved for people, engines, muzzle, round and impacts
    const expoT = (st === 'flight' || ragdoll) ? 0.96 : (st === 'brief' || st === 'aim' || st === 'shot') ? 1.08 : 1;
    expoV = fresh ? expoT : damp(expoV, expoT, 8, dt);
    d.uExpo.value = expoV;
    // muzzle envelope: full white for ~3 frames, then an exponential afterglow that carries into flight
    if (st === 'shot' && typeof G !== 'undefined') muzT = G.stateT;
    else if (muzT >= 0) { muzT += dt; if (muzT > 0.9) muzT = -1; }
    d.uMuzzle.value = muzT < 0 ? 0 : (muzT < 0.06 ? 1 : Math.exp(-(muzT - 0.06) / 0.22));
    if (st === 'shot') d.uFlash.value = 0;                 // the muzzle envelope replaces the flat flash lift
    sn.uFovK.value = camera.fov / 40;
    d.uNoise.value = sn.uNoise.value;
    // scope iris + zoom transition
    const want = d.uScope.value;
    scopeE = want < 0.5 ? 0 : (cut && scopeE === 0 ? 0.0001 : scopeE) + (1 - scopeE) * (1 - Math.exp(-dt * 9));
    if (want > 0.5 && scopeE > 0.999) scopeE = 1;
    d.uIris.value = want > 0.5 ? 1 - Math.pow(1 - scopeE, 2) : 1;
    const aspect = W / H;
    // portrait / narrow screens: keep the whole objective inside the screen
    d.uScopeR.value = Math.min(d.uScopeR.value, 0.47 * aspect);
    const fz = Math.log(Math.max(1e-3, camera.fov));
    const zv = lastFov && dt > 0 && dt < 0.2 && want > 0.5 ? Math.abs(fz - lastFov) / dt : 0; lastFov = fz;
    zoomV = damp(zoomV, clamp(zv * 0.9, 0, 1), 14, dt);
    d.uZoom.value = zoomV;

    renderer.setRenderTarget(rtScene); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, camera);
    const w = rtScene.width, h = rtScene.height;
    down.uniforms.tIn.value = rtScene.texture; down.uniforms.uTex.value.set(1 / w, 1 / h); pass(down, q1a);
    blur.uniforms.tIn.value = q1a.texture; blur.uniforms.uDir.value.set(1 / q1a.width, 0); pass(blur, q1b);
    blur.uniforms.tIn.value = q1b.texture; blur.uniforms.uDir.value.set(0, 1 / q1a.height); pass(blur, q1a);
    down.uniforms.tIn.value = q1a.texture; down.uniforms.uTex.value.set(0.5 / q1a.width, 0.5 / q1a.height); pass(down, q2a);
    blur.uniforms.tIn.value = q2a.texture; blur.uniforms.uDir.value.set(1.5 / q2a.width, 0); pass(blur, q2b);
    blur.uniforms.tIn.value = q2b.texture; blur.uniforms.uDir.value.set(0, 1.5 / q2a.height); pass(blur, q2a);
    // AGC statistics (1x1 ping-pong)
    const ap = agc[agcCur]; agcCur ^= 1; const ao = agc[agcCur];
    const au = agcMat.uniforms;
    au.tIn.value = q2a.texture; au.tPrev.value = ap.texture;
    au.uK.value = fresh ? 1 : 1 - Math.exp(-dt * (cutT > 0 ? 14 : 2.2));
    au.uScope.value = want > 0.5 ? 1 : 0; au.uScopeR.value = d.uScopeR.value; au.uAspect.value = aspect;
    pass(agcMat, ao);
    const prev = sens[cur]; cur ^= 1; const out = sens[cur];
    sn.tScene.value = rtScene.texture; sn.tLow.value = q1a.texture; sn.tPrev.value = prev.texture;
    sn.uPx.value.set(1 / w, 1 / h);
    pass(sensor, out);
    d.tS.value = out.texture; d.tQ1.value = q1a.texture; d.tQ2.value = q2a.texture; d.tAgc.value = ao.texture;
    d.tHud.value = hudTex; d.uRes.value.set(Math.round(W * maxPr), Math.round(H * maxPr)); d.uSRes.value.set(w, h);
    if (hudTex && hudTex.image) d.uHudPx.value.set(1 / hudTex.image.width, 1 / hudTex.image.height);
    pass(display, null);
    fresh = false;
  }
  // Dynamic resolution. rAF intervals are quantised to the display refresh, so compare
  // against the observed refresh period instead of fixed millisecond thresholds, step
  // back up after sustained headroom, and remember a ceiling that failed recently.
  let acc = 0, frames = 0, cool = 0, vsync = 1 / 60, ceil = 99, ceilT = 0, good = 0;
  function adapt(dtReal) {
    if (!(dtReal > 0) || dtReal > 0.25) return;           // tab switches, hitches
    vsync = clamp(Math.min(vsync * 1.002, dtReal), 1 / 240, 1 / 50);       // slowly relaxing minimum = refresh period
    acc += dtReal; frames++; cool -= dtReal; ceilT -= dtReal;
    if (ceilT <= 0) ceil = 99;
    if (acc < 0.75) return;
    const avg = acc / frames; acc = 0; frames = 0;
    if (cool > 0) return;
    let np = pr;
    if (avg > vsync * 1.3 && pr > 0.5) { np = Math.max(0.5, pr * (avg > vsync * 1.8 ? 0.78 : 0.88)); ceil = pr; ceilT = 20; good = 0; }
    else if (avg < vsync * 1.08 && pr < maxPr) { good++; if (good >= 3 && pr * 1.1 < ceil) { np = Math.min(maxPr, pr * 1.1); good = 0; } }
    else good = 0;
    if (Math.abs(np - pr) > 0.02) { pr = np; alloc(); cool = 1.5; }
  }
  return {
    init, resize, render, renderInset, adapt, sensor, display, agcMat,
    get pr() { return pr; }, set pr(v) { pr = v; },
    get dpr() { return maxPr; }, get W() { return W; }, get H() { return H; }, get floatOK() { return floatOK; },
  };
})();
