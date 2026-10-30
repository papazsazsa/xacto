// ---------------------------------------------------------------------------
// City: procedural low-poly city, regenerated from a seed every stage.
// Provides collision (AABB grid), raycasts, rooftops for target spawns,
// heat emitters, traffic.
// ---------------------------------------------------------------------------
const City = (() => {
  const CELL = 32;
  const group = new THREE.Group();
  const geo = {
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 10, 1).translate(0, 0.5, 0),
    cone: new THREE.ConeGeometry(1, 1, 10, 1).translate(0, 0.5, 0),
  };
  const mats = {
    bld: thermalMat(FS_BUILDING),
    hvac: thermalMat(FS_HVAC),
    tank: thermalMat(FS_SOLID, { uT: { value: 0.27 }, uStripe: { value: 1 } }),
    cone: thermalMat(FS_SOLID, { uT: { value: 0.22 }, uStripe: { value: 0 } }),
    car: thermalMat(FS_CAR),
    ground: thermalMat(FS_GROUND, { uGrid: { value: new THREE.Vector4(GRID.aveSp, GRID.mainHW, GRID.aveHW, GRID.stSp) }, uGrid2: { value: new THREE.Vector2(GRID.stHW, GRID.sw) } }),
    sky: thermalMat(FS_SKY, {}, { side: THREE.BackSide, depthWrite: false }),
  };
  // lattice style (6) for masts / crane trusses: injected into the building shader
  mats.bld.fragmentShader = mats.bld.fragmentShader.replace('if (st >= 3) {', `if (st == 6) {
    bool xF = abs(n.x) > 0.5; bool yF = abs(n.y) > 0.5;
    float fwid = yF ? vS.x : (xF ? vS.z : vS.x);
    float u = yF ? (vL.x + 0.5)*vS.x : ((xF ? vL.z : vL.x) + 0.5)*fwid;
    float v = yF ? (vL.z + 0.5)*vS.z : vL.y*vS.y;
    float cell = yF ? min(vS.x, vS.z) : min(fwid, vS.y);
    vec2 q = vec2(u, v)/cell; vec2 f = fract(q);
    float lw = 0.085;
    float edge = max(max(step(f.x, lw), step(1.0-lw, f.x)), max(step(f.y, lw), step(1.0-lw, f.y)));
    float br = max(step(abs(f.x - f.y), lw), step(abs(f.x + f.y - 1.0), lw));
    float px = max(fwidth(q.x), fwidth(q.y));
    if (max(edge, br) < 0.5 && px < 0.22) discard;
    t = 0.30 + 0.02*(seed - 0.5);
  } else if (st >= 3) {`);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2).translate(0, 0, -1500), mats.ground);
  ground.frustumCulled = false;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5200, 24, 12), mats.sky);
  sky.frustumCulled = false; sky.renderOrder = -10;
  group.add(sky, ground);

  let boxes = [], grid = new Map(), roofs = [], emitters = [], B = [], H = [], TK = [], CN = [], LP = [];
  let meshes = [], cars = [], carMesh = null, lightPts = null, stamp = 1;
  let density = () => 0;
  const info = { seed: 0, bridges: 0, cranes: 0, towers: 0 };

  const key = (cx, cz) => (cx + 2048) * 4096 + (cz + 2048);
  function addCol(x0, y0, z0, x1, y1, z1, kind = 0) {
    const b = { x0, y0, z0, x1, y1, z1, kind, s: 0 }; const id = boxes.length; boxes.push(b);
    const cx0 = Math.floor(x0 / CELL), cx1 = Math.floor(x1 / CELL), cz0 = Math.floor(z0 / CELL), cz1 = Math.floor(z1 / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) { const k = key(cx, cz); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(id); }
    return id;
  }
  // style: 0 glass office, 1 brick residential, 2 concrete, 3 plain, 4 warm panel, 5 skybridge, 6 lattice
  function addB(x0, y0, z0, x1, y1, z1, style, seed = crnd(), collide = true, kind = 1) {
    B.push([x0, y0, z0, x1, y1, z1, seed, style]);
    if (collide) addCol(x0, y0, z0, x1, y1, z1, kind);
  }

  function maxHeightAt(x, z) {
    const a = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))); let h = 0;
    if (a) for (const id of a) { const b = boxes[id]; if (b.kind === 1 && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) h = Math.max(h, b.y1); }
    return h;
  }

  function heightFor(x, z, w, d) {
    const f = density(x, z);
    let h = 12 + 24 * Math.pow(crnd(), 1.7);
    if (crnd() < 0.07) h += crnd(10, 30);
    const big = Math.min(1, Math.min(w, d) / 28);
    h += f * (35 + 240 * Math.pow(crnd(), 1.25)) * big;
    h = Math.min(h, lerp(30, 999, sstep(-40, -380, z)));
    return h;
  }

  function roofDetails(x0, z0, x1, z1, y, style, h, far) {
    const w = x1 - x0, d = z1 - z0;
    const ph = style === 0 ? 1.3 : 1.05, pt = 0.35;
    addB(x0, y, z0, x1, y + ph, z0 + pt, 3); addB(x0, y, z1 - pt, x1, y + ph, z1, 3);
    addB(x0, y, z0 + pt, x0 + pt, y + ph, z1 - pt, 3); addB(x1 - pt, y, z0 + pt, x1, y + ph, z1 - pt, 3);
    if (far || w < 7 || d < 7) return;
    const occ = [];
    const place = (sw, sd, m = 1.4) => {
      for (let i = 0; i < 14; i++) {
        const px = crnd(x0 + m, x1 - m - sw), pz = crnd(z0 + m, z1 - m - sd);
        if (px < x0 + m - 1e-3 || pz < z0 + m - 1e-3) continue;
        if (occ.some((o) => px < o[2] + 1 && px + sw > o[0] - 1 && pz < o[3] + 1 && pz + sd > o[1] - 1)) continue;
        const r = [px, pz, px + sw, pz + sd]; occ.push(r); return r;
      }
      return null;
    };
    // stair / elevator bulkhead
    if (w > 11 && d > 11) { const r = place(crnd(3, 5), crnd(3.5, 6)); if (r) addB(r[0], y, r[1], r[2], y + crnd(3, 4.6), r[3], 3); }
    // HVAC units
    const nH = Math.min(5, Math.floor((w * d) / 260 + crnd(0, 1.5)));
    for (let i = 0; i < nH; i++) {
      const r = place(crnd(1.8, 5.5), crnd(1.8, 3.5)); if (!r) continue;
      const hh = crnd(1.1, 2.4); H.push([r[0], y, r[1], r[2], y + hh, r[3], crnd()]); addCol(r[0], y, r[1], r[2], y + hh, r[3], 2);
    }
    // vent stacks with heat plumes
    const nV = Math.floor(crnd(0, 3));
    for (let i = 0; i < nV; i++) {
      const r = place(0.6, 0.6, 1.0); if (!r) continue;
      const vh = crnd(1.2, 3.5); addB(r[0], y, r[1], r[2], y + vh, r[3], 3);
      emitters.push({ x: r[0] + 0.3, y: y + vh, z: r[1] + 0.3, rate: crnd(1.5, 4), heat: crnd(0.035, 0.07), size: crnd(1.2, 2.6), acc: 0 });
    }
    // water tower
    if ((style === 1 || style === 2) && h < 75 && w > 12 && d > 12 && crnd() < 0.5) {
      const r = place(7, 7, 1.6);
      if (r) {
        const cx = r[0] + 3.5, cz = r[1] + 3.5, rad = crnd(2.3, 3.1), leg = crnd(3.5, 6), th = crnd(4.5, 6.5);
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) addB(cx + sx * rad * 0.7 - 0.15, y, cz + sz * rad * 0.7 - 0.15, cx + sx * rad * 0.7 + 0.15, y + leg, cz + sz * rad * 0.7 + 0.15, 3, crnd(), false);
        addB(cx - rad * 0.8, y + leg - 0.3, cz - rad * 0.8, cx + rad * 0.8, y + leg, cz + rad * 0.8, 3, crnd(), false);
        TK.push([cx, y + leg, cz, rad, th, crnd()]); CN.push([cx, y + leg + th, cz, rad * 1.06, th * 0.32, crnd()]);
        addCol(cx - rad, y, cz - rad, cx + rad, y + leg + th + th * 0.32, cz + rad, 3);
        info.towers++;
      }
    }
    // rooftop billboard facing the player
    if (h < 60 && w > 14 && crnd() < 0.14) {
      const bw = Math.min(w - 4, crnd(9, 16)), cx = (x0 + x1) / 2, cz = z0 + crnd(2, d - 3), bh = crnd(4, 6), lg = crnd(2.5, 4);
      for (let i = 0; i <= 3; i++) { const lx = cx - bw / 2 + (bw * i) / 3; addB(lx - 0.15, y, cz + 0.4, lx + 0.15, y + lg, cz + 0.7, 6, crnd(), false); }
      addB(cx - bw / 2, y + lg, cz - 0.2, cx + bw / 2, y + lg + bh, cz + 0.25, 4);
      occ.push([cx - bw / 2, cz - 1, cx + bw / 2, cz + 1.5]);
    }
    // antenna mast
    if ((h > 110 && crnd() < 0.75) || (h > 40 && crnd() < 0.12)) {
      const mh = h > 110 ? crnd(18, 48) : crnd(8, 18), mw = mh > 20 ? crnd(1.2, 1.8) : 0.6;
      const cx = crnd(x0 + 3, x1 - 3), cz = crnd(z0 + 3, z1 - 3);
      addB(cx - mw / 2, y, cz - mw / 2, cx + mw / 2, y + mh, cz + mw / 2, mw > 1 ? 6 : 3);
      if (mh > 20) addB(cx - 0.12, y + mh, cz - 0.12, cx + 0.12, y + mh + mh * 0.35, cz + 0.12, 3);
      LP.push([cx, y + mh + (mh > 20 ? mh * 0.35 : 0) + 0.3, cz, crnd(), 0, 1.4]);
      if (mh > 25) LP.push([cx, y + mh * 0.55, cz, crnd(), 0, 1.0]);
      occ.push([cx - mw, cz - mw, cx + mw, cz + mw]);
    }
    roofs.push({ x0, z0, x1, z1, y, h, occ });
  }

  function building(x0, z0, x1, z1, opts = {}) {
    const w = x1 - x0, d = z1 - z0; if (w < 6 || d < 6) return;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const h0 = opts.h || heightFor(cx, cz, w, d);
    const tall = h0 > 60;
    const style = opts.style != null ? opts.style : (tall ? (crnd() < 0.62 ? 0 : 2) : (crnd() < 0.6 ? 1 : crnd() < 0.7 ? 2 : 0));
    const flH = style === 0 ? 3.9 : style === 1 ? 3.1 : 4.2;
    const h = Math.max(9, 5 + Math.round((h0 - 5) / flH) * flH + 1.6);
    const seed = crnd();
    let tiers = 1; if (h > 75 && crnd() < 0.7) tiers++; if (h > 150 && crnd() < 0.7) tiers++;
    let y = 0, bx0 = x0, bx1 = x1, bz0 = z0, bz1 = z1;
    for (let i = 0; i < tiers; i++) {
      const last = i === tiers - 1;
      let top = last ? h : 5 + Math.round((y + (h - y) * crnd(0.5, 0.72) - 5) / flH) * flH + 1.6;
      if (top - y < 8) top = Math.min(h, y + 8);
      addB(bx0, y, bz0, bx1, top, bz1, style, seed);
      if (!last) {
        // cornice ledge between tiers
        addB(bx0 - 0.35, top - 0.5, bz0 - 0.35, bx1 + 0.35, top, bz1 + 0.35, 3, seed, false);
        roofDetails(bx0, bz0, bx1, bz1, top, style, top, true);
        const sx = (bx1 - bx0) * crnd(0.08, 0.2), sz = (bz1 - bz0) * crnd(0.08, 0.2), off = crnd() < 0.5;
        bx0 += off ? sx * 2 : sx; bx1 -= off ? 0 : sx; bz0 += sz; bz1 -= sz;
        if (bx1 - bx0 < 8 || bz1 - bz0 < 8) { tiers = i + 1; roofDetails(bx0, bz0, bx1, bz1, top, style, top, opts.far); break; }
      } else roofDetails(bx0, bz0, bx1, bz1, top, style, top, opts.far);
      y = top;
    }
  }

  function crane(cx, cz) {
    const H0 = crnd(55, 115), m = 1.1;
    addB(cx - m, 0, cz - m, cx + m, H0, cz + m, 6);
    addB(cx - 1.6, H0, cz - 1.6, cx + 1.6, H0 + 3.2, cz + 1.6, 4); // cab / slewing unit
    const L = crnd(38, 62), C = crnd(12, 18), dir = crnd() < 0.5 ? 0 : 1, sgn = crnd() < 0.5 ? -1 : 1;
    const jy0 = H0 + 3.2, jy1 = jy0 + 1.8;
    if (dir === 0) {
      const a = sgn > 0 ? cx : cx - L, b = sgn > 0 ? cx + L : cx;
      addB(a, jy0, cz - 0.8, b, jy1, cz + 0.8, 6);
      const ca = sgn > 0 ? cx - C : cx, cb = sgn > 0 ? cx : cx + C;
      addB(ca, jy0, cz - 0.8, cb, jy1, cz + 0.8, 6);
      const cw = sgn > 0 ? ca : cb - 4; addB(cw, jy0 - 2.5, cz - 1.4, cw + 4, jy0, cz + 1.4, 3);
      LP.push([sgn > 0 ? b : a, jy1 + 0.3, cz, crnd(), 0, 1.2]);
    } else {
      const a = sgn > 0 ? cz : cz - L, b = sgn > 0 ? cz + L : cz;
      addB(cx - 0.8, jy0, a, cx + 0.8, jy1, b, 6);
      const ca = sgn > 0 ? cz - C : cz, cb = sgn > 0 ? cz : cz + C;
      addB(cx - 0.8, jy0, ca, cx + 0.8, jy1, cb, 6);
      const cw = sgn > 0 ? ca : cb - 4; addB(cx - 1.4, jy0 - 2.5, cw, cx + 1.4, jy0, cw + 4, 3);
      LP.push([cx, jy1 + 0.3, sgn > 0 ? b : a, crnd(), 0, 1.2]);
    }
    addB(cx - 0.6, H0 + 3.2, cz - 0.6, cx + 0.6, H0 + 11, cz + 0.6, 6); // apex
    LP.push([cx, H0 + 11.3, cz, crnd(), 0, 1.2]);
    info.cranes++;
  }

  function splitLots(x0, z0, x1, z1, depth, out) {
    const w = x1 - x0, d = z1 - z0;
    const f = density((x0 + x1) / 2, (z0 + z1) / 2);
    const minS = 13 + 16 * f;
    if (depth > 4 || (w < minS * 2 && d < minS * 2) || (f > 0.45 && depth > 0 && crnd() < 0.3 * f)) { out.push([x0, z0, x1, z1]); return; }
    const gap = crnd() < 0.3 ? crnd(1.5, 5) : 0;
    if ((w > d && w >= minS * 2) || d < minS * 2) {
      const s = x0 + w * crnd(0.35, 0.65);
      splitLots(x0, z0, s - gap / 2, z1, depth + 1, out); splitLots(s + gap / 2, z0, x1, z1, depth + 1, out);
    } else {
      const s = z0 + d * crnd(0.35, 0.65);
      splitLots(x0, z0, x1, s - gap / 2, depth + 1, out); splitLots(x0, s + gap / 2, x1, z1, depth + 1, out);
    }
  }

  function block(x0, z0, x1, z1, exclude) {
    const lots = []; splitLots(x0, z0, x1, z1, 0, lots);
    const far = z1 < -2700 || Math.abs((x0 + x1) / 2) > 760;
    for (const L of lots) {
      if (exclude && L[0] < exclude[2] && L[2] > exclude[0] && L[1] < exclude[3] && L[3] > exclude[1]) continue;
      const r = crnd();
      if (!far && r < 0.035 && L[2] - L[0] > 20 && L[3] - L[1] > 20 && L[1] < -250) {
        // construction site: crane + low concrete stub
        crane((L[0] + L[2]) / 2 + crnd(-4, 4), (L[1] + L[3]) / 2 + crnd(-4, 4));
        const sx = L[0] + 2, sz = L[1] + 2; addB(sx, 0, sz, sx + (L[2] - L[0]) * 0.35, crnd(6, 16), sz + (L[3] - L[1]) * 0.35, 2);
        continue;
      }
      if (r < 0.06) continue; // plaza / parking lot
      building(L[0], L[1], L[2], L[3], { far });
    }
  }

  function skybridges() {
    // across the main avenue: these are the obstacles the bullet must thread
    const edge = GRID.mainHW + GRID.sw;
    let z = -crnd(150, 260);
    while (z > -2300) {
      const sdz = Math.abs(z + Math.round(-z / GRID.stSp) * GRID.stSp);
      if (sdz > GRID.stHW + 7) {
        const hl = maxHeightAt(-edge - 2, z), hr = maxHeightAt(edge + 2, z);
        const ymax = Math.min(hl, hr) - 4;
        if (ymax > 16) {
          const yb = crnd(9, Math.min(ymax, 72)), bh = crnd(3.6, 5), bd = crnd(4, 6.5);
          addB(-edge - 1, yb, z - bd / 2, edge + 1, yb + bh, z + bd / 2, 5);
          if (crnd() < 0.3 && ymax > yb + 18) { const y2 = yb + crnd(10, 20); addB(-edge - 1, y2, z - bd / 2, edge + 1, y2 + bh, z + bd / 2, 5); }
          info.bridges++;
        }
      }
      z -= crnd(110, 330);
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

  function elevatedRail() {
    if (crnd() < 0.35) return null;
    const k = Math.floor(crnd(3, 12)), zc = -k * GRID.stSp, y0 = crnd(8, 11);
    addB(-1100, y0, zc - 3.6, 1100, y0 + 1.6, zc + 3.6, 3);
    addB(-1100, y0 + 1.6, zc - 3.6, 1100, y0 + 2.4, zc - 3.2, 3, crnd(), false);
    addB(-1100, y0 + 1.6, zc + 3.2, 1100, y0 + 2.4, zc + 3.6, 3, crnd(), false);
    for (let x = -1080; x <= 1080; x += 36) {
      const ax = Math.abs(x - Math.round(x / GRID.aveSp) * GRID.aveSp);
      if (ax < GRID.aveHW + 1 || (Math.abs(x) < GRID.mainHW + 1)) continue;
      addB(x - 0.8, 0, zc - 1.2, x + 0.8, y0, zc + 1.2, 3);
    }
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
      const tm = new THREE.InstancedMesh(tg, thermalMat(FS_BUILDING), 6); tm.frustumCulled = false;
      tm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const st = new Float32Array(6).fill(5); tg.setAttribute('aStyle', new THREE.InstancedBufferAttribute(st, 1));
      train = { mesh: tm, x: crnd(-1000, 0), sp: crnd(16, 24) * (crnd() < 0.5 ? -1 : 1) };
      meshes.push(tm); group.add(tm);
    }
  }
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
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

  function instBoxes(list, mat, hasStyle) {
    const n = list.length; if (!n) return;
    const g = geo.box.clone(); const seeds = new Float32Array(n), styles = new Float32Array(n);
    const mesh = new THREE.InstancedMesh(g, mat, n); const m = new THREE.Matrix4();
    list.forEach((b, i) => { m.makeScale(b[3] - b[0], b[4] - b[1], b[5] - b[2]); m.setPosition((b[0] + b[3]) / 2, b[1], (b[2] + b[5]) / 2); mesh.setMatrixAt(i, m); seeds[i] = b[6]; styles[i] = hasStyle ? b[7] : 0; });
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1)); g.setAttribute('aStyle', new THREE.InstancedBufferAttribute(styles, 1));
    mesh.frustumCulled = false; meshes.push(mesh); group.add(mesh);
  }
  function instRound(list, mat, base) {
    const n = list.length; if (!n) return;
    const g = base.clone(); const seeds = new Float32Array(n); const mesh = new THREE.InstancedMesh(g, mat, n); const m = new THREE.Matrix4();
    list.forEach((c, i) => { m.makeScale(c[3], c[4], c[3]); m.setPosition(c[0], c[1], c[2]); mesh.setMatrixAt(i, m); seeds[i] = c[5]; });
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    mesh.frustumCulled = false; meshes.push(mesh); group.add(mesh);
  }
  function lampsAndLights() {
    for (let z = -24; z > -2500; z -= 34) {
      const sdz = Math.abs(z + Math.round(-z / GRID.stSp) * GRID.stSp); if (sdz < GRID.stHW + 2) continue;
      for (const s of [-1, 1]) {
        const x = s * (GRID.mainHW + 0.9);
        addB(x - 0.13, 0, z - 0.13, x + 0.13, 7.6, z + 0.13, 3, crnd(), false);
        addB(Math.min(x, x - s * 2.2), 7.4, z - 0.1, Math.max(x, x - s * 2.2), 7.6, z + 0.1, 3, crnd(), false);
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

  function generate(seed) {
    reseedCity(seed); info.seed = seed; info.bridges = info.cranes = info.towers = 0;
    for (const m of meshes) { group.remove(m); m.geometry.dispose(); }
    meshes = []; boxes = []; grid = new Map(); roofs = []; emitters = []; B = []; H = []; TK = []; CN = []; LP = []; cars = []; carMesh = null; train = null;
    // randomised skyline: one dominant downtown + two secondary clusters
    const c1 = [crnd(-220, 220), -crnd(1250, 1850), crnd(330, 460)];
    const c2 = [crnd(-500, 500), -crnd(600, 1000), crnd(160, 260), crnd(0.4, 0.75)];
    const c3 = [crnd(-600, 600), -crnd(2000, 2600), crnd(220, 360), crnd(0.35, 0.6)];
    density = (x, z) => {
      const g = (c, s) => Math.exp(-((x - c[0]) ** 2 + (z - c[1]) ** 2) / (2 * c[2] * c[2])) * s;
      return Math.min(1, g(c1, 1) + g(c2, c2[3]) + g(c3, c3[3]));
    };
    // player's building
    addB(-38, 0, 13.4, 38, PLAYER.roofY, 62, 2, 0.5);
    addB(-38, PLAYER.roofY, 13.4, 38, PLAYER.roofY + 1.05, 13.75, 3);
    for (let k = -1; k < GRID.nSt; k++) {
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
    skybridges();
    rail = elevatedRail();
    instBoxes(B, mats.bld, true);
    instBoxes(H.map((h) => [...h, 0]), mats.hvac, false);
    instRound(TK, mats.tank, geo.cyl);
    instRound(CN, mats.cone, geo.cone);
    lampsAndLights();
    traffic();
    updateTraffic(0);
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
  function raycast(o, d, maxT) {
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
      for (const id of a) { const b = boxes[id]; if (b.s === stamp) continue; b.s = stamp; fn(b); }
    }
  }
  return {
    group, generate, raycast, hit, forBoxesNear, updateTraffic, info,
    get roofs() { return roofs; }, get emitters() { return emitters; }, get boxes() { return boxes; },
    setPointScale(s) { LightPoints.mat.uniforms.uScale.value = s; },
    sky,
  };
})();
