// ---------------------------------------------------------------------------
// HUD: drawn on a 2D canvas, composited inside the CRT display shader.
// Red channel = bright phosphor ink (partial red = dim ink), green channel = dark ink /
// scrim. Glow is added in the display shader (no canvas shadowBlur). The canvas
// matches the display resolution; Press Start 2P is drawn only at whole multiples of
// its 8 px design size, on whole-pixel baselines, always with a dark outline.
// Static frames are skipped: the canvas is redrawn and uploaded only when a
// quantised signature of what it shows changes.
// ---------------------------------------------------------------------------
const Hud = (() => {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.premultiplyAlpha = true; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  let W = 2, H = 2, u = 1, portrait = false, touch = false, touched = false;
  // ink channels (the display pass turns them into colours): red = bright phosphor, green = dark, blue = the
  // red of the target brackets (the only red on screen)
  const BR = '#ff0000', DK = '#00ff00', RD = '#0000ff', DIM = 'rgba(255,0,0,0.62)', FAINT = 'rgba(255,0,0,0.3)';
  const scrim = (a) => `rgba(0,255,0,${a})`;
  const FA = '"Press Start 2P", monospace', FB = '"VT323", monospace';
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  function resize(w, h) {
    const k = (typeof Post !== 'undefined' && Post.dpr) || Math.min(window.devicePixelRatio || 1, 1.75);
    W = cv.width = Math.max(2, Math.round(w * k)); H = cv.height = Math.max(2, Math.round(h * k));
    portrait = W / H < 1.0;
    u = portrait ? Math.min(W / 600, H / 1100) : Math.min(H / 720, W / 1280);
    touch = coarse || portrait || MOBILE || touched;
    sig.length = 0; scrimGrad = null;
    tex.dispose();                                  // texture storage is allocated once: re-allocate at the new size
  }
  // first touch on any device: switch to the touch layout (buttons, hints)
  function setTouch() { if (!touched) { touched = true; touch = true; sig.length = 0; } }
  // touch buttons drawn this frame, in screen fractions (0..1, y down), read by the touch input; each one is
  // given a little more room to hit than it is drawn
  const buttons = [];
  function btn(code, x0, y0, x1, y1, pad = 10 * u) { buttons.push({ code, x0: (x0 - pad) / W, y0: (y0 - pad) / H, x1: (x1 + pad) / W, y1: (y1 + pad) / H }); }
  let scrimGrad = null, G_ref = { modeName: '' };
  // ---- primitives ------------------------------------------------------------
  // Typography system (one 1987 look):
  //   Press Start 2P only for big headline words (24 px design size and up), at whole multiples of 8 px.
  //   VT323 for every label and every number (clear 8, readable small), at whole even pixel sizes.
  //   A Press Start 2P request below 24 is drawn in VT323: 8 -> 20 px (about 12 px letters at 720p), 16 -> 28 px.
  const ffam = (sz, font) => (font === FA && sz < 24 ? FB : font);
  const fpx = (sz, font) => {
    if (font === FA && sz < 24) sz = sz <= 8 ? 20 : 28;
    else if (font === FA) return Math.max(16, Math.round(sz * u / 8) * 8);
    return Math.max(14, Math.round(sz * u / 2) * 2);
  };
  function setFont(px, fam, align) { ctx.font = `${px}px ${fam}`; ctx.textAlign = align; ctx.textBaseline = fam === FA ? 'alphabetic' : 'middle'; }
  // y is the visual middle of capitals; Press Start 2P capitals are 7 of 8 design pixels tall
  const baseY = (y, px, fam) => (fam === FA ? Math.round(y + px * 0.4375) : Math.round(y));
  function txt(str, x, y, size, align = 'left', font = FA, col = BR) {
    const px = fpx(size, font), fam = ffam(size, font);
    setFont(px, fam, align);
    const X = Math.round(x), Y = baseY(y, px, fam);
    ctx.strokeStyle = DK; ctx.lineJoin = 'miter'; ctx.miterLimit = 2; ctx.lineWidth = px <= 28 ? 2 : Math.max(3, Math.round(px * 0.1));
    ctx.strokeText(str, X, Y);
    ctx.fillStyle = col; ctx.fillText(str, X, Y);
    return ctx.measureText(str).width;
  }
  // inverted label: bright tab with dark lettering
  function tag(str, x, y, size = 8, align = 'left', col = BR) {
    const px = fpx(size, FA), fam = ffam(size, FA); setFont(px, fam, align);
    const w = ctx.measureText(str).width, padX = Math.round(5 * u), h = Math.round(px * (fam === FA ? 1 : 0.8)) + Math.round(4 * u);
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillStyle = col; ctx.fillRect(Math.round(x0 - padX), Math.round(y - h / 2), Math.round(w + 2 * padX), h);
    ctx.fillStyle = DK; ctx.fillText(str, Math.round(x), baseY(y, px, fam));
    return w + 2 * padX;
  }
  const tw = (str, size, font = FA) => { ctx.font = `${fpx(size, font)}px ${ffam(size, font)}`; return ctx.measureText(str).width; };
  // reveal a line token by token: a number always appears together with its unit
  const UNITS = /^(M|M\/S|S|X|%)$/;
  function tokens(str) {
    const parts = str.split(/(\s+)/), out = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]; if (!p) continue;
      if (/^\s+$/.test(p)) { out.push(p); continue; }
      const nxt = parts[i + 2];
      if (/[0-9]$/.test(p) && nxt && UNITS.test(nxt)) { out.push(p + parts[i + 1] + nxt); i += 2; } else out.push(p);
    }
    return out;
  }
  function typeTokens(str, x, y, size, reveal, align = 'center', font = FA, col = BR) {
    const tk = tokens(str), words = tk.filter((s) => !/^\s+$/.test(s)).length;
    let n = Math.floor(words * clamp(reveal, 0, 1) + 1e-6); if (n <= 0) return;
    let s = '';
    for (const t of tk) { if (/^\s+$/.test(t)) { s += t; continue; } if (n-- <= 0) break; s += t; }
    txt(s.trimEnd() + ' '.repeat(Math.max(0, str.length - s.trimEnd().length)), x, y, size, align, font, col);
  }
  function plate(x, y, w, h, a = 0.72) { ctx.fillStyle = scrim(a); ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  // text on its own dark plate
  function plated(str, x, y, size, align = 'left', font = FA, col = BR, a = 0.72) {
    const w = tw(str, size, font), px = fpx(size, font), p = Math.round(4 * u);
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    plate(x0 - p, y - px / 2 - p, w + 2 * p, px + 2 * p, a);
    txt(str, x, y, size, align, font, col);
    return w;
  }
  function line(x0, y0, x1, y1, w = 1.5, col = BR) { ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, w * u); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
  function rect(x, y, w, h, fill, col = BR, lw = 1.5) { ctx.fillStyle = col; ctx.strokeStyle = col; if (fill) ctx.fillRect(x, y, w, h); else { ctx.lineWidth = Math.max(1, lw * u); ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h)); } }
  // open corner brackets around a box (x0,y0)-(x1,y1)
  function corners(x0, y0, x1, y1, len, col = BR, lw = 2) {
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, lw * u); ctx.lineCap = 'square'; ctx.beginPath();
    ctx.moveTo(x0, y0 + len); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0);
    ctx.moveTo(x1 - len, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + len);
    ctx.moveTo(x1, y1 - len); ctx.lineTo(x1, y1); ctx.lineTo(x1 - len, y1);
    ctx.moveTo(x0 + len, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - len);
    ctx.stroke(); ctx.lineCap = 'butt';
  }
  // the target's brackets: red, on a dark edge so they stand out on any background
  function tgtCorners(x0, y0, x1, y1, len, lw) {
    corners(x0, y0, x1, y1, len, DK, lw + 2.2);
    corners(x0, y0, x1, y1, len, RD, lw);
  }
  // chamfered panel with an inverted title tab
  function panel(x, y, w, h, title, opts = {}) {
    const c = (opts.chamfer || 8) * u;
    if (opts.scrim) { ctx.fillStyle = scrim(opts.scrim); poly(x, y, w, h, c); ctx.fill(); }
    ctx.strokeStyle = opts.col || DIM; ctx.lineWidth = Math.max(1, (opts.lw || 1.25) * u); poly(x, y, w, h, c); ctx.stroke();
    if (title) tag(title, x + c + 5 * u, y, 8, 'left', opts.tab || BR);
  }
  function poly(x, y, w, h, c) {
    ctx.beginPath(); ctx.moveTo(x + c, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + c); ctx.lineTo(x + w, y + h - c);
    ctx.lineTo(x + w - c, y + h); ctx.lineTo(x + c, y + h); ctx.lineTo(x, y + h - c); ctx.lineTo(x, y + c); ctx.closePath();
  }
  const pad = (n, l) => String(Math.max(0, Math.floor(n))).padStart(l, '0');
  const blink = (rate = 2) => Math.floor(U.uTime.value * rate * 2) % 2 === 0;
  const blinkLong = () => (U.uTime.value % 1) < 0.8;       // mostly-on blink for prompts (on 80 % of the time)
  const scopeRadius = (G) => Math.min(G.scopeR, 0.47 * W / H) * H;
  const iris = () => (typeof Post !== 'undefined' && Post.display) ? Post.display.uniforms.uIris.value : 1;

  // The display shader barrel-distorts the scope image; map an undistorted screen point to where
  // it is actually seen, so markers sit on the target (fixed-point inverse of q = p (1 - k r^2 / R^2)).
  const warped = { x: 0, y: 0 };
  function warpScope(x, y, Rpx) {
    const k = 0.07, R = Rpx / H, qx = (x - W / 2) / H, qy = (y - H / 2) / H;
    let dx = qx, dy = qy;
    for (let i = 0; i < 4; i++) { const f = Math.max(0.5, 1 - k * (dx * dx + dy * dy) / (R * R)); dx = qx / f; dy = qy / f; }
    warped.x = W / 2 + dx * H; warped.y = H / 2 + dy * H; return warped;
  }
  // Screen box around the man (alive pose): chest is ~1.3 m up, hat top ~1.9 m, arms ~0.35 m out.
  const box = { x0: 0, y0: 0, x1: 0, y1: 0, cx: 0, cy: 0, h: 0 };
  function targetBox(G, scope, Rpx) {
    let tx = G.tgtScreen.x * W, ty = (1 - G.tgtScreen.y) * H;
    if (scope) { const p = warpScope(tx, ty, Rpx); tx = p.x; ty = p.y; }
    const h = Math.max(6 * u, G.tgtScreen.h * H), m = 5 * u;
    box.cx = tx; box.cy = ty; box.h = h;
    if (G.tgtScreen.bw) {   // a car: its whole box
      const hw = G.tgtScreen.bw * W / 2 + m, hh = G.tgtScreen.bh * H / 2 + m;
      box.x0 = tx - hw; box.x1 = tx + hw; box.y0 = ty - hh; box.y1 = ty + hh;
    } else { box.x0 = tx - h * 0.2 - m; box.x1 = tx + h * 0.2 + m; box.y0 = ty - h * 0.34 - m; box.y1 = ty + h * 0.74 + m; }
    if (box.x1 - box.x0 < 22 * u) { const c = (box.x0 + box.x1) / 2; box.x0 = c - 11 * u; box.x1 = c + 11 * u; }
    if (box.y1 - box.y0 < 30 * u) { const c = (box.y0 + box.y1) / 2; box.y0 = c - 15 * u; box.y1 = c + 15 * u; }
    return box;
  }
  // clip everything that follows to "outside the man's box" (never draw over his silhouette)
  function clipOutside(b) {
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(b.x0 + 2 * u, b.y0 + 2 * u, b.x1 - b.x0 - 4 * u, b.y1 - b.y0 - 4 * u); ctx.clip('evenodd');
  }

  // ---- shared blocks ----------------------------------------------------------
  // One top bar on every screen: 1UP score | STAGE. Same label row, same value row,
  // same faces everywhere; each slot sits on its own dark plate (which also covers the reticle's top post).
  function topBar(G) {
    const yl = 18 * u, yv = 42 * u, m = 36 * u, play = G.state !== 'attract';
    const slot = (label, value, x, align, labelCol) => {
      const w = Math.max(tw(label, 20, FB), tw(value, 34, FB)) + 16 * u;
      const x0 = align === 'left' ? x - 8 * u : align === 'right' ? x - w + 8 * u : x - w / 2;
      plate(x0, 4 * u, w, 58 * u, 0.7);
      txt(label, x, yl, 20, align, FB, labelCol);
      txt(value, x, yv, 34, align, FB, BR);
    };
    slot('1UP', pad(G.scoreShown, 7), m, 'left', !play || blink(1) ? BR : DIM);     // arcade pulse, never disappears
    if (G.state === 'flight') return;                                                // flight: score only, the seeker owns the top
    slot('STAGE', pad(G.stage, 2), pauseOn(G) ? W - m - 2 * PB * u - 18 * u : W - m, 'right', DIM);
  }
  // touch pause button, top right, on the playing screens
  const PB = 22;
  const pauseOn = (G) => touch && !G.demo && !G.paused && (G.state === 'brief' || G.state === 'aim' || G.state === 'shot' || G.state === 'flight' || G.state === 'mload' || G.state === 'mflight');
  function pauseButton(G) {
    const r = PB * u, x = W - 36 * u - r, y = 32 * u;
    ctx.fillStyle = scrim(0.55); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = BR; ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.fillStyle = BR; ctx.fillRect(x - 7 * u, y - 8 * u, 5 * u, 16 * u); ctx.fillRect(x + 2 * u, y - 8 * u, 5 * u, 16 * u);
    btn('KeyP', x - r, y - r, x + r, y + r, 16 * u);
  }
  function cartridge(x, y, s, filled) {
    // .50 round, nose up: case, shoulder, neck, ogive
    const w = 7 * s, hC = 22 * s;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y + hC); ctx.lineTo(x - w / 2, y + 4 * s); ctx.lineTo(x - w * 0.3, y); ctx.lineTo(x - w * 0.3, y - 3 * s);
    ctx.quadraticCurveTo(x - w * 0.3, y - 10 * s, x, y - 14 * s); ctx.quadraticCurveTo(x + w * 0.3, y - 10 * s, x + w * 0.3, y - 3 * s);
    ctx.lineTo(x + w * 0.3, y); ctx.lineTo(x + w / 2, y + 4 * s); ctx.lineTo(x + w / 2, y + hC); ctx.closePath();
    if (filled) { ctx.fillStyle = BR; ctx.fill(); ctx.fillStyle = DK; ctx.fillRect(x - w / 2, y + hC - 3 * s, w, 1.2 * s); ctx.fillRect(x - w * 0.3, y - 3 * s, w * 0.6, 1 * s); }
    else { ctx.strokeStyle = FAINT; ctx.lineWidth = Math.max(1, s); ctx.stroke(); }
  }
  function segBar(x, y, w, h, frac, n, warn) {
    const g = 2 * u, sw = (w - g * (n - 1)) / n, f = clamp(frac, 0, 1) * n;
    for (let i = 0; i < n; i++) {
      const a = clamp(f - i, 0, 1);
      ctx.fillStyle = FAINT; ctx.fillRect(Math.round(x + i * (sw + g)), Math.round(y), Math.max(1, Math.round(sw)), Math.round(h));
      if (a > 0 && (!warn || blink(3))) { ctx.fillStyle = BR; ctx.fillRect(Math.round(x + i * (sw + g)), Math.round(y), Math.max(1, Math.round(sw * a)), Math.round(h)); }
    }
  }
  function hint(strDesk, strTouch, y) { const s = touch ? strTouch : strDesk; if (s) txt(s, W / 2, y, 8, 'center', FA, DIM); }
  function demoBanner(G, yAt) {
    if (!G.demo) return;
    const y = typeof yAt === 'number' ? yAt : H - (portrait ? 110 : 96) * u;
    tag('DEMO PLAY', W / 2, y, 16, 'center', BR);
    if (blinkLong()) plated('PRESS SPACE OR CLICK TO PLAY', W / 2, y + 30 * u, 8, 'center');
  }

  // ---- scope -----------------------------------------------------------------
  // fire mission: a mortar sight's mil scales (etched dark lines, no posts). A long deflection scale across
  // the middle with ticks hanging below it and numbers under the long ones; an elevation scale up and down
  // the middle with ticks and numbers to its right; a short base bar at the foot.
  function mortarReticle(cx, cy, R) {
    const half = R * 0.74, step = half / 20, top = R * 0.72, foot = R * 0.66;
    const thin = Math.max(1, 1.2 * u);
    for (let pass = 0; pass < 2; pass++) {
      const halo = pass === 0, ex = halo ? 1.4 * u : 0, col = halo ? 'rgba(255,0,0,0.14)' : DK;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineCap = 'butt'; ctx.lineWidth = thin + 2 * ex; ctx.beginPath();
      // deflection scale
      ctx.moveTo(cx - half, cy); ctx.lineTo(cx + half, cy);
      for (let i = -20; i <= 20; i++) {
        if (!i) continue;
        const x = cx + i * step, l = (i % 5 === 0 ? 9 : 4.5) * u + ex;
        ctx.moveTo(x, cy - ex); ctx.lineTo(x, cy + l);
      }
      // elevation scale
      ctx.moveTo(cx, cy - top); ctx.lineTo(cx, cy + foot);
      for (let i = -20; i <= 18; i++) {
        if (!i) continue;
        const y = cy + i * step * 0.9, l = (i % 5 === 0 ? 9 : 4.5) * u + ex;
        if (y < cy - top || y > cy + foot) continue;
        ctx.moveTo(cx - ex, y); ctx.lineTo(cx + l, y);
      }
      ctx.stroke();
      // base bar at the foot of the elevation scale
      ctx.fillRect(Math.round(cx - 22 * u - ex), Math.round(cy + foot), Math.round(44 * u + 2 * ex), Math.round(4 * u + ex));
    }
    // the numbers, dark like the etching: every fifth tick, in tens of mils
    for (let i = 5; i <= 20; i += 5) {
      const n = String(i * 2);
      for (const sg of [-1, 1]) txt(n, cx + sg * i * step, cy + 22 * u, 8, 'center', FA, DK);
      const yU = cy - i * step * 0.9, yD = cy + i * step * 0.9;
      if (yU > cy - top + 6 * u) txt(n, cx + 14 * u, yU, 8, 'left', FA, DK);
      if (yD < cy + foot - 6 * u) txt(n, cx + 14 * u, yD, 8, 'left', FA, DK);
    }
  }
  function reticle(cx, cy, R) {
    const post = R * 0.6, step = post / 6, gap = step * 0.16;
    const thin = Math.max(1, 1.3 * u), thick = Math.max(3, 6.5 * u);
    for (let pass = 0; pass < 2; pass++) {
      const halo = pass === 0, ex = halo ? 1.6 * u : 0, col = halo ? 'rgba(255,0,0,0.14)' : DK;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineCap = 'butt';
      ctx.lineWidth = thin + 2 * ex; ctx.beginPath();
      ctx.moveTo(cx - post, cy); ctx.lineTo(cx - gap, cy); ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + post, cy);
      ctx.moveTo(cx, cy - post); ctx.lineTo(cx, cy - gap); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + post);
      // half-mil hash marks on the horizontal (wind holds) and lower vertical (holdover)
      for (let i = 0; i < 6; i++) {
        const o = (i + 0.5) * step, hl = 2.6 * u + ex;
        ctx.moveTo(cx + o, cy - hl); ctx.lineTo(cx + o, cy + hl); ctx.moveTo(cx - o, cy - hl); ctx.lineTo(cx - o, cy + hl);
        ctx.moveTo(cx - hl, cy + o); ctx.lineTo(cx + hl, cy + o);
      }
      ctx.stroke();
      // tapered posts (run past the rim; the caller clips to the objective)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const px = -dy, py = dx, hw = thick / 2 + ex;
        ctx.beginPath();
        ctx.moveTo(cx + dx * (post - ex), cy + dy * (post - ex));
        ctx.lineTo(cx + dx * (post + thick * 1.6) + px * hw, cy + dy * (post + thick * 1.6) + py * hw);
        ctx.lineTo(cx + dx * R * 1.1 + px * hw, cy + dy * R * 1.1 + py * hw);
        ctx.lineTo(cx + dx * R * 1.1 - px * hw, cy + dy * R * 1.1 - py * hw);
        ctx.lineTo(cx + dx * (post + thick * 1.6) - px * hw, cy + dy * (post + thick * 1.6) - py * hw);
        ctx.closePath(); ctx.fill();
      }
      // mil dots (slightly oval along the line, like etched glass)
      for (let i = 1; i <= 5; i++) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.beginPath(); ctx.ellipse(cx + dx * step * i, cy + dy * step * i, (dx ? 2.6 : 1.9) * u + ex, (dx ? 1.9 : 2.6) * u + ex, 0, 0, TAU); ctx.fill();
        }
      }
    }
    // illuminated centre: short bright cross + dot
    const a0 = gap * 1.6, a1 = step * 0.62;
    ctx.strokeStyle = BR; ctx.lineWidth = Math.max(1, 1.4 * u); ctx.beginPath();
    ctx.moveTo(cx - a1, cy); ctx.lineTo(cx - a0, cy); ctx.moveTo(cx + a0, cy); ctx.lineTo(cx + a1, cy);
    ctx.moveTo(cx, cy - a1); ctx.lineTo(cx, cy - a0); ctx.moveTo(cx, cy + a0); ctx.lineTo(cx, cy + a1);
    ctx.stroke();
    ctx.fillStyle = BR; ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.2, 1.5 * u), 0, TAU); ctx.fill();
  }
  function rimTicks(cx, cy, R, rot) {
    ctx.strokeStyle = FAINT; ctx.lineWidth = Math.max(1, 1.2 * u); ctx.beginPath();
    const r0 = R * 1.075, yTop = 62 * u, yBot = H - 36 * u;     // keep clear of the score row and the hint line
    for (let i = 0; i < 72; i++) {
      const a = i * TAU / 72 + rot, l = i % 6 === 0 ? 11 * u : 5 * u;
      const ca = Math.cos(a), sa = Math.sin(a), y0 = cy + sa * r0, y1 = cy + sa * (r0 + l);
      if (Math.min(y0, y1) < yTop || Math.max(y0, y1) > yBot) continue;
      ctx.moveTo(cx + ca * r0, y0); ctx.lineTo(cx + ca * (r0 + l), y1);
    }
    ctx.stroke();
  }
  function magTape(x, y, w, G) {
    const mags = [4, 6, 8, 12, 16, 24, 32], n = mags.length;
    let fi = 0;
    for (let i = 0; i < n - 1; i++) if (G.mag >= mags[i]) fi = i + clamp((G.mag - mags[i]) / (mags[i + 1] - mags[i]), 0, 1);
    line(x, y, x + w, y, 1, FAINT);
    for (let i = 0; i < n; i++) { const tx = x + w * i / (n - 1); line(tx, y - 4 * u, tx, y + 4 * u, 1, DIM); txt(String(mags[i]), tx, y + 15 * u, 8, 'center', FA, i === G.magI ? BR : DIM); }
    const mx = x + w * fi / (n - 1);
    ctx.fillStyle = BR; ctx.beginPath(); ctx.moveTo(mx, y - 5 * u); ctx.lineTo(mx - 5 * u, y - 13 * u); ctx.lineTo(mx + 5 * u, y - 13 * u); ctx.closePath(); ctx.fill();
  }
  function windArrow(x, y, G) {
    const wx = G.crossWind, dir = Math.sign(wx) || 1, n = clamp(Math.round(Math.abs(wx) / 3), 1, 4);
    for (let i = 0; i < n; i++) {
      const ox = x + dir * (i - (n - 1) / 2) * 11 * u;
      ctx.strokeStyle = BR; ctx.lineWidth = Math.max(1, 2.2 * u); ctx.beginPath();
      ctx.moveTo(ox - dir * 4 * u, y - 7 * u); ctx.lineTo(ox + dir * 3 * u, y); ctx.lineTo(ox - dir * 4 * u, y + 7 * u); ctx.stroke();
    }
  }

  // scope view: the rounds left, on one panel (the target's own figures ride on his brackets)
  function roundsPanel(G, x, y, w, h) {
    panel(x, y, w, h, 'ROUNDS', { scrim: 0.45 });
    for (let i = 0; i < G.maxRounds; i++) cartridge(x + 22 * u + i * 20 * u, y + h * 0.42, u, i < G.rounds);
    txt(`${G.rounds} OF ${G.maxRounds}`, x + w - 14 * u, y + h * 0.56, 8, 'right', FA, G.rounds <= 1 ? BR : DIM);
  }
  // the one target label, on his brackets in both views: distance (from the shooter in the scope, from the
  // round in flight) and his height above the ground, in metres
  const tgtLabel = (d) => `D ${Math.max(0, Math.round(d))}  AGL ${Math.max(0, Math.round(Target.S.root.y))}`;

  function scopeHud(G, hideMarkers = false) {
    const cx = W / 2, cy = H / 2, R = scopeRadius(G), ir = iris();
    const Rr = R * (0.08 + 0.92 * ir);
    if (ir > 0.3) rimTicks(cx, cy, Rr, (typeof Aim !== 'undefined' ? Aim.yaw : 0) * 3);
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, Rr, 0, TAU); ctx.clip();
    (G.mission ? mortarReticle : reticle)(cx + G.reticleOff.x * H, cy - G.reticleOff.y * H, Rr);   // fire mission: the mortar sight
    ctx.restore();
    if (!portrait) {
      const bw = clamp(cx - R * 1.12 - 40 * u, 150 * u, 250 * u), bh = 84 * u;
      roundsPanel(G, cx - R * 1.12 - 20 * u - bw, cy - bh / 2, bw, bh);
      if (!G.demo) {
        if (touch) { if (!G.mission) hint('', 'DRAG TO AIM   TAP FIRE TO SHOOT', H - 20 * u); }
        else { if (!G.mission) txt('SPACE FIRE', 36 * u, H - 22 * u, 8, 'left', FA, DIM); txt('T SENSOR   P PAUSE', W - 36 * u, H - 22 * u, 8, 'right', FA, DIM); }
      }
      fireButton(G);
    } else {
      const bh = 70 * u, top = cy - R * 1.12, bot = cy + R * 1.12, bw = Math.min(W - 28 * u, 320 * u);
      roundsPanel(G, W / 2 - bw / 2, top - bh - 16 * u, bw, bh);
      fireButton(G, W / 2, Math.min(H - 80 * u, bot + 90 * u), 44 * u);
      if (!G.demo && !G.mission) hint('', 'DRAG TO AIM   TAP FIRE TO SHOOT', H - 18 * u);
    }
    // target marker: open corners outside the man, tracking every frame, label on a dark plate
    // (hidden while the mission card is up, so nothing shows through it)
    if (!hideMarkers && G.tgtScreen.vis) {
      const b = targetBox(G, true, Rr);
      if (Math.hypot(b.cx - cx, b.cy - cy) < Rr * 0.95) {
        if (G.tgtHidden) ctx.setLineDash([3 * u, 3 * u]);   // dashed: out of sight behind something
        tgtCorners(b.x0, b.y0, b.x1, b.y1, Math.max(5 * u, (b.x1 - b.x0) * 0.25), 1.8); ctx.setLineDash([]);
        const label = tgtLabel(Target.S.dist), lw = tw(label, 8) + 8 * u, lh = fpx(8, FA) + 8 * u, g = 6 * u;
        // try the four bracket corners; skip any spot where the plate would sit on a reticle line
        const spots = [[b.x1 + g, b.y0 - lh], [b.x0 - g - lw, b.y0 - lh], [b.x1 + g, b.y1], [b.x0 - g - lw, b.y1]];
        let sx = spots[0][0], sy = spots[0][1];
        for (const [px, py] of spots) {
          const hitV = px - 3 * u < cx && px + lw + 3 * u > cx, hitH = py - 3 * u < cy && py + lh + 3 * u > cy;
          if (!hitV && !hitH) { sx = px; sy = py; break; }
        }
        plate(sx, sy, lw, lh, 0.8);
        txt(label, sx + 4 * u, sy + lh / 2, 8, 'left', FA, BR);
      }
    }
    if (!hideMarkers && G.mission) missionMarks(G, cx, cy, Rr);
    if (!hideMarkers && (G.tgtScreen.off || (G.tgtScreen.vis && Math.hypot(G.tgtScreen.x * W - cx, (1 - G.tgtScreen.y) * H - cy) > Rr))) {
      const a = G.tgtScreen.off ? G.tgtScreen.ang : Math.atan2(G.tgtScreen.y * H - H / 2, G.tgtScreen.x * W - W / 2);
      const px = cx + Math.cos(a) * (Rr - 30 * u), py = cy - Math.sin(a) * (Rr - 30 * u);
      ctx.save(); ctx.translate(px, py); ctx.rotate(-a);
      if (blink(2)) { ctx.fillStyle = BR; ctx.strokeStyle = DK; ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.moveTo(16 * u, 0); ctx.lineTo(-8 * u, -11 * u); ctx.lineTo(-3 * u, 0); ctx.lineTo(-8 * u, 11 * u); ctx.closePath(); ctx.stroke(); ctx.fill(); }
      ctx.restore();
    }
    demoBanner(G);
  }
  function fireButton(G, x = W * 0.9, y = H * 0.83, r = (portrait ? 34 : 48) * u) {
    if (!touch || G.demo) return;
    btn('Fire', x - r, y - r, x + r, y + r, 22 * u);
    ctx.fillStyle = scrim(0.55); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = BR; ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = DIM; ctx.beginPath(); ctx.arc(x, y, r * 0.78, 0, TAU); ctx.stroke();
    txt(G.mission && G.state === 'aim' ? 'LOCK' : 'FIRE', x, y, 8, 'center', FA, BR);
  }
  // fire mission: red brackets on each truck (numbered once locked) and the prompt under the scope
  function missionMarks(G, cx, cy, Rr) {
    const SC = Mortar.SC, L = Mortar.M.locks;
    SC.forEach((s, i) => {
      if (!s.vis || !Mortar.M.trucks[i] || !Mortar.M.trucks[i].alive) return;
      const x0 = s.x0 * W - 4 * u, x1 = s.x1 * W + 4 * u, y0 = s.y0 * H - 4 * u, y1 = s.y1 * H + 4 * u, n = L.indexOf(i);
      if (G.state !== 'mflight' && Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy) > Rr * 0.95) return;
      if (n < 0) ctx.setLineDash([3 * u, 3 * u]);
      tgtCorners(x0, y0, x1, y1, Math.max(5 * u, (x1 - x0) * 0.28), n >= 0 ? 2.8 : 1.6); ctx.setLineDash([]);
      if (n >= 0) plated(String(n + 1), x1 + 12 * u, y0 - 6 * u, 16, 'left', FA, BR, 0.8);
    });
    if (G.state === 'aim') plated(`LOCKED ${L.length} OF 3   ${touch ? 'TAP A TARGET' : 'CROSSHAIRS ON A TARGET, CLICK'}`, W / 2, H - 70 * u, 8, 'center', FA, BR, 0.8);
    // the mortar crew's calls: hang the round over the muzzle, then fire
    if (G.state === 'mload') {
      if (G.stateT < 1.0) plated('HANG IT!', W / 2, H - 70 * u, 24, 'center', FA, BR, 0.85);
      else if (blinkLong()) plated(touch ? 'TAP TO FIRE!' : 'CLICK TO FIRE!', W / 2, H - 70 * u, 24, 'center', FA, BR, 0.85);
    }
  }
  // fire mission in flight: the brackets on the trucks and a title
  function missionHud(G) {
    missionMarks(G, W / 2, H / 2, 1e9);
    plated('FIRE MISSION', W / 2, 84 * u, 16, 'center');
  }

  // ---- bullet camera: seeker head display ------------------------------------
  // The side gauges slide fully off screen while the man's bracket overlaps them; the small plates fade
  // to 30 %. Target markers are drawn last, above everything.
  let tgtB = null, slideL = 0, slideR = 0, slideT = -1;
  const hits = (x, y, w, h) => !!(tgtB && tgtB.x1 > x - 12 * u && tgtB.x0 < x + w + 12 * u && tgtB.y1 > y - 12 * u && tgtB.y0 < y + h + 12 * u);
  const fadeFor = (x, y, w, h) => (hits(x, y, w, h) ? 0.3 : 1);
  function flightHud(G) {
    const m = 24 * u, B = Bullet.S, t = U.uTime.value, flying = G.state === 'flight';
    const dt = slideT < 0 ? 1 : clamp(t - slideT, 0, 0.25); slideT = t;
    tgtB = G.tgtScreen.vis ? targetBox(G, false, 0) : null;
    let on = false;
    if (tgtB && G.pipScreen.vis) { const px = G.pipScreen.x * W, py = (1 - G.pipScreen.y) * H; on = px > tgtB.x0 && px < tgtB.x1 && py > tgtB.y0 && py < tgtB.y1; }
    corners(m, 70 * u, W - m, H - m, 40 * u, DIM, 1.5);
    // top-left (under the top bar): round + datalink
    ctx.globalAlpha = fadeFor(36 * u, 76 * u, 200 * u, 50 * u);
    plate(36 * u, 76 * u, 200 * u, 58 * u, 0.62);
    txt('GUIDED ROUND', 46 * u, 92 * u, 16, 'left');
    ctx.fillStyle = BR; if (blink(1.2)) ctx.fillRect(Math.round(46 * u), Math.round(114 * u), Math.round(8 * u), Math.round(8 * u));
    txt('DATALINK', 60 * u, 118 * u, 8, 'left', FA, DIM);
    ctx.globalAlpha = 1;
    // seeker dial: the faint ring with its ticks, the roll scale over the top and the roll pointer
    const cx = W / 2, cy = H / 2, sr = Math.min(H * 0.3, W * 0.3);
    const keepOut = () => ctx.save();
    ctx.strokeStyle = FAINT; ctx.lineWidth = Math.max(1, u); ctx.beginPath(); ctx.arc(cx, cy, sr, 0, TAU); ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 24; i++) { const a = i * TAU / 24, l = i % 6 === 0 ? 12 * u : 5 * u; ctx.moveTo(cx + Math.cos(a) * sr, cy + Math.sin(a) * sr); ctx.lineTo(cx + Math.cos(a) * (sr - l), cy + Math.sin(a) * (sr - l)); }
    ctx.stroke();
    const roll = typeof camK !== 'undefined' ? camK.roll : 0;
    ctx.strokeStyle = DIM; ctx.beginPath();
    for (let d = -30; d <= 30; d += 10) { const a = -Math.PI / 2 + d * DEG, l = d === 0 ? 10 * u : 6 * u; ctx.moveTo(cx + Math.cos(a) * (sr + 6 * u), cy + Math.sin(a) * (sr + 6 * u)); ctx.lineTo(cx + Math.cos(a) * (sr + 6 * u + l), cy + Math.sin(a) * (sr + 6 * u + l)); }
    ctx.stroke();
    { const a = -Math.PI / 2 - roll, rr = sr + 2 * u; ctx.fillStyle = BR; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); ctx.lineTo(cx + Math.cos(a - 0.03) * (rr - 10 * u), cy + Math.sin(a - 0.03) * (rr - 10 * u)); ctx.lineTo(cx + Math.cos(a + 0.03) * (rr - 10 * u), cy + Math.sin(a + 0.03) * (rr - 10 * u)); ctx.closePath(); ctx.fill(); }
    // ---- target symbology (drawn last, above all panels): everything stays outside the man's box ----
    const lock = G.lock || 0, homing = !!B.homing;
    const drawTargetMarks = () => {
    // predicted path for the next ~1.2 s: a thin line from the round that fades with distance, a small ring
    // where it will ricochet, and an X where the course runs into a structure
    const PS = G.pathScreen, RS = G.roundScreen;
    if (flying && PS && RS && RS.vis) {
      keepOut();
      const pts = [[RS.x * W, (1 - RS.y) * H]];
      const nB = G.pathBlock >= 0 && G.blockScreen.vis ? G.pathBlock : PS.length;
      for (let i = 0; i < Math.min(nB, PS.length); i++) { const p = PS[i]; if (!p.vis) break; pts.push([p.x * W, (1 - p.y) * H]); }
      const blocked = G.pathBlock >= 0 && G.blockScreen.vis;
      if (blocked) pts.push([G.blockScreen.x * W, (1 - G.blockScreen.y) * H]);
      if (pts.length > 1) {
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const nS = pts.length - 1;
        // the line fades out as it comes up to him, so nothing is drawn over his figure
        const rK = tgtB ? 0.5 * Math.hypot(tgtB.x1 - tgtB.x0, tgtB.y1 - tgtB.y0) + 4 * u : 0;
        const nearFade = (x, y) => tgtB ? clamp((Math.hypot(x - tgtB.cx, y - tgtB.cy) - rK) / (36 * u), 0, 1) : 1;
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? 'rgba(0,255,0,0.75)' : BR; ctx.lineWidth = Math.max(1, (pass === 0 ? 4 : 1.8) * u);
          for (let i = 1; i <= nS; i++) {
            // fades toward the far end (stays solid all the way when it ends in a warning X)
            ctx.globalAlpha = (blocked ? 1 : clamp(1 - 0.8 * ((i - 1) / Math.max(1, nS - 1)), 0.2, 1)) * nearFade(pts[i][0], pts[i][1]);
            ctx.beginPath(); ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
        // the ricochet point: a small ring on the line
        const bk = G.bounceK;
        if (bk >= 0 && bk < Math.min(nB, PS.length) && PS[bk] && PS[bk].vis) {
          const bx = PS[bk].x * W, by = (1 - PS[bk].y) * H, rr = 6 * u;
          ctx.strokeStyle = DK; ctx.lineWidth = 4.5 * u; ctx.beginPath(); ctx.arc(bx, by, rr, 0, TAU); ctx.stroke();
          ctx.strokeStyle = BR; ctx.lineWidth = 1.8 * u; ctx.stroke();
        }
        ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
        if (blocked) {
          const [bx, byy] = pts[pts.length - 1], k = 9 * u;
          ctx.strokeStyle = DK; ctx.lineWidth = 6 * u; ctx.beginPath(); ctx.moveTo(bx - k, byy - k); ctx.lineTo(bx + k, byy + k); ctx.moveTo(bx + k, byy - k); ctx.lineTo(bx - k, byy + k); ctx.stroke();
          ctx.strokeStyle = BR; ctx.lineWidth = 2.6 * u; ctx.stroke();
        }
      }
      ctx.restore();
    }
    if (tgtB) {
      const b = tgtB;
      clipOutside(b);
      // predicted impact pipper (hidden once it sits on the man: the brackets show that instead)
      if (G.pipScreen.vis && !on && STEER_MODE !== 'point') {
        const px = G.pipScreen.x * W, py = (1 - G.pipScreen.y) * H, d = 10 * u;
        ctx.strokeStyle = BR; ctx.lineWidth = Math.max(1, 2 * u); ctx.beginPath(); ctx.arc(px, py, d, 0, TAU); ctx.stroke();
        ctx.fillStyle = BR; ctx.beginPath(); ctx.arc(px, py, 2 * u, 0, TAU); ctx.fill();
        line(px - d * 1.9, py, px - d * 1.25, py, 2); line(px + d * 1.25, py, px + d * 1.9, py, 2); line(px, py - d * 1.9, px, py - d * 1.25, 2);
      }
      // brackets: acquiring = wide, blinking, closing in with lock progress; locked = solid double corners;
      // on target = inward chevrons; near-miss whoosh = a short outward pulse
      const grow = (1 - lock) * 0.6 + (G.whoosh || 0) * 0.35;
      const gx = (b.x1 - b.x0) * grow / 2 + 4 * u * grow, gy = (b.y1 - b.y0) * grow / 2 + 4 * u * grow;
      const x0 = b.x0 - gx, x1 = b.x1 + gx, y0 = b.y0 - gy, y1 = b.y1 + gy, len = Math.max(7 * u, (x1 - x0) * 0.28);
      // one set of brackets carries his status: solid in sight, dashed when hidden, heavier with the marker on him
      const mk = (STEER_MODE === 'point' && flying && G.aimLock) || (flying && G.tLock);
      if (G.tgtHidden) ctx.setLineDash([3 * u, 3 * u]);
      tgtCorners(x0, y0, x1, y1, len, mk ? 2.8 : 1.8);
      ctx.setLineDash([]);
      ctx.restore();
      // one label: range, to the right of the brackets (left when that would leave the screen), on a dark plate
      const rl = tgtLabel(G.tgtRange), gap = 10 * u;
      const rlw = tw(rl, 16);
      if (x1 + gap + rlw < W - 178 * u) plated(rl, x1 + gap, (y0 + y1) / 2 - 6 * u, 16, 'left', FA, BR, 0.75);
      else if (x0 - gap - rlw > 160 * u) plated(rl, x0 - gap, (y0 + y1) / 2 - 6 * u, 16, 'right', FA, BR, 0.75);
      else plated(rl, (x0 + x1) / 2, y0 - 22 * u, 16, 'center', FA, BR, 0.75);
    }
    // early stages: a big arrow at the screen edge on the open side of his cover, while it blocks the line
    if (flying && G.coverBlocked && G.stage <= 2 && G.coverSide && blinkLong()) {
      const side = G.coverSide, k = 20 * u;
      const ax = side === 'RIGHT' ? W - 205 * u : side === 'LEFT' ? 175 * u : W / 2, ay = side === 'TOP' ? Math.max(130 * u, cy - sr + 24 * u) : cy;
      ctx.fillStyle = BR; ctx.strokeStyle = DK; ctx.lineWidth = 3 * u; ctx.beginPath();
      if (side === 'TOP') { ctx.moveTo(ax, ay - k); ctx.lineTo(ax - k, ay + k * 0.5); ctx.lineTo(ax, ay + k * 0.1); ctx.lineTo(ax + k, ay + k * 0.5); }
      else { const sg = side === 'RIGHT' ? 1 : -1; ctx.moveTo(ax + sg * k, ay); ctx.lineTo(ax - sg * k * 0.5, ay - k); ctx.lineTo(ax - sg * k * 0.1, ay); ctx.lineTo(ax - sg * k * 0.5, ay + k); }
      ctx.closePath(); ctx.stroke(); ctx.fill();
    }
    // edge arrow with range, clamped inside the safe area, only when he is off screen
    // (on screen the bracket and its range tag are always drawn on top, so one range tag is enough)
    const sx0 = safe.x0, sx1 = safe.x1, sy0 = safe.y0, sy1 = safe.y1;
    const a = !tgtB && G.tgtScreen.off ? G.tgtScreen.ang : null;
    if (a !== null) {
      const dx = Math.cos(a), dy = -Math.sin(a);
      const kx = dx > 1e-4 ? (sx1 - cx) / dx : dx < -1e-4 ? (sx0 - cx) / dx : 1e9, ky = dy > 1e-4 ? (sy1 - cy) / dy : dy < -1e-4 ? (sy0 - cy) / dy : 1e9;
      const k = Math.min(kx, ky), px = cx + dx * k, py = cy + dy * k;
      ctx.save(); ctx.translate(px, py); ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = BR; ctx.strokeStyle = DK; ctx.lineWidth = 2 * u; ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(-22 * u, -13 * u); ctx.lineTo(-15 * u, 0); ctx.lineTo(-22 * u, 13 * u); ctx.closePath();
      ctx.stroke(); if (G.tgtScreen.off ? blink(2) : true) ctx.fill();
      ctx.restore();
      const lx = px - dx * 40 * u, ly = py - dy * 34 * u;
      plated(tgtLabel(G.tgtRange), lx, ly, 8, 'center', FA, BR, 0.8);
    }
    };
    // safe area for markers: inside the frame, between the side panels, clear of the top plates and bottom strip
    const safe = { x0: 160 * u, x1: W - 195 * u, y0: 140 * u, y1: H - 120 * u };
    // status line (one message, highest priority first), above the seeker dial's roll scale
    if (flying) {
      const sy = Math.max(84 * u, cy - sr - 40 * u);
      if ((G.stampT || 0) > 0) plated(G.stampText || 'GUIDANCE ACTIVE', W / 2, sy, 24, 'center', FA, (G.stampT * 6) % 2 < 1.2 ? BR : DIM);
      else if (homing) { if (blink(4)) plated('TERMINAL HOMING', W / 2, sy, 16, 'center'); }
      else if (G.pathBlock >= 0 && G.blockScreen.vis) { if (blink(3)) plated('COURSE BLOCKED', W / 2, sy, 16, 'center'); }
      if (B.depleted && blink(3)) plated('STEERING BUDGET EMPTY', W / 2, H - 232 * u, 8, 'center');
    }
    // steering budget gauge (left); slides off to the left while the bracket overlaps it. Desktop: on a backing
    // strip at mid height. Touch: no backing, up high, clear of where the thumbs rest
    const frac = B.budget / Math.max(1e-6, B.budget0), gx = 44 * u, gh = touch ? Math.min(H * 0.3, 130 * u) : Math.min(H * 0.36, 250 * u), gy = touch ? 190 * u : cy - gh / 2;
    const gw = tw('STEERING', 8) + 20 * u;
    slideL = damp(slideL, hits(gx - 10 * u, gy - 60 * u, gw, gh + 100 * u) ? 1 : 0, 10, dt);
    ctx.save(); ctx.translate(-Math.round(slideL * (gw + 60 * u)), 0);
    if (!touch) plate(gx - 10 * u, gy - 60 * u, gw, gh + 100 * u, 0.55);
    txt('STEERING', gx, gy - 42 * u, 8, 'left', FA, BR); txt('BUDGET', gx, gy - 19 * u, 8, 'left', FA, BR);
    const n = 16, sg = gh / n;
    for (let i = 0; i < n; i++) {
      const lit = (i + 0.5) / n < frac, yy = gy + gh - (i + 1) * sg;
      ctx.fillStyle = lit ? (frac < 0.25 && !blink(3) ? DIM : BR) : FAINT;
      ctx.fillRect(Math.round(gx), Math.round(yy + 1 * u), Math.round(18 * u), Math.max(1, Math.round(sg - 3 * u)));
    }
    // glancing ricochets left on this round (three to start)
    { const ry = gy + gh + 50 * u; if (!touch) plate(gx - 10 * u, ry, gw, 50 * u, 0.55);
      txt('RICOCHETS', gx, ry + 16 * u, 8, 'left', FA, B.ricochets > 0 ? BR : DIM); txt(B.ricochets > 0 ? `${B.ricochets} LEFT` : 'NONE LEFT', gx, ry + 36 * u, 8, 'left', FA, B.ricochets > 0 ? BR : DIM); }
    txt(`${Math.round(frac * 100)}%`, gx, gy + gh + 22 * u, 16, 'left');
    ctx.restore();
    // speed tape (right), value and unit inside one box; slides fully off to the right while the bracket
    // overlaps it. Desktop: on a narrow translucent strip at mid height. Touch: no strip, up high
    const v = B.v.length(), tx0 = W - 44 * u, th = gh, ty0 = touch ? gy + th / 2 : cy;
    slideR = damp(slideR, hits(tx0 - 106 * u, gy - 52 * u, 116 * u, gh + 92 * u) ? 1 : 0, 10, dt);
    ctx.save(); ctx.translate(Math.round(slideR * 180 * u), 0);
    if (!touch) plate(tx0 - 106 * u, gy - 52 * u, 116 * u, gh + 92 * u, 0.55);
    txt('SPEED', tx0, gy - 26 * u, 8, 'right', FA, DIM);
    ctx.save(); ctx.beginPath(); ctx.rect(tx0 - 100 * u, gy, 100 * u, th); ctx.clip();
    const pxPer = th / 200;
    ctx.strokeStyle = DIM; ctx.lineWidth = Math.max(1, u); ctx.beginPath();
    for (let s = Math.max(0, Math.floor((v - 110) / 10) * 10); s <= v + 110; s += 10) {
      const yy = ty0 - (s - v) * pxPer, l = s % 50 === 0 ? 14 * u : 7 * u;
      ctx.moveTo(tx0, yy); ctx.lineTo(tx0 - l, yy);
    }
    ctx.stroke();
    for (let s = Math.max(0, Math.ceil((v - 110) / 50) * 50); s <= v + 110; s += 50) { if (Math.abs(s - v) > 16) txt(String(s), tx0 - 20 * u, ty0 - (s - v) * pxPer, 8, 'right', FA, BR); }
    ctx.restore();
    const bw = 96 * u, bh2 = 30 * u, bx = tx0 - bw;
    ctx.fillStyle = scrim(0.9); ctx.fillRect(Math.round(bx), Math.round(ty0 - bh2 / 2), Math.round(bw), Math.round(bh2));
    rect(bx, ty0 - bh2 / 2, bw, bh2, false, BR, 1.5);
    const vw = txt(String(Math.round(v)), bx + 7 * u, ty0, 28, 'left', FB, BR);
    txt('M/S', bx + 12 * u + vw, ty0 + 3 * u, 8, 'left', FA, DIM);
    ctx.restore();
    // bottom strip: time to impact and the slow-motion factor (range lives on the bracket tag only)
    const by = H - 64 * u;
    ctx.globalAlpha = fadeFor(W / 2 - 180 * u, by - 34 * u, 360 * u, 80 * u);
    plate(W / 2 - 180 * u, by - 34 * u, 360 * u, 80 * u, 0.6);
    txt('TIME TO IMPACT', W / 2 - 95 * u, by - 18 * u, 8, 'center', FA, DIM);
    txt(`${G.tti.toFixed(2)} S`, W / 2 - 95 * u, by + 10 * u, 32, 'center', FB);
    txt('SLOW MOTION', W / 2 + 95 * u, by - 18 * u, 8, 'center', FA, DIM);
    txt(`${G.timeScale.toFixed(2)}X`, W / 2 + 95 * u, by + 10 * u, 32, 'center', FB);
    ctx.globalAlpha = 1;
    drawTargetMarks();
    // pointing steer: off him the marker is a diamond waypoint the round flies to (never drawn over him);
    // locked on him it is shown by his brackets (heavier)
    if (STEER_MODE === 'point' && flying && G.aimScreen.vis) {
      if (!G.aimLock) {
        const ax = G.aimScreen.x * W, ay = (1 - G.aimScreen.y) * H, rr = 15 * u;
        keepOut();
        const dia = () => { ctx.beginPath(); ctx.moveTo(ax, ay - rr); ctx.lineTo(ax + rr, ay); ctx.lineTo(ax, ay + rr); ctx.lineTo(ax - rr, ay); ctx.closePath(); };
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? DK : BR; ctx.lineWidth = Math.max(1, (pass === 0 ? 6 : 2.4) * u);
          dia(); ctx.stroke();
          ctx.beginPath(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(ax + dx * (rr + 3 * u), ay + dy * (rr + 3 * u)); ctx.lineTo(ax + dx * (rr + 11 * u), ay + dy * (rr + 11 * u)); } ctx.stroke();
        }
        ctx.fillStyle = BR; ctx.fillRect(Math.round(ax - 2 * u), Math.round(ay - 2 * u), Math.max(2, Math.round(4 * u)), Math.max(2, Math.round(4 * u)));
        ctx.restore();
      }
    }
    demoBanner(G, H - 150 * u);
  }
  // ---- attract / title -------------------------------------------------------
  // vector glyphs on a 4 x 6 grid (y down), Battlezone-style single strokes
  const GLYPH = {
    X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
    A: [[[0, 6], [0, 1.6], [1.6, 0], [2.4, 0], [4, 1.6], [4, 6]], [[0, 3.7], [4, 3.7]]],
    C: [[[4, 1.2], [2.8, 0], [1.2, 0], [0, 1.2], [0, 4.8], [1.2, 6], [2.8, 6], [4, 4.8]]],
    T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
    O: [[[1.2, 0], [2.8, 0], [4, 1.2], [4, 4.8], [2.8, 6], [1.2, 6], [0, 4.8], [0, 1.2], [1.2, 0]]],
  };
  function logo(cx, cy, width, t, reveal) {
    const word = 'XACTO', adv = 5.7, tot = 4 + adv * 4, k = width / tot, h = 6 * k;
    const ox = cx - width / 2, oy = cy - h / 2;
    const shown = Math.floor(reveal * word.length + 1e-6), part = reveal * word.length - shown;
    // passes: soft letter-shaped shadow (wide, then tight), phosphor halo, one solid beam
    const passes = [[scrim(0.35), 2.6], [scrim(0.7), 1.5], ['rgba(255,0,0,0.22)', 1.0], [BR, 0.52]];
    const hum = 0.5 + 0.5 * Math.sin(t * 2.3);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (let p = 0; p < passes.length; p++) {
      ctx.strokeStyle = p === 2 ? `rgba(255,0,0,${(0.18 + 0.08 * hum).toFixed(3)})` : passes[p][0];
      ctx.lineWidth = Math.max(3, passes[p][1] * k);
      ctx.beginPath();
      for (let gi = 0; gi < word.length; gi++) {
        if (gi > shown || (gi === shown && part < 0.5)) continue;
        if (gi === shown && Math.floor(t * 30) % 2) continue;          // the letter being drawn flickers on
        for (const pl of GLYPH[word[gi]]) {
          // closed outlines (O) are closed with closePath so the join has no overlapping end caps
          const n = pl.length, closed = n > 2 && pl[0][0] === pl[n - 1][0] && pl[0][1] === pl[n - 1][1];
          for (let i = 0; i < (closed ? n - 1 : n); i++) {
            const x = ox + (gi * adv + pl[i][0]) * k, y = oy + pl[i][1] * k;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          if (closed) ctx.closePath();
        }
      }
      ctx.stroke();
    }
    // the beam dwells at each vertex: brighter points with a small halo
    for (let gi = 0; gi < word.length; gi++) {
      if (gi > shown || (gi === shown && part < 0.5)) continue;
      for (const pl of GLYPH[word[gi]]) for (const v of pl) {
        const x = ox + (gi * adv + v[0]) * k, y = oy + v[1] * k;
        ctx.fillStyle = 'rgba(255,0,0,0.16)'; ctx.beginPath(); ctx.arc(x, y, 0.5 * k, 0, TAU); ctx.fill();
      }
    }
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    return h;
  }
  function attract(G) {
    const t = U.uTime.value, st = G.stateT;
    // legibility scrim over the city flythrough
    if (!scrimGrad) {
      scrimGrad = ctx.createLinearGradient(0, 0, 0, H);
      scrimGrad.addColorStop(0, scrim(0.55)); scrimGrad.addColorStop(0.45, scrim(0.35)); scrimGrad.addColorStop(1, scrim(0.6));
    }
    ctx.fillStyle = scrimGrad; ctx.fillRect(0, 0, W, H);
    const lw =Math.min(W * (portrait ? 0.86 : 0.6), 780 * u), ly = H * (portrait ? 0.24 : 0.27);
    const lh = logo(W / 2, ly, lw, t, clamp(st / 1.2, 0, 1));
    const sy = ly + lh / 2 + 36 * u;
    if (st > 1.2) {
      const s = 'DARPA GAMES', w2 = tw(s, 16) / 2 + 20 * u;
      txt(s, W / 2, sy, 16, 'center');
      line(W / 2 - w2 - 60 * u, sy, W / 2 - w2, sy, 1.2, DIM); line(W / 2 + w2, sy, W / 2 + w2 + 60 * u, sy, 1.2, DIM);
    }
    // attract pages
    const pw = Math.min(W - 40 * u, portrait ? W - 28 * u : 620 * u), ph = 228 * u, px = W / 2 - pw / 2, py = H * (portrait ? 0.42 : 0.5) - 10 * u;
    const page = 1 + (Math.floor(t / 6) % 2);
    if (st > 1.6) {
      const title = ['', 'HOW TO PLAY', 'SCORING'][page];
      panel(px, py, pw, ph, title, { scrim: 0.82, col: DIM, tab: BR });
      const rowY = (i) => py + 40 * u + i * 36 * u;
      const small = portrait ? 8 : 16;
      if (page === 1) {
        const rows = touch
          ? [['DRAG', 'AIM THE SCOPE'], ['FIRE BUTTON', 'SHOOT'], ['DRAG IN FLIGHT', 'MOVE THE MARKER'], ['TAP HIM IN FLIGHT', 'LOCK THE ROUND ON'], ['II BUTTON', 'PAUSE AND SETTINGS']]
          : [['MOUSE OR ARROWS', 'AIM'], ['SPACE OR CLICK', 'FIRE THE ROUND'], ['MOUSE OR ARROWS', STEER_MODE === 'point' ? 'MOVE THE MARKER IN FLIGHT' : 'STEER IN FLIGHT'], ['T  P', 'SENSOR  PAUSE']];
        rows.forEach((r, i) => { txt(r[0], px + pw * 0.06, rowY(i), 8, 'left', FA, DIM); txt(r[1], px + pw * 0.94, rowY(i), small, 'right'); });
      } else {
        const rows = [['RANGE', '2 PER M'], ['CENTER MASS', '500'], ['STEERING LEFT', 'UP TO 800'], ['RICOCHET KILL', '1000 EACH'], ['STAGE BONUS', '250 X STAGE']];
        rows.forEach((r, i) => { txt(r[0], px + pw * 0.06, rowY(i), small, 'left', FA, 'rgba(255,0,0,0.85)'); txt(r[1], px + pw * 0.94, rowY(i), small, 'right'); });
      }
    }
    // large start prompt under the table, on 80 % of every second
    if (st > 0.6 && (t % 1) < 0.8) plated(touch ? 'TAP TO START' : 'PRESS SPACE OR CLICK', W / 2, py + ph + 42 * u, portrait ? 16 : 24, 'center', FA, BR, 0.88);
    if (portrait && touch && blinkLong()) txt('TURN SIDEWAYS FOR A WIDER VIEW', W / 2, H - 92 * u, 8, 'center', FA, DIM);
    shadowTxt('© 1987 VALENTINE ARCADE', W / 2, H - 52 * u, 26);
    shadowTxt('ONE PLAYER   FREE PLAY', W / 2, H - 24 * u, 26);
  }
  // full-brightness phosphor text (VT323) with a hard black drop shadow
  function shadowTxt(str, x, y, size) {
    const px = fpx(size, FB), o = Math.max(2, Math.round(2 * u));
    setFont(px, FB, 'center'); ctx.fillStyle = DK; ctx.fillText(str, Math.round(x) + o, baseY(y, px, FB) + o);
    txt(str, x, y, size, 'center', FB, BR);
  }

  // ---- stage brief, results, tally, game over, pause ---------------------------
  function typeT(str, x, y, size, reveal, align = 'center', font = FA, col = BR) {
    const n = Math.ceil(str.length * clamp(reveal, 0, 1)); if (n <= 0) return;
    // keep the reveal anchored: pad the hidden tail with spaces in a monospace face
    txt(str.slice(0, n) + ' '.repeat(str.length - n), x, y, size, align, font, col);
  }
  function banner(y, h, alpha = 0.6) {
    ctx.fillStyle = scrim(alpha); ctx.fillRect(0, Math.round(y - h / 2), W, Math.round(h));
    line(0, y - h / 2, W, y - h / 2, 1, DIM); line(0, y + h / 2, W, y + h / 2, 1, DIM);
  }
  function brief(G) {
    // mission card in the lower third of the objective (the target is near the centre); fades after ~2 s.
    // World markers stay hidden while the card is up.
    const fade = 1 - sstep(2.0, 2.7, G.stateT);
    scopeHud(G, fade > 0);
    if (fade <= 0) return;
    const r = G.stateT * 1.8, R = scopeRadius(G), y = H / 2 + R * (G.stage <= 2 ? 0.5 : 0.56);
    if (G.mission) {   // fire mission card
      const pw = Math.min(W - 28 * u, 600 * u), ph = 206 * u;
      ctx.globalAlpha = fade;
      if (r > 0.05) {
        panel(W / 2 - pw / 2, y - ph / 2, pw, ph, 'FIRE MISSION', { scrim: 0.95, col: BR, tab: BR });
        typeT('FIRE MISSION', W / 2, y - 58 * u, 32, r);
        typeTokens(`THREE TARGETS ${Math.round(Mortar.dist())} M`, W / 2, y - 14 * u, 28, (r - 0.4) * 2, 'center', FB, 'rgba(255,0,0,0.9)');
        typeTokens(touch ? 'TAP EACH TARGET TO LOCK IT' : 'CROSSHAIRS ON EACH TARGET AND CLICK TO LOCK', W / 2, y + 22 * u, 28, (r - 0.8) * 2, 'center', FB, BR);
        typeTokens(touch ? 'THEN TAP TO FIRE THE MORTAR' : 'THEN CLICK TO FIRE THE MORTAR', W / 2, y + 50 * u, 28, (r - 1.1) * 2, 'center', FB, BR);
      }
      ctx.globalAlpha = 1;
      return;
    }
    const teach = G.stage <= 2, pw = Math.min(W - 28 * u, 600 * u), ph = (teach ? 246 : 176) * u;
    ctx.globalAlpha = fade;
    if (r > 0.05) {
      // 0.95 scrim = about 87 % black in the display
      panel(W / 2 - pw / 2, y - ph / 2, pw, ph, 'MISSION', { scrim: 0.95, col: BR, tab: BR });
      const o = teach ? -20 * u : 0;
      typeT(`STAGE ${pad(G.stage, 2)}`, W / 2, y - 48 * u + o, 32, r);
      if (G.sector) typeTokens(String(G.sector).toUpperCase(), W / 2, y - 6 * u + o, 34, (r - 0.3) * 3, 'center', FB);
      typeTokens(`TARGET ${Math.round(Target.S.dist)} M   WIND ${Math.abs(G.crossWind).toFixed(1)} M/S`, W / 2, y + 30 * u + o, 28, (r - 0.5) * 2, 'center', FB, 'rgba(255,0,0,0.9)');
      typeTokens(`STEERING BUDGET ${G.diff.budget.toFixed(0)} M/S`, W / 2, y + 60 * u + o, 28, (r - 0.8) * 2, 'center', FB, 'rgba(255,0,0,0.9)');
      if (teach) {
        // hidden spots teach the dashed brackets and the marker; open shots just say aim and fire
        const hid = !!(Target.S.spot && Target.S.spot.kind !== 'highway');
        typeTokens(hid ? 'DASHED BRACKETS: HE IS OUT OF SIGHT' : 'SOLID BRACKETS: A CLEAR SHOT', W / 2, y + 82 * u, 28, (r - 1.1) * 2, 'center', FB, BR);
        typeTokens(!hid ? (touch ? 'PUT THE CROSSHAIRS ON THE TARGET AND TAP FIRE' : 'PUT THE CROSSHAIRS ON THE TARGET AND FIRE') : touch ? 'DRAG THE MARKER, OR TAP HIM TO LOCK ON' : STEER_MODE === 'point' ? 'MOVE THE MARKER TO FLY THE ROUND TO HIM' : 'STEER THE ROUND AROUND THE BUILDINGS', W / 2, y + 108 * u, 28, (r - 1.4) * 2, 'center', FB, BR);
      }
    }
    ctx.globalAlpha = 1;
  }
  // Result banner: one large full-width band. Its side (top or bottom) is chosen once per camera shot from
  // the man's projected joint box. Every frame it slides toward the screen edge to keep 32 px clear of him;
  // if even the edge position would touch him it fades out, and it may change sides only while invisible.
  let banSide = 1, banKey = '', banA = 1, banY = -1, banT = -1;
  function banPlace(G, side, hgt) {
    const def = side > 0 ? H * 0.81 : H * 0.19, edge = side > 0 ? H - hgt / 2 - 6 * u : hgt / 2 + 6 * u, bb = G.bodyBox, need = 32 * u;
    if (!bb.vis) return { y: def, ok: true, clear: 1e9 };
    const by0 = bb.y0 * H, by1 = bb.y1 * H;
    let y = def;
    if (side > 0) y = clamp(Math.max(def, by1 + need + hgt / 2), def, edge);
    else y = clamp(Math.min(def, by0 - need - hgt / 2), edge, def);
    // a body that ends above (bottom band) or starts below (top band) the band is always clear
    const clear = side > 0 ? (y - hgt / 2) - by1 : by0 - (y + hgt / 2);
    const away = side > 0 ? by0 > y + hgt / 2 : by1 < y - hgt / 2;
    return { y, ok: clear >= 12 * u || away, clear: away ? 1e9 : clear };
  }
  function bannerPos(G, hgt) {
    const t = U.uTime.value, dt = banT < 0 ? 0 : clamp(t - banT, 0, 0.1); banT = t;
    const key = G.state + (typeof KC !== 'undefined' && KC.cut ? ':2' : ':1');
    let cur = banPlace(G, banSide, hgt);
    if (key !== banKey) {
      banKey = key;
      const a = banPlace(G, 1, hgt), b = banPlace(G, -1, hgt);
      banSide = b.clear > a.clear ? -1 : 1; cur = banSide > 0 ? a : b;
      banY = cur.y; banA = cur.ok ? 1 : 0;
    }
    if (!cur.ok && banA < 0.05) {
      const o = banPlace(G, -banSide, hgt);
      if (o.ok) { banSide = -banSide; cur = o; banY = o.y; }
    }
    banA = damp(banA, cur.ok ? 1 : 0, 14, dt);
    banY = damp(banY, cur.y, 12, dt);
    return banY;
  }
  // lines: [text, size, reveal, colour]; the headline is shown whole, the sublines appear token by token
  function resultBlock(G, lines, bandH) {
    const y = bannerPos(G, bandH);
    if (banA < 0.02) return;
    ctx.globalAlpha = banA;
    banner(y, bandH, 0.72);
    let yy = y - bandH / 2 + 34 * u;
    lines.forEach(([s, size, rev, col], i) => {
      if (i === 0) txt(s, W / 2, yy, size, 'center', FA, col);
      else typeTokens(s, W / 2, yy, 36, rev, 'center', FB, col);
      yy += (i === 0 ? 46 : 34) * u;
    });
    ctx.globalAlpha = 1;
  }
  function result(G) {
    if (G.state === 'killcam') {
      // headline from the first frame; the subline appears token by token (number + unit together)
      const lines = [['TARGET DOWN', portrait ? 24 : 40, 1, BR]];
      if (G.lastHit) lines.push([`${Math.round(G.lastHit.range)} M   ${G.lastHit.centre < 0.15 ? 'CENTER MASS' : 'HIT'}`, 16, (G.stateT - 0.3) * 1.6, BR]);
      resultBlock(G, lines, 116 * u);
    } else if (G.state === 'misscam') {
      if (G.missGap && G.missA.vis && G.missB.vis && G.stateT > 0.15) {
        const ax = G.missA.x * W, ay = (1 - G.missA.y) * H, bx = G.missB.x * W, by = (1 - G.missB.y) * H;
        ctx.setLineDash([6 * u, 5 * u]);
        ctx.strokeStyle = DK; ctx.lineWidth = 5 * u; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.strokeStyle = BR; ctx.lineWidth = 2 * u; ctx.stroke(); ctx.setLineDash([]);
        for (const [x, y] of [[ax, ay], [bx, by]]) { ctx.fillStyle = DK; ctx.fillRect(Math.round(x - 5 * u), Math.round(y - 5 * u), Math.round(10 * u), Math.round(10 * u)); ctx.fillStyle = BR; ctx.fillRect(Math.round(x - 3 * u), Math.round(y - 3 * u), Math.round(6 * u), Math.round(6 * u)); }
        plated(`${Bullet.S.minDist.toFixed(1)} M`, (ax + bx) / 2, (ay + by) / 2 - 18 * u, 16, 'center', FA, BR, 0.85);
      }
      const lines = [['MISS', 40, 1, BR]];
      if (G.lastMiss) lines.push([G.lastMiss, 16, G.stateT > 0.25 ? 9 : 0, BR]);
      if (G.rounds > 0) lines.push([`${G.rounds} ROUND${G.rounds === 1 ? '' : 'S'} LEFT`, 16, (G.stateT - 0.8) * 3, DIM]);
      resultBlock(G, lines, 154 * u);
    }
  }
  function tally(G) {
    // anchored in the right part of the screen: the kill camera frames the body in the left third
    const rows = G.tallyRows, rh = 34 * u, pw = portrait ? W - 28 * u : Math.min(W * 0.5, 600 * u), ph = 136 * u + rows.length * rh;
    const px = portrait ? W / 2 - pw / 2 : W - pw - 44 * u, py = Math.max(84 * u, H / 2 - ph / 2), pcx = px + pw / 2;
    panel(px, py, pw, ph, 'DOPE', { scrim: 1.0, col: BR, tab: BR });       // full scrim = 92 % black in the display
    panel(px + 6 * u, py + 6 * u, pw - 12 * u, ph - 12 * u, null, { col: FAINT });
    txt(`STAGE ${pad(G.stage, 2)} CLEAR`, pcx, py + 40 * u, 24, 'center');
    const fs = portrait ? 8 : 16, x0 = px + 34 * u, x1 = px + pw - 34 * u;
    rows.forEach((r, i) => {
      if (G.stateT < 0.5 + i * (G.tallyStep || 0.45)) return;
      const y = py + 84 * u + i * rh;
      const lw = txt(r[0], x0, y, fs, 'left', FA, 'rgba(255,0,0,0.88)');
      const vs = pad(r[1], 7), vw = tw(vs, fs);
      ctx.fillStyle = FAINT; for (let x = x0 + lw + 10 * u; x < x1 - vw - 10 * u; x += 10 * u) ctx.fillRect(Math.round(x), Math.round(y + fpx(fs, FA) * 0.3), Math.max(1, Math.round(2 * u)), Math.max(1, Math.round(2 * u)));
      txt(vs, x1, y, fs, 'right');
    });
    const ty = py + 84 * u + rows.length * rh + 10 * u;
    if (G.stateT > 0.5 + rows.length * (G.tallyStep || 0.45)) {
      line(x0, ty - 16 * u, x1, ty - 16 * u, 1.5, DIM);
      txt('TOTAL', x0, ty + 8 * u, 34, 'left', FB); txt(pad(G.score, 7), x1, ty + 8 * u, 40, 'right', FB);
    }
    if (G.stateT > 0.9 + rows.length * (G.tallyStep || 0.45) && blinkLong()) plated(touch ? 'TAP TO CONTINUE' : 'PRESS SPACE OR CLICK', pcx, py + ph + 28 * u, 16, 'center');
    demoBanner(G);
  }
  function gameover(G) {
    ctx.fillStyle = scrim(0.66); ctx.fillRect(0, 0, W, H);
    const y = H * 0.3;
    const sz = portrait ? 32 : 56;
    const r = G.stateT * 2;
    if (r > 0) {
      const s = 'GAME OVER', n = Math.ceil(s.length * clamp(r, 0, 1)), str = s.slice(0, n) + ' '.repeat(s.length - n), px = fpx(sz, FA);
      setFont(px, FA, 'center');
      ctx.lineWidth = Math.max(2, 2 * u); ctx.strokeStyle = DIM; ctx.strokeText(str, Math.round(W / 2 + 5 * u), baseY(y + 5 * u, px, FA));
      txt(str, W / 2, y, sz, 'center');
    }
    typeT(`SCORE ${pad(G.score, 7)}`, W / 2, y + 74 * u, 16, r - 0.6);
    typeT(`STAGE ${pad(G.stage, 2)} REACHED`, W / 2, y + 104 * u, 8, r - 0.9, 'center', FA, DIM);
    if (false) {
      txt('NEW HIGH SCORE', W / 2, H * 0.55, 16, 'center');
      txt('ENTER YOUR INITIALS', W / 2, H * 0.55 + 28 * u, 8, 'center', FA, DIM);
      const L = G.initials, cw = 64 * u, ch = 76 * u;
      for (let i = 0; i < 3; i++) {
        const x = W / 2 + (i - 1) * (cw + 16 * u), yy = H * 0.68, isCur = i === G.initialPos;
        panel(x - cw / 2, yy - ch / 2, cw, ch, null, { scrim: 0.6, col: isCur ? BR : DIM, chamfer: 6 });
        if (!isCur || blink(3)) txt(L[i], x, yy, 40, 'center');
        if (isCur) { ctx.fillStyle = BR; ctx.fillRect(Math.round(x - cw * 0.3), Math.round(yy + ch / 2 + 8 * u), Math.round(cw * 0.6), Math.round(4 * u)); }
      }
      txt(touch ? 'UP / DOWN CHANGE   RIGHT NEXT   TAP OK' : 'UP / DOWN CHANGE LETTER   SPACE CONFIRM', W / 2, H * 0.84, 8, 'center', FA, DIM);
    } else if (G.stateT > 1.5 && blinkLong()) txt(touch ? 'TAP TO CONTINUE' : 'PRESS SPACE OR CLICK', W / 2, H * 0.62, 16, 'center');
  }
  function paused() {
    ctx.fillStyle = scrim(0.66); ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 28 * u, 520 * u), ph = (touch ? 290 : 250) * u, px = W / 2 - pw / 2, py = H / 2 - ph / 2;
    panel(px, py, pw, ph, 'PAUSED', { scrim: 0.8, col: BR, tab: BR });
    txt('PAUSED', W / 2, py + 50 * u, 32, 'center');
    if (touch) {
      // three big buttons; a tap anywhere else also resumes
      const items = [['RESUME', 'KeyP'], [`SENSOR  ${G_ref.modeName}`, 'KeyT'], [`SOUND  ${Sfx.muted ? 'OFF' : 'ON'}`, 'KeyM']];
      const bw = pw - 68 * u, bh = 46 * u, bx = px + 34 * u;
      items.forEach(([label, code], i) => {
        const by = py + 92 * u + i * (bh + 12 * u);
        ctx.fillStyle = scrim(0.6); ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = i === 0 ? BR : DIM; ctx.lineWidth = 2 * u; ctx.strokeRect(bx, by, bw, bh);
        txt(label, W / 2, by + bh / 2, 16, 'center');
        btn(code, bx, by, bx + bw, by + bh, 4 * u);
      });
      return;
    }
    const rows = [['P OR ESC OR CLICK', 'RESUME'], ['T', 'SENSOR MODE'], ['M', 'SOUND ON / OFF']];
    rows.forEach((r, i) => { const y = py + 106 * u + i * 30 * u; txt(r[0], px + 34 * u, y, 8, 'left', FA, DIM); txt(r[1], px + pw - 34 * u, y, 8, 'right'); });
  }

  // ---- change detection --------------------------------------------------------
  const sig = [], cur = [];
  function signature(G) {
    const t = U.uTime.value, ts = G.tgtScreen, q = (v, k = 1) => Math.round(v * k);
    cur.length = 0;
    cur.push(G.state, G.paused ? 1 : 0, G.mode, G.toastT > 0 ? G.toast : '', Math.floor(t * 2), Math.floor(t * 2.4), Math.floor(t * 3), Math.floor(t * 4), Math.floor(t * 6), Math.floor((t % 1) / 0.8) + Math.floor(t) * 2,
      G.stateT < 4 ? Math.floor(G.stateT * 30) : -1, q(G.scoreShown), G.hi, G.stage, G.rounds, q(G.lased), q(G.crossWind, 10), q(G.mag, 10), G.magI, Math.ceil(G.timeLeft),
      q(G.breath, 48), G.holding ? 1 : 0, G.gasp > 0 ? 1 : 0, ts.vis ? 1 : 0, ts.off ? 1 : 0, q(ts.x * W), q(ts.y * H), q(ts.h * H), q(ts.ang, 40),
      q(G.reticleOff.x * H), q(G.reticleOff.y * H), q(Target.S.root.y), G.initials.join(''), G.initialPos, G.score, q(iris(), 60), typeof Aim !== 'undefined' ? q(Aim.yaw, 3000) : 0,
      G.demo ? 1 : 0, G.sector || '', G.tallyRows.length, Sfx.muted ? 1 : 0, touch ? 1 : 0, G.mission ? Mortar.M.locks.length : -1);
    let same = cur.length === sig.length;
    for (let i = 0; same && i < cur.length; i++) if (cur[i] !== sig[i]) same = false;
    if (!same) { sig.length = cur.length; for (let i = 0; i < cur.length; i++) sig[i] = cur[i]; }
    return same;
  }

  function draw(G) {
    const animated = G.state === 'attract' || G.state === 'flight' || G.state === 'killcam' || G.state === 'misscam' || G.state === 'mflight';
    if (!animated && signature(G)) return;          // nothing visible changed: skip redraw and upload
    if (animated) sig.length = 0;
    buttons.length = 0; G_ref = G;
    ctx.clearRect(0, 0, W, H);
    switch (G.state) {
      case 'attract': attract(G); break;
      case 'brief': brief(G); break;
      case 'aim': case 'shot': case 'mload': scopeHud(G); break;
      case 'mflight': missionHud(G); break;   // fire mission
      case 'flight': flightHud(G); break;
      case 'killcam': case 'misscam': result(G); demoBanner(G, banSide > 0 ? 88 * u : H - 72 * u); break;
      case 'tally': tally(G); break;
      case 'gameover': case 'initials': gameover(G); break;
    }
    // one three-slot top bar on every screen except the kill/miss cameras (nothing competes with the payoff)
    if (G.state !== 'killcam' && G.state !== 'misscam') topBar(G);
    if (pauseOn(G)) pauseButton(G);
    if (G.paused) paused();
    // toasts (the demo prompt is drawn by demoBanner instead); in flight they sit low, clear of the seeker dial
    if (G.toast && G.toastT > 0 && !(G.demo && /^DEMO/.test(G.toast))) {
      const ty = G.state === 'flight' ? H - 200 * u : H * (portrait ? 0.1 : 0.15);
      plated(G.toast, W / 2, ty, 16, 'center');
    }
    tex.needsUpdate = true;
  }
  return { cv, tex, resize, draw, setTouch, buttons, get touch() { return touch; }, get u() { return u; } };
})();
