// ---------------------------------------------------------------------------
// City: procedural low-poly city, regenerated from a seed every stage.
// Provides collision (AABB grid), raycasts, rooftops for target spawns,
// heat emitters, traffic.
//
// Every seed rolls a "sector profile" (skyline height, tower archetypes, river,
// parks, industrial quarter, obstacle mix over the main avenue), so each stage
// reads as a different part of town. Detail is spent where the scope and the
// bullet can see it: lots inside the firing sector get full roof clutter and
// parapets, lots outside it are plain massing.
// ---------------------------------------------------------------------------
const City = (() => {
  const CELL = 32;
  const group = new THREE.Group();

  // ---- geometry ------------------------------------------------------------
  function polyGeo(polys) {
    // polys: [{ p: [[x,y,z]...3|4], n: [x,y,z], f: [flags] }] -> non-indexed, flat normals, winding fixed to n
    const P = [], N = [], F = [];
    for (const q of polys) {
      const [a, b, c] = q.p;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const flip = (uy * vz - uz * vy) * q.n[0] + (uz * vx - ux * vz) * q.n[1] + (ux * vy - uy * vx) * q.n[2] < 0;
      const ord = q.p.length === 4 ? (flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) : (flip ? [0, 2, 1] : [0, 1, 2]);
      for (const i of ord) { P.push(...q.p[i]); N.push(...q.n); F.push(q.f ? q.f[i] : 0); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('aIn', new THREE.Float32BufferAttribute(F, 1));
    return g;
  }
  function mergeNI(gs) {
    const P = [], N = [];
    for (const g0 of gs) { const g = g0.index ? g0.toNonIndexed() : g0; P.push(...g.attributes.position.array); N.push(...g.attributes.normal.array); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    return g;
  }
  function ringGeo() {
    // parapet ring: outer walls, inner walls (aIn=1, pulled in by VS_RING), top frame
    const o = 0.5, i = 0.4, polys = [];
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [sx, sz] of sides) {
      const c = (r) => (sx ? [[sx * r, -r], [sx * r, r]] : [[-r, sz * r], [r, sz * r]]);
      const [A, Bq] = c(o), [Ai, Bi] = c(i);
      polys.push({ p: [[A[0], 0, A[1]], [Bq[0], 0, Bq[1]], [Bq[0], 1, Bq[1]], [A[0], 1, A[1]]], n: [sx, 0, sz] });
      polys.push({ p: [[Ai[0], 0, Ai[1]], [Bi[0], 0, Bi[1]], [Bi[0], 1, Bi[1]], [Ai[0], 1, Ai[1]]], n: [-sx, 0, -sz], f: [1, 1, 1, 1] });
      polys.push({ p: [[A[0], 1, A[1]], [Bq[0], 1, Bq[1]], [Bi[0], 1, Bi[1]], [Ai[0], 1, Ai[1]]], n: [0, 1, 0], f: [0, 0, 1, 1] });
    }
    return polyGeo(polys);
  }
  function wedgeGeo() {
    // sawtooth roof tooth: vertical glazed face at +z, slope down to -z
    const s = 1 / Math.SQRT2;
    return polyGeo([
      { p: [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]], n: [0, 0, 1] },
      { p: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]], n: [0, s, -s] },
      { p: [[0.5, 0, -0.5], [0.5, 0, 0.5], [0.5, 1, 0.5]], n: [1, 0, 0] },
      { p: [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5]], n: [-1, 0, 0] },
    ]);
  }
  const geo = {
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    cbox: new THREE.BoxGeometry(1, 1, 1),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 10, 1).translate(0, 0.5, 0),
    cone: new THREE.ConeGeometry(1, 1, 10, 1).translate(0, 0.5, 0),
    pyr: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0),
    dish: new THREE.ConeGeometry(1, 1, 8, 1, true).rotateX(Math.PI).translate(0, 0.5, 0),
    tree: mergeNI([new THREE.ConeGeometry(1, 0.8, 5, 1).translate(0, 0.6, 0), new THREE.CylinderGeometry(0.12, 0.15, 0.25, 4, 1).translate(0, 0.125, 0)]),
    stCan: new THREE.IcosahedronGeometry(1, 0), stTrunk: new THREE.CylinderGeometry(0.16, 0.24, 1, 5, 1).translate(0, 0.5, 0),
    hyper: new THREE.LatheGeometry([[1, 0], [0.84, 0.22], [0.66, 0.5], [0.6, 0.72], [0.64, 0.9], [0.7, 1]].map(([x, y]) => new THREE.Vector2(x, y)), 12),
    wedge: wedgeGeo(), ring: ringGeo(),
  };
  const mats = {
    bld: thermalMat(FS_BUILDING),
    ring: thermalMat(FS_BUILDING, { uRingT: { value: 0.32 } }, { vertexShader: VS_RING }),
    lat: thermalMat(FS_LATTICE, {}, { side: THREE.DoubleSide }),
    hvac: thermalMat(FS_HVAC),
    tank: thermalMat(FS_TANK, { uT: { value: 0.272 } }),
    cone: thermalMat(FS_SOLID_C, { uT: { value: 0.23 }, uStripe: { value: 0 } }),
    pyr: thermalMat(FS_SHAPE, { uT: { value: 0.27 }, uKind: { value: 0 } }),
    saw: thermalMat(FS_SHAPE, { uT: { value: 0.22 }, uKind: { value: 1 } }),
    cool: thermalMat(FS_SHAPE, { uT: { value: 0.34 }, uKind: { value: 2 } }, { side: THREE.DoubleSide }),
    dish: thermalMat(FS_SHAPE, { uT: { value: 0.305 }, uKind: { value: 3 } }, { side: THREE.DoubleSide }),
    tree: thermalMat(FS_SOLID_C, { uT: { value: 0.285 }, uStripe: { value: 0 } }),
    stCan: thermalMat(FS_SOLID_C, { uT: { value: 0.3 }, uStripe: { value: 0 } }), stTrunk: thermalMat(FS_SOLID_C, { uT: { value: 0.33 }, uStripe: { value: 0 } }),
    car: thermalMat(FS_CAR),
    ground: thermalMat(FS_GROUND, {
      uGrid: { value: new THREE.Vector4(GRID.aveSp, GRID.mainHW, GRID.aveHW, GRID.stSp) }, uGrid2: { value: new THREE.Vector2(GRID.stHW, GRID.sw) },
      uRiver: { value: new THREE.Vector4(0, 0, 0, 0) }, uPark0: { value: new THREE.Vector4(1, 1, 0, 0) }, uPark1: { value: new THREE.Vector4(1, 1, 0, 0) },
    }),
    sky: thermalMat(FS_SKY, {}, { side: THREE.BackSide, depthWrite: false }),
  };

  // big full-screen-ish surfaces draw after the buildings so early-z rejects hidden pixels
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2).translate(0, 0, -1500), mats.ground);
  ground.frustumCulled = false; ground.renderOrder = 5;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5200, 24, 12), mats.sky);
  sky.frustumCulled = false; sky.renderOrder = 10;
  group.add(sky, ground);

  // ---- state -----------------------------------------------------------------
  let boxes = [], grid = new Map(), roofs = [], emitters = [];
  // instance lists. B/L/H: axis-aligned [x0,y0,z0,x1,y1,z1,seed,style]; RG: parapet rings (same form);
  // T-lists: [x,y,z, sx,sy,sz, rx,ry,rz, seed, style] (Euler YXZ)
  let B = [], L = [], H = [], RG = [], TK = [], CN = [], PY = [], WD = [], HY = [], DS = [], TR = [], CB = [], LP = [], STC = [], STT = [];
  let meshes = [], cars = [], carMesh = null, lightPts = null, stamp = 1;
  let density = () => 0, indus = () => 0, prof = {}, river = null, parks = [], reserved = [], heroes = [], steamVents = [];
  const info = { seed: 0, bridges: 0, cranes: 0, towers: 0, sector: '', cables: 0, spires: 0 };

  const key = (cx, cz) => (cx + 2048) * 4096 + (cz + 2048);
  function addCol(x0, y0, z0, x1, y1, z1, kind = 0) {
    const b = { x0, y0, z0, x1, y1, z1, kind, s: 0 }; const id = boxes.length; boxes.push(b);
    const cx0 = Math.floor(x0 / CELL), cx1 = Math.floor(x1 / CELL), cz0 = Math.floor(z0 / CELL), cz1 = Math.floor(z1 / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) { const k = key(cx, cz); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(id); }
    return id;
  }
  // style: 0 glass, 1 brick, 2 concrete, 3 plain, 4 warm panel, 5 skybridge, 6 lattice, 7 metal shed, 8 steel, 9 helipad, 10 deco
  function addB(x0, y0, z0, x1, y1, z1, style, seed = crnd(), collide = true, kind = 1) {
    if (style === 6) { const e = 0.03; L.push([x0 + e, y0 + e, z0 + e, x1 - e, y1 - e, z1 - e, seed, style]); }
    else B.push([x0, y0, z0, x1, y1, z1, seed, style]);
    if (collide) addCol(x0, y0, z0, x1, y1, z1, kind);
  }
  const addT = (list, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0, seed = crnd(), style = 0) => list.push([x, y, z, sx, sy, sz, rx, ry, rz, seed, style]);
  // remove the most recently added collision box (spawn tests place a trial box, then take it back)
  function popCol() {
    const id = boxes.length - 1, b = boxes[id]; if (!b) return;
    const cx0 = Math.floor(b.x0 / CELL), cx1 = Math.floor(b.x1 / CELL), cz0 = Math.floor(b.z0 / CELL), cz1 = Math.floor(b.z1 / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) { const a = grid.get(key(cx, cz)); if (!a) continue; const i = a.lastIndexOf(id); if (i >= 0) a.splice(i, 1); }
    boxes.pop();
  }
  // Cover structures placed after the city is built (the man's rooftop cover): their own small instanced
  // mesh, rebuilt whenever one is added, cleared with the city.
  let coverList = [], coverMesh = null;
  // Breakable glass (window and car targets): thin panes with their own meshes, collision kind 5. The round
  // goes straight through a pane and shatters it (the pane's collision box is marked dead). Props are plain
  // solid boxes at a set temperature (car bodies), with collision.
  let glassList = [], propList = [];
  const glassMat = thermalMat(FS_SOLID, { uT: { value: 0.15 }, uStripe: { value: 0 } });
  const propMats = {};
  function addGlass(b) {
    const id = addCol(b[0], b[1], b[2], b[3], b[4], b[5], 5);
    const m = new THREE.Mesh(new THREE.BoxGeometry(b[3] - b[0], b[4] - b[1], b[5] - b[2]), glassMat);
    m.position.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2); m.frustumCulled = false; group.add(m);
    glassList.push({ id, m }); return id;
  }
  function breakGlass(id) {
    const g = glassList.find((q) => q.id === id); if (!g || boxes[id].dead) return false;
    boxes[id].dead = true; g.m.visible = false; return true;
  }
  function addProp(b, t, collide = true, order = 0) {
    const key = t.toFixed(2); if (!propMats[key]) propMats[key] = thermalMat(FS_SOLID, { uT: { value: t }, uStripe: { value: 0 } });
    const m = new THREE.Mesh(new THREE.BoxGeometry(b[3] - b[0], b[4] - b[1], b[5] - b[2]), propMats[key]);
    m.position.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2); m.frustumCulled = false; m.renderOrder = order; group.add(m); propList.push(m);
    if (collide) addCol(b[0], b[1], b[2], b[3], b[4], b[5], 1);
  }
  // A window cut into a solid building: the room behind it (and the man) are drawn first (render order -2),
  // then this mask writes depth just in front of the facade over the opening (-1), so the building's face
  // (drawn after) leaves a hole there and the room shows through. The glass pane covers it until it breaks.
  const maskMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  function addMask(cx, cy, cz, w, h, nx, nz) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), maskMat);
    m.position.set(cx, cy, cz); m.lookAt(cx + nx, cy, cz + nz); m.renderOrder = -1; m.frustumCulled = false; group.add(m); propList.push(m);
  }
  function breakGlassNear(p, r) {
    let n = 0;
    for (const g of glassList) { const b = boxes[g.id]; if (b.dead) continue; const dx = (b.x0 + b.x1) / 2 - p.x, dy = (b.y0 + b.y1) / 2 - p.y, dz = (b.z0 + b.z1) / 2 - p.z; if (dx * dx + dy * dy + dz * dz < r * r && breakGlass(g.id)) n++; }
    return n;
  }
  function addCover(list) {
    for (const c of list) { coverList.push([c[0], c[1], c[2], c[3], c[4], c[5], c[7] != null ? c[7] : crnd(), c[6]]); if (c[8] !== false) addCol(c[0], c[1], c[2], c[3], c[4], c[5], 1); }
    if (coverMesh) { group.remove(coverMesh); coverMesh.geometry.dispose(); meshes = meshes.filter((m) => m !== coverMesh); coverMesh = null; }
    const before = meshes.length; instBoxes(coverList, mats.bld); if (meshes.length > before) coverMesh = meshes[meshes.length - 1];
  }

  function maxHeightAt(x, z) {
    const a = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))); let h = 0;
    if (a) for (const id of a) { const b = boxes[id]; if (b.kind === 1 && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) h = Math.max(h, b.y1); }
    return h;
  }
  // level of detail for a lot: 2 inside the firing sector, 1 near it, 0 background
  const EYE = PLAYER.eye;
  function lodAt(x, z) {
    const dx = x - EYE.x, dz = z - EYE.z, d = Math.hypot(dx, dz), yaw = Math.abs(Math.atan2(dx, -dz));
    if (d < 2350 && yaw < 0.95) return 2;
    if (d < 3000 && yaw < 1.25) return 1;
    return 0;
  }

  function heightFor(x, z, w, d) {
    const f = density(x, z);
    let h = 12 + 24 * Math.pow(crnd(), 1.7);
    if (crnd() < 0.07) h += crnd(10, 30);
    const big = Math.min(1, Math.min(w, d) / 28);
    h += (f * (25 + 90 * crnd()) + f * f * (50 + 190 * prof.height * Math.pow(crnd(), 0.9))) * big;
    h = Math.min(h, lerp(30, 999, sstep(-40, -380, z)));
    return h;
  }

  // ---- roof furniture ----------------------------------------------------------
  function mast(cx, cz, y, mh, beacons = true) {
    const mw = mh > 20 ? crnd(1.2, 1.8) : 0.5;
    addB(cx - mw / 2, y, cz - mw / 2, cx + mw / 2, y + mh, cz + mw / 2, mw > 1 ? 6 : 8);
    let top = y + mh;
    if (mh > 20) { addB(cx - 0.12, top, cz - 0.12, cx + 0.12, top + mh * 0.35, cz + 0.12, 8); top += mh * 0.35; }
    if (beacons) { LP.push([cx, top + 0.3, cz, crnd(), 0, 1.4]); if (mh > 25) LP.push([cx, y + mh * 0.55, cz, crnd(), 0, 1.0]); }
    return mw;
  }
  function dish(cx, cz, y, r) {
    const post = r * 0.7;
    addB(cx - 0.25, y, cz - 0.25, cx + 0.25, y + post, cz + 0.25, 8, crnd(), false);
    // bowl: the cone's apex points down after the flip; tilt it toward the sky at a random bearing
    const tilt = crnd(0.5, 1.0), yaw = crnd(0, TAU), by = y + post + r * 0.35;
    addT(DS, cx, by, cz, r, r * 0.35, r, tilt, yaw, 0);
    // feed arm along the dish axis (local +y after the YXZ tilt)
    _e.set(tilt, yaw, 0); _p.set(0, 1, 0).applyEuler(_e);
    const ax = _p.x, ay = _p.y, az = _p.z, L0 = r * 0.75;
    addT(CB, cx + ax * L0 / 2, by + ay * L0 / 2, cz + az * L0 / 2, 0.09, 0.09, L0, -Math.atan2(ay, Math.hypot(ax, az)), Math.atan2(ax, az), 0, crnd(), 8);
    addT(CB, cx + ax * L0, by + ay * L0, cz + az * L0, 0.3, 0.3, 0.3, -Math.atan2(ay, Math.hypot(ax, az)), Math.atan2(ax, az), 0, crnd(), 3);
    addCol(cx - r, y, cz - r, cx + r, y + post + r * 0.9, cz + r, 2);
  }
  function waterTower(cx, cz, y) {
    const rad = crnd(2.3, 3.1), leg = crnd(3.5, 6), th = crnd(4.5, 6.5);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) addB(cx + sx * rad * 0.7 - 0.15, y, cz + sz * rad * 0.7 - 0.15, cx + sx * rad * 0.7 + 0.15, y + leg, cz + sz * rad * 0.7 + 0.15, 8, crnd(), false);
    addB(cx - rad * 0.8, y + leg - 0.3, cz - rad * 0.8, cx + rad * 0.8, y + leg, cz + rad * 0.8, 3, crnd(), false);
    addT(TK, cx, y + leg, cz, rad, th, rad); addT(CN, cx, y + leg + th, cz, rad * 1.06, th * 0.32, rad * 1.06);
    addCol(cx - rad, y, cz - rad, cx + rad, y + leg + th + th * 0.32, cz + rad, 3);
    info.towers++;
  }

  function roofDetails(x0, z0, x1, z1, y, style, lod, kind = 'flat') {
    const w = x1 - x0, d = z1 - z0, seed = crnd();
    if (lod >= 1) {
      const ph = style === 0 ? 1.3 : 1.05, t = 0.32;
      RG.push([x0, y, z0, x1, y + ph, z1, seed, 3]);
      if (lod === 2) { addCol(x0, y, z0, x1, y + ph, z0 + t, 1); addCol(x0, y, z1 - t, x1, y + ph, z1, 1); addCol(x0, y, z0, x0 + t, y + ph, z1, 1); addCol(x1 - t, y, z0, x1, y + ph, z1, 1); }
    }
    const occ = [];
    if (lod < 2 || w < 7 || d < 7) { roofs.push({ x0, z0, x1, z1, y, h: y, occ }); return occ; }
    const place = (sw, sd, m = 1.4) => {
      for (let i = 0; i < 14; i++) {
        const px = crnd(x0 + m, x1 - m - sw), pz = crnd(z0 + m, z1 - m - sd);
        if (px < x0 + m - 1e-3 || pz < z0 + m - 1e-3) continue;
        if (occ.some((o) => px < o[2] + 1 && px + sw > o[0] - 1 && pz < o[3] + 1 && pz + sd > o[1] - 1)) continue;
        const r = [px, pz, px + sw, pz + sd]; occ.push(r); return r;
      }
      return null;
    };
    // helipad on big tower roofs
    if (kind === 'heli' && w > 18 && d > 18) {
      const s = Math.min(w, d) - 4, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      addB(cx - s / 2, y, cz - s / 2, cx + s / 2, y + 1.6, cz + s / 2, 9);
      for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; LP.push([cx + Math.cos(a) * s * 0.47, y + 1.8, cz + Math.sin(a) * s * 0.47, 0, 1, 0.5]); }
      occ.push([cx - s / 2, cz - s / 2, cx + s / 2, cz + s / 2]);
      roofs.push({ x0, z0, x1, z1, y, h: y, occ });
      return occ;
    }
    // stair / elevator bulkhead
    if (w > 11 && d > 11) { const r = place(crnd(3, 5), crnd(3.5, 6)); if (r) addB(r[0], y, r[1], r[2], y + crnd(3, 4.6), r[3], 12); }
    // HVAC units
    const nH = Math.min(5, Math.floor((w * d) / 260 + crnd(0, 1.5)));
    for (let i = 0; i < nH; i++) {
      const r = place(crnd(1.8, 5.5), crnd(1.8, 3.5)); if (!r) continue;
      const hh = crnd(1.1, 2.4); H.push([r[0], y, r[1], r[2], y + hh, r[3], crnd(), 0]); addCol(r[0], y, r[1], r[2], y + hh, r[3], 2);
      const cw = Math.min(0.9, (r[2] - r[0]) * 0.3), cd = Math.min(0.9, (r[3] - r[1]) * 0.3);
      addB(r[0] - cw, y, r[1] - cd, r[2] + cw, y + 0.22, r[3] + cd, 14, crnd(), false);
    }
    // vent stacks with heat plumes
    const nV = Math.floor(crnd(0, 3));
    for (let i = 0; i < nV; i++) {
      const r = place(0.6, 0.6, 1.0); if (!r) continue;
      const vh = crnd(1.2, 3.5); addB(r[0], y, r[1], r[2], y + vh, r[3], 8);
      addB(r[0] - 0.2, y + vh, r[1] - 0.2, r[2] + 0.2, y + vh + 0.18, r[3] + 0.2, 13, crnd(), false); // hot rain cap
      emitters.push({ x: r[0] + 0.3, y: y + vh, z: r[1] + 0.3, rate: crnd(1.5, 4), heat: crnd(0.012, 0.024), size: crnd(1.2, 2.6), acc: 0 });
    }
    // chimney pots on walk-ups, kitchen exhaust boxes on the rest
    {
      const nC = style === 1 ? 1 + Math.floor(crnd(0, 3)) : Math.floor(crnd(0, 2.2));
      for (let i = 0; i < nC; i++) {
        const r = place(style === 1 ? 0.9 : 1.2, style === 1 ? 0.9 : 1.2, 0.8); if (!r) continue;
        const ch = style === 1 ? crnd(1.4, 2.6) : crnd(0.8, 1.3);
        addB(r[0], y, r[1], r[2], y + ch, r[3], style === 1 ? 2 : 3, crnd(), false);
        addB(r[0] + 0.15, y + ch, r[1] + 0.15, r[2] - 0.15, y + ch + 0.35, r[3] - 0.15, 13, crnd(), false);
        addCol(r[0], y, r[1], r[2], y + ch + 0.35, r[3], 2);
        if (crnd() < 0.5) emitters.push({ x: (r[0] + r[2]) / 2, y: y + ch + 0.4, z: (r[1] + r[3]) / 2, rate: crnd(1, 2.5), heat: crnd(0.01, 0.02), size: crnd(0.8, 1.6), acc: 0 });
      }
    }
    // pipe runs along the roof (lying on short sleepers)
    if (crnd() < 0.45 && w > 14) {
      const pz = crnd(z0 + 2, z1 - 2), px0 = x0 + crnd(1.5, 4), px1 = x1 - crnd(1.5, 4);
      if (!occ.some((o) => pz > o[1] - 0.6 && pz < o[3] + 0.6)) {
        addB(px0, y + 0.35, pz - 0.16, px1, y + 0.67, pz + 0.16, 8, crnd(), false);
        for (let x = px0 + 1; x < px1; x += 6) addB(x - 0.1, y, pz - 0.3, x + 0.1, y + 0.35, pz + 0.3, 3, crnd(), false);
        occ.push([px0, pz - 0.5, px1, pz + 0.5]);
      }
    }
    // guard rail on top of the parapet along one or two edges
    if (crnd() < 0.3 && lod === 2) {
      // solid top and knee rails (a lattice panel this thin turns into moire under the scope)
      const ry = y + (style === 0 ? 1.3 : 1.05);
      // on the far edge only: never between the scope and a man on this roof
      for (const hy of [0.45, 0.95]) addB(x0 + 0.05, ry + hy, z0 + 0.12, x1 - 0.05, ry + hy + 0.07, z0 + 0.2, 8, crnd(), false);
      for (let x = x0 + 0.3; x < x1 - 0.2; x += 6) addB(x - 0.04, ry, z0 + 0.12, x + 0.04, ry + 0.95, z0 + 0.2, 8, crnd(), false);
    }
    // water tower
    if ((style === 1 || style === 2) && y < 75 && w > 12 && d > 12 && crnd() < prof.tower) {
      const r = place(7, 7, 1.6); if (r) waterTower(r[0] + 3.5, r[1] + 3.5, y);
    }
    // radio dishes
    if (crnd() < prof.dishes) {
      const n = 1 + Math.floor(crnd(0, 3));
      for (let i = 0; i < n; i++) { const rr = crnd(1.2, 2.6); const r = place(rr * 2, rr * 2, 1.2); if (r) dish(r[0] + rr, r[1] + rr, y, rr); }
    }
    // rooftop billboard facing the player
    if (y < 60 && w > 14 && crnd() < prof.signs) {
      const bw = Math.min(w - 4, crnd(9, 16)), cx = (x0 + x1) / 2, cz = z0 + crnd(2, d - 3), bh = crnd(4, 7), lg = crnd(2.5, 4);
      for (let i = 0; i <= 3; i++) { const lx = cx - bw / 2 + (bw * i) / 3; addB(lx - 0.15, y, cz + 0.4, lx + 0.15, y + lg, cz + 0.7, 8, crnd(), false); }
      addB(cx - bw / 2, y + lg, cz - 0.2, cx + bw / 2, y + lg + bh, cz + 0.25, 4);
      addCol(cx - bw / 2, y, cz - 0.2, cx + bw / 2, y + lg, cz + 0.7, 2);
      for (let i = 0; i < 4; i++) LP.push([cx - bw / 2 + bw * (i + 0.5) / 4, y + lg + bh + 0.2, cz + 0.6, 0, 1, 0.45]);
      occ.push([cx - bw / 2, cz - 1, cx + bw / 2, cz + 1.5]);
    }
    // antenna mast / antenna farm
    if ((y > 110 && crnd() < 0.75) || (y > 40 && crnd() < prof.masts)) {
      const cx = crnd(x0 + 3, x1 - 3), cz = crnd(z0 + 3, z1 - 3);
      const mw = mast(cx, cz, y, y > 110 ? crnd(18, 48) : crnd(8, 18));
      occ.push([cx - mw, cz - mw, cx + mw, cz + mw]);
      if (crnd() < 0.4) for (let i = 0; i < 3; i++) { const r = place(0.4, 0.4, 1.0); if (r) { mast(r[0] + 0.2, r[1] + 0.2, y, crnd(4, 11), crnd() < 0.5); } }
    }
    roofs.push({ x0, z0, x1, z1, y, h: y, occ });
    return occ;
  }

  // ---- building archetypes ------------------------------------------------------
  function crown(x0, z0, x1, z1, y, style, lod, force = false) {
    // art-deco crown: three quick setbacks, a pyramid cap and a needle with a beacon
    const seed = crnd(); let bx0 = x0, bx1 = x1, bz0 = z0, bz1 = z1;
    for (let i = 0; i < 3; i++) {
      const ix = (bx1 - bx0) * 0.12, iz = (bz1 - bz0) * 0.12; bx0 += ix; bx1 -= ix; bz0 += iz; bz1 -= iz;
      const hh = crnd(4, 8); addB(bx0, y, bz0, bx1, y + hh, bz1, i === 2 ? 3 : style, seed); y += hh;
      addB(bx0 - 0.4, y - 0.5, bz0 - 0.4, bx1 + 0.4, y, bz1 + 0.4, 3, seed, false);
    }
    const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2, nh = crnd(8, 26);
    let ph = 0;
    if (force || info.crowns++ < prof.maxCrowns) {
      ph = Math.min(bx1 - bx0, bz1 - bz0) * crnd(0.45, 0.8);
      addT(PY, cx, y, cz, bx1 - bx0, ph, bz1 - bz0);
      addCol(bx0 + (bx1 - bx0) * 0.25, y, bz0 + (bz1 - bz0) * 0.25, bx1 - (bx1 - bx0) * 0.25, y + ph * 0.5, bz1 - (bz1 - bz0) * 0.25, 1);
    } else {
      // flat-topped deco crown: lit lantern box
      ph = crnd(3, 5); addB(cx - (bx1 - bx0) * 0.3, y, cz - (bz1 - bz0) * 0.3, cx + (bx1 - bx0) * 0.3, y + ph, cz + (bz1 - bz0) * 0.3, 4, seed);
    }
    addB(cx - 0.35, y + ph * 0.6, cz - 0.35, cx + 0.35, y + ph + nh, cz + 0.35, 8);
    LP.push([cx, y + ph + nh + 0.3, cz, crnd(), 0, 1.4]);
  }
  function steppedTop(x0, z0, x1, z1, y, style) {
    const seed = crnd(), n = 4 + Math.floor(crnd(0, 3)), st = Math.min(x1 - x0, z1 - z0) / (2 * n + 2);
    for (let i = 0; i < n; i++) {
      const hh = crnd(2.4, 3.6);
      addB(x0 + st * (i + 1), y, z0 + st * (i + 1), x1 - st * (i + 1), y + hh, z1 - st * (i + 1), i % 2 ? 3 : style, seed);
      y += hh;
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2; mast(cx, cz, y, crnd(6, 14));
  }
  function spire(x0, z0, x1, z1, y, scale = 1) {
    // drum, lantern, needle
    const W = Math.min(x1 - x0, z1 - z0), w = W * crnd(0.2, 0.3), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, sh = crnd(35, 85) * scale;
    const d1 = W * 0.36, d2 = W * 0.26, h1 = crnd(5, 9), h2 = crnd(4, 7);
    addB(cx - d1, y, cz - d1, cx + d1, y + h1, cz + d1, 10);
    addB(cx - d2, y + h1, cz - d2, cx + d2, y + h1 + h2, cz + d2, 4);
    y += h1 + h2;
    addT(PY, cx, y, cz, w, sh, w);
    addCol(cx - w * 0.3, y, cz - w * 0.3, cx + w * 0.3, y + sh * 0.45, cz + w * 0.3, 1);
    addCol(cx - w * 0.1, y, cz - w * 0.1, cx + w * 0.1, y + sh * 0.85, cz + w * 0.1, 1);
    LP.push([cx, y + sh + 0.4, cz, crnd(), 0, 1.6], [cx, y + sh * 0.5, cz, crnd(), 0, 1.0]);
    info.spires++;
  }

  function tower(x0, z0, x1, z1, h, lod, hero = null) {
    const r = crnd();
    let style = r < prof.glass ? 0 : r < prof.glass + prof.deco * 0.6 ? 10 : 2;
    if (hero) style = hero.style;
    const flH = style === 0 ? 3.9 : 3.8;
    h = Math.max(9, 5 + Math.round((h - 5) / flH) * flH + 1.6);
    const seed = crnd();
    const top = crnd();
    // crowns and spires are landmarks: rationed per city, reserved for the tallest towers
    let kind = 'flat';
    if (hero) kind = hero.kind;
    else if (style === 10 && h > 85 && top < 0.6) kind = 'crown';
    else if (h > 125 && info.spires < prof.maxSpires && top < 0.55) kind = 'spire';
    else if (h > 90 && top < prof.heli + 0.25) kind = 'heli';
    else if (h > 70 && top < 0.12) kind = 'stepped';
    let tiers = 1; if (h > 75 && crnd() < (style === 10 ? 0.95 : 0.7)) tiers++; if (h > 150 && crnd() < 0.75) tiers++;
    if (hero) tiers = 3;
    let y = 0, bx0 = x0, bx1 = x1, bz0 = z0, bz1 = z1;
    for (let i = 0; i < tiers; i++) {
      const last = i === tiers - 1;
      let top = last ? h : 5 + Math.round((y + (h - y) * crnd(0.5, 0.72) - 5) / flH) * flH + 1.6;
      if (top - y < 8) top = Math.min(h, y + 8);
      addB(bx0, y, bz0, bx1, top, bz1, style, seed);
      if (!last) {
        addB(bx0 - 0.35, top - 0.5, bz0 - 0.35, bx1 + 0.35, top, bz1 + 0.35, 3, seed, false);
        if (lod >= 1) RG.push([bx0, top, bz0, bx1, top + 1.05, bz1, seed, 3]);
        const sx = (bx1 - bx0) * crnd(0.08, 0.2), sz = (bz1 - bz0) * crnd(0.08, 0.2), off = crnd() < 0.5;
        bx0 += off ? sx * 2 : sx; bx1 -= off ? 0 : sx; bz0 += sz; bz1 -= sz;
        if (bx1 - bx0 < 8 || bz1 - bz0 < 8) { y = top; break; }
      }
      y = top;
    }
    if (kind === 'crown' && lod >= 1) crown(bx0, bz0, bx1, bz1, y, style, lod, !!hero);
    else if (kind === 'spire' && lod >= 1) spire(bx0, bz0, bx1, bz1, y, hero ? 2 : 1);
    else if (kind === 'mast') {
      // broadcast tower top: plant room, lattice mast, two beacon levels
      const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2, pw = Math.min(bx1 - bx0, bz1 - bz0) * 0.5;
      addB(cx - pw / 2, y, cz - pw / 2, cx + pw / 2, y + 7, cz + pw / 2, 3);
      mast(cx, cz, y + 7, crnd(45, 70));
      roofs.push({ x0: bx0, z0: bz0, x1: bx1, z1: bz1, y, h: y, occ: [[cx - pw / 2, cz - pw / 2, cx + pw / 2, cz + pw / 2]] });
    }
    else if (kind === 'stepped' && lod >= 1) steppedTop(bx0, bz0, bx1, bz1, y, style);
    else roofDetails(bx0, bz0, bx1, bz1, y, style, lod, kind);
  }

  function lowRise(x0, z0, x1, z1, h, lod) {
    if (crnd() < prof.parking && x1 - x0 > 24 && z1 - z0 > 24) {
      // parking structure: open decks, ramp housing, a few warm cars on the roof deck
      const hp = 3.2 * Math.floor(crnd(3, 7)) + 1.1;
      addB(x0, 0, z0, x1, hp, z1, 11);
      if (lod >= 1) RG.push([x0, hp, z0, x1, hp + 1.0, z1, crnd(), 3]);
      addB(x0 + 1, hp, z0 + 1, x0 + 7, hp + 3.4, z0 + 9, 12);
      const occ = [[x0, z0, x0 + 8, z0 + 10]];
      roofs.push({ x0, z0, x1, z1, y: hp, h: hp, occ });
      if (lod === 2) for (let i = 0; i < 6; i++) { const cx = crnd(x0 + 4, x1 - 4), cz = crnd(z0 + 12, z1 - 4); addB(cx - 0.9, hp, cz - 2.2, cx + 0.9, hp + 1.45, cz + 2.2, 3, crnd(), false); occ.push([cx - 1, cz - 2.4, cx + 1, cz + 2.4]); }
      return;
    }
    const style = crnd() < prof.brick ? 1 : crnd() < 0.75 ? 2 : 0;
    const flH = style === 0 ? 3.9 : style === 1 ? 3.5 : 3.8;
    h = Math.max(9, 5 + Math.round((h - 5) / flH) * flH + 1.6);
    addB(x0, 0, z0, x1, h, z1, style);
    // scaffolding on one face of a few mid-rise blocks
    if (lod === 2 && h > 18 && crnd() < prof.scaffold) {
      const side = crnd() < 0.5, hh = h * crnd(0.5, 0.95);
      if (side) addB(x0 + 2, 0, z1 + 0.4, x1 - 2, hh, z1 + 2.0, 6); else addB(x1 + 0.4, 0, z0 + 2, x1 + 2.0, hh, z1 - 2, 6);
    }
    roofDetails(x0, z0, x1, z1, h, style, lod);
  }

  function warehouse(x0, z0, x1, z1, lod) {
    const h = crnd(8, 15), seed = crnd();
    addB(x0, 0, z0, x1, h, z1, 7, seed);
    const w = x1 - x0, d = z1 - z0;
    if (crnd() < 0.65 && d > 14) {
      // sawtooth roof: teeth run along x, glazed faces toward the player
      const n = Math.max(2, Math.round(d / crnd(6, 9))), td = d / n, th = crnd(2.4, 3.6);
      for (let i = 0; i < n; i++) addT(WD, (x0 + x1) / 2, h, z0 + td * (i + 0.5), w, th, td);
      addCol(x0, h, z0, x1, h + th * 0.6, z1, 1);
      if (lod === 2) for (let i = 0; i < 2; i++) { const vx = crnd(x0 + 2, x1 - 2), vz = crnd(z0 + 2, z1 - 2); addB(vx - 0.4, h, vz - 0.4, vx + 0.4, h + th + crnd(2, 5), vz + 0.4, 8); emitters.push({ x: vx, y: h + th + 3, z: vz, rate: crnd(2, 4), heat: crnd(0.015, 0.025), size: crnd(2, 3.5), acc: 0 }); }
    } else roofDetails(x0, z0, x1, z1, h, 7, lod);
  }
  function tankFarm(x0, z0, x1, z1, lod) {
    const occ = [];
    for (let i = 0; i < 9; i++) {
      const r = crnd(5, 11), cx = crnd(x0 + r + 1, x1 - r - 1), cz = crnd(z0 + r + 1, z1 - r - 1);
      if (x1 - x0 < 2 * r + 2 || z1 - z0 < 2 * r + 2) continue;
      if (occ.some((o) => Math.hypot(o[0] - cx, o[1] - cz) < o[2] + r + 2)) continue;
      occ.push([cx, cz, r]);
      const th = crnd(7, 15);
      addT(TK, cx, 0, cz, r, th, r); addT(CN, cx, th, cz, r * 1.02, r * 0.12, r * 1.02);
      addCol(cx - r * 0.85, 0, cz - r * 0.85, cx + r * 0.85, th + r * 0.1, cz + r * 0.85, 1);
      if (lod === 2) { addB(cx + r - 0.3, 0, cz - 0.6, cx + r + 0.3, th, cz + 0.6, 6, crnd(), false); }
    }
    // containment berm
    const bh = 1.4;
    addB(x0, 0, z0, x1, bh, z0 + 0.6, 2); addB(x0, 0, z1 - 0.6, x1, bh, z1, 2);
    addB(x0, 0, z0, x0 + 0.6, bh, z1, 2); addB(x1 - 0.6, 0, z0, x1, bh, z1, 2);
  }
  function silos(x0, z0, x1, z1) {
    const n = 2 + Math.floor(crnd(0, 4)), r = crnd(3.5, 5.5), h = crnd(28, 48), cz = (z0 + z1) / 2;
    const span = n * r * 2.1; let cx = (x0 + x1) / 2 - span / 2 + r;
    if (span > x1 - x0 - 2) return warehouse(x0, z0, x1, z1, 1);
    for (let i = 0; i < n; i++, cx += r * 2.1) { addT(TK, cx, 0, cz, r, h, r); addT(CN, cx, h, cz, r, r * 0.5, r); }
    addCol((x0 + x1) / 2 - span / 2, 0, cz - r, (x0 + x1) / 2 + span / 2, h + r * 0.4, cz + r, 1);
    // head house + conveyor gallery over the silos
    const hx = (x0 + x1) / 2 - span / 2 - 7;
    if (hx > x0) { addB(hx, 0, cz - 4, hx + 6, h + 9, cz + 4, 2); roofs.push({ x0: hx, z0: cz - 4, x1: hx + 6, z1: cz + 4, y: h + 9, h: h + 9, occ: [] }); }
    addB((x0 + x1) / 2 - span / 2, h + r * 0.5, cz - 1.5, (x0 + x1) / 2 + span / 2, h + r * 0.5 + 3, cz + 1.5, 7);
  }
  function coolingTower(cx, cz, R) {
    const Ht = R * crnd(2.4, 3.0);
    addT(HY, cx, 0, cz, R, Ht, R);
    addCol(cx - R * 0.85, 0, cz - R * 0.85, cx + R * 0.85, Ht * 0.3, cz + R * 0.85, 1);
    addCol(cx - R * 0.68, Ht * 0.3, cz - R * 0.68, cx + R * 0.68, Ht, cz + R * 0.68, 1);
    for (let i = 0; i < 4; i++) emitters.push({ x: cx + crnd(-R, R) * 0.35, y: Ht + 2, z: cz + crnd(-R, R) * 0.35, rate: crnd(5, 8), heat: crnd(0.02, 0.03), size: crnd(9, 15), acc: 0 });
    LP.push([cx, Ht + 0.5, cz, crnd(), 0, 2.0]);
    info.cool = (info.cool || 0) + 1;
  }

  function crane(cx, cz) {
    const H0 = crnd(55, 115), m = 1.1;
    addB(cx - m, 0, cz - m, cx + m, H0, cz + m, 6);
    addB(cx - 1.6, H0, cz - 1.6, cx + 1.6, H0 + 3.2, cz + 1.6, 4); // cab / slewing unit
    const Lj = crnd(38, 62), C = crnd(12, 18), dir = crnd() < 0.5 ? 0 : 1, sgn = crnd() < 0.5 ? -1 : 1;
    const jy0 = H0 + 3.2, jy1 = jy0 + 1.8;
    if (dir === 0) {
      const a = sgn > 0 ? cx : cx - Lj, b = sgn > 0 ? cx + Lj : cx;
      addB(a, jy0, cz - 0.8, b, jy1, cz + 0.8, 6);
      const ca = sgn > 0 ? cx - C : cx, cb = sgn > 0 ? cx : cx + C;
      addB(ca, jy0, cz - 0.8, cb, jy1, cz + 0.8, 6);
      const cw = sgn > 0 ? ca : cb - 4; addB(cw, jy0 - 2.5, cz - 1.4, cw + 4, jy0, cz + 1.4, 3);
      LP.push([sgn > 0 ? b : a, jy1 + 0.3, cz, crnd(), 0, 1.2]);
      // hook line + block hanging from the jib
      const hx = sgn > 0 ? cx + Lj * crnd(0.4, 0.9) : cx - Lj * crnd(0.4, 0.9), hy = crnd(H0 * 0.35, H0 * 0.8);
      addB(hx - 0.06, hy, cz - 0.06, hx + 0.06, jy0, cz + 0.06, 8, crnd(), false); addB(hx - 0.6, hy - 1.4, cz - 0.6, hx + 0.6, hy, cz + 0.6, 3);
    } else {
      const a = sgn > 0 ? cz : cz - Lj, b = sgn > 0 ? cz + Lj : cz;
      addB(cx - 0.8, jy0, a, cx + 0.8, jy1, b, 6);
      const ca = sgn > 0 ? cz - C : cz, cb = sgn > 0 ? cz : cz + C;
      addB(cx - 0.8, jy0, ca, cx + 0.8, jy1, cb, 6);
      const cw = sgn > 0 ? ca : cb - 4; addB(cx - 1.4, jy0 - 2.5, cw, cx + 1.4, jy0, cw + 4, 3);
      LP.push([cx, jy1 + 0.3, sgn > 0 ? b : a, crnd(), 0, 1.2]);
      const hz = sgn > 0 ? cz + Lj * crnd(0.4, 0.9) : cz - Lj * crnd(0.4, 0.9), hy = crnd(H0 * 0.35, H0 * 0.8);
      addB(cx - 0.06, hy, hz - 0.06, cx + 0.06, jy0, hz + 0.06, 8, crnd(), false); addB(cx - 0.6, hy - 1.4, hz - 0.6, cx + 0.6, hy, hz + 0.6, 3);
    }
    addB(cx - 0.6, H0 + 3.2, cz - 0.6, cx + 0.6, H0 + 11, cz + 0.6, 6); // apex
    LP.push([cx, H0 + 11.3, cz, crnd(), 0, 1.2]);
    info.cranes++;
  }

  function splitLots(x0, z0, x1, z1, depth, out, lod) {
    const w = x1 - x0, d = z1 - z0;
    const f = density((x0 + x1) / 2, (z0 + z1) / 2);
    const minS = (13 + 16 * f) * (lod === 0 ? 2.1 : lod === 1 ? 1.3 : 1);
    if (depth > 4 || (w < minS * 2 && d < minS * 2) || (f > 0.45 && depth > 0 && crnd() < 0.3 * f)) { out.push([x0, z0, x1, z1]); return; }
    const gap = crnd() < 0.3 ? crnd(1.5, 5) : 0;
    if ((w > d && w >= minS * 2) || d < minS * 2) {
      const s = x0 + w * crnd(0.35, 0.65);
      splitLots(x0, z0, s - gap / 2, z1, depth + 1, out, lod); splitLots(s + gap / 2, z0, x1, z1, depth + 1, out, lod);
    } else {
      const s = z0 + d * crnd(0.35, 0.65);
      splitLots(x0, z0, x1, s - gap / 2, depth + 1, out, lod); splitLots(x0, s + gap / 2, x1, z1, depth + 1, out, lod);
    }
  }

  function park(x0, z0, x1, z1) {
    const n = Math.floor((x1 - x0) * (z1 - z0) / 70);
    for (let i = 0; i < n; i++) {
      const x = crnd(x0 + 2, x1 - 2), z = crnd(z0 + 2, z1 - 2);
      // keep the diagonal paths clear
      const d1 = Math.abs(((x + z) / 38) % 1 + 1) % 1, d2 = Math.abs(((x - z) / 38) % 1 + 1) % 1;
      if (Math.abs(d1 - 0.5) > 0.44 || Math.abs(d2 - 0.5) > 0.44) continue;
      const r = crnd(1.8, 3.2), th = crnd(5, 10);
      addT(TR, x, 0, z, r, th, r, 0, crnd(0, TAU), 0);
    }
    // a pavilion and a monument for silhouette interest
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    addB(cx - 1.5, 0, cz - 1.5, cx + 1.5, 4, cz + 1.5, 10); addT(PY, cx, 4, cz, 3, crnd(14, 26), 3);
    addCol(cx - 1.5, 0, cz - 1.5, cx + 1.5, 16, cz + 1.5, 1);
    LP.push([cx, 4.5, cz + 1.8, 0, 1, 0.6]);
  }

  function block(x0, z0, x1, z1, exclude) {
    const cxB = (x0 + x1) / 2, czB = (z0 + z1) / 2;
    for (const P of parks) if (cxB > P[0] && cxB < P[2] && czB > P[1] && czB < P[3]) { park(x0, z0, x1, z1); return; }
    const lodB = lodAt(cxB, czB);
    const lots = []; splitLots(x0, z0, x1, z1, 0, lots, lodB);
    // hero tower: the biggest lot of the block that holds a hero point
    for (const hr of heroes) {
      if (hr.done || hr.x < x0 || hr.x > x1 || hr.z < z0 || hr.z > z1) continue;
      let bi = -1, ba = 0;
      lots.forEach((Lt, i) => { const a = Math.min(Lt[2] - Lt[0], Lt[3] - Lt[1]); if (a > ba) { ba = a; bi = i; } });
      if (bi < 0 || ba < 22) continue;
      const Lt = lots.splice(bi, 1)[0]; hr.done = true;
      tower(Lt[0], Lt[1], Lt[2], Lt[3], hr.h, lodAt((Lt[0] + Lt[2]) / 2, (Lt[1] + Lt[3]) / 2), hr);
    }
    const ind = indus(cxB, czB) > 0.5;
    for (const Lt of lots) {
      if (exclude && Lt[0] < exclude[2] && Lt[2] > exclude[0] && Lt[1] < exclude[3] && Lt[3] > exclude[1]) continue;
      if (reserved.some((r) => Lt[0] < r[0] + r[2] + 3 && Lt[2] > r[0] - r[2] - 3 && Lt[1] < r[1] + r[2] + 3 && Lt[3] > r[1] - r[2] - 3)) continue;
      const lx = (Lt[0] + Lt[2]) / 2, lz = (Lt[1] + Lt[3]) / 2, w = Lt[2] - Lt[0], d = Lt[3] - Lt[1];
      if (w < 6 || d < 6) continue;
      const lod = lodAt(lx, lz), r = crnd();
      if (ind) {
        if (r < 0.06) continue;
        if (r < 0.2 && w > 30 && d > 30) { tankFarm(Lt[0], Lt[1], Lt[2], Lt[3], lod); continue; }
        if (r < 0.28 && w > 26 && d > 12) { silos(Lt[0], Lt[1], Lt[2], Lt[3]); continue; }
        warehouse(Lt[0], Lt[1], Lt[2], Lt[3], lod); continue;
      }
      if (lod === 2 && r < prof.cranes && info.cranes < 22 && w > 20 && d > 20 && Lt[1] < -250) {
        // construction site: crane + concrete stub wrapped in scaffolding
        crane(lx + crnd(-4, 4), lz + crnd(-4, 4));
        const sx = Lt[0] + 2, sz = Lt[1] + 2, sh = crnd(6, 22), ex = sx + w * 0.4, ez = sz + d * 0.4;
        addB(sx, 0, sz, ex, sh, ez, 2); addB(sx - 1.2, 0, ez + 0.4, ex, sh + 2, ez + 1.6, 6);
        continue;
      }
      if (r < prof.cranes + 0.05) continue; // plaza / parking lot
      const h = heightFor(lx, lz, w, d);
      if (h > 60) tower(Lt[0], Lt[1], Lt[2], Lt[3], h, lod); else lowRise(Lt[0], Lt[1], Lt[2], Lt[3], h, lod);
    }
  }

  // ---- obstacles across the main avenue --------------------------------------------
  const edge = GRID.mainHW + GRID.sw;
  const offStreet = (z, m) => Math.abs(z + Math.round(-z / GRID.stSp) * GRID.stSp) > GRID.stHW + m;
  function skybridges() {
    let z = -crnd(150, 260);
    while (z > -2300) {
      if (offStreet(z, 7) && !(river && z > river.z0 - 8 && z < river.z1 + 8)) {
        const hl = maxHeightAt(-edge - 2, z), hr = maxHeightAt(edge + 2, z);
        const ymax = Math.min(hl, hr) - 4;
        if (ymax > 16) {
          const yb = crnd(9, Math.min(ymax - 2, 70)), bh = crnd(4.6, 6.4), bd = crnd(5, 7.5);
          addB(-edge - 1, yb, z - bd / 2, edge + 1, yb + bh, z + bd / 2, 5);
          if (crnd() < 0.3 && ymax > yb + 18) { const y2 = yb + crnd(10, 20); addB(-edge - 1, y2, z - bd / 2, edge + 1, y2 + bh, z + bd / 2, 5); }
          else if (crnd() < 0.35) { // open-truss bridge variant: lattice deck with a glazed tube on top
            addB(-edge - 1, yb - 2.2, z - bd / 2, edge + 1, yb, z + bd / 2, 6);
          }
          info.bridges++;
        }
      }
      z -= crnd(110, 330) / prof.bridges;
    }
    // a few across cross streets elsewhere
    for (let i = 0; i < 26; i++) {
      const k = Math.floor(crnd(2, 22)), zc = -k * GRID.stSp, x = crnd(-700, 700);
      const ax = Math.abs(x - Math.round(x / GRID.aveSp) * GRID.aveSp); if (ax < GRID.aveHW + 12) continue;
      const e = GRID.stHW + GRID.sw;
      const hn = maxHeightAt(x, zc + e + 2), hf = maxHeightAt(x, zc - e - 2), ymax = Math.min(hn, hf) - 4;
      if (ymax < 14) continue;
      const yb = crnd(8, Math.min(ymax, 60)), bw = crnd(4, 6);
      addB(x - bw / 2, yb, zc - e - 1, x + bw / 2, yb + crnd(3.5, 4.5), zc + e + 1, 5);
    }
  }
  // sagging cable as short sloped segments (visual: rotated thin boxes; collision: tight AABBs)
  function cable(ax, ay, az, bx, by, bz, sag, th = 0.22) {
    const n = 8, P = [];
    for (let i = 0; i <= n; i++) { const t = i / n; P.push([lerp(ax, bx, t), lerp(ay, by, t) - sag * 4 * t * (1 - t), lerp(az, bz, t)]); }
    for (let i = 0; i < n; i++) {
      const [x0, y0, z0] = P[i], [x1, y1, z1] = P[i + 1];
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz), hl = Math.hypot(dx, dz);
      addT(CB, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, th, th, len, -Math.atan2(dy, hl), Math.atan2(dx, dz), 0, crnd(), 8);
      addCol(Math.min(x0, x1) - th / 2, Math.min(y0, y1) - th / 2, Math.min(z0, z1) - th / 2, Math.max(x0, x1) + th / 2, Math.max(y0, y1) + th / 2, Math.max(z0, z1) + th / 2, 4);
    }
  }
  function cables() {
    // power / comms lines strung between rooftops over the main avenue
    let z = -crnd(120, 300);
    while (z > -2100) {
      if (offStreet(z, 4) && !(river && z > river.z0 - 4 && z < river.z1 + 4)) {
        const hl = maxHeightAt(-edge - 3, z), hr = maxHeightAt(edge + 3, z);
        if (hl > 20 && hr > 20 && hl < 170 && hr < 170) {
          const n = 1 + Math.floor(crnd(0, 3)), sag = crnd(1.5, 4.5);
          for (let i = 0; i < n; i++) cable(-edge - 3, hl + 1.0, z + i * 1.3, edge + 3, hr + 1.0, z + i * 1.3, sag);
          // small anchor masts on each roof
          addB(-edge - 3.3, hl, z - 0.3, -edge - 2.7, hl + 1.6, z + n * 1.3, 8); addB(edge + 2.7, hr, z - 0.3, edge + 3.3, hr + 1.6, z + n * 1.3, 8);
          info.cables++;
        }
      }
      z -= crnd(140, 420) / prof.cables;
    }
  }
  function gantries() {
    // traffic-signal gantries at main-avenue intersections, sign gantries mid-block
    for (let k = 1; k < 24; k++) {
      if (crnd() > prof.gantry) continue;
      const zc = -k * GRID.stSp + GRID.stHW + 2.5;
      if (river && zc > river.z0 - 10 && zc < river.z1 + 10) continue;
      const y = 6.2;
      for (const s of [-1, 1]) addB(s * (GRID.mainHW + 0.6) - 0.25, 0, zc - 0.25, s * (GRID.mainHW + 0.6) + 0.25, y + 0.6, zc + 0.25, 8);
      addB(-GRID.mainHW - 0.6, y, zc - 0.3, GRID.mainHW + 0.6, y + 0.6, zc + 0.3, 8);
      for (let i = 0; i < 4; i++) { const x = -GRID.mainHW + 4 + i * (2 * GRID.mainHW - 8) / 3; addB(x - 0.35, y - 1.3, zc - 0.25, x + 0.35, y, zc + 0.25, 3, crnd(), false); LP.push([x, y - 0.65, zc + 0.35, 0, 1, 0.35]); }
      if (crnd() < 0.35) { // overhead sign panel on the far side of the block
        const zs = zc - crnd(25, 50);
        addB(-GRID.mainHW - 0.6, 0, zs - 0.25, -GRID.mainHW, 7.5, zs + 0.25, 8); addB(GRID.mainHW, 0, zs - 0.25, GRID.mainHW + 0.6, 7.5, zs + 0.25, 8);
        addB(-GRID.mainHW, 7.5, zs - 1, GRID.mainHW, 8.2, zs + 1, 6);
        addB(-6, 8.2, zs - 0.2, 6, 11.5, zs + 0.2, 4);
      }
    }
  }
  function steamGrates() {
    steamVents = [];
    for (let i = 0; i < 22; i++) {
      const main = i < 8;
      const j = main ? 0 : Math.round(crnd(-GRID.nAve + 1, GRID.nAve - 1));
      const hw = j === 0 ? GRID.mainHW : GRID.aveHW;
      const x = j * GRID.aveSp + (crnd() < 0.5 ? -1 : 1) * crnd(2.5, hw - 2.5);
      const k = Math.floor(crnd(1, 26)), z = -(k + crnd(0.3, 0.7)) * GRID.stSp;
      if (river && z > river.z0 - 4 && z < river.z1 + 4) continue;
      addB(x - 0.6, 0, z - 0.45, x + 0.6, 0.16, z + 0.45, 15, crnd(), false);
      steamVents.push({ x, y: 0.16, z });
      emitters.push({ x, y: 0.2, z, rate: crnd(3, 5), heat: crnd(0.02, 0.035), size: crnd(1.4, 2.4), acc: 0, street: true });
    }
  }
  function riverworks() {
    if (!river) return;
    // embankment walls and bridges for every avenue; the main avenue gets a through-truss
    for (const z of [river.z0, river.z1]) addB(-1100, 0, z - 0.8, 1100, 1.0, z + 0.8, 3, crnd(), false);
    for (let j = -GRID.nAve; j <= GRID.nAve; j++) {
      const hw = (j === 0 ? GRID.mainHW : GRID.aveHW) + GRID.sw, x = j * GRID.aveSp;
      addB(x - hw, 0.6, river.z0, x - hw + 0.5, 1.8, river.z1, 8, crnd(), false); addB(x + hw - 0.5, 0.6, river.z0, x + hw, 1.8, river.z1, 8, crnd(), false);
      addB(x - hw, -2, river.z0, x + hw, 0.6, river.z1, 3, crnd(), false);
      if (j === 0) {
        const th = crnd(9, 13);
        for (const s of [-1, 1]) addB(s * hw - 0.6, 0.6, river.z0 - 2, s * hw + 0.6, 0.6 + th, river.z1 + 2, 6);
        for (let z = river.z0; z <= river.z1; z += (river.z1 - river.z0) / 3) addB(-hw, th - 0.6, z - 0.6, hw, th + 0.6, z + 0.6, 6);
        LP.push([-hw, th + 1, river.z0, 0.2, 0, 1.0], [hw, th + 1, river.z1, 0.7, 0, 1.0]);
      }
    }
  }

  // tree-lined streets: about one cross street in six gets a row of trees down both sidewalks. The canopies
  // hang out over the kerb lanes (solid to the round, collision kind 7), something to thread it between; the
  // middle of the road and the intersections stay open. Only within the shooter's field of play.
  function streetTrees() {
    const phase = Math.floor(crnd(0, 6)), eye = PLAYER.eye;
    for (let k = 2; k < GRID.nSt - 1; k++) {
      if ((k + phase) % 6 !== 0 || (river && (k === river.k || k === river.k + 1))) continue;
      const zc = -k * GRID.stSp, xMax = Math.tan(32 * DEG) * (eye.z - zc) + 60;
      for (const side of [-1, 1]) {
        const z = zc + side * (GRID.stHW + GRID.sw * 0.45);
        for (let x = -xMax + crnd(0, 10); x <= xMax; x += crnd(10, 13)) {
          const j = Math.round(x / GRID.aveSp), hw = (j === 0 ? GRID.mainHW : GRID.aveHW) + GRID.sw + 3;
          if (Math.abs(x - j * GRID.aveSp) < hw) continue;
          const r = crnd(2.4, 3.2), tH = crnd(3.6, 4.6), cy = tH + r * 0.7;
          addT(STT, x, 0, z, 1, tH + 0.3, 1, 0, crnd(0, TAU), 0);
          addT(STC, x, cy, z, r, r * crnd(0.8, 1.0), r, crnd(-0.2, 0.2), crnd(0, TAU), 0);
          addCol(x - 0.25, 0, z - 0.25, x + 0.25, tH, z + 0.25, 7);
          addCol(x - r * 0.75, cy - r * 0.7, z - r * 0.75, x + r * 0.75, cy + r * 0.75, z + r * 0.75, 7);
        }
      }
    }
  }
  function elevatedRail() {
    if (!prof.rail) return null;
    let k = Math.floor(crnd(3, 12)), zc = -k * GRID.stSp;
    if (river && Math.abs(zc - (river.z0 + river.z1) / 2) < 80) { k += 2; zc = -k * GRID.stSp; }
    const y0 = crnd(8, 11);
    addB(-1100, y0, zc - 3.6, 1100, y0 + 1.6, zc + 3.6, 3);
    addB(-1100, y0 + 1.6, zc - 3.6, 1100, y0 + 2.4, zc - 3.2, 3, crnd(), false);
    addB(-1100, y0 + 1.6, zc + 3.2, 1100, y0 + 2.4, zc + 3.6, 3, crnd(), false);
    for (let x = -1080; x <= 1080; x += 36) {
      const ax = Math.abs(x - Math.round(x / GRID.aveSp) * GRID.aveSp);
      if (ax < GRID.aveHW + 1 || (Math.abs(x) < GRID.mainHW + 1)) continue;
      addB(x - 0.8, 0, zc - 1.2, x + 0.8, y0, zc + 1.2, 3);
      if (Math.abs(x) < 900 && ((x / 36) | 0) % 2 === 0) addB(x - 0.12, y0 + 2.4, zc - 3.4, x + 0.12, y0 + 7, zc - 3.1, 8, crnd(), false); // catenary poles
    }
    addB(-1100, y0 + 6.6, zc - 3.32, 1100, y0 + 6.72, zc - 3.2, 8, crnd(), false);
    return { z: zc, y: y0 + 1.6 };
  }

  function mergeBoxes(list) {
    const g = new THREE.BufferGeometry(); const pos = [], nor = [], idx = []; let off = 0;
    for (const b of list) {
      const bg = new THREE.BoxGeometry(b[3] - b[0], b[4] - b[1], b[5] - b[2]).translate((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
      pos.push(...bg.attributes.position.array); nor.push(...bg.attributes.normal.array);
      for (const i of bg.index.array) idx.push(i + off); off += bg.attributes.position.count; bg.dispose();
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setIndex(idx);
    return g;
  }
  const carGeo = mergeBoxes([
    [-0.9, 0.34, -2.2, 0.9, 1.06, 2.2], [-0.8, 1.06, -1.25, 0.8, 1.58, 0.85],
    [-0.98, 0.0, 1.15, -0.78, 0.68, 1.8], [0.78, 0.0, 1.15, 0.98, 0.68, 1.8],
    [-0.98, 0.0, -1.75, -0.78, 0.68, -1.1], [0.78, 0.0, -1.75, 0.98, 0.68, -1.1],
  ]);
  const trainMat = thermalMat(FS_BUILDING);
  let rail = null, train = null;

  function traffic() {
    const add = (x, z, dx, dz, sp, axis, lo, hi) => {
      const kind = crnd(); const sc = kind < 0.08 ? [1.15, 1.45, 2.5] : kind < 0.25 ? [1.05, 1.25, 1.2] : [1, 1, 1];
      cars.push({ x, z, dx, dz, sp, axis, lo, hi, sc, seed: crnd() });
    };
    for (let i = 0; i < 4; i++) {
      const lx = 1.9 + 3.4 * i;
      for (let c = 0; c < 18; c++) { add(lx, -crnd(60, 2600), 0, -1, crnd(9, 16), 'z', -2700, -60); add(-lx, -crnd(60, 2600), 0, 1, crnd(9, 16), 'z', -2700, -60); }
    }
    for (let k = 1; k <= 16; k++) {
      const zc = -k * GRID.stSp;
      for (const [lz, dir] of [[2.1, 1], [5.4, 1], [-2.1, -1], [-5.4, -1]]) for (let c = 0; c < 4; c++) add(crnd(-1000, 1000), zc + lz, dir, 0, crnd(8, 14), 'x', -1050, 1050);
    }
    for (let j = -3; j <= 3; j++) {
      if (!j) continue;
      for (const [lx, dir] of [[2.1, -1], [5.4, -1], [-2.1, 1], [-5.4, 1]]) for (let c = 0; c < 5; c++) add(j * GRID.aveSp + lx, -crnd(60, 2600), 0, dir, crnd(8, 14), 'z', -2700, 40);
    }
    const n = cars.length;
    const g = carGeo.clone(); const seeds = new Float32Array(n); cars.forEach((c, i) => (seeds[i] = c.seed));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    carMesh = new THREE.InstancedMesh(g, mats.car, n); carMesh.frustumCulled = false;
    carMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    meshes.push(carMesh); group.add(carMesh);
    if (rail) {
      const tg = mergeBoxes([[-0.0, 0, -1.5, 17.4, 3.4, 1.5]]);
      const tseeds = new Float32Array(6).map(() => crnd()); tg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(tseeds, 1));
      const tm = new THREE.InstancedMesh(tg, trainMat, 6); tm.frustumCulled = false;
      tm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const st = new Float32Array(6).fill(5); tg.setAttribute('aStyle', new THREE.InstancedBufferAttribute(st, 1));
      train = { mesh: tm, x: crnd(-1000, 0), sp: crnd(16, 24) * (crnd() < 0.5 ? -1 : 1) };
      meshes.push(tm); group.add(tm);
    }
  }
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
  function updateTraffic(dt) {
    if (!carMesh) return;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.axis === 'z') { c.z += c.dz * c.sp * dt; if (c.z < c.lo) c.z = c.hi; if (c.z > c.hi) c.z = c.lo; }
      else { c.x += c.dx * c.sp * dt; if (c.x < c.lo) c.x = c.hi; if (c.x > c.hi) c.x = c.lo; }
      const yaw = c.axis === 'z' ? (c.dz > 0 ? 0 : Math.PI) : (c.dx > 0 ? Math.PI / 2 : -Math.PI / 2);
      _q.setFromAxisAngle(UP, yaw); _p.set(c.x, 0, c.z); _s.set(c.sc[0], c.sc[1], c.sc[2]);
      _m.compose(_p, _q, _s); carMesh.setMatrixAt(i, _m);
    }
    carMesh.instanceMatrix.needsUpdate = true;
    if (train) {
      train.x += train.sp * dt; if (train.x > 1100) train.x = -1200; if (train.x < -1200) train.x = 1100;
      for (let i = 0; i < 6; i++) { _q.identity(); _p.set(train.x + i * 18, rail.y, rail.z); _s.set(1, 1, 1); _m.compose(_p, _q, _s); train.mesh.setMatrixAt(i, _m); }
      train.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---- instancing -------------------------------------------------------------------
  const distE = (x, z) => (x - EYE.x) * (x - EYE.x) + (z - EYE.z) * (z - EYE.z);
  function sortNear(list, ix, iz, box) {
    // front-to-back from the player's rooftop: the opaque city then gets early depth rejection
    const n = list.length, k = new Float64Array(n), idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) { const b = list[i]; k[i] = box ? distE((b[0] + b[3]) / 2, (b[2] + b[5]) / 2) : distE(b[ix], b[iz]); idx[i] = i; }
    idx.sort((a, b) => k[a] - k[b]);
    const out = new Array(n); for (let i = 0; i < n; i++) out[i] = list[idx[i]];
    return out;
  }
  function finish(mesh, g, seeds, styles) {
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1)); g.setAttribute('aStyle', new THREE.InstancedBufferAttribute(styles, 1));
    mesh.frustumCulled = false; mesh.instanceMatrix.needsUpdate = true; meshes.push(mesh); group.add(mesh);
  }
  function instBoxes(list, mat, g0 = geo.box) {
    const n = list.length; if (!n) return;
    list = sortNear(list, 0, 0, true);
    const g = g0.clone(), mesh = new THREE.InstancedMesh(g, mat, n), A = mesh.instanceMatrix.array;
    const seeds = new Float32Array(n), styles = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const b = list[i], o = i * 16;
      A[o] = b[3] - b[0]; A[o + 1] = 0; A[o + 2] = 0; A[o + 3] = 0;
      A[o + 4] = 0; A[o + 5] = b[4] - b[1]; A[o + 6] = 0; A[o + 7] = 0;
      A[o + 8] = 0; A[o + 9] = 0; A[o + 10] = b[5] - b[2]; A[o + 11] = 0;
      A[o + 12] = (b[0] + b[3]) / 2; A[o + 13] = b[1]; A[o + 14] = (b[2] + b[5]) / 2; A[o + 15] = 1;
      seeds[i] = b[6]; styles[i] = b[7];
    }
    finish(mesh, g, seeds, styles);
  }
  function instT(list, mat, g0) {
    const n = list.length; if (!n) return;
    list = sortNear(list, 0, 2, false);
    const g = g0.clone(), mesh = new THREE.InstancedMesh(g, mat, n);
    const seeds = new Float32Array(n), styles = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = list[i];
      _e.set(c[6], c[7], c[8]); _q.setFromEuler(_e); _p.set(c[0], c[1], c[2]); _s.set(c[3], c[4], c[5]);
      _m.compose(_p, _q, _s); mesh.setMatrixAt(i, _m); seeds[i] = c[9]; styles[i] = c[10];
    }
    finish(mesh, g, seeds, styles);
  }
  function lampsAndLights() {
    for (let z = -24; z > -2500; z -= 34) {
      if (!offStreet(z, 2)) continue;
      if (river && z > river.z0 - 2 && z < river.z1 + 2) continue;
      for (const s of [-1, 1]) {
        const x = s * (GRID.mainHW + 0.9);
        addB(x - 0.13, 0, z - 0.13, x + 0.13, 7.6, z + 0.13, 8, crnd(), false);
        addB(Math.min(x, x - s * 2.2), 7.4, z - 0.1, Math.max(x, x - s * 2.2), 7.6, z + 0.1, 8, crnd(), false);
        LP.push([x - s * 2.2, 7.3, z, 0, 1, 0.9]);
      }
    }
    const n = LP.length; const gp = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3), ph = new Float32Array(n), kd = new Float32Array(n), sz = new Float32Array(n);
    LP.forEach((l, i) => { pos.set([l[0], l[1], l[2]], i * 3); ph[i] = l[3]; kd[i] = l[4]; sz[i] = l[5]; });
    gp.setAttribute('position', new THREE.BufferAttribute(pos, 3)); gp.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    gp.setAttribute('aKind', new THREE.BufferAttribute(kd, 1)); gp.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    lightPts = new THREE.Points(gp, LightPoints.mat); lightPts.frustumCulled = false; lightPts.renderOrder = 5;
    meshes.push(lightPts); group.add(lightPts);
  }

  // ---- sector profile ----------------------------------------------------------------
  const SECTORS = ['FINANCIAL DISTRICT', 'MIDTOWN', 'OLD TOWN', 'RIVERSIDE', 'DOCKLANDS', 'UPTOWN'];
  function rollProfile() {
    const kind = Math.floor(crnd(0, SECTORS.length));
    const p = {
      kind, name: SECTORS[kind],
      height: crnd(0.75, 1.2), glass: crnd(0.3, 0.7), deco: crnd(0.1, 0.5), crown: crnd(0.05, 0.2), spire: crnd(0.05, 0.2), heli: crnd(0.08, 0.25),
      brick: crnd(0.35, 0.7), tower: crnd(0.12, 0.35), dishes: crnd(0.05, 0.25), signs: crnd(0.08, 0.25), masts: crnd(0.08, 0.2), scaffold: crnd(0.02, 0.1),
      bridges: crnd(0.7, 1.4), parking: crnd(0.03, 0.09), cables: crnd(0.5, 1.4), gantry: crnd(0.08, 0.25), rail: crnd() < 0.6, cranes: crnd(0.015, 0.05),
      river: crnd() < 0.35, maxSpires: Math.floor(crnd(1, 5)), maxCrowns: Math.floor(crnd(2, 7)), parks: Math.floor(crnd(0, 2.2)), industrial: crnd() < 0.5, cool: Math.floor(crnd(0, 2.6)),
    };
    // the sector's character pushes a few dials hard
    if (kind === 0) { p.maxSpires += 2; p.height *= 1.25; p.glass = crnd(0.65, 0.9); p.heli += 0.15; p.spire += 0.1; p.bridges *= 1.4; p.industrial = false; }
    if (kind === 1) { p.cables *= 1.5; p.signs += 0.15; p.rail = true; }
    if (kind === 2) { p.maxCrowns += 6; p.deco = crnd(0.6, 0.9); p.glass *= 0.4; p.crown += 0.3; p.brick = crnd(0.7, 0.9); p.tower = crnd(0.45, 0.7); p.height *= 0.85; p.cables *= 1.6; }
    if (kind === 3) { p.river = true; p.parks = Math.max(1, p.parks); }
    if (kind === 4) { p.industrial = true; p.cool = Math.max(1, p.cool); p.cranes *= 1.8; p.height *= 0.8; p.river = crnd() < 0.6; }
    if (kind === 5) { p.parks = 2; p.dishes += 0.15; p.heli += 0.1; p.masts += 0.1; }
    return p;
  }

  function generate(seed) {
    // hash the seed first: consecutive stage seeds must not give correlated sectors
    let hs = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b); hs ^= hs >>> 13; hs = Math.imul(hs, 0xc2b2ae35); hs ^= hs >>> 16;
    reseedCity(hs >>> 0); info.seed = seed;
    const PT = [performance.now()]; info.timing = PT; info.bridges = info.cranes = info.towers = info.cables = info.spires = info.cool = info.crowns = 0;
    for (const m of meshes) { group.remove(m); m.geometry.dispose(); }
    meshes = []; boxes = []; grid = new Map(); roofs = []; emitters = []; LP = []; cars = []; carMesh = null; train = null; coverList = []; coverMesh = null;
    for (const g of glassList) { group.remove(g.m); g.m.geometry.dispose(); } for (const m of propList) { group.remove(m); m.geometry.dispose(); } glassList = []; propList = [];
    B = []; L = []; H = []; RG = []; TK = []; CN = []; PY = []; WD = []; HY = []; DS = []; TR = []; CB = []; STC = []; STT = [];
    prof = rollProfile(); info.sector = prof.name;
    // randomised skyline: one dominant downtown + two secondary clusters
    const c1 = [crnd(-220, 220), -crnd(1250, 1850), crnd(330, 460)];
    const c2 = [crnd(-500, 500), -crnd(600, 1000), crnd(160, 260), crnd(0.4, 0.75)];
    const c3 = [crnd(-600, 600), -crnd(2000, 2600), crnd(220, 360), crnd(0.35, 0.6)];
    // two or three hero towers around the downtown core, each with its own top
    heroes = [];
    const kinds = ['spire', 'crown', 'mast', 'stepped'].sort(() => crnd() - 0.5);
    const nH = crnd() < 0.5 ? 2 : 3;
    for (let i = 0; i < nH; i++) {
      const a = crnd(0, TAU), rr = i === 0 ? crnd(0, 60) : crnd(110, 230);
      const x = c1[0] + Math.cos(a) * rr, z = c1[1] + Math.sin(a) * rr * 0.7;
      const j = Math.floor(x / GRID.aveSp), k = Math.floor(-z / GRID.stSp);
      const hx = j * GRID.aveSp + GRID.aveSp / 2, hz = -k * GRID.stSp - GRID.stSp / 2;
      if (heroes.some((h) => h.x === hx && h.z === hz) || Math.abs(hx) < 40) continue;
      const kind = kinds[i];
      heroes.push({ x: hx, z: hz, h: (i === 0 ? crnd(300, 360) : crnd(230, 290)) * Math.min(1.15, prof.height), kind, style: kind === 'crown' ? 10 : kind === 'spire' ? 0 : crnd() < 0.5 ? 0 : 2, done: false });
    }
    const ind = [(crnd() < 0.5 ? -1 : 1) * crnd(420, 760), -crnd(500, 2300), crnd(220, 330)];
    indus = prof.industrial ? (x, z) => Math.exp(-((x - ind[0]) ** 2 + (z - ind[1]) ** 2) / (2 * ind[2] * ind[2])) : () => 0;
    density = (x, z) => {
      const g = (c, s) => Math.exp(-((x - c[0]) ** 2 + (z - c[1]) ** 2) / (2 * c[2] * c[2])) * s;
      return Math.max(0, Math.min(1, g(c1, 1) + g(c2, c2[3]) + g(c3, c3[3])) - indus(x, z));
    };
    // river: replaces one row of blocks
    river = null;
    if (prof.river) {
      const k = Math.floor(crnd(5, 19));
      river = { k, z1: -k * GRID.stSp - GRID.stHW - GRID.sw, z0: -(k + 1) * GRID.stSp + GRID.stHW + GRID.sw };
      mats.ground.uniforms.uRiver.value.set(river.z0, river.z1, 1, 0);
    } else mats.ground.uniforms.uRiver.value.set(0, 0, 0, 0);
    // parks: whole blocks beside the main avenue
    parks = [];
    for (let i = 0; i < prof.parks; i++) {
      let k = Math.floor(crnd(2, 16)); if (river && Math.abs(k - river.k) < 2) k += 3;
      const j = crnd() < 0.5 ? -1 : 0;
      const zHi = -k * GRID.stSp - GRID.stHW - GRID.sw, zLo = -(k + 1) * GRID.stSp + GRID.stHW + GRID.sw;
      const xLo = j === 0 ? GRID.mainHW + GRID.sw : -GRID.aveSp + GRID.aveHW + GRID.sw, xHi = j === 0 ? GRID.aveSp - GRID.aveHW - GRID.sw : -GRID.mainHW - GRID.sw;
      parks.push([xLo, zLo, xHi, zHi]);
    }
    const pu = [mats.ground.uniforms.uPark0.value, mats.ground.uniforms.uPark1.value];
    pu.forEach((v, i) => (parks[i] ? v.set(...parks[i]) : v.set(1, 1, 0, 0)));
    // cooling towers: skyline landmarks out in the industrial quarter; their lots are reserved up front
    reserved = [];
    for (let i = 0; i < (prof.industrial ? prof.cool : 0); i++) {
      const j = Math.floor((ind[0] + crnd(-150, 150)) / GRID.aveSp), k = Math.max(2, Math.floor(-(ind[1] + crnd(-190, 190)) / GRID.stSp));
      const cx = j * GRID.aveSp + GRID.aveSp / 2, cz = -k * GRID.stSp - GRID.stSp / 2;
      if (Math.abs(cx) < 200 || (river && k === river.k) || reserved.some((r) => Math.hypot(r[0] - cx, r[1] - cz) < 60)) continue;
      reserved.push([cx, cz, crnd(20, 28)]);
    }
    // player's building
    addB(-38, 0, 13.4, 38, PLAYER.roofY, 62, 2, 0.5);
    addB(-38, PLAYER.roofY, 13.4, 38, PLAYER.roofY + 1.05, 13.75, 3);
    for (let k = -1; k < GRID.nSt; k++) {
      if (river && k === river.k) continue;
      const zHi = k === -1 ? 96 : -k * GRID.stSp - GRID.stHW - GRID.sw;
      const zLo = k === -1 ? GRID.stHW + GRID.sw : -(k + 1) * GRID.stSp + GRID.stHW + GRID.sw;
      for (let j = -GRID.nAve; j < GRID.nAve; j++) {
        if (k === -1 && j === 0) continue;
        const hwL = j === 0 ? GRID.mainHW : GRID.aveHW, hwR = j + 1 === 0 ? GRID.mainHW : GRID.aveHW;
        let xLo = j * GRID.aveSp + hwL + GRID.sw, xHi = (j + 1) * GRID.aveSp - hwR - GRID.sw;
        if (k === -1 && j === -1) { xHi = GRID.aveSp - GRID.aveHW - GRID.sw; block(xLo, zLo, xHi, zHi, [-40, 10, 40, 64]); continue; }
        block(xLo, zLo, xHi, zHi);
      }
    }
    PT.push(performance.now());
    for (const r of reserved) coolingTower(r[0], r[1], r[2]);
    skybridges();
    cables();
    gantries();
    steamGrates();
    riverworks();
    rail = elevatedRail();
    streetTrees();
    PT.push(performance.now());
    instBoxes(B, mats.bld);
    instBoxes(L, mats.lat);
    instBoxes(RG, mats.ring, geo.ring);
    instBoxes(H, mats.hvac);
    instT(TK, mats.tank, geo.cyl);
    instT(CN, mats.cone, geo.cone);
    instT(PY, mats.pyr, geo.pyr);
    instT(WD, mats.saw, geo.wedge);
    instT(HY, mats.cool, geo.hyper);
    instT(DS, mats.dish, geo.dish);
    instT(TR, mats.tree, geo.tree);
    instT(STT, mats.stTrunk, geo.stTrunk);
    instT(STC, mats.stCan, geo.stCan);
    instT(CB, mats.bld, geo.cbox);
    PT.push(performance.now());
    lampsAndLights();
    traffic();
    updateTraffic(0);
    PT.push(performance.now());
    info.ms = Math.round(PT[PT.length - 1] - PT[0]);
    info.timing = PT.slice(1).map((t, i) => Math.round(t - PT[i])).join('/');
    return info;
  }

  // --- queries --------------------------------------------------------------
  const hit = { t: 0, nx: 0, ny: 0, nz: 0, id: -1, kind: 0 };
  function rayBox(ox, oy, oz, dx, dy, dz, b, tmax, res) {
    let t0 = 0, t1 = tmax, ax = -1, sg = 0;
    const o = [ox, oy, oz], d = [dx, dy, dz], lo = [b.x0, b.y0, b.z0], hi = [b.x1, b.y1, b.z1];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-12) { if (o[i] < lo[i] || o[i] > hi[i]) return false; continue; }
      const inv = 1 / d[i]; let ta = (lo[i] - o[i]) * inv, tb = (hi[i] - o[i]) * inv, s = -1;
      if (ta > tb) { const tt = ta; ta = tb; tb = tt; s = 1; }
      if (ta > t0) { t0 = ta; ax = i; sg = s; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    res.t = t0; res.ax = ax; res.sg = sg; return true;
  }
  const _rb = { t: 0, ax: 0, sg: 0 };
  function raycast(o, d, maxT, skipGlass = false) {
    stamp++;
    let best = maxT, found = false;
    hit.id = -1; hit.kind = 0;
    if (d.y < -1e-9) { const tg = -o.y / d.y; if (tg >= 0 && tg < best) { best = tg; found = true; hit.nx = 0; hit.ny = 1; hit.nz = 0; hit.id = -2; hit.kind = 0; } }
    let cx = Math.floor(o.x / CELL), cz = Math.floor(o.z / CELL);
    const sx = d.x > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
    const tdx = Math.abs(d.x) > 1e-12 ? Math.abs(CELL / d.x) : Infinity, tdz = Math.abs(d.z) > 1e-12 ? Math.abs(CELL / d.z) : Infinity;
    let tmx = Math.abs(d.x) > 1e-12 ? ((d.x > 0 ? cx + 1 : cx) * CELL - o.x) / d.x : Infinity;
    let tmz = Math.abs(d.z) > 1e-12 ? ((d.z > 0 ? cz + 1 : cz) * CELL - o.z) / d.z : Infinity;
    let t = 0, guard = 0;
    while (t <= best && guard++ < 2000) {
      const a = grid.get(key(cx, cz));
      if (a) for (let i = 0; i < a.length; i++) {
        const b = boxes[a[i]]; if (b.s === stamp) continue; b.s = stamp;
        if (b.dead || (skipGlass && b.kind === 5)) continue;
        if (rayBox(o.x, o.y, o.z, d.x, d.y, d.z, b, best, _rb) && _rb.t < best) {
          best = _rb.t; found = true; hit.id = a[i]; hit.kind = b.kind;
          hit.nx = hit.ny = hit.nz = 0;
          if (_rb.ax === 0) hit.nx = _rb.sg; else if (_rb.ax === 1) hit.ny = _rb.sg; else if (_rb.ax === 2) hit.nz = _rb.sg; else { hit.nx = -Math.sign(d.x); }
        }
      }
      if (tmx < tmz) { t = tmx; tmx += tdx; cx += sx; } else { t = tmz; tmz += tdz; cz += sz; }
    }
    hit.t = best;
    return found;
  }
  function forBoxesNear(x, z, r, fn) {
    stamp++;
    const cx0 = Math.floor((x - r) / CELL), cx1 = Math.floor((x + r) / CELL), cz0 = Math.floor((z - r) / CELL), cz1 = Math.floor((z + r) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const a = grid.get(key(cx, cz)); if (!a) continue;
      for (const id of a) { const b = boxes[id]; if (b.s === stamp) continue; b.s = stamp; if (b.dead) continue; fn(b); }
    }
  }
  return {
    group, generate, raycast, hit, forBoxesNear, updateTraffic, info, addCover, popCol, addGlass, breakGlass, addProp, addMask, breakGlassNear,
    addCol(x0, y0, z0, x1, y1, z1, kind = 1) { return addCol(x0, y0, z0, x1, y1, z1, kind); },
    get roofs() { return roofs; }, get emitters() { return emitters; }, get boxes() { return boxes; },
    get profile() { return prof; },
    get features() { return { river, parks, cool: reserved }; },
    get steamVents() { return steamVents; },
    setPointScale(s) { LightPoints.mat.uniforms.uScale.value = s; },
    sky,
  };
})();
