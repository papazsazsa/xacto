// ---------------------------------------------------------------------------
// HUD: drawn on a 2D canvas, composited inside the CRT display shader.
// Red channel = bright phosphor ink, green channel = dark reticle ink.
// ---------------------------------------------------------------------------
const Hud = (() => {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.premultiplyAlpha = true; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  let W = 2, H = 2, s = 1;
  const BR = '#ff0000', DK = '#00ff00';
  const FA = '"Press Start 2P", monospace', FB = '"VT323", monospace';
  function resize(w, h) {
    const k = Math.min(1.5, Math.max(1, 1400 / Math.max(w, h)) * (window.devicePixelRatio > 1 ? 1.25 : 1));
    W = cv.width = Math.round(w * k); H = cv.height = Math.round(h * k); s = Math.min(H / 900, W / 1300);
  }
  function glow(on, blur = 7) { ctx.shadowColor = on ? 'rgba(255,0,0,0.85)' : 'transparent'; ctx.shadowBlur = on ? blur * s : 0; }
  function txt(str, x, y, size, align = 'left', font = FB, col = BR, g = true) {
    ctx.font = `${Math.round(size * s)}px ${font}`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = col;
    glow(g && col === BR); ctx.fillText(str, x, y); glow(false);
  }
  function line(x0, y0, x1, y1, w = 1.5, col = BR, g = true) { ctx.strokeStyle = col; ctx.lineWidth = w * s; glow(g && col === BR, 5); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); glow(false); }
  function rect(x, y, w, h, fill, col = BR) { ctx.fillStyle = col; ctx.strokeStyle = col; if (fill) ctx.fillRect(x, y, w, h); else { ctx.lineWidth = 1.5 * s; ctx.strokeRect(x, y, w, h); } }
  function brackets(x, y, w, h, len, col = BR, lw = 2) {
    ctx.strokeStyle = col; ctx.lineWidth = lw * s; glow(col === BR, 6); ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = x + sx * w / 2, cy = y + sy * h / 2;
      ctx.moveTo(cx, cy - sy * len); ctx.lineTo(cx, cy); ctx.lineTo(cx - sx * len, cy);
    }
    ctx.stroke(); glow(false);
  }
  const pad = (n, l) => String(Math.max(0, Math.floor(n))).padStart(l, '0');
  const blink = (rate = 2) => Math.floor(U.uTime.value * rate * 2) % 2 === 0;

  function topBar(G) {
    const y = 26 * s;
    txt('1UP', 40 * s, y, 14, 'left', FA); txt(pad(G.scoreShown, 7), 40 * s, y + 24 * s, 14, 'left', FA);
    txt('HI-SCORE', W / 2, y, 14, 'center', FA); txt(pad(Math.max(G.hi, G.scoreShown), 7), W / 2, y + 24 * s, 14, 'center', FA);
    txt('STAGE', W - 40 * s, y, 14, 'right', FA); txt(pad(G.stage, 2), W - 40 * s, y + 24 * s, 14, 'right', FA);
  }
  function rounds(G, x, y) {
    for (let i = 0; i < G.maxRounds; i++) {
      const bx = x + i * 16 * s, filled = i < G.rounds;
      ctx.fillStyle = BR; ctx.strokeStyle = BR; ctx.lineWidth = 1.2 * s;
      ctx.beginPath(); ctx.moveTo(bx, y + 14 * s); ctx.lineTo(bx, y - 4 * s); ctx.lineTo(bx + 4 * s, y - 12 * s); ctx.lineTo(bx + 8 * s, y - 4 * s); ctx.lineTo(bx + 8 * s, y + 14 * s); ctx.closePath();
      if (filled) { glow(true, 4); ctx.fill(); glow(false); } else ctx.stroke();
    }
  }
  function bar(x, y, w, h, frac, label, warn) {
    rect(x, y, w, h, false); const f = clamp(frac, 0, 1);
    if (!warn || blink(3)) { ctx.fillStyle = BR; glow(true, 4); ctx.fillRect(x + 2 * s, y + 2 * s, (w - 4 * s) * f, h - 4 * s); glow(false); }
    if (label) txt(label, x, y - 12 * s, 20, 'left');
  }

  function reticle(cx, cy, R) {
    ctx.strokeStyle = DK; ctx.fillStyle = DK;
    const gap = R * 0.035, thin = 1.6 * s, thick = 6 * s, post = R * 0.62;
    ctx.lineWidth = thin; ctx.beginPath();
    ctx.moveTo(cx - post, cy); ctx.lineTo(cx - gap, cy); ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + post, cy);
    ctx.moveTo(cx, cy - post); ctx.lineTo(cx, cy - gap); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + post);
    ctx.stroke();
    ctx.lineWidth = thick; ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx - post, cy); ctx.moveTo(cx + post, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy + post); ctx.lineTo(cx, cy + R); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy - post);
    ctx.stroke();
    const step = post / 6;
    for (let i = 1; i <= 5; i++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.beginPath(); ctx.arc(cx + dx * step * i, cy + dy * step * i, 2.4 * s, 0, TAU); ctx.fill(); }
    }
    // centre dot (bright) so it reads on hot targets
    ctx.fillStyle = BR; glow(true, 4); ctx.beginPath(); ctx.arc(cx, cy, 1.8 * s, 0, TAU); ctx.fill(); glow(false);
  }

  function scopeHud(G) {
    const cx = W / 2, cy = H / 2, R = G.scopeR * H;
    reticle(cx + G.reticleOff.x * H, cy - G.reticleOff.y * H, R);
    topBar(G);
    const portrait = W / H < 1.25;
    const lx = portrait ? 40 * s : cx - R - 60 * s, rx = portrait ? W - 40 * s : cx + R + 60 * s;
    const la = portrait ? 'left' : 'right', ra = portrait ? 'right' : 'left';
    const y0 = portrait ? H - 200 * s : cy - 150 * s;
    txt('RANGE', lx, y0, 20, la); txt(G.lased > 0 ? `${Math.round(G.lased)} M` : '---- M', lx, y0 + 30 * s, 40, la);
    txt('WIND', lx, y0 + 80 * s, 20, la);
    const wx = G.crossWind;
    txt(`${Math.abs(wx).toFixed(1)} M/S`, lx, y0 + 110 * s, 34, la);
    // wind arrow
    const ax = portrait ? lx + 150 * s : lx - 180 * s, ay = y0 + 110 * s, al = clamp(Math.abs(wx) / 12, 0.2, 1) * 48 * s, dir = Math.sign(wx) || 1;
    line(ax - dir * al / 2, ay, ax + dir * al / 2, ay, 2.5); line(ax + dir * al / 2, ay, ax + dir * (al / 2 - 9 * s), ay - 7 * s, 2.5); line(ax + dir * al / 2, ay, ax + dir * (al / 2 - 9 * s), ay + 7 * s, 2.5);
    txt('MAG', lx, y0 + 160 * s, 20, la); txt(`${G.mag.toFixed(1)}X`, lx, y0 + 190 * s, 34, la);
    txt('ROUNDS', rx, y0, 20, ra);
    rounds(G, portrait ? rx - G.maxRounds * 16 * s : rx, y0 + 34 * s);
    txt('TIME', rx, y0 + 80 * s, 20, ra);
    const tl = Math.max(0, G.timeLeft);
    txt(pad(tl, 2), rx, y0 + 112 * s, 40, ra, FB, tl < 10 && blink(2) ? DK : BR);
    const bw = 130 * s, bxx = portrait ? rx - bw : rx;
    bar(bxx, y0 + 175 * s, bw, 14 * s, G.breath, 'BREATH', G.gasp > 0);
    if (G.holding) txt('HOLDING', bxx, y0 + 205 * s, 18);
    // target marker
    if (G.tgtScreen.vis) {
      const tx = G.tgtScreen.x * W, ty = (1 - G.tgtScreen.y) * H;
      const dx = tx - cx, dy = ty - cy;
      if (Math.hypot(dx, dy) < R * 0.97) {
        const h = Math.max(28 * s, G.tgtScreen.h * H * 1.3);
        if (blink(1.5) || Math.hypot(dx, dy) < R * 0.2) brackets(tx, ty, h * 0.7, h, 7 * s);
        txt(`TGT ${Math.round(Target.S.dist)}M`, tx + h * 0.45, ty - h * 0.6, 18);
      }
    }
    if (G.tgtScreen.off) {
      const a = G.tgtScreen.ang; const px = cx + Math.cos(a) * (R - 26 * s), py = cy - Math.sin(a) * (R - 26 * s);
      ctx.save(); ctx.translate(px, py); ctx.rotate(-a); ctx.fillStyle = BR; glow(true);
      if (blink(2)) { ctx.beginPath(); ctx.moveTo(14 * s, 0); ctx.lineTo(-8 * s, -10 * s); ctx.lineTo(-8 * s, 10 * s); ctx.closePath(); ctx.fill(); }
      glow(false); ctx.restore();
    }
    const hint = 'SPACE FIRE   SHIFT HOLD BREATH   WHEEL / Q E ZOOM   T SENSOR';
    txt(hint, W / 2, H - 22 * s, 18, 'center');
    txt(G.modeName, rx, portrait ? y0 - 50 * s : cy + R * 0.72, 20, ra);
  }

  function flightHud(G) {
    const m = 30 * s, L = 46 * s;
    // viewfinder frame
    brackets(W / 2, H / 2, W - 2 * m, H - 2 * m, L, BR, 2.5);
    txt('XACTO GUIDED ROUND', 60 * s, 52 * s, 13, 'left', FA);
    txt(blink(1.2) ? '■ LINK' : '  LINK', 60 * s, 80 * s, 22);
    txt(`${G.timeScale.toFixed(2)}X TIME`, W - 60 * s, 52 * s, 22, 'right');
    const B = Bullet.S;
    // target box + predicted impact pipper
    if (G.tgtScreen.vis) {
      const tx = G.tgtScreen.x * W, ty = (1 - G.tgtScreen.y) * H;
      const h = clamp(G.tgtScreen.h * H * 1.25, 26 * s, H * 0.6);
      brackets(tx, ty, h * 0.75, h, Math.max(8 * s, h * 0.2), BR, 2.5);
      txt(`${Math.max(0, Math.round(G.tgtRange))} M`, tx + h * 0.45 + 8 * s, ty - h * 0.5, 22);
      if (G.pipScreen.vis) {
        const px = G.pipScreen.x * W, py = (1 - G.pipScreen.y) * H;
        ctx.setLineDash([5 * s, 6 * s]); line(px, py, tx, ty, 1.2); ctx.setLineDash([]);
        const d = 10 * s; ctx.strokeStyle = BR; ctx.lineWidth = 2 * s; glow(true, 6);
        ctx.beginPath(); ctx.moveTo(px, py - d); ctx.lineTo(px + d, py); ctx.lineTo(px, py + d); ctx.lineTo(px - d, py); ctx.closePath(); ctx.stroke(); glow(false);
        line(px - d * 1.8, py, px - d * 1.2, py, 2); line(px + d * 1.2, py, px + d * 1.8, py, 2);
        const on = Math.hypot(px - tx, py - ty) < h * 0.35;
        if (on) txt('ON TARGET', W / 2, H * 0.2, 20, 'center', FA);
      }
    } else if (G.tgtScreen.off) {
      txt('TARGET OFF AXIS', W / 2, H * 0.2, 16, 'center', FA);
    }
    // bottom readouts
    const y = H - 80 * s;
    const frac = B.budget / Math.max(1e-6, B.budget0);
    bar(60 * s, y, 220 * s, 18 * s, frac, `CTRL ${Math.round(frac * 100)}%`, frac < 0.25);
    if (B.depleted && blink(3)) txt('CONTROL DEPLETED', W / 2, H * 0.27, 16, 'center', FA);
    txt(`V ${Math.round(B.v.length())} M/S`, W - 60 * s, y - 14 * s, 26, 'right');
    txt(`TTI ${G.tti.toFixed(2)} S`, W - 60 * s, y + 16 * s, 26, 'right');
    // stick indicator
    const sx = W / 2, sy = H - 70 * s, sr = 34 * s;
    ctx.strokeStyle = BR; ctx.lineWidth = 1.5 * s; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.stroke();
    line(sx - sr, sy, sx + sr, sy, 0.8); line(sx, sy - sr, sx, sy + sr, 0.8);
    ctx.fillStyle = BR; glow(true, 6); ctx.beginPath(); ctx.arc(sx + G.stick.x * sr, sy - G.stick.y * sr, 5 * s, 0, TAU); ctx.fill(); glow(false);
    txt('STEER', sx, sy + sr + 16 * s, 18, 'center');
  }

  function center(str, y, size, font = FA, reveal = 1) {
    const n = Math.ceil(str.length * clamp(reveal, 0, 1));
    txt(str.slice(0, n), W / 2, y, size, 'center', font);
  }
  function attract(G) {
    const t = U.uTime.value;
    topBar(G);
    // title with vector double-stroke
    const sz = Math.round(96 * s);
    ctx.font = `${sz}px ${FA}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.2 * s; ctx.strokeStyle = BR; glow(true, 14);
    const ty = H * 0.3;
    ctx.strokeText('XACTO', W / 2, ty); ctx.strokeText('XACTO', W / 2 + 4 * s, ty + 4 * s);
    glow(false);
    txt('EXTREME ACCURACY TASKED ORDNANCE', W / 2, ty + 78 * s, 14, 'center', FA);
    const ph = Math.floor(t / 6) % 2;
    if (ph === 0) {
      txt('- HIGH SCORES -', W / 2, H * 0.5, 16, 'center', FA);
      G.table.slice(0, 5).forEach((e, i) => txt(`${i + 1}. ${e.n}  ${pad(e.s, 7)}`, W / 2, H * 0.5 + (36 + i * 30) * s, 15, 'center', FA));
    } else {
      txt('- HOW TO PLAY -', W / 2, H * 0.5, 16, 'center', FA);
      ['AIM WITH MOUSE OR ARROWS', 'SPACE FIRES THE GUIDED ROUND', 'STEER THE ROUND ONTO THE TARGET', 'SHIFT HOLDS BREATH   T SENSOR MODE'].forEach((l, i) => txt(l, W / 2, H * 0.5 + (36 + i * 30) * s, 12, 'center', FA));
    }
    if (blink(1)) txt('PRESS SPACE TO START', W / 2, H * 0.84, 18, 'center', FA);
    txt('© 1987 NIGHTGLASS ARCADE', W / 2, H - 26 * s, 12, 'center', FA);
  }
  function brief(G) {
    scopeHud(G);
    const r = clamp(G.stateT * 1.6, 0, 1);
    center(`STAGE ${G.stage}`, H * 0.3, 30, FA, r);
    center(`TARGET AT ${Math.round(Target.S.dist)} M`, H * 0.3 + 50 * s, 15, FA, clamp(G.stateT * 1.6 - 0.4, 0, 1));
    center(`WIND ${Math.abs(G.crossWind).toFixed(1)} M/S   CTRL ${G.diff.budget.toFixed(0)} M/S`, H * 0.3 + 80 * s, 13, FA, clamp(G.stateT * 1.6 - 0.8, 0, 1));
  }
  function result(G) {
    if (G.state === 'killcam') {
      center('TARGET DOWN', H * 0.22, 34, FA, G.stateT * 2);
      if (G.lastHit) center(`${Math.round(G.lastHit.range)} M  ${G.lastHit.centre < 0.15 ? 'CENTER MASS' : 'HIT'}`, H * 0.22 + 52 * s, 15, FA, G.stateT * 2 - 0.5);
    } else if (G.state === 'misscam') {
      center('MISS', H * 0.24, 40, FA, G.stateT * 3);
      if (G.lastMiss) center(G.lastMiss, H * 0.24 + 56 * s, 14, FA, G.stateT * 3 - 0.6);
    }
  }
  function tally(G) {
    ctx.fillStyle = 'rgba(0,255,0,0.55)'; ctx.fillRect(W * 0.18, H * 0.2, W * 0.64, H * 0.6);
    rect(W * 0.18, H * 0.2, W * 0.64, H * 0.6, false);
    center(`STAGE ${G.stage} CLEAR`, H * 0.27, 24);
    const rows = G.tallyRows;
    rows.forEach((r, i) => {
      if (G.stateT < 0.5 + i * 0.45) return;
      const y = H * 0.36 + i * 44 * s;
      txt(r[0], W * 0.23, y, 14, 'left', FA); txt(pad(r[1], 6), W * 0.77, y, 14, 'right', FA);
    });
    if (G.stateT > 0.5 + rows.length * 0.45) { line(W * 0.23, H * 0.36 + rows.length * 44 * s - 16 * s, W * 0.77, H * 0.36 + rows.length * 44 * s - 16 * s); txt('TOTAL', W * 0.23, H * 0.36 + rows.length * 44 * s + 10 * s, 16, 'left', FA); txt(pad(G.score, 7), W * 0.77, H * 0.36 + rows.length * 44 * s + 10 * s, 16, 'right', FA); }
    if (G.stateT > 2.5 && blink(1)) center('PRESS SPACE', H * 0.75, 14);
  }
  function gameover(G) {
    ctx.fillStyle = 'rgba(0,255,0,0.6)'; ctx.fillRect(0, 0, W, H);
    center('GAME OVER', H * 0.32, 44, FA, G.stateT * 2);
    center(`SCORE ${pad(G.score, 7)}`, H * 0.32 + 70 * s, 18, FA, G.stateT * 2 - 0.6);
    if (G.state === 'initials') {
      center('NEW HIGH SCORE - ENTER INITIALS', H * 0.55, 15);
      const L = G.initials;
      for (let i = 0; i < 3; i++) {
        const x = W / 2 + (i - 1) * 64 * s, y = H * 0.66;
        if (i !== G.initialPos || blink(3)) txt(L[i], x, y, 40, 'center', FA);
        line(x - 22 * s, y + 34 * s, x + 22 * s, y + 34 * s, 2);
      }
      center('UP / DOWN CHANGE   SPACE CONFIRM', H * 0.8, 11);
    } else if (G.stateT > 1.5 && blink(1)) center('PRESS SPACE', H * 0.7, 14);
  }
  function paused() { ctx.fillStyle = 'rgba(0,255,0,0.5)'; ctx.fillRect(0, 0, W, H); center('PAUSED', H * 0.45, 36); center('P TO RESUME', H * 0.55, 13); }

  function draw(G) {
    ctx.clearRect(0, 0, W, H);
    switch (G.state) {
      case 'attract': attract(G); break;
      case 'brief': brief(G); break;
      case 'aim': case 'shot': scopeHud(G); break;
      case 'flight': flightHud(G); break;
      case 'killcam': case 'misscam': if (G.state === 'misscam') flightHud(G); result(G); break;
      case 'tally': tally(G); break;
      case 'gameover': case 'initials': gameover(G); break;
    }
    if (G.paused) paused();
    if (G.toast && G.toastT > 0) txt(G.toast, W / 2, H * 0.12, 16, 'center', FA);
    tex.needsUpdate = true;
  }
  return { cv, tex, resize, draw };
})();
