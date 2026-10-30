// ---------------------------------------------------------------------------
// Sfx: fully synthesised WebAudio sound (no assets)
//   graph:  sources -> buses (report / sfx / ui / amb / flight) -> sum -> HP 24 Hz
//           -> compressor -> master -> soft clipper -> out
//   city reverb: convolver with a generated "street canyon" impulse response
//   (discrete slap-back echoes off buildings, duller with distance, plus a
//   rolling diffuse tail). Arcade sounds run on a 60 Hz "sound driver": pitch
//   and volume change in frame steps on pulse / triangle / noise voices.
// The context is created and resumed on the first key / click / touch
// (Sfx.init is called from those handlers), so browser autoplay rules hold.
// Sfx.renderOffline(name, args, seconds, events) renders any sound through the
// same graph into an OfflineAudioContext (used by the audio probe).
// ---------------------------------------------------------------------------
const Sfx = (() => {
  let ctx = null, A = null, flight = null, amb = null, sirenTimer = 0;
  let muted = Store.get('muted', false);
  const MASTER = 0.8;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const rnd = (a = 0, b = 1) => a + (b - a) * Math.random();

  // ---- graph ----------------------------------------------------------------------
  function makeGraph(c) {
    const g = { c };
    const sr = c.sampleRate;
    // noise tables (white, and brown for distant rumble)
    g.white = c.createBuffer(1, sr * 2, sr);
    { const d = g.white.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    g.brown = c.createBuffer(1, sr * 4, sr);
    { const d = g.brown.getChannelData(0); let y = 0; for (let i = 0; i < d.length; i++) { y = (y + 0.02 * (Math.random() * 2 - 1)) * 0.997; d[i] = y * 3.5; } }
    // supersonic N-wave (2.2 ms) used for cracks
    { const L = Math.round(sr * 0.0022), b = c.createBuffer(1, L + 64, sr), d = b.getChannelData(0);
      for (let i = 0; i < L; i++) d[i + 4] = 1 - 2 * i / L; g.nwave = b; }
    // pulse waves (12.5 %, 25 %, 50 %) for the chip voices
    g.wave = {};
    for (const [k, duty] of [['p12', 0.125], ['p25', 0.25], ['p50', 0.5]]) {
      const N = 48, re = new Float32Array(N), im = new Float32Array(N);
      for (let n = 1; n < N; n++) { re[n] = (2 / (n * Math.PI)) * Math.sin(2 * Math.PI * n * duty); im[n] = (2 / (n * Math.PI)) * (1 - Math.cos(2 * Math.PI * n * duty)); }
      g.wave[k] = c.createPeriodicWave(re, im);
    }
    g.sum = c.createGain();
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 24; hp.Q.value = 0.6;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = 0.003; comp.release.value = 0.22;
    g.master = c.createGain(); g.master.gain.value = muted ? 0 : MASTER;
    const clip = c.createWaveShaper(); clip.curve = softClipCurve(); clip.oversample = '2x';
    g.sum.connect(hp).connect(comp).connect(g.master).connect(clip).connect(c.destination);
    // city reverb
    g.verb = c.createConvolver(); g.verb.buffer = makeCityIR(c, 3.6);
    g.verbIn = c.createGain(); g.verbIn.gain.value = 1;
    g.verbLP = c.createBiquadFilter(); g.verbLP.type = 'lowpass'; g.verbLP.frequency.value = 9000;
    g.verbOut = c.createGain(); g.verbOut.gain.value = 0.9;
    g.verbIn.connect(g.verb).connect(g.verbLP).connect(g.verbOut).connect(g.sum);
    // buses
    g.sfx = c.createGain(); g.sfx.connect(g.sum);
    g.ui = c.createGain(); g.ui.gain.value = 0.9; g.ui.connect(g.sum);
    g.amb = c.createGain(); g.amb.gain.value = 1;
    // the whole ambience bus darkens when time slows (see slowWorld)
    g.ambLP = c.createBiquadFilter(); g.ambLP.type = 'lowpass'; g.ambLP.frequency.value = 20000; g.ambLP.Q.value = 0.6;
    g.amb.connect(g.ambLP).connect(g.sum);
    g.reportIn = c.createGain();
    g.reportLP = c.createBiquadFilter(); g.reportLP.type = 'lowpass'; g.reportLP.frequency.value = 18000; g.reportLP.Q.value = 0.5;
    g.report = c.createGain();
    g.reportIn.connect(g.reportLP).connect(g.report); g.report.connect(g.sum);
    g.reportSend = c.createGain(); g.reportSend.gain.value = 0.5; g.report.connect(g.reportSend).connect(g.verbIn);
    return g;
  }
  function softClipCurve() {
    const n = 2048, cv = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); cv[i] = Math.sign(x) * (a < 0.7 ? a : 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3)); }
    return cv;
  }
  // Street-canyon impulse response: discrete slaps (each a short diffuse burst,
  // darker and wider the later it arrives) + a slow-building, rolling tail.
  function makeCityIR(c, sec) {
    const sr = c.sampleRate, len = Math.floor(sr * sec), b = c.createBuffer(2, len, sr);
    const slaps = [[0.083, 0.75, -0.7], [0.142, 0.55, 0.6], [0.231, 0.5, -0.2], [0.348, 0.42, 0.8], [0.47, 0.3, -0.6], [0.66, 0.26, 0.3], [0.91, 0.18, -0.4], [1.24, 0.13, 0.7], [1.71, 0.08, -0.5]];
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (const [t, amp, pan] of slaps) {
        const gainC = amp * (ch === 0 ? Math.min(1, 1 - pan) : Math.min(1, 1 + pan));
        const s0 = Math.floor((t + (ch ? 0.006 : 0) * pan) * sr), tau = (0.002 + t * 0.012) * sr;
        const fc = 7000 * Math.exp(-t / 0.55) + 600, a = 1 - Math.exp(-2 * Math.PI * fc / sr);
        let y = 0;
        for (let j = 0; j < tau * 6 && s0 + j < len; j++) { y += a * ((Math.random() * 2 - 1) - y); d[s0 + j] += y * gainC * Math.exp(-j / tau) * 2.2; }
      }
      let y = 0;
      for (let i = Math.floor(0.05 * sr); i < len; i++) {
        const t = i / sr, fc = 3200 * Math.exp(-t / 0.7) + 260, a = 1 - Math.exp(-2 * Math.PI * fc / sr);
        y += a * ((Math.random() * 2 - 1) - y);
        const env = (1 - Math.exp(-(t - 0.05) / 0.12)) * Math.exp(-t / 0.75) * (1 - t / sec) * (0.75 + 0.25 * Math.sin(t * 7.3 + ch * 2));
        d[i] += y * env * 0.32;
      }
    }
    return b;
  }

  function init() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC({ latencyHint: 'interactive' });
        A = makeGraph(ctx);
        // iOS unlock: play one silent frame inside the gesture
        const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); s.connect(ctx.destination); s.start(0);
        startAmbience();
        document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); });
      }
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    } catch (e) { ctx = null; A = null; }
  }
  const now = () => ctx.currentTime;

  // ---- building blocks ----------------------------------------------------------
  function noise(t0, dur, buf, rate = 1) {
    const s = ctx.createBufferSource(); s.buffer = buf || A.white; s.loop = true; s.playbackRate.value = rate;
    s.start(t0, Math.random() * (s.buffer.duration - 0.1)); if (dur) s.stop(t0 + dur); return s;
  }
  function filt(type, f, q = 0.7) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  function gainAD(t0, peak, attack, decay, hold = 0) {
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack); if (hold) g.gain.setValueAtTime(peak, t0 + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay); return g;
  }
  function osc(type, f, t0, t1) { const o = ctx.createOscillator(); if (A.wave[type]) o.setPeriodicWave(A.wave[type]); else o.type = type; o.frequency.setValueAtTime(f, t0); o.start(t0); if (t1 != null) o.stop(t1); return o; }
  function panner(p) { if (!ctx.createStereoPanner) return ctx.createGain(); const s = ctx.createStereoPanner(); s.pan.value = p; return s; }
  function shaper(drive) {
    const w = ctx.createWaveShaper(), n = 1024, cv = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; cv[i] = Math.tanh(x * drive) / Math.tanh(drive); }
    w.curve = cv; return w;
  }
  // 60 Hz chip voice: frame-stepped volume envelope and pitch slide, like an 8-bit sound driver
  const FR = 1 / 60;
  function chip(t0, f, dur, wave = 'p50', vol = 0.07, o = {}) {
    const frames = Math.max(1, Math.round(dur / FR)), t1 = t0 + frames * FR;
    const v = osc(wave, f, t0, t1 + 0.03), g = ctx.createGain(); g.gain.setValueAtTime(0, t0);
    const sustain = o.sustain == null ? 0.55 : o.sustain;
    for (let k = 0; k < frames; k++) {
      const x = k / frames, env = k === 0 ? 1 : k < 3 ? 1 - (1 - sustain) * (k / 3) : sustain * Math.pow(1 - x, o.release || 0.6);
      g.gain.setTargetAtTime(vol * env, t0 + k * FR, 0.0015);
      if (o.slide) v.frequency.setValueAtTime(f * Math.pow(o.slide, x), t0 + k * FR);
      if (o.vib && k > 4) v.frequency.setValueAtTime(f * (1 + o.vib * ((k & 2) ? 1 : -1)), t0 + k * FR);
    }
    g.gain.setTargetAtTime(0, t1, 0.003);
    v.connect(g).connect(o.bus || A.ui);
    return g;
  }
  function chipNoise(t0, dur, vol = 0.05, hp = 1000, bus) {
    const frames = Math.max(1, Math.round(dur / FR)), g = ctx.createGain(); g.gain.setValueAtTime(0, t0);
    for (let k = 0; k < frames; k++) g.gain.setTargetAtTime(vol * Math.pow(1 - k / frames, 1.5), t0 + k * FR, 0.0015);
    g.gain.setTargetAtTime(0, t0 + frames * FR, 0.003);
    noise(t0, dur + 0.05, null, 0.5).connect(filt('highpass', hp)).connect(g).connect(bus || A.ui); return g;
  }
  // tiny sequencer: tracks of [midi|0 (rest), sixteenths]
  function seq(t0, step, tracks) {
    let end = t0;
    for (const tr of tracks) {
      let t = t0;
      for (const [m, len] of tr.notes) {
        const d = len * step;
        if (m) { if (tr.noise) chipNoise(t, Math.min(d, tr.len || 0.08), tr.vol, m); else chip(t, mtof(m), d * (tr.gate || 0.9), tr.wave, tr.vol, tr.o || {}); }
        t += d;
      }
      end = Math.max(end, t);
    }
    return end - t0;
  }

  // ---- weapon -------------------------------------------------------------------
  function crackAt(t, vol, bus) {
    const s = ctx.createBufferSource(); s.buffer = A.nwave; s.start(t);
    const g = ctx.createGain(); g.gain.value = vol; s.connect(filt('highpass', 300)).connect(g).connect(bus);
    return g;
  }
  // .50 cal report: N-wave crack + saturated muzzle blast + brake bark + chest boom; city slap-back via the reverb
  function shot() {
    if (!ctx) return; const t = now(), R = A.reportIn;
    A.reportLP.frequency.cancelScheduledValues(t); A.reportLP.frequency.setValueAtTime(18000, t);
    A.report.gain.cancelScheduledValues(t); A.report.gain.setValueAtTime(1, t);
    A.verbLP.frequency.cancelScheduledValues(t); A.verbLP.frequency.setValueAtTime(9000, t);
    crackAt(t, 0.9, R);
    // blast: white noise through a falling lowpass, driven into saturation
    const lp = filt('lowpass', 9000, 0.9);
    lp.frequency.setValueAtTime(11000, t); lp.frequency.exponentialRampToValueAtTime(2600, t + 0.03); lp.frequency.exponentialRampToValueAtTime(320, t + 0.4);
    let g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1.0, t + 0.0008);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.04); g.gain.exponentialRampToValueAtTime(0.04, t + 0.15); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    noise(t, 0.8).connect(lp).connect(shaper(2.2)).connect(g).connect(R);
    // muzzle-brake bark (harsh mid band)
    g = gainAD(t, 0.55, 0.001, 0.13); noise(t, 0.2).connect(filt('bandpass', 750, 1.4)).connect(g).connect(R);
    g = gainAD(t, 0.3, 0.001, 0.06); noise(t, 0.1).connect(filt('bandpass', 2400, 1.2)).connect(g).connect(R);
    // chest boom: falling sine + punch
    let o = osc('sine', 64, t, t + 0.9); o.frequency.exponentialRampToValueAtTime(29, t + 0.5);
    g = gainAD(t, 0.95, 0.002, 0.42); o.connect(g).connect(R);
    o = osc('triangle', 120, t, t + 0.3); o.frequency.exponentialRampToValueAtTime(48, t + 0.18);
    g = gainAD(t, 0.45, 0.001, 0.22); o.connect(shaper(1.6)).connect(g).connect(R);
    // low rumble rolling down the avenue (brown noise, swells late)
    g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    noise(t, 2.5, A.brown).connect(filt('lowpass', 220)).connect(g).connect(R);
  }
  // Supersonic crack heard near the flight path (dist m, pan -1..1)
  function crack(dist = 10, pan = 0) {
    if (!ctx) return; const t = now(), v = Math.min(0.95, 6 / Math.max(2, dist));
    const p = panner(pan); p.connect(A.sfx); crackAt(t, v, p);
    const g = gainAD(t, v * 0.5, 0.0005, 0.05); noise(t, 0.08).connect(filt('highpass', 3000)).connect(g).connect(p); g.connect(A.verbIn);
  }

  // ---- arcade / UI -------------------------------------------------------------------
  function blip(freq = 880, dur = 0.06, type = 'square', vol = 0.08, when = 0) {
    if (!ctx) return; const w = type === 'square' ? 'p50' : type;
    chip(now() + when, freq, Math.max(FR * 2, dur), w, vol * 0.9, { sustain: 0.7 });
  }
  function arp(notes, step = 0.07, type = 'square', vol = 0.07) { notes.forEach((f, i) => blip(f, step * 1.2, type, vol, i * step)); }
  function coin() { // credit in: stepped upward run on a thin pulse, ends with a sparkle
    if (!ctx) return; const t = now();
    [72, 76, 79, 84, 88, 91].forEach((m, i) => chip(t + i * 0.035, mtof(m), 0.05, 'p25', 0.08, { sustain: 0.8 }));
    chip(t + 0.21, mtof(96), 0.3, 'p12', 0.07, { sustain: 0.7, vib: 0.012, release: 1.2 });
  }
  function tick() { if (!ctx) return; chip(now(), 1976, FR * 2, 'p25', 0.18, { sustain: 0.9 }); }
  function lock() { if (!ctx) return; const t = now(); chip(t, 1319, 0.05, 'triangle', 0.16, { sustain: 0.9 }); chip(t + 0.05, 1760, 0.08, 'triangle', 0.14, { sustain: 0.8 }); }
  function deny() { if (!ctx) return; const t = now(); chip(t, 110, 0.09, 'p25', 0.08, { sustain: 1 }); chip(t + 0.12, 104, 0.16, 'p25', 0.08, { sustain: 1, slide: 0.85 }); }
  // stage start: bugle-call motif over a marching bass and snare
  function stageStart() {
    if (!ctx) return 0; const t = now() + 0.02, s = 0.075;
    return seq(t, s, [
      { wave: 'p25', vol: 0.06, notes: [[67, 2], [72, 2], [76, 2], [79, 4], [76, 2], [79, 8]], o: { sustain: 0.6, vib: 0.006 } },
      { wave: 'p12', vol: 0.025, notes: [[0, 1], [67, 2], [72, 2], [76, 2], [79, 4], [76, 2], [79, 7]], o: { sustain: 0.5 } },
      { wave: 'triangle', vol: 0.16, notes: [[48, 4], [43, 4], [48, 4], [43, 2], [48, 6]], gate: 0.8, o: { sustain: 0.9 } },
      { noise: true, vol: 0.05, len: 0.05, notes: [[3000, 1], [3000, 1], [3000, 2], [3000, 4], [3000, 4], [3000, 2], [3000, 6]] },
    ]);
  }
  // target down fanfare
  function fanfare(t) {
    seq(t, 0.06, [
      { wave: 'p25', vol: 0.06, notes: [[72, 1], [76, 1], [79, 1], [84, 2], [79, 1], [84, 6]], o: { sustain: 0.65, vib: 0.008 } },
      { wave: 'triangle', vol: 0.15, notes: [[48, 2], [55, 2], [60, 2], [48, 6]], gate: 0.85, o: { sustain: 0.9 } },
    ]);
  }
  function gameOver() {
    if (!ctx) return 0; const t = now() + 0.02;
    return seq(t, 0.11, [
      { wave: 'p50', vol: 0.055, notes: [[76, 2], [74, 2], [72, 2], [71, 2], [69, 6], [0, 1], [64, 2], [69, 8]], o: { sustain: 0.6, vib: 0.01, release: 0.9 } },
      { wave: 'triangle', vol: 0.15, notes: [[45, 4], [43, 4], [41, 4], [40, 4], [45, 8]], gate: 0.9, o: { sustain: 0.85 } },
    ]);
  }
  function bonus() { if (!ctx) return; const t = now(); [84, 88, 91, 96].forEach((m, i) => chip(t + i * 0.04, mtof(m), 0.06, 'p12', 0.05, { sustain: 0.8 })); }

  // ---- results / impacts ---------------------------------------------------------------
  function hit() {
    if (!ctx) return; const t = now();
    // fabric / dust thwump (no gore): soft low noise + body thump
    let g = gainAD(t, 0.7, 0.002, 0.2); noise(t, 0.25).connect(filt('lowpass', 900, 0.8)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    const o = osc('sine', 150, t, t + 0.35); o.frequency.exponentialRampToValueAtTime(55, t + 0.22);
    g = gainAD(t, 0.8, 0.002, 0.26); o.connect(g).connect(A.sfx);
    g = gainAD(t, 0.25, 0.0005, 0.03); noise(t, 0.05).connect(filt('bandpass', 2200, 1)).connect(g).connect(A.sfx);
    fanfare(t + 0.18);
  }
  function miss() {
    if (!ctx) return; const t = now();
    // round whining off into the distance
    const o = osc('sine', 2900, t, t + 0.75); o.frequency.exponentialRampToValueAtTime(700, t + 0.7);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 31; const lg = ctx.createGain(); lg.gain.value = 90; lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + 0.75);
    const g = gainAD(t, 0.16, 0.01, 0.65); const p = panner(rnd(-0.5, 0.5)); o.connect(g).connect(p).connect(A.sfx); g.connect(A.verbIn);
    // "wah-wah" sad trombone on a pulse voice
    seq(t + 0.35, 0.09, [{ wave: 'p50', vol: 0.065, notes: [[67, 3], [66, 3], [65, 3], [64, 8]], o: { sustain: 0.7, vib: 0.012 } }]);
  }
  // bullet into concrete / steel: crack, thud, debris patter, sometimes a ricochet whine
  // blast: a crack, a long low roar and a sub drop
  function boom() {
    if (!ctx) return; const t = now();
    let g = gainAD(t, 0.7, 0.0005, 0.12); noise(t, 0.15).connect(filt('highpass', 1400)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    g = gainAD(t, 1.0, 0.003, 1.1); noise(t, 1.4).connect(filt('lowpass', 750)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    const o = osc('sine', 72, t, t + 1.1); o.frequency.exponentialRampToValueAtTime(26, t + 0.9);
    g = gainAD(t, 0.95, 0.004, 0.9); o.connect(g).connect(A.sfx);
  }
  // glass: a bright crash, then a scatter of tinkles
  function glass() {
    if (!ctx) return; const t = now();
    let g = gainAD(t, 0.8, 0.0005, 0.09); noise(t, 0.14).connect(filt('highpass', 3200)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    g = gainAD(t, 0.4, 0.001, 0.2); noise(t, 0.25).connect(filt('bandpass', 1400, 0.8)).connect(g).connect(A.sfx);
    for (let i = 0; i < 16; i++) {
      const tt = t + 0.02 + Math.pow(Math.random(), 1.5) * 0.75, f = rnd(2600, 7400);
      const o = osc('sine', f, tt, tt + 0.14), gg = gainAD(tt, rnd(0.025, 0.08), 0.0005, rnd(0.04, 0.11)); o.connect(gg).connect(A.sfx);
    }
  }
  // ricochet: a hard tick, then the classic falling whine with a fast wobble
  function ricochet() {
    if (!ctx) return; const t = now();
    let g = gainAD(t, 0.9, 0.0005, 0.04); noise(t, 0.06).connect(filt('highpass', 2500)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    const o = osc('sine', 3300, t + 0.01, t + 0.6); o.frequency.exponentialRampToValueAtTime(1150, t + 0.55);
    const lfo = osc('sine', 36, t, t + 0.6), lg = ctx.createGain(); lg.gain.value = 110; lfo.connect(lg).connect(o.frequency);
    g = gainAD(t + 0.01, 0.2, 0.004, 0.5); o.connect(g).connect(A.sfx); g.connect(A.verbIn);
  }
  function impactThud() {
    if (!ctx) return; const t = now();
    let g = gainAD(t, 1.0, 0.0005, 0.06); noise(t, 0.1).connect(filt('bandpass', 1800, 0.9)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    g = gainAD(t, 1.0, 0.002, 0.28); noise(t, 0.35).connect(filt('lowpass', 380)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    const o = osc('sine', 110, t, t + 0.3); o.frequency.exponentialRampToValueAtTime(45, t + 0.2); g = gainAD(t, 0.45, 0.002, 0.22); o.connect(g).connect(A.sfx);
    for (let i = 0; i < 9; i++) { // debris patter
      const tt = t + 0.05 + Math.pow(Math.random(), 1.6) * 0.7; g = gainAD(tt, rnd(0.03, 0.12), 0.0005, rnd(0.01, 0.03));
      noise(tt, 0.05).connect(filt('bandpass', rnd(2500, 6000), 3)).connect(g).connect(A.sfx);
    }
    if (Math.random() < 0.5) {
      const f0 = rnd(2600, 3600), r = osc('sine', f0, t + 0.02, t + 0.6); r.frequency.exponentialRampToValueAtTime(f0 * 0.42, t + 0.55);
      g = gainAD(t + 0.02, 0.09, 0.005, 0.5); r.connect(g).connect(panner(rnd(-0.7, 0.7))).connect(A.sfx); g.connect(A.verbIn);
    }
  }
  // ragdoll body / hat landing (strength 0..1)
  function bodyThud(strength = 1) {
    if (!ctx) return; const t = now(), s = Math.max(0.1, Math.min(1, strength));
    let g = gainAD(t, 0.45 * s, 0.002, 0.12 + 0.1 * s); noise(t, 0.3).connect(filt('lowpass', 500 + 400 * s)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    const o = osc('sine', 90 + 30 * s, t, t + 0.25); o.frequency.exponentialRampToValueAtTime(48, t + 0.15); g = gainAD(t, 0.5 * s, 0.002, 0.16); o.connect(g).connect(A.sfx);
  }
  function hatLand() { // cartoon: soft pat then a little two-note chip "plop"
    if (!ctx) return; const t = now();
    const g = gainAD(t, 0.2, 0.002, 0.06); noise(t, 0.1).connect(filt('bandpass', 900, 1.5)).connect(g).connect(A.sfx);
    chip(t + 0.03, mtof(79), 0.06, 'triangle', 0.1, { sustain: 0.8 }); chip(t + 0.09, mtof(74), 0.1, 'triangle', 0.09, { sustain: 0.7 });
  }
  function heartbeat(rate = 1) {
    if (!ctx) return; const t = now();
    [[0, 0.5, 62], [0.17, 0.32, 55]].forEach(([d, v, f]) => {
      const o = osc('sine', f, t + d, t + d + 0.25); o.frequency.exponentialRampToValueAtTime(36, t + d + 0.14);
      let g = gainAD(t + d, v * rate, 0.006, 0.16); o.connect(g).connect(A.sfx);
      g = gainAD(t + d, v * rate * 0.35, 0.004, 0.06); noise(t + d, 0.1).connect(filt('lowpass', 160)).connect(g).connect(A.sfx);
    });
    // hold-breath focus: duck the ambience while the heart is audible
    if (amb) { amb.bus.gain.cancelScheduledValues(t); amb.bus.gain.setTargetAtTime(0.35, t, 0.15); amb.bus.gain.setTargetAtTime(1, t + 0.9, 0.6); }
  }
  function staticBurst(dur = 0.25) {
    if (!ctx) return; const t = now();
    let g = gainAD(t, 0.22, 0.002, dur, dur * 0.4); noise(t, dur + 0.1).connect(filt('bandpass', 2600, 0.5)).connect(g).connect(A.ui);
    for (let i = 0; i < 5; i++) { const tt = t + Math.random() * dur; g = gainAD(tt, rnd(0.05, 0.12), 0.0005, 0.008); noise(tt, 0.03).connect(filt('highpass', 1500)).connect(g).connect(A.ui); }
    chip(t, 3520, FR * 2, 'p12', 0.025, { sustain: 1, slide: 0.5 });
  }

  // ---- bullet flight soundscape (slow motion) -------------------------------------------
  function flightStart() {
    if (!ctx || flight) return; const t = now();
    // the report tail sinks into slow motion: darker and quieter
    A.reportLP.frequency.cancelScheduledValues(t); A.reportLP.frequency.setTargetAtTime(420, t, 0.08);
    A.report.gain.cancelScheduledValues(t); A.report.gain.setTargetAtTime(0.5, t, 0.1);
    A.verbLP.frequency.cancelScheduledValues(t); A.verbLP.frequency.setTargetAtTime(700, t, 0.1);
    if (amb) { amb.bus.gain.cancelScheduledValues(t); amb.bus.gain.setTargetAtTime(0.25, t, 0.2); }
    const bus = ctx.createGain(); bus.gain.setValueAtTime(0.0001, t); bus.gain.exponentialRampToValueAtTime(0.6, t + 0.3); bus.connect(A.sfx);
    // wind roar (two decorrelated noise bands, wide stereo)
    const roarL = noise(t), roarR = noise(t, 0, null, 0.97);
    const bpL = filt('bandpass', 600, 0.7), bpR = filt('bandpass', 640, 0.7), rg = ctx.createGain(); rg.gain.value = 0.1;
    const pL = panner(-0.6), pR = panner(0.6);
    roarL.connect(bpL).connect(pL).connect(rg); roarR.connect(bpR).connect(pR).connect(rg); rg.connect(bus);
    // pressure rumble
    const rum = noise(t, 0, A.brown), rumg = ctx.createGain(); rumg.gain.value = 0.1; rum.connect(filt('lowpass', 140)).connect(rumg).connect(bus);
    // whine: two detuned triangles through a resonant band
    const w1 = osc('triangle', 420, t), w2 = osc('triangle', 423, t), wbp = filt('bandpass', 420, 2), wg = ctx.createGain(); wg.gain.value = 0.0001;
    w1.connect(wbp); w2.connect(wbp); wbp.connect(wg).connect(bus);
    // time-dilation drone: low fifth with a slow pulse
    const d1 = osc('sine', 41.2, t), d2 = osc('sine', 61.7, t), dg = ctx.createGain(); dg.gain.value = 0.11;
    const lfo = osc('sine', 0.7, t), lg = ctx.createGain(); lg.gain.value = 0.045; lfo.connect(lg).connect(dg.gain);
    d1.connect(dg); d2.connect(dg); dg.connect(bus);
    flight = { t0: t, bus, srcs: [roarL, roarR, rum, w1, w2, d1, d2, lfo], bpL, bpR, rg, wbp, wg, w1, w2, d1, d2, dg, near: [0, 0, 0, 0], ts: 0.2, lastWhoosh: -1 };
  }
  const fF = { x: 0, y: 0, z: 0 }, fR = { x: 0, y: 0, z: 0 }, fU = { x: 0, y: 0, z: 0 };
  let rayO = null, rayD = null;
  function sideClearance(k, sx, sy, sz) {
    rayD.set(sx, sy, sz);
    return City.raycast(rayO, rayD, 16) ? City.hit.t : 99;
  }
  function flightUpdate(speedFrac, timeScale, near) {
    if (!flight) return; const t = now(), F = flight;
    const s = Math.max(0, Math.min(1.2, speedFrac)), ts = Math.max(0.02, Math.min(1, timeScale)), nr = Math.max(0, Math.min(1, near));
    F.ts = ts;
    const fc = 260 + 1500 * s * (0.35 + ts);
    F.bpL.frequency.setTargetAtTime(fc, t, 0.05); F.bpR.frequency.setTargetAtTime(fc * 1.07, t, 0.05);
    F.rg.gain.setTargetAtTime(0.05 + 0.11 * s + 0.16 * nr, t, 0.06);
    const wf = 170 + 520 * s * (0.3 + ts);
    F.w1.frequency.setTargetAtTime(wf, t, 0.08); F.w2.frequency.setTargetAtTime(wf * 1.008, t, 0.08); F.wbp.frequency.setTargetAtTime(wf, t, 0.08);
    F.wg.gain.setTargetAtTime(0.012 + 0.025 * s, t, 0.1);
    F.d1.frequency.setTargetAtTime(41.2 * (1 + 0.5 * nr), t, 0.2); F.d2.frequency.setTargetAtTime(61.7 * (1 + 0.5 * nr), t, 0.2);
    // doppler swell when the round threads past structures (side / under / over)
    if (Sfx.autoWhoosh && typeof Bullet !== 'undefined' && Bullet.S && Bullet.S.active && typeof City !== 'undefined') { // off: 09_game's near-miss check calls whoosh()
      if (!rayO) { rayO = new THREE.Vector3(); rayD = new THREE.Vector3(); }
      const v = Bullet.S.v, l = v.length() || 1; fF.x = v.x / l; fF.y = v.y / l; fF.z = v.z / l;
      let rx = -fF.z, rz = fF.x; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
      fR.x = rx; fR.y = 0; fR.z = rz; fU.x = -rz * fF.y; fU.y = rz * fF.x - rx * fF.z; fU.z = rx * fF.y;
      rayO.copy(Bullet.S.p);
      const c = [sideClearance(0, fR.x, 0, fR.z), sideClearance(1, -fR.x, 0, -fR.z), sideClearance(2, fU.x, fU.y, fU.z), sideClearance(3, -fU.x, -fU.y, -fU.z)];
      for (let k = 0; k < 4; k++) {
        const thr = 9;
        if (c[k] < thr && !F.near[k] && t - F.lastWhoosh > 0.12) { F.near[k] = 1; F.lastWhoosh = t; whoosh(1 - c[k] / thr, k === 0 ? 0.8 : k === 1 ? -0.8 : 0); }
        else if (c[k] > thr * 1.4) F.near[k] = 0;
      }
    }
  }
  // doppler swell: noise band sliding down + a low thrum (intensity 0..1, pan -1..1)
  function whoosh(intensity = 1, pan = 0) {
    if (!ctx) return; const t = now(), k = Math.max(0.15, Math.min(1, intensity)), slow = flight ? 1 + 0.6 * (1 - flight.ts) : 1;
    const dur = 0.55 * slow, bp = filt('bandpass', 2400, 1.1);
    bp.frequency.setValueAtTime(2600, t); bp.frequency.exponentialRampToValueAtTime(1500, t + dur * 0.3); bp.frequency.exponentialRampToValueAtTime(320, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5 * k, t + dur * 0.28); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = panner(pan); noise(t, dur + 0.05).connect(bp).connect(g).connect(p).connect(A.sfx); g.connect(A.verbIn);
    const o = osc('sine', 140, t, t + dur); o.frequency.exponentialRampToValueAtTime(55, t + dur);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.2 * k, t + dur * 0.3); og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(og).connect(A.sfx);
  }
  // ---- the slow-down: "eeeooowwmmm" -----------------------------------------------------
  // One falling voice over ~0.85 s that holds high for a moment, drops fast, then settles into a low hum:
  // a buzzy tone through a closing low-pass (the vowel goes ee -> oo -> mm), a rush of air sliding down with
  // it, and a sub "womp" swelling at the bottom. The world's ambience drops in pitch and dulls on the same curve.
  function slowDive(ts = 0.4) {
    if (!ctx) return;
    try {
      const t = now() + 0.005, T = 1.1, N = 110, fHi = 1500, fLo = 62;
      const fv = new Float32Array(N), fv2 = new Float32Array(N), fl = new Float32Array(N), fn = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const tt = (i / (N - 1)) * T, p = Math.pow(sstep(0.28, 0.9, tt), 0.8);
        fv[i] = fHi * Math.pow(fLo / fHi, p); fv2[i] = fv[i] * 0.502;
        fl[i] = Math.min(9000, fv[i] * 3.2 + 180); fn[i] = 3400 * Math.pow(240 / 3400, p);
      }
      const end = t + T + 0.6;
      const o1 = osc('sawtooth', fHi, t - 0.004, end), o2 = osc('p25', fHi * 0.502, t - 0.004, end);
      o1.frequency.setValueCurveAtTime(fv, t, T); o2.frequency.setValueCurveAtTime(fv2, t, T);
      const lp = filt('lowpass', fl[0], 4); lp.frequency.setValueCurveAtTime(fl, t, T);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.setValueAtTime(0.14, t + 0.4); g.gain.exponentialRampToValueAtTime(0.08, t + T * 0.85); g.gain.exponentialRampToValueAtTime(0.0001, t + T + 0.5);
      o1.connect(lp); o2.connect(lp); lp.connect(g).connect(A.sfx);
      // air rush
      const nb = filt('bandpass', fn[0], 1.3); nb.frequency.setValueCurveAtTime(fn, t, T);
      const ng = ctx.createGain(); ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(0.42, t + 0.03);
      ng.gain.setValueAtTime(0.42, t + 0.3); ng.gain.exponentialRampToValueAtTime(0.0001, t + T + 0.25);
      noise(t, T + 0.35).connect(nb).connect(ng).connect(A.sfx);
      // womp
      const sb = osc('sine', 110, t + 0.38, end + 0.3); sb.frequency.setValueAtTime(110, t + 0.4); sb.frequency.exponentialRampToValueAtTime(36, t + T + 0.35);
      const sg = ctx.createGain(); sg.gain.setValueAtTime(0.0001, t + 0.38); sg.gain.exponentialRampToValueAtTime(0.38, t + 0.75); sg.gain.exponentialRampToValueAtTime(0.0001, t + T + 0.75);
      sb.connect(sg).connect(A.sfx);
      slowWorld(ts, t + 0.28);
    } catch (e) { /* never let a sound break the game */ }
  }
  // the ambience bus follows game time: lower pitch (noise beds play slower, hum drops) and a closing low-pass
  function slowWorld(ts, t = now()) {
    if (!amb || !A) return;
    const rate = Math.max(0.4, Math.min(0.7, 0.3 + 0.55 * ts)), tc = 0.2;
    amb.srcs.forEach((src, i) => { const p = src.playbackRate; p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.setTargetAtTime(amb.rates[i] * rate, t + 0.05, tc); });
    for (const [o, f] of amb.oscs) { const p = o.frequency; p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.setTargetAtTime(f * rate, t + 0.05, tc); }
    const lp = A.ambLP.frequency; lp.cancelScheduledValues(t); lp.setValueAtTime(lp.value, t); lp.setTargetAtTime(650, t + 0.05, tc);
  }
  function worldResume(delay = 0.6, tc = 0.8) {
    if (!amb || !A || !ctx) return; const t = now();
    amb.srcs.forEach((src, i) => { const p = src.playbackRate; p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.setTargetAtTime(amb.rates[i], t + delay, tc); });
    for (const [o, f] of amb.oscs) { const p = o.frequency; p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.setTargetAtTime(f, t + delay, tc); }
    const lp = A.ambLP.frequency; lp.cancelScheduledValues(t); lp.setValueAtTime(lp.value, t); lp.setTargetAtTime(20000, t + delay, tc * 1.5);
  }
  function flightStop() {
    worldResume(0.6, 0.8);
    if (!flight) return; const t = now(), F = flight; flight = null;
    F.bus.gain.cancelScheduledValues(t); F.bus.gain.setTargetAtTime(0.0001, t, 0.06);
    F.srcs.forEach((s) => { try { s.stop(t + 0.6); } catch (e) { /* already stopped */ } });
    A.reportLP.frequency.cancelScheduledValues(t); A.reportLP.frequency.setTargetAtTime(18000, t, 0.05);
    A.report.gain.cancelScheduledValues(t); A.report.gain.setTargetAtTime(1, t, 0.05);
    A.verbLP.frequency.cancelScheduledValues(t); A.verbLP.frequency.setTargetAtTime(9000, t, 0.05);
    if (amb) { amb.bus.gain.cancelScheduledValues(t); amb.bus.gain.setTargetAtTime(1, t + 0.4, 0.8); }
  }

  // ---- ambience: wind gusts, distant traffic rumble, mains hum, far siren ----------------
  function startAmbience() {
    const t = now(), bus = ctx.createGain(); bus.gain.value = 1; bus.connect(A.amb);
    const wl = noise(t), wr = noise(t, 0, null, 0.93), lpL = filt('lowpass', 420, 0.9), lpR = filt('lowpass', 380, 0.9), wg = ctx.createGain(); wg.gain.value = 0.03;
    wl.connect(lpL).connect(panner(-0.5)).connect(wg); wr.connect(lpR).connect(panner(0.5)).connect(wg); wg.connect(bus);
    const gust = osc('sine', 0.09, t), gg = ctx.createGain(); gg.gain.value = 0.015; gust.connect(gg).connect(wg.gain);
    const gust2 = osc('sine', 0.053, t), gf = ctx.createGain(); gf.gain.value = 160; gust2.connect(gf); gf.connect(lpL.frequency); gf.connect(lpR.frequency);
    const rum = noise(t, 0, A.brown), rg = ctx.createGain(); rg.gain.value = 0.03; rum.connect(filt('lowpass', 150)).connect(rg).connect(bus);
    const hum = osc('sine', 60, t), hum2 = osc('sine', 120, t), hg = ctx.createGain(); hg.gain.value = 0.004; hum.connect(hg); hum2.connect(hg); hg.connect(bus);
    amb = { bus, wg, lpL, lpR, srcs: [wl, wr, rum], rates: [1, 0.93, 1], oscs: [[hum, 60], [hum2, 120]] };
    if (!sirenTimer && ctx instanceof (window.AudioContext || window.webkitAudioContext)) {
      const loop = () => { sirenTimer = setTimeout(loop, rnd(28000, 65000)); if (ctx && ctx.state === 'running' && !muted && !flight) siren(); };
      sirenTimer = setTimeout(loop, rnd(9000, 20000));
    }
  }
  // far-off siren: wailing sine/triangle pair, heavily filtered, swims in the city reverb
  function siren(dur = 7) {
    if (!ctx) return; const t = now(), base = rnd(700, 820), p = panner(rnd(-0.8, 0.8));
    const o1 = osc('triangle', base, t, t + dur), o2 = osc('sine', base * 2.01, t, t + dur);
    const lfo = osc('sine', 1 / 3.4, t, t + dur), lg = ctx.createGain(); lg.gain.value = base * 0.42; lfo.connect(lg); lg.connect(o1.frequency);
    const lg2 = ctx.createGain(); lg2.gain.value = base * 0.84; lfo.connect(lg2); lg2.connect(o2.frequency);
    o1.frequency.linearRampToValueAtTime(base * 0.94, t + dur); // drifting away
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.03, t + dur * 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o1.connect(g); o2.connect(g2).connect(g); g.connect(filt('lowpass', 1500)).connect(p).connect(A.amb); g.connect(A.verbIn);
  }
  // ---- fire mission (mortar) ----------------------------------------------------------------
  // loading: the fins clink on the muzzle, the bomb slides down, seats with a hollow thunk, the tube rings
  function mortarLoad() {
    if (!ctx) return; const t = now();
    for (const [f, v, d] of [[2380, 0.07, 0.25], [3710, 0.045, 0.18], [5230, 0.03, 0.12]]) { const o = osc('sine', f, t, t + d + 0.05), g = gainAD(t, v, 0.001, d); o.connect(g).connect(A.sfx); }
    const nb = filt('bandpass', 2200, 2); nb.frequency.setValueAtTime(2200, t + 0.03); nb.frequency.exponentialRampToValueAtTime(500, t + 0.3);
    let g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t + 0.03); g.gain.exponentialRampToValueAtTime(0.12, t + 0.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    noise(t + 0.03, 0.32).connect(nb).connect(g).connect(A.sfx);
    const tt = t + 0.32;
    const o = osc('sine', 150, tt, tt + 0.5); o.frequency.exponentialRampToValueAtTime(70, tt + 0.25);
    g = gainAD(tt, 0.85, 0.002, 0.3); o.connect(g).connect(A.sfx);
    g = gainAD(tt, 0.5, 0.001, 0.08); noise(tt, 0.12).connect(filt('lowpass', 900)).connect(g).connect(A.sfx);
    for (const [f, v, d] of [[330, 0.12, 0.9], [612, 0.06, 0.6], [1180, 0.035, 0.4]]) { const r = osc('sine', f, tt, tt + d + 0.1), rg = gainAD(tt, v, 0.004, d); r.connect(rg).connect(A.sfx); rg.connect(A.verbIn); }
  }
  // the launch: a deep, hollow thoomp out of the tube
  function mortarFire() {
    if (!ctx) return; const t = now();
    const o = osc('sine', 85, t, t + 1.0); o.frequency.exponentialRampToValueAtTime(32, t + 0.7);
    let g = gainAD(t, 1.0, 0.003, 0.7); o.connect(g).connect(A.sfx);
    g = gainAD(t, 0.9, 0.002, 0.45); noise(t, 0.5).connect(filt('bandpass', 260, 3)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    g = gainAD(t, 0.6, 0.001, 0.12); noise(t, 0.15).connect(filt('lowpass', 1500)).connect(g).connect(A.sfx);
    const r = osc('sine', 300, t, t + 0.9), rg = gainAD(t, 0.08, 0.004, 0.7); r.connect(rg).connect(A.sfx);
  }
  // the nose popping open at the top of the arc
  function mortarSplit() {
    if (!ctx) return; const t = now();
    let g = gainAD(t, 0.5, 0.0005, 0.06); noise(t, 0.1).connect(filt('highpass', 1200)).connect(g).connect(A.sfx); g.connect(A.verbIn);
    g = gainAD(t, 0.4, 0.002, 0.15); const o = osc('sine', 220, t, t + 0.25); o.frequency.exponentialRampToValueAtTime(90, t + 0.15); o.connect(g).connect(A.sfx);
  }
  // falling whistle of the cones coming down
  function whistle(dur = 3) {
    if (!ctx) return; const t = now();
    const o = osc('sine', 2600, t, t + dur + 0.05); o.frequency.exponentialRampToValueAtTime(900, t + dur);
    const lfo = osc('sine', 5.5, t, t + dur), lg = ctx.createGain(); lg.gain.value = 18; lfo.connect(lg).connect(o.frequency);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + dur * 0.85); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.04);
    o.connect(g).connect(A.sfx); g.connect(A.verbIn);
  }
  function windLevel(v) { if (!amb) return; const t = now(); amb.wg.gain.setTargetAtTime(0.022 + 0.004 * v, t, 0.5); amb.lpL.frequency.setTargetAtTime(300 + 30 * v, t, 0.5); amb.lpR.frequency.setTargetAtTime(280 + 30 * v, t, 0.5); }
  function toggleMute() { muted = !muted; Store.set('muted', muted); if (A) A.master.gain.setTargetAtTime(muted ? 0 : MASTER, now(), 0.02); return muted; }

  // ---- offline rendering (test probe) --------------------------------------------------------
  // events: [{ t, fn, args }] run at render time via OfflineAudioContext.suspend
  async function renderOffline(fn, args = [], seconds = 2, events = [], sr = 48000) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oc = new OAC(2, Math.ceil(sr * seconds), sr);
    const saved = [ctx, A, flight, amb]; const api = Sfx;
    ctx = oc; A = makeGraph(oc); flight = null; amb = null;
    try {
      if (fn === 'ambience') startAmbience(); else if (fn) api[fn](...args);
      const groups = new Map();
      for (const ev of events) { const k = Math.round(ev.t * sr / 128) * 128 / sr; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(ev); }
      for (const [k, evs] of groups) oc.suspend(k).then(() => { for (const ev of evs) api[ev.fn](...(ev.args || [])); oc.resume(); });
      const buf = await oc.startRendering();
      return [buf.getChannelData(0), buf.getChannelData(1)];
    } finally { [ctx, A, flight, amb] = saved; }
  }

  return {
    init, shot, crack, blip, arp, coin, tick, lock, deny, hit, miss, impactThud, ricochet, glass, boom, bodyThud, hatLand, heartbeat, staticBurst,
    stageStart, gameOver, bonus, whoosh, siren, flightStart, flightUpdate, flightStop, windLevel, toggleMute, renderOffline, slowDive, slowWorld, worldResume,
    mortarLoad, mortarFire, mortarSplit, whistle,
    get muted() { return muted; }, get ctx() { return ctx; },
  };
})();
