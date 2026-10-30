(() => {
  const X = window.__X, T = X.Target, out = {};
  for (const kind of (window.__K || ['tower', 'ledge', 'quad'])) {
    let ok = 0, n = 0, plan = 0; const agl = [], dist = [], sites = {}; let ms = 0;
    for (let i = 0; i < (window.__N || 10); i++) {
      X.startAt(4 + (i % 4)); const t0 = performance.now();
      const r = X.spawnKind(kind); ms += performance.now() - t0; n++;
      if (!r) continue; ok++; if (X.RP.ok) plan++;
      agl.push(Math.round(T.S.root.y)); dist.push(Math.round(T.S.dist));
      const st = T.S.spot.site; if (st) sites[st] = (sites[st] || 0) + 1;
    }
    out[kind] = `${ok}/${n} plan ${plan}  agl ${agl.join(',')}  d ${dist.join(',')}  ${JSON.stringify(sites)}  ${Math.round(ms / n)} ms`;
  }
  out.CF = JSON.stringify(T.CF);
  return out;
})()
