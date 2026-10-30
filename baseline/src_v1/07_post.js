// ---------------------------------------------------------------------------
// Post: thermal sensor + CRT display pipeline
//   scene (temp, facet, depth) -> blur pyramid -> sensor pass (detail
//   enhancement, vector edges, noise, phosphor persistence) -> display pass
//   (palette, bloom, scope optics, HUD composite, scanlines, curvature)
// ---------------------------------------------------------------------------
const Post = (() => {
  let renderer, W = 1, H = 1, pr = 1, maxPr = 1.5, floatOK = true;
  let rtScene, q1a, q1b, q2a, q2b, sens = [], cur = 0;
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

  const sensor = sh(HASH + `uniform sampler2D tScene, tLow, tPrev; uniform vec2 uPx; uniform float uTime, uDDE, uNoise, uPersist, uEdge; varying vec2 vUv;
    void main(){
      vec4 c = texture(tScene, vUv);
      float t = c.r;
      float low = texture(tLow, vUv).r;
      t += (t - low) * uDDE;                                   // digital detail enhancement
      // vector edges: facet changes (forward diff) + near-side depth silhouettes
      vec4 r = texture(tScene, vUv + vec2(uPx.x, 0.0)), u = texture(tScene, vUv + vec2(0.0, uPx.y));
      vec4 l = texture(tScene, vUv - vec2(uPx.x, 0.0)), d = texture(tScene, vUv - vec2(0.0, uPx.y));
      float dg = max(abs(r.g - c.g), abs(u.g - c.g));
      float dd = max(max(r.b - c.b, l.b - c.b), max(u.b - c.b, d.b - c.b));
      float edge = max(smoothstep(0.035, 0.1, dg), smoothstep(0.0018, 0.005, dd));
      float fade = 1.0 - smoothstep(0.66, 0.86, c.b);
      t += edge * uEdge * fade;
      // sensor noise: temporal grain + fixed-pattern column noise
      float n = hash(gl_FragCoord.xy + fract(uTime*7.31)*vec2(311.7, 183.3)) - 0.5;
      float col = hash(vec2(floor(gl_FragCoord.x), 3.7)) - 0.5;
      t += n*uNoise + col*uNoise*0.35;
      float prev = texture(tPrev, vUv).r;
      t = max(t, mix(t, prev, uPersist));                      // phosphor persistence on bright trails
      gl_FragColor = vec4(t, 0.0, 0.0, 1.0);
    }`,
  { tScene: { value: null }, tLow: { value: null }, tPrev: { value: null }, uPx: { value: new THREE.Vector2() }, uTime: U.uTime, uDDE: { value: 0.75 }, uNoise: { value: 0.018 }, uPersist: { value: 0.2 }, uEdge: { value: 0.085 } });

  const display = sh(HASH + `uniform sampler2D tS, tQ1, tQ2, tHud; uniform vec2 uRes; uniform float uMode, uScope, uScopeR, uFlash, uStatic, uFade, uTime, uCurv, uBloom;
    uniform vec2 uScopeOff; varying vec2 vUv;
    vec3 palette(float v){
      if (uMode < 0.5) return vec3(clamp(v, 0.0, 1.25)) * vec3(0.94, 0.98, 1.0);
      if (uMode < 1.5) return vec3(1.0 - clamp(v, 0.0, 1.0)) * vec3(0.96, 0.98, 1.0);
      vec3 g = vec3(0.16, 1.0, 0.42) * pow(clamp(v, 0.0, 1.0), 1.1);
      return mix(g, vec3(0.86, 1.0, 0.88), smoothstep(0.82, 1.3, v));
    }
    void main(){
      vec2 cc = vUv*2.0 - 1.0; cc *= 1.0 + uCurv*vec2(cc.y*cc.y, cc.x*cc.x); vec2 uv = cc*0.5 + 0.5;
      vec2 e = smoothstep(vec2(0.0), vec2(0.003), uv) * smoothstep(vec2(0.0), vec2(0.003), 1.0 - uv);
      float inScreen = e.x*e.y;
      float aspect = uRes.x/uRes.y;
      vec2 sp = vec2((uv.x - 0.5)*aspect, uv.y - 0.5);
      float r = length(sp);
      vec2 suv = uv;
      if (uScope > 0.0) { float k = 0.08*uScope; vec2 q = sp*(1.0 - k*(r*r)/(uScopeR*uScopeR)); suv = vec2(q.x/aspect + 0.5, q.y + 0.5); }
      float t = texture(tS, suv).r;
      float b1 = texture(tQ1, suv).r, b2 = texture(tQ2, suv).r;
      float bloom = (max(b1 - 0.6, 0.0)*0.8 + max(b2 - 0.48, 0.0)*0.9) * uBloom;
      float v = max((t - 0.09)/0.80, 0.0) + bloom;
      if (uStatic > 0.0) {
        float s = hash(floor(gl_FragCoord.xy/3.0) + floor(uTime*50.0)*vec2(17.0, 31.0));
        float bar = smoothstep(0.0, 0.08, abs(fract(uv.y*1.5 - uTime*2.0) - 0.5));
        v = mix(v, s*0.9*bar + 0.05, uStatic);
      }
      vec3 c = palette(v);
      // scope optics: eyebox shadow, edge falloff, tube
      if (uScope > 0.0) {
        float R = uScopeR;
        float inside = 1.0 - smoothstep(R - 0.0025, R + 0.0015, r);
        float rim = smoothstep(R*0.72, R, r);
        float eyebox = 1.0 - smoothstep(R*0.80, R*1.02, length(sp - uScopeOff));
        float lens = mix(1.0, (1.0 - 0.5*rim*rim) * mix(0.25, 1.0, eyebox), uScope);
        c *= lens;
        c *= mix(1.0, inside, uScope);
        // thin bright lens ring
        c += vec3(0.05) * uScope * (1.0 - smoothstep(0.0, 0.004, abs(r - R - 0.006)));
      }
      vec4 hud = texture(tHud, uv);
      vec3 ink = uMode > 0.5 && uMode < 1.5 ? vec3(0.02) : (uMode > 1.5 ? vec3(0.75, 1.0, 0.8) : vec3(0.97, 1.0, 0.98));
      vec3 darkInk = uMode > 0.5 && uMode < 1.5 ? vec3(0.98) : vec3(0.0);
      c = mix(c, darkInk, clamp(hud.g, 0.0, 1.0) * 0.9);
      c = mix(c, ink, clamp(hud.r, 0.0, 1.0));
      c += uFlash;
      float sl = 0.93 + 0.07*sin(gl_FragCoord.y*2.0944);
      c *= sl;
      vec2 vg = uv*(1.0 - uv.yx); float vig = pow(vg.x*vg.y*16.0, 0.18);
      c *= vig * inScreen * (1.0 - uFade);
      c += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;    // dither
      gl_FragColor = vec4(c, 1.0);
    }`,
  {
    tS: { value: null }, tQ1: { value: null }, tQ2: { value: null }, tHud: { value: null }, uRes: { value: new THREE.Vector2() },
    uMode: { value: 0 }, uScope: { value: 0 }, uScopeR: { value: 0.46 }, uFlash: { value: 0 }, uStatic: { value: 0 }, uFade: { value: 0 },
    uTime: U.uTime, uCurv: { value: 0.035 }, uScopeOff: { value: new THREE.Vector2() }, uBloom: { value: 1 },
  });

  function mkRT(w, h, samples = 0) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: samples > 0 || w === -1, samples,
      generateMipmaps: false,
    });
  }
  function init(r) {
    renderer = r;
    const gl = r.getContext();
    floatOK = !!(r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float'));
    maxPr = Math.min(window.devicePixelRatio || 1, 1.75);
    if (QS.get('pr')) maxPr = parseFloat(QS.get('pr')) || 1;
    pr = maxPr;
  }
  function alloc() {
    [rtScene, q1a, q1b, q2a, q2b, ...sens].forEach((t) => t && t.dispose());
    const w = Math.round(W * pr), h = Math.round(H * pr);
    rtScene = new THREE.WebGLRenderTarget(w, h, { type: floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: 4, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    q1a = mkRT(w >> 2, h >> 2); q1b = mkRT(w >> 2, h >> 2); q2a = mkRT(w >> 3, h >> 3); q2b = mkRT(w >> 3, h >> 3);
    sens = [mkRT(w, h), mkRT(w, h)];
  }
  function resize(w, h) {
    W = w; H = h;
    renderer.setPixelRatio(pr); renderer.setSize(W, H, true);
    alloc();
  }
  function pass(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam); }
  function render(scene, camera, hudTex) {
    renderer.setRenderTarget(rtScene); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, camera);
    const w = rtScene.width, h = rtScene.height;
    down.uniforms.tIn.value = rtScene.texture; down.uniforms.uTex.value.set(1 / w, 1 / h); pass(down, q1a);
    blur.uniforms.tIn.value = q1a.texture; blur.uniforms.uDir.value.set(1 / q1a.width, 0); pass(blur, q1b);
    blur.uniforms.tIn.value = q1b.texture; blur.uniforms.uDir.value.set(0, 1 / q1a.height); pass(blur, q1a);
    down.uniforms.tIn.value = q1a.texture; down.uniforms.uTex.value.set(0.5 / q1a.width, 0.5 / q1a.height); pass(down, q2a);
    blur.uniforms.tIn.value = q2a.texture; blur.uniforms.uDir.value.set(1.5 / q2a.width, 0); pass(blur, q2b);
    blur.uniforms.tIn.value = q2b.texture; blur.uniforms.uDir.value.set(0, 1.5 / q2a.height); pass(blur, q2a);
    const prev = sens[cur]; cur ^= 1; const out = sens[cur];
    sensor.uniforms.tScene.value = rtScene.texture; sensor.uniforms.tLow.value = q1a.texture; sensor.uniforms.tPrev.value = prev.texture;
    sensor.uniforms.uPx.value.set(1 / w, 1 / h);
    pass(sensor, out);
    display.uniforms.tS.value = out.texture; display.uniforms.tQ1.value = q1a.texture; display.uniforms.tQ2.value = q2a.texture;
    display.uniforms.tHud.value = hudTex; display.uniforms.uRes.value.set(W * pr, H * pr);
    pass(display, null);
  }
  // dynamic resolution to hold frame rate on weak GPUs
  let acc = 0, frames = 0, cool = 0;
  function adapt(dtReal) {
    acc += dtReal; frames++; cool -= dtReal;
    if (acc < 1.0) return;
    const ms = (acc / frames) * 1000; acc = 0; frames = 0;
    if (cool > 0) return;
    let np = pr;
    if (ms > 21 && pr > 0.6) np = Math.max(0.6, pr * 0.85);
    else if (ms < 13 && pr < maxPr) np = Math.min(maxPr, pr * 1.12);
    if (Math.abs(np - pr) > 0.02) { pr = np; resize(W, H); cool = 2; }
  }
  return { init, resize, render, adapt, sensor, display, get pr() { return pr; }, get W() { return W; }, get H() { return H; }, set pr(v) { pr = v; } };
})();
