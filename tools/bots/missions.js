(() => {
  const X = __X, M = X.Mortar, out = {};
  for (const v of ['checkpoint', 'convoy', 'nest', 'motorpool', 'garage']) {
    const r = [];
    for (let i = 0; i < 3; i++) {
      M.M.force = v; X.startAt(5); X.setState('aim'); X.advance(0.5, 1 / 30, false);
      let guard = 0;
      while (M.M.locks.length < 3 && guard++ < 40) {
        // point the scope at the next unlocked target and tap it
        const k = [0, 1, 2].find((q) => !M.M.locks.includes(q)); X.aimAt(M.M.trucks[k].p.clone().setY(M.M.trucks[k].p.y + 1)); X.advance(0.1, 1 / 30, false);
        X.camera.updateMatrixWorld(); M.screen(X.camera); const s = M.SC[k];
        if (s.vis) X.Input.tap = { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 };
        X.advance(1 / 30, 1 / 30, false);
      }
      X.advance(2.2, 1 / 30, false); X.Input.pressed.add('Fire'); X.advance(1 / 30, 1 / 30, false);
      let t = 0; while (X.G.state === 'mflight' && t < 30) { X.advance(0.1, 1 / 30, false); t += 0.1; }
      r.push(`${M.M.variant} locks${M.M.locks.length} ${X.G.state} alive${M.M.trucks.filter((q) => q.alive).length} ${t.toFixed(1)}s`);
    }
    out[v] = r.join(' | ');
  }
  return out;
})()
