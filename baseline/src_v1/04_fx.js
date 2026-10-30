// ---------------------------------------------------------------------------
// FX: additive "heat" particles (vent plumes, sparks, impact puffs, gas)
// ---------------------------------------------------------------------------
const FX = (() => {
  const MAX = 4000;
  const pos = new Float32Array(MAX * 3), heat = new Float32Array(MAX), size = new Float32Array(MAX);
  const vel = new Float32Array(MAX * 3), life = new Float32Array(MAX), maxLife = new Float32Array(MAX);
  const s0 = new Float32Array(MAX), s1 = new Float32Array(MAX), h0 = new Float32Array(MAX), drag = new Float32Array(MAX), buoy = new Float32Array(MAX);
  let n = 0;
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aHeat = new THREE.BufferAttribute(heat, 1).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('aHeat', aHeat); geo.setAttribute('aSize', aSize);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 500 }, uCam: U.uCam, uFogD: U.uFogD },
    vertexShader: /* glsl */`
      uniform float uScale; uniform float uFogD;
      attribute float aHeat; attribute float aSize; varying float vHeat;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        vHeat = aHeat * exp(-d * uFogD);
        gl_PointSize = clamp(aSize * uScale / max(d, 0.1), 1.5, 220.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vHeat;
      void main(){
        vec2 c = gl_PointCoord - 0.5; float r2 = dot(c, c) * 4.0;
        if (r2 > 1.0) discard;
        float a = (1.0 - r2); a *= a;
        gl_FragColor = vec4(vHeat * a, 0.0, 0.0, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 6;

  function spawn(x, y, z, vx, vy, vz, lifeS, sa, sb, ht, dr = 0.5, by = 0) {
    if (n >= MAX) return;
    const i = n++;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
    life[i] = 0; maxLife[i] = lifeS; s0[i] = sa; s1[i] = sb; h0[i] = ht; drag[i] = dr; buoy[i] = by;
    size[i] = sa; heat[i] = ht;
  }
  function kill(i) {
    const j = --n; if (i === j) return;
    for (let k = 0; k < 3; k++) { pos[i * 3 + k] = pos[j * 3 + k]; vel[i * 3 + k] = vel[j * 3 + k]; }
    life[i] = life[j]; maxLife[i] = maxLife[j]; s0[i] = s0[j]; s1[i] = s1[j]; h0[i] = h0[j]; drag[i] = drag[j]; buoy[i] = buoy[j]; size[i] = size[j]; heat[i] = heat[j];
  }
  const wind = new THREE.Vector3();
  function update(dt, camPos) {
    // ambient vent plumes near the camera's region of interest
    const em = City.emitters;
    for (let e = 0; e < em.length; e++) {
      const E = em[e];
      const dx = E.x - camPos.x, dz = E.z - camPos.z;
      if (dx * dx + dz * dz > 1400 * 1400 || n > MAX * 0.6) continue;
      E.acc += E.rate * dt;
      while (E.acc > 1) {
        E.acc -= 1;
        spawn(E.x + grnd(-0.2, 0.2), E.y, E.z + grnd(-0.2, 0.2), grnd(-0.3, 0.3), grnd(1.0, 2.0), grnd(-0.3, 0.3), grnd(3, 5.5), E.size * 0.5, E.size * 2.6, E.heat, 0.3, 0.6);
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      life[i] += dt;
      if (life[i] >= maxLife[i]) { kill(i); continue; }
      const k = Math.exp(-drag[i] * dt), i3 = i * 3;
      // buoyancy > 0 lifts warm gas; < 0 acts as gravity for sparks
      vel[i3] = (vel[i3] - wind.x) * k + wind.x; vel[i3 + 1] = vel[i3 + 1] * k + buoy[i] * dt; vel[i3 + 2] = (vel[i3 + 2] - wind.z) * k + wind.z;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      if (pos[i3 + 1] < 0.05) { pos[i3 + 1] = 0.05; vel[i3 + 1] *= -0.3; }
      const f = life[i] / maxLife[i];
      size[i] = s0[i] + (s1[i] - s0[i]) * Math.sqrt(f);
      heat[i] = h0[i] * (1 - f) * (1 - f) * Math.min(1, life[i] * 8 + 0.2);
    }
    geo.setDrawRange(0, n);
    aPos.needsUpdate = aHeat.needsUpdate = aSize.needsUpdate = true;
  }
  function sparks(p, nrm, count = 40, speed = 30) {
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(gauss(gameRand), gauss(gameRand), gauss(gameRand)).normalize().multiplyScalar(speed * grnd(0.2, 1));
      if (v.dot(nrm) < 0) v.addScaledVector(nrm, -2 * v.dot(nrm));
      spawn(p.x, p.y, p.z, v.x, v.y, v.z, grnd(0.25, 0.9), 0.09, 0.03, grnd(0.5, 1.2), 1.2, -9.8);
    }
    for (let i = 0; i < 14; i++) {
      const v = nrm.clone().multiplyScalar(grnd(1, 5)).add(new THREE.Vector3(grnd(-2, 2), grnd(-1, 2), grnd(-2, 2)));
      spawn(p.x, p.y, p.z, v.x, v.y, v.z, grnd(1.2, 2.6), 0.4, grnd(2.5, 4.5), grnd(0.08, 0.16), 1.6, 0.4);
    }
  }
  function puff(p, dir, count = 24) {
    for (let i = 0; i < count; i++) {
      const v = dir.clone().multiplyScalar(grnd(2, 9)).add(new THREE.Vector3(grnd(-2.5, 2.5), grnd(-1, 3), grnd(-2.5, 2.5)));
      spawn(p.x, p.y, p.z, v.x, v.y, v.z, grnd(0.6, 1.6), 0.25, grnd(1.2, 2.4), grnd(0.15, 0.32), 2.2, 0.3);
    }
  }
  function muzzle(p, dir) {
    for (let i = 0; i < 30; i++) {
      const v = dir.clone().multiplyScalar(grnd(5, 40)).add(new THREE.Vector3(grnd(-3, 3), grnd(-2, 3), grnd(-3, 3)));
      spawn(p.x, p.y, p.z, v.x, v.y, v.z, grnd(0.4, 1.4), 0.3, grnd(2, 4), grnd(0.25, 0.6), 3.0, 0.5);
    }
  }
  function clear() { n = 0; geo.setDrawRange(0, 0); }
  return { points, update, spawn, sparks, puff, muzzle, clear, wind, setScale(s) { mat.uniforms.uScale.value = s; } };
})();
