// ---------------------------------------------------------------------------
// Sfx: fully synthesised WebAudio sound (no assets)
// ---------------------------------------------------------------------------
const Sfx = (() => {
  let ctx = null, out = null, verbSend = null, noiseBuf = null;
  let muted = Store.get('muted', false);
  let flight = null, amb = null;

  function init() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 5;
        comp.attack.value = 0.002; comp.release.value = 0.3;
        out = ctx.createGain(); out.gain.value = muted ? 0 : 0.85;
        out.connect(comp); comp.connect(ctx.destination);
        noiseBuf = makeNoise(3);
        const verb = ctx.createConvolver(); verb.buffer = makeIR(3.4);
        verbSend = ctx.createGain(); verbSend.gain.value = 0.55;
        verbSend.connect(verb); verb.connect(out);
        startAmbience();
      }
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e) { ctx = null; }
  }
  function makeNoise(sec) {
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  // Urban impulse response: diffuse tail + discrete slap-back echoes off buildings
  function makeIR(sec) {
    const sr = ctx.sampleRate, len = Math.floor(sr * sec), b = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) { const t = i / sr; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t / sec, 4) * 0.35; }
      const echoes = [0.09, 0.21, 0.37, 0.58, 0.86, 1.22, 1.71];
      echoes.forEach((e, k) => {
        const s = Math.floor((e + c * 0.017 + Math.random() * 0.012) * sr), amp = 0.8 * Math.pow(0.6, k);
        for (let j = 0; j < 1400 && s + j < len; j++) d[s + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j / 220);
      });
    }
    return b;
  }
  const now = () => ctx.currentTime;
  function noiseSrc(t0, dur) { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(t0, Math.random() * 2); if (dur) s.stop(t0 + dur); return s; }
  function gainEnv(t0, peak, attack, decay) { const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay); return g; }
  function filt(type, f, q = 0.7) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }

  function shot() {
    if (!ctx) return; const t = now();
    // supersonic crack
    let g = gainEnv(t, 0.9, 0.001, 0.07); noiseSrc(t, 0.12).connect(filt('highpass', 2600)).connect(g); g.connect(out); g.connect(verbSend);
    // muzzle blast body
    const lp = filt('lowpass', 2800); lp.frequency.setValueAtTime(3200, t); lp.frequency.exponentialRampToValueAtTime(140, t + 0.5);
    g = gainEnv(t, 1.5, 0.002, 0.65); noiseSrc(t, 0.8).connect(lp).connect(g); g.connect(out); g.connect(verbSend);
    // chest thump
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.3);
    g = gainEnv(t, 1.3, 0.002, 0.42); o.connect(g).connect(out); o.start(t); o.stop(t + 0.5);
    // bolt/mechanical tick
    g = gainEnv(t + 0.62, 0.12, 0.001, 0.05); noiseSrc(t + 0.62, 0.08).connect(filt('bandpass', 3800, 6)).connect(g).connect(out);
  }
  function blip(freq = 880, dur = 0.06, type = 'square', vol = 0.08, when = 0) {
    if (!ctx) return; const t = now() + when;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    const g = gainEnv(t, vol, 0.003, dur); o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.05);
  }
  function arp(notes, step = 0.07, type = 'square', vol = 0.07) { notes.forEach((f, i) => blip(f, step * 1.3, type, vol, i * step)); }
  function coin() { arp([988, 1319], 0.08, 'square', 0.08); }
  function tick() { blip(1760, 0.025, 'square', 0.05); }
  function lock() { blip(1320, 0.04, 'triangle', 0.08); blip(1760, 0.05, 'triangle', 0.06, 0.05); }
  function deny() { arp([220, 165], 0.09, 'square', 0.07); }
  function hit() {
    if (!ctx) return; const t = now();
    let g = gainEnv(t, 0.9, 0.001, 0.18); noiseSrc(t, 0.25).connect(filt('bandpass', 700, 1.2)).connect(g); g.connect(out); g.connect(verbSend);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.2);
    g = gainEnv(t, 0.9, 0.002, 0.25); o.connect(g).connect(out); o.start(t); o.stop(t + 0.3);
    arp([523, 659, 784, 1047, 1319], 0.065, 'square', 0.06);
  }
  function miss() {
    if (!ctx) return; const t = now();
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(2600, t); o.frequency.exponentialRampToValueAtTime(520, t + 0.45);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 38; const lg = ctx.createGain(); lg.gain.value = 120; lfo.connect(lg).connect(o.frequency);
    let g = gainEnv(t, 0.25, 0.004, 0.45); o.connect(g); g.connect(out); g.connect(verbSend); o.start(t); o.stop(t + 0.5); lfo.start(t); lfo.stop(t + 0.5);
    g = gainEnv(t, 0.6, 0.001, 0.1); noiseSrc(t, 0.15).connect(filt('highpass', 1800)).connect(g); g.connect(out); g.connect(verbSend);
    arp([392, 330, 262], 0.12, 'square', 0.05);
  }
  function impactThud() {
    if (!ctx) return; const t = now();
    const g = gainEnv(t, 0.5, 0.002, 0.3); noiseSrc(t, 0.4).connect(filt('lowpass', 400)).connect(g); g.connect(out); g.connect(verbSend);
  }
  function heartbeat(rate = 1) {
    if (!ctx) return; const t = now();
    [0, 0.18].forEach((d, i) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(58, t + d); o.frequency.exponentialRampToValueAtTime(38, t + d + 0.12);
      const g = gainEnv(t + d, i ? 0.25 * rate : 0.4 * rate, 0.004, 0.14); o.connect(g).connect(out); o.start(t + d); o.stop(t + d + 0.2);
    });
  }
  function staticBurst(dur = 0.25) {
    if (!ctx) return; const t = now();
    const g = gainEnv(t, 0.12, 0.002, dur); noiseSrc(t, dur + 0.1).connect(filt('bandpass', 2400, 0.6)).connect(g).connect(out);
  }

  // Bullet flight: wind roar + supersonic whine; slow-motion drone underneath
  function flightStart() {
    if (!ctx || flight) return; const t = now();
    const n = noiseSrc(t); const bp = filt('bandpass', 900, 0.8); const g = ctx.createGain(); g.gain.value = 0.0001;
    n.connect(bp).connect(g).connect(out);
    const whine = ctx.createOscillator(); whine.type = 'sawtooth'; whine.frequency.value = 420; const wf = filt('lowpass', 1200); const wg = ctx.createGain(); wg.gain.value = 0.0001;
    whine.connect(wf).connect(wg).connect(out); whine.start(t);
    const drone = ctx.createOscillator(); drone.type = 'triangle'; drone.frequency.value = 46; const dg = ctx.createGain(); dg.gain.value = 0.0001;
    drone.connect(dg).connect(out); drone.start(t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.15); dg.gain.exponentialRampToValueAtTime(0.18, t + 0.4);
    flight = { n, bp, g, whine, wg, drone, dg };
  }
  function flightUpdate(speedFrac, timeScale, near) {
    if (!flight) return; const t = now();
    flight.bp.frequency.setTargetAtTime(300 + 1400 * speedFrac * (0.4 + timeScale), t, 0.05);
    flight.g.gain.setTargetAtTime(0.18 + 0.3 * speedFrac + 0.4 * near, t, 0.05);
    flight.whine.frequency.setTargetAtTime(160 + 500 * speedFrac * (0.3 + timeScale), t, 0.08);
    flight.wg.gain.setTargetAtTime(0.02 + 0.04 * speedFrac, t, 0.1);
  }
  function flightStop() {
    if (!flight) return; const t = now(), f = flight; flight = null;
    [f.g, f.wg, f.dg].forEach((g) => { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0.0001, t, 0.06); });
    setTimeout(() => { try { f.n.stop(); f.whine.stop(); f.drone.stop(); } catch (e) { /* already stopped */ } }, 600);
  }
  function startAmbience() {
    const t = now();
    const n = noiseSrc(t); const lp = filt('lowpass', 380); const g = ctx.createGain(); g.gain.value = 0.05;
    n.connect(lp).connect(g).connect(out);
    const hum = ctx.createOscillator(); hum.type = 'sine'; hum.frequency.value = 60; const hg = ctx.createGain(); hg.gain.value = 0.012; hum.connect(hg).connect(out); hum.start(t);
    amb = { g, lp };
  }
  function windLevel(v) { if (!amb) return; amb.g.gain.setTargetAtTime(0.03 + 0.012 * v, now(), 0.5); amb.lp.frequency.setTargetAtTime(250 + 25 * v, now(), 0.5); }
  function toggleMute() { muted = !muted; Store.set('muted', muted); if (out) out.gain.setTargetAtTime(muted ? 0 : 0.85, now(), 0.02); return muted; }
  return { init, shot, blip, arp, coin, tick, lock, deny, hit, miss, impactThud, heartbeat, staticBurst, flightStart, flightUpdate, flightStop, windLevel, toggleMute, get muted() { return muted; } };
})();
