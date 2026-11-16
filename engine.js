'use strict';
// Ambient machine — audio engine.
// 8 granular/loop slots → per-slot filter, volume, pan, sends → stereo delay + convolution reverb
// → mix bus → (resample looper) → master → soft limiter → speakers.
(() => {
  const AM = window.AM = window.AM || {};
  const LOOKAHEAD = 0.15;          // seconds of grains scheduled ahead of the audio clock
  const TICK_MS = 25;
  const rnd = Math.random;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const wrap01 = v => v - Math.floor(v);

  /* ---------------------------------------------------------------- specs */
  const fmt = {
    pct: v => Math.round(v * 100) + '%',
    ms: v => (v < 100 ? v.toFixed(1) : Math.round(v)) + ' ms',
    s: v => v.toFixed(1) + ' s',
    hz: v => v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz',
    lfo: v => (v < 1 ? v.toFixed(2) : v.toFixed(1)) + ' Hz',
    st: v => (v > 0 ? '+' : '') + Math.round(v) + ' st',
    db: v => v <= 0.001 ? '−∞' : (20 * Math.log10(v * v)).toFixed(1) + ' dB',
    pan: v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100),
  };
  const P = (label, min, max, def, o = {}) => ({ type: 'num', label, min, max, def,
    curve: o.curve || 'lin', step: o.step || 0, fmt: o.fmt || fmt.pct, bipolar: !!o.bipolar });
  const S = (label, options, def) => ({ type: 'select', label, options, def });
  const B = (label, def) => ({ type: 'bool', label, def });

  const DIVS = { '1/16': 0.25, '1/8t': 1 / 3, '1/8': 0.5, '1/8d': 0.75, '1/4t': 2 / 3,
    '1/4': 1, '1/4d': 1.5, '1/2': 2, '1/2d': 3, '1/1': 4 };

  AM.SPEC = {
    slot: {
      mode: S('mode', ['cloud', 'loop'], 'cloud'),
      size: P('size', 10, 2000, 240, { curve: 'log', fmt: fmt.ms }),
      density: P('density', 0.5, 60, 8, { curve: 'log', fmt: v => v.toFixed(v < 10 ? 1 : 0) + '/s' }),
      position: P('position', 0, 1, 0.2),
      scan: P('scan', -0.25, 0.25, 0, { bipolar: true, fmt: v => (v * 100).toFixed(1) + '%/s' }),
      spray: P('spray', 0, 1, 0.1),
      pitch: P('pitch', -24, 24, 0, { step: 1, bipolar: true, fmt: fmt.st }),
      spread: P('spread', 0, 24, 0, { step: 1, fmt: v => '±' + Math.round(v) + ' st' }),
      scale: S('scale', ['free', 'octaves', 'fifths', 'penta'], 'free'),
      reverse: P('reverse', 0, 1, 0.2),
      shape: P('shape', 0, 1, 0.5, { fmt: v => v < 0.3 ? 'pluck' : v < 0.7 ? 'bell' : 'swell' }),
      width: P('width', 0, 1, 0.6),
      cutoff: P('tone', 200, 18000, 14000, { curve: 'log', fmt: fmt.hz }),
      beats: S('every', ['1', '2', '4', '8', '16'], '4'),
      volume: P('volume', 0, 1, 0.75, { fmt: fmt.db }),
      pan: P('pan', -1, 1, 0, { bipolar: true, fmt: fmt.pan }),
      sendDelay: P('→ delay', 0, 1, 0.3),
      sendReverb: P('→ reverb', 0, 1, 0.4),
      lfoTarget: S('lfo →', ['off', 'position', 'size', 'density', 'pitch', 'spray', 'cutoff', 'pan', 'volume'], 'off'),
      lfoShape: S('wave', ['sine', 'triangle', 'walk', 's&h'], 'sine'),
      lfoRate: P('rate', 0.01, 4, 0.1, { curve: 'log', fmt: fmt.lfo }),
      lfoDepth: P('depth', 0, 1, 0),
    },
    delay: {
      time: P('time', 1, 2000, 450, { curve: 'log', fmt: fmt.ms }),
      sync: B('sync', true),
      div: S('division', Object.keys(DIVS), '1/4d'),
      feedback: P('feedback', 0, 0.98, 0.55),
      lowcut: P('low cut', 20, 2000, 160, { curve: 'log', fmt: fmt.hz }),
      highcut: P('high cut', 500, 18000, 4500, { curve: 'log', fmt: fmt.hz }),
      pingpong: P('ping-pong', 0, 1, 0.8),
      width: P('width', 0, 1, 0.9),
      offset: P('offset R', 0, 0.5, 0),
      wowRate: P('wow rate', 0.05, 8, 0.35, { curve: 'log', fmt: fmt.lfo }),
      wowDepth: P('wow depth', 0, 20, 1.5, { fmt: v => v.toFixed(1) + ' ms' }),
      toReverb: P('→ reverb', 0, 1, 0.25),
      mix: P('mix', 0, 1, 0.7),
      freeze: B('freeze', false),
    },
    reverb: {
      size: P('size', 0.5, 12, 5, { curve: 'log', fmt: fmt.s }),
      damping: P('damping', 0, 1, 0.5),
      predelay: P('pre-delay', 0, 200, 20, { fmt: fmt.ms }),
      mix: P('mix', 0, 1, 0.8),
    },
    master: {
      volume: P('volume', 0, 1, 0.8, { fmt: fmt.db }),
      bpm: P('tempo', 40, 160, 72, { step: 1, fmt: v => Math.round(v) + ' bpm' }),
      quant: S('launch', ['off', 'beat', 'bar', '2 bars'], 'bar'),
      limiter: B('limiter', true),
      ceiling: P('ceiling', -12, 0, -1, { step: 0.5, fmt: v => v.toFixed(1) + ' dB' }),
      morph: P('morph', 0, 10, 2, { fmt: fmt.s }),
    },
    drum: {                                          // one drum-machine track
      volume: P('volume', 0, 1, 0.8, { fmt: fmt.db }),
      pitch: P('pitch', -12, 12, 0, { step: 1, bipolar: true, fmt: fmt.st }),
      decay: P('decay', 30, 2000, 600, { curve: 'log', fmt: fmt.ms }),
      pan: P('pan', -1, 1, 0, { bipolar: true, fmt: fmt.pan }),
      sendDelay: P('→ delay', 0, 1, 0.1),
      sendReverb: P('→ reverb', 0, 1, 0.15),
      shuffle: P('shuffle', 0, 1, 1),                // how much of the global shuffle this track follows
      mute: B('mute', false),
      solo: B('solo', false),
    },
    drums: {
      pattern: S('pattern', ['A', 'B', 'C', 'D'], 'A'),
      // MPC-style shuffle: 50% = straight, 66.7% = triplet feel, 75% = hardest. Applies to every 2nd 16th or 8th.
      shuffle: P('shuffle', 50, 75, 56, { step: 0.5, fmt: v => v.toFixed(v % 1 ? 1 : 0) + '%' + (Math.abs(v - 66.7) < 0.6 ? ' (trip)' : v <= 50 ? ' (str)' : '') }),
      shuffleGrid: S('grid', ['1/16', '1/8'], '1/16'),
      level: P('level', 0, 1, 0.8, { fmt: fmt.db }),
      humanize: P('humanise', 0, 1, 0.15),
      seconds: P('length', 0.5, 5, 1, { fmt: fmt.s }),
      influence: P('prompt weight', 0, 1, 0.6),
    },
    looper: {
      bars: S('length', ['1', '2', '4', '8'], '2'),
      level: P('level', 0, 1, 0.8, { fmt: fmt.db }),
      keep: P('overdub keep', 0, 1, 0.85),
    },
  };

  AM.toNorm = (spec, v) => spec.curve === 'log'
    ? Math.log(v / spec.min) / Math.log(spec.max / spec.min)
    : (v - spec.min) / (spec.max - spec.min);
  AM.fromNorm = (spec, n) => {
    n = clamp(n, 0, 1);
    let v = spec.curve === 'log' ? spec.min * Math.pow(spec.max / spec.min, n) : spec.min + (spec.max - spec.min) * n;
    if (spec.step) v = Math.round(v / spec.step) * spec.step;
    return clamp(v, spec.min, spec.max);
  };
  AM.defaults = section => Object.fromEntries(Object.entries(AM.SPEC[section]).map(([k, s]) => [k, s.def]));
  AM.util = { clamp, wrap01, fmt, DIVS };

  const SCALES = { octaves: [0], fifths: [0, 7], penta: [0, 2, 4, 7, 9] };
  function spreadSemis(p) {
    if (p.spread <= 0) return 0;
    if (p.scale === 'free') return (rnd() * 2 - 1) * p.spread;
    const notes = [];
    for (let o = -2; o <= 2; o++) for (const s of SCALES[p.scale]) {
      const n = o * 12 + s;
      if (Math.abs(n) <= p.spread) notes.push(n);
    }
    return notes[Math.floor(rnd() * notes.length)] || 0;
  }

  // Grain envelope: shape 0 = pluck (fast attack), 0.5 = bell (symmetric), 1 = swell (slow attack).
  function envCurve(shape, amp) {
    const N = 33, a = 0.03 + shape * 0.94, c = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      const y = x < a ? Math.sin((Math.PI / 2) * (x / a)) : Math.cos((Math.PI / 2) * ((x - a) / (1 - a)));
      c[i] = amp * y * y;
    }
    c[N - 1] = 0;
    return c;
  }

  const gain = (ctx, v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const ramp = (param, v, ctx, tc = 0.03) => param.setTargetAtTime(v, ctx.currentTime, tc);

  /* ---------------------------------------------------------------- slot */
  class Slot {
    constructor(engine, index) {
      const ctx = this.ctx = engine.ctx;
      this.engine = engine; this.index = index;
      this.gate = gain(ctx, 0);                     // grains land here; fades on launch/stop
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = 0.5;
      this.vol = gain(ctx, 0.5);
      this.panner = ctx.createStereoPanner();
      this.sendD = gain(ctx, 0); this.sendR = gain(ctx, 0);
      this.meter = ctx.createAnalyser(); this.meter.fftSize = 256;
      this.gate.connect(this.filter).connect(this.vol).connect(this.panner);
      this.panner.connect(engine.mix);
      this.panner.connect(this.sendD).connect(engine.delay.input);
      this.panner.connect(this.sendR).connect(engine.reverb.input);
      this.panner.connect(this.meter);
      this.meterData = new Float32Array(this.meter.fftSize);
      this.state = 'stopped';                       // stopped | pending | playing | stopping
      this.startAt = 0; this.stopAt = 0; this.nextT = 0; this.scanOffset = 0;
      this.lfo = { phase: 0, v: 0, walk: 0, sh: 0, lastCycle: 0 };
      this.grains = [];                             // recent grains for the waveform view
      this.last = {};
    }
    get cfg() { return AM.state.slots[this.index]; }
    get params() { return this.cfg.params; }
    get sound() { return this.engine.sounds.get(this.cfg.sound); }

    // Base value plus this slot's LFO when it targets `key`.
    eff(key) {
      const p = this.params, spec = AM.SPEC.slot[key];
      if (p.lfoTarget !== key || p.lfoDepth <= 0) return p[key];
      return AM.fromNorm(spec, AM.toNorm(spec, p[key]) + this.lfo.v * p.lfoDepth * 0.5);
    }
    modNorm() {                                     // for the UI's modulation marker
      const p = this.params;
      if (p.lfoTarget === 'off' || p.lfoDepth <= 0) return null;
      return { key: p.lfoTarget, norm: AM.toNorm(AM.SPEC.slot[p.lfoTarget], this.eff(p.lfoTarget)) };
    }

    updateLfo(dt) {
      const p = this.params, l = this.lfo;
      l.phase += p.lfoRate * dt;
      switch (p.lfoShape) {
        case 'sine': l.v = Math.sin(2 * Math.PI * l.phase); break;
        case 'triangle': l.v = 4 * Math.abs(wrap01(l.phase + 0.25) - 0.5) - 1; break;
        case 'walk': {
          l.walk += (rnd() * 2 - 1) * Math.sqrt(dt) * p.lfoRate * 4;
          if (l.walk > 1) l.walk = 2 - l.walk; if (l.walk < -1) l.walk = -2 - l.walk;
          l.v += (l.walk - l.v) * Math.min(1, dt * 6); break;
        }
        case 's&h': {
          const cycle = Math.floor(l.phase);
          if (cycle !== l.lastCycle) { l.lastCycle = cycle; l.sh = rnd() * 2 - 1; }
          l.v += (l.sh - l.v) * Math.min(1, dt * 30); break;
        }
      }
    }

    applyParams() {
      const ctx = this.ctx, set = (k, param, v, tc) => {
        if (this.last[k] !== undefined && Math.abs(this.last[k] - v) < 1e-4) return;
        this.last[k] = v; ramp(param, v, ctx, tc);
      };
      const vol = this.eff('volume');
      set('vol', this.vol.gain, vol * vol, 0.04);
      set('pan', this.panner.pan, this.eff('pan'), 0.04);
      set('cut', this.filter.frequency, this.eff('cutoff'), 0.04);
      set('sd', this.sendD.gain, this.params.sendDelay, 0.03);
      set('sr', this.sendR.gain, this.params.sendReverb, 0.03);
    }

    launch() {
      if (!this.sound) return false;
      const e = this.engine;
      if (this.state === 'playing' || this.state === 'pending') return this.stop();
      this.state = 'pending';
      this.startAt = e.nextBoundary();
      return true;
    }
    stop() {
      if (this.state === 'pending') { this.state = 'stopped'; return true; }
      if (this.state !== 'playing') return false;
      this.state = 'stopping';
      this.stopAt = this.engine.nextBoundary();
      const tc = this.params.mode === 'loop' ? 0.05 : 0.25;
      this.gate.gain.setTargetAtTime(0, this.stopAt, tc);
      return true;
    }
    stopNow() {
      this.state = 'stopped';
      this.gate.gain.cancelScheduledValues(this.ctx.currentTime);
      ramp(this.gate.gain, 0, this.ctx, 0.08);
    }

    tick(now, dt) {
      this.updateLfo(dt);
      this.applyParams();
      if (this.state === 'pending' && this.startAt <= now + LOOKAHEAD) {
        this.state = 'playing'; this.nextT = this.startAt; this.scanOffset = 0;
        this.gate.gain.cancelScheduledValues(this.startAt);
        this.gate.gain.setValueAtTime(1, this.startAt);
      }
      if (this.state === 'stopping' && now >= this.stopAt + 0.6) this.state = 'stopped';
      if (this.state === 'playing') this.scanOffset += this.params.scan * dt;
      if (this.state !== 'playing' && this.state !== 'stopping') return;
      const sound = this.sound;
      if (!sound) { this.state = 'stopped'; return; }
      if (this.nextT < now) this.nextT = now + 0.01;  // recovered from a throttled tab
      const loop = this.params.mode === 'loop';
      while (this.nextT < now + LOOKAHEAD) {
        if (this.state === 'stopping' && this.nextT >= this.stopAt) break;
        if (loop) {
          const beats = Number(this.params.beats) * this.engine.beatDur;
          this.grain(this.nextT, sound, true, beats);
          this.nextT += beats;
        } else {
          this.grain(this.nextT, sound, false);
          this.nextT += (1 / this.eff('density')) * (0.7 + rnd() * 0.6);
        }
      }
    }

    grain(t, sound, loop, beatsDur) {
      const ctx = this.ctx, p = this.params, buf = sound.buffer, total = buf.duration;
      const rev = rnd() < p.reverse;
      const rate = Math.pow(2, (this.eff('pitch') + spreadSemis(p)) / 12);
      let pos = wrap01(this.eff('position') + this.scanOffset + (loop ? 0 : (rnd() * 2 - 1) * this.eff('spray') * 0.5));
      let dur, amp;
      if (loop) {
        dur = Math.min((total * (1 - pos)) / rate, beatsDur + 0.5);
        if (dur < 0.05) { pos = 0; dur = Math.min(total / rate, beatsDur + 0.5); }
        amp = 0.8;
      } else {
        dur = Math.min(this.eff('size') / 1000, total / rate);
        amp = 0.75 / Math.sqrt(Math.max(1, this.eff('density') * dur));
      }
      const span = dur * rate;                       // seconds of buffer consumed
      let offset = Math.min(pos * total, Math.max(0, total - span));
      const fwdOffset = offset;
      if (rev) offset = Math.max(0, total - offset - span);
      const src = ctx.createBufferSource();
      src.buffer = rev ? sound.reversed : buf;
      src.playbackRate.value = rate;
      const env = ctx.createGain();
      if (loop) {
        const rel = Math.min(0.3, dur * 0.3);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(amp, t + 0.008);
        env.gain.setValueAtTime(amp, t + dur - rel);
        env.gain.linearRampToValueAtTime(0, t + dur);
      } else {
        env.gain.value = 0;                          // a curve may not overlap other events
        env.gain.setValueCurveAtTime(envCurve(p.shape, amp), t, dur);
      }
      const pan = ctx.createStereoPanner();
      pan.pan.value = (rnd() * 2 - 1) * p.width;
      src.connect(env).connect(pan).connect(this.gate);
      src.start(t, offset, span);
      src.stop(t + dur + 0.02);
      src.onended = () => { src.disconnect(); env.disconnect(); pan.disconnect(); };
      this.grains.push({ pos: fwdOffset / total, len: span / total, t, dur, rev });
      if (this.grains.length > 48) this.grains.shift();
    }

    level() {
      this.meter.getFloatTimeDomainData(this.meterData);
      let s = 0; for (const x of this.meterData) s += x * x;
      return Math.sqrt(s / this.meterData.length);
    }
  }

  /* ---------------------------------------------------------------- delay */
  class Delay {
    constructor(ctx) {
      this.ctx = ctx;
      this.input = gain(ctx, 1);
      const split = ctx.createChannelSplitter(2);
      this.input.connect(split);
      this.lToL = gain(ctx, 1); this.rToR = gain(ctx, 1); this.rToL = gain(ctx, 0);
      split.connect(this.lToL, 0); split.connect(this.rToR, 1); split.connect(this.rToL, 1);
      this.dL = ctx.createDelay(12); this.dR = ctx.createDelay(12);
      this.lToL.connect(this.dL); this.rToL.connect(this.dL); this.rToR.connect(this.dR);
      const shaper = () => {
        const w = ctx.createWaveShaper(), c = new Float32Array(1025);
        for (let i = 0; i < c.length; i++) { const x = (i / 512) - 1; c[i] = Math.tanh(x); }        // unity gain at low level, soft above
        w.curve = c; w.oversample = '2x'; return w;
      };
      const chain = d => {
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.6;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.6;
        const sat = shaper();
        d.connect(hp).connect(lp).connect(sat);
        return { hp, lp, sat };
      };
      this.cL = chain(this.dL); this.cR = chain(this.dR);
      this.fbLL = gain(ctx, 0); this.fbLR = gain(ctx, 0); this.fbRR = gain(ctx, 0); this.fbRL = gain(ctx, 0);
      this.cL.sat.connect(this.fbLL).connect(this.dL); this.cL.sat.connect(this.fbLR).connect(this.dR);
      this.cR.sat.connect(this.fbRR).connect(this.dR); this.cR.sat.connect(this.fbRL).connect(this.dL);
      this.out = gain(ctx, 0.7);
      this.panL = ctx.createStereoPanner(); this.panR = ctx.createStereoPanner();
      this.cL.lp.connect(this.panL).connect(this.out); this.cR.lp.connect(this.panR).connect(this.out);
      this.toReverb = gain(ctx, 0.25); this.out.connect(this.toReverb);
      this.wow = ctx.createOscillator(); this.wow.frequency.value = 0.35;
      this.wowL = gain(ctx, 0); this.wowR = gain(ctx, 0);
      this.wow.connect(this.wowL).connect(this.dL.delayTime);
      this.wow.connect(this.wowR).connect(this.dR.delayTime);
      this.wow.start();
    }
    update(p, beatDur) {
      const ctx = this.ctx;
      const time = p.sync ? DIVS[p.div] * beatDur : p.time / 1000;
      // Freeze snaps both lines to whole samples: fractional (interpolated) delays dull the loop on every pass.
      const snap = t => p.freeze ? Math.round(t * ctx.sampleRate) / ctx.sampleRate : t;
      const tL = snap(clamp(time, 0.003, 11)), tR = snap(clamp(time * (1 + p.offset), 0.003, 11.5));
      for (const [d, t] of [[this.dL, tL], [this.dR, tR]]) {
        if (p.freeze) { d.delayTime.cancelScheduledValues(ctx.currentTime); d.delayTime.setValueAtTime(t, ctx.currentTime); }
        else ramp(d.delayTime, t, ctx, 0.08);       // tape-style glide when the time changes
      }
      const fb = p.freeze ? 1 : p.feedback, pp = p.pingpong;   // tanh in the loop keeps 1.0 from running away
      ramp(this.fbLL.gain, fb * (1 - pp), ctx); ramp(this.fbRR.gain, fb * (1 - pp), ctx);
      ramp(this.fbLR.gain, fb * pp, ctx); ramp(this.fbRL.gain, fb * pp, ctx);
      ramp(this.input.gain, p.freeze ? 0 : 1, ctx, 0.02);
      ramp(this.rToR.gain, 1 - pp, ctx); ramp(this.rToL.gain, pp, ctx);
      for (const c of [this.cL, this.cR]) {         // freeze: all-pass = unity magnitude, so the hold doesn't fade
        const hpType = p.freeze ? 'allpass' : 'highpass', lpType = p.freeze ? 'allpass' : 'lowpass';
        if (c.hp.type !== hpType) c.hp.type = hpType;
        if (c.lp.type !== lpType) c.lp.type = lpType;
        c.sat.oversample = p.freeze ? 'none' : '2x';  // the oversampler's anti-alias filter also leaks level
        ramp(c.hp.frequency, p.freeze ? 20 : p.lowcut, ctx);
        ramp(c.lp.frequency, p.freeze ? 20 : p.highcut, ctx);
      }
      ramp(this.panL.pan, -p.width, ctx); ramp(this.panR.pan, p.width, ctx);
      ramp(this.wow.frequency, p.wowRate, ctx, 0.1);
      const wow = p.freeze ? 0 : p.wowDepth / 1000;
      ramp(this.wowL.gain, wow, ctx, 0.1); ramp(this.wowR.gain, -wow, ctx, 0.1);
      ramp(this.out.gain, p.mix, ctx); ramp(this.toReverb.gain, p.toReverb, ctx);
    }
  }

  /* ---------------------------------------------------------------- reverb */
  class Reverb {
    constructor(ctx) {
      this.ctx = ctx;
      this.input = gain(ctx, 1);
      this.pre = ctx.createDelay(1);
      this.convs = [ctx.createConvolver(), ctx.createConvolver()];
      this.fades = [gain(ctx, 1), gain(ctx, 0)];
      this.out = gain(ctx, 0.8);
      this.input.connect(this.pre);
      this.convs.forEach((c, i) => this.pre.connect(c).connect(this.fades[i]).connect(this.out));
      this.active = 0; this.key = ''; this.timer = 0;
    }
    impulse(size, damping) {
      const ctx = this.ctx, sr = ctx.sampleRate, len = Math.floor(size * sr);
      const buf = ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch); let y = 0;
        for (let i = 0; i < len; i++) {
          const t = i / sr, k = 1 - damping * 0.97 * Math.pow(t / size, 0.5);  // darker as it decays
          y += Math.max(0.02, k) * ((rnd() * 2 - 1) - y);
          d[i] = y * Math.exp(-6.9 * t / size) * Math.min(1, t / 0.004);
        }
      }
      return buf;
    }
    update(p) {
      const ctx = this.ctx;
      ramp(this.pre.delayTime, p.predelay / 1000, ctx);
      ramp(this.out.gain, p.mix, ctx);
      const key = p.size.toFixed(2) + '/' + p.damping.toFixed(2);
      if (key === this.key) return;
      this.key = key;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {               // rebuild the IR, crossfade to it
        const next = 1 - this.active;
        this.convs[next].buffer = this.impulse(p.size, p.damping);
        ramp(this.fades[next].gain, 1, ctx, 0.12); ramp(this.fades[this.active].gain, 0, ctx, 0.12);
        this.active = next;
      }, this.convs[0].buffer ? 160 : 0);
    }
  }

  /* ---------------------------------------------------------------- looper (AudioWorklet) */
  const WORKLET = `
  class AmLooper extends AudioWorkletProcessor {
    constructor() {
      super();
      this.L = new Float32Array(0); this.R = new Float32Array(0);
      this.len = 0; this.pos = 0; this.state = 'empty'; this.at = 0; this.dub = false; this.keep = 0.85; this.tick = 0;
      this.port.onmessage = e => {
        const d = e.data;
        if (d.type === 'record') { this.L = new Float32Array(d.length); this.R = new Float32Array(d.length); this.len = d.length; this.at = d.at; this.state = 'armed'; this.dub = false; }
        else if (d.type === 'play') { if (this.len) { this.at = d.at; this.state = 'cueing'; } }
        else if (d.type === 'stop') { if (this.len) this.state = 'stopped'; }
        else if (d.type === 'clear') { this.len = 0; this.state = 'empty'; this.dub = false; }
        else if (d.type === 'dub') this.dub = d.on;
        else if (d.type === 'keep') this.keep = d.value;
        else if (d.type === 'export') this.port.postMessage({ type: 'data', L: this.L.slice(0, this.len), R: this.R.slice(0, this.len) });
        this.report();
      };
    }
    report() { this.port.postMessage({ type: 'state', state: this.state, dub: this.dub, pos: this.len ? this.pos / this.len : 0 }); }
    process(inputs, outputs) {
      const inp = inputs[0], out = outputs[0], n = out[0].length;
      const iL = inp[0], iR = inp[1] || inp[0];
      for (let i = 0; i < n; i++) {
        const frame = currentFrame + i;
        if ((this.state === 'armed' || this.state === 'cueing') && frame >= this.at) {
          this.state = this.state === 'armed' ? 'recording' : 'playing'; this.pos = 0; this.report();
        }
        let oL = 0, oR = 0;
        if (this.state === 'recording') {
          this.L[this.pos] = iL ? iL[i] : 0; this.R[this.pos] = iR ? iR[i] : 0;
          if (++this.pos >= this.len) { this.pos = 0; this.state = 'playing'; this.report(); }
        } else if (this.state === 'playing') {
          oL = this.L[this.pos]; oR = this.R[this.pos];
          if (this.dub) {
            this.L[this.pos] = oL * this.keep + (iL ? iL[i] : 0);
            this.R[this.pos] = oR * this.keep + (iR ? iR[i] : 0);
          }
          if (++this.pos >= this.len) this.pos = 0;
        }
        out[0][i] = oL; if (out[1]) out[1][i] = oR;
      }
      if (++this.tick % 24 === 0) this.report();
      return true;
    }
  }
  registerProcessor('am-looper', AmLooper);`;

  class Looper {
    constructor(ctx) {
      this.ctx = ctx;
      this.node = new AudioWorkletNode(ctx, 'am-looper', { numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      this.out = gain(ctx, 0.64);
      this.node.connect(this.out);
      this.status = { state: 'empty', dub: false, pos: 0 };
      this.onstate = null; this.waiting = null;
      this.node.port.onmessage = e => {
        const d = e.data;
        if (d.type === 'state') { this.status = d; this.onstate?.(d); }
        if (d.type === 'data' && this.waiting) { this.waiting(d); this.waiting = null; }
      };
    }
    send(msg) { this.node.port.postMessage(msg); }
    record(atTime, seconds) {
      const sr = this.ctx.sampleRate;
      this.send({ type: 'record', at: Math.round(atTime * sr), length: Math.round(seconds * sr) });
    }
    play(atTime) { this.send({ type: 'play', at: Math.round(atTime * this.ctx.sampleRate) }); }
    export() { return new Promise(res => { this.waiting = res; this.send({ type: 'export' }); }); }
  }

  /* ---------------------------------------------------------------- drum machine */
  // 8 tracks x 16 sixteenth-note steps on the engine clock. Step values: 0 off, 1 hit, 2 accent.
  // Shuffle as a time warp inside each pair (2 sixteenths, or 2 eighths = 4 steps): the first half of the
  // pair is stretched to `pct` of its length and the second half squeezed. Returns the offset in steps.
  function shuffleOffset(step, pct, grid) {
    const L = grid === '1/8' ? 4 : 2, p = step % L, r = pct / 100, half = L / 2;
    const warped = p < half ? p * (r * L) / half : r * L + (p - half) * ((1 - r) * L) / half;
    return warped - p;
  }
  AM.shuffleOffset = shuffleOffset;
  class Drums {
    constructor(engine) {
      const ctx = this.ctx = engine.ctx;
      this.engine = engine;
      this.tracks = Array.from({ length: 8 }, () => {
        const vol = gain(ctx, 0.6), pan = ctx.createStereoPanner(), sd = gain(ctx, 0), sr = gain(ctx, 0);
        vol.connect(pan); pan.connect(engine.mix);
        pan.connect(sd).connect(engine.delay.input); pan.connect(sr).connect(engine.reverb.input);
        return { vol, pan, sd, sr, ringing: null };
      });
      this.state = 'stopped';                        // stopped | pending | playing
      this.startAt = 0; this.gridT = 0; this.step = 0; this.active = 0;
      this.marks = [];                               // [{step, t}] for the UI playhead
    }
    get cfg() { return AM.state.drums; }
    apply(i) {
      const p = this.cfg.tracks[i], n = this.tracks[i], ctx = this.ctx;
      ramp(n.vol.gain, p.volume * p.volume, ctx); ramp(n.pan.pan, p.pan, ctx);
      ramp(n.sd.gain, p.sendDelay, ctx); ramp(n.sr.gain, p.sendReverb, ctx);
    }
    applyAll() { for (let i = 0; i < 8; i++) this.apply(i); }
    toggle() {
      if (this.state === 'stopped') { this.state = 'pending'; this.startAt = this.engine.nextBoundary(); }
      else this.stop();
    }
    stop() { this.state = 'stopped'; this.marks = []; for (const t of this.tracks) this.choke(t, this.ctx.currentTime); }
    patternIndex() { return AM.state.drums.pattern.charCodeAt(0) - 65; }
    tick(now) {
      if (this.state === 'pending' && this.startAt <= now + LOOKAHEAD) {
        this.state = 'playing'; this.gridT = this.startAt; this.step = 0; this.active = this.patternIndex();
      }
      if (this.state !== 'playing') return;
      if (this.gridT < now - 0.25) {                 // tab was throttled: re-align to the next step
        const sd = this.engine.beatDur / 4;
        const k = Math.ceil((now - this.gridT) / sd);
        this.gridT += k * sd; this.step += k;
      }
      const d = this.cfg, stepDur = this.engine.beatDur / 4;
      while (this.gridT < now + LOOKAHEAD) {
        const s = this.step % 16;
        if (s === 0) this.active = this.patternIndex(); // pattern changes land on the bar
        const shift = shuffleOffset(s, d.shuffle, d.shuffleGrid) * stepDur;
        const solo = d.tracks.some(tr => tr.solo);
        d.patterns[this.active].forEach((row, i) => {
          const v = row[s], tr = d.tracks[i];
          if (!v || tr.mute || (solo && !tr.solo)) return;
          const jitter = d.humanize * (rnd() - 0.5) * 0.012;
          const t = this.gridT + shift * tr.shuffle;
          this.trigger(i, Math.max(now, t + jitter), (v === 2 ? 1 : 0.62) * (1 - d.humanize * 0.25 * rnd()));
        });
        this.marks.push({ step: s, t: this.gridT + shift });
        if (this.marks.length > 32) this.marks.shift();
        this.gridT += stepDur; this.step++;
      }
    }
    choke(node, t) {
      if (!node.ringing) return;
      const g = node.ringing.gain;
      g.cancelScheduledValues(t); g.setTargetAtTime(0, t, 0.012);
      node.ringing = null;
    }
    trigger(i, t = this.ctx.currentTime, vel = 1) {
      const p = this.cfg.tracks[i], sound = this.engine.sounds.get(p.sound);
      if (!sound) return;
      const ctx = this.ctx, node = this.tracks[i];
      if (i === 3 || i === 4) this.choke(this.tracks[i === 3 ? 4 : 3], t);   // closed hat chokes open hat
      this.choke(node, t);                           // a new hit cuts this track's previous one
      const src = ctx.createBufferSource(), env = ctx.createGain();
      src.buffer = sound.buffer;
      src.playbackRate.value = Math.pow(2, p.pitch / 12);
      const amp = vel * this.cfg.level * this.cfg.level * 1.2, d = p.decay / 1000;
      env.gain.setValueAtTime(amp, t);
      env.gain.setTargetAtTime(0, t + d * 0.35, d * 0.22);
      src.connect(env).connect(node.vol);
      src.start(t, sound.onset || 0);
      src.stop(t + d * 1.6 + 0.05);
      node.ringing = env;
      src.onended = () => { src.disconnect(); env.disconnect(); if (node.ringing === env) node.ringing = null; };
    }
    currentStep(now) {
      let cur = -1;
      for (const m of this.marks) if (m.t <= now) cur = m.step;
      return cur;
    }
  }

  /* ---------------------------------------------------------------- engine */
  class Engine {
    constructor() {
      this.ctx = null; this.sounds = new Map(); this.slots = []; this.listeners = new Set();
      this.clockStart = 0; this.bpm = 72; this.lastTick = 0; this.ready = null;
    }
    init() {
      if (this.ready) return this.ready;
      this.ready = (async () => {
        const ctx = this.ctx = new AudioContext({ latencyHint: 'playback' });
        this.mix = gain(ctx, 1);
        this.master = gain(ctx, 0.64);
        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.002; this.limiter.release.value = 0.15;
        this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.8;
        this.delay = new Delay(ctx); this.reverb = new Reverb(ctx);
        this.delay.out.connect(this.mix); this.delay.toReverb.connect(this.reverb.input);
        this.reverb.out.connect(this.mix);
        this.mix.connect(this.master);
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        try {
          await ctx.audioWorklet.addModule(url);
          this.looper = new Looper(ctx);
          this.mix.connect(this.looper.node);
          this.looper.out.connect(this.master);
        } catch (err) { console.warn('looper unavailable', err); this.looper = null; }
        this.master.connect(this.limiter).connect(this.analyser).connect(ctx.destination);
        for (let i = 0; i < 8; i++) this.slots.push(new Slot(this, i));
        this.drums = new Drums(this);
        this.clockStart = ctx.currentTime + 0.05;
        this.applyAll();
        setInterval(() => this.tick(), TICK_MS);
      })();
      return this.ready;
    }
    async resume() { await this.init(); if (this.ctx.state !== 'running') await this.ctx.resume(); }

    get beatDur() { return 60 / this.bpm; }
    beatPos(t = this.ctx.currentTime) { return (t - this.clockStart) / this.beatDur; }
    nextBoundary(q = AM.state.master.quant) {
      const now = this.ctx.currentTime;
      const unit = { off: 0, beat: 1, bar: 4, '2 bars': 8 }[q];
      if (!unit) return now + 0.03;
      const step = unit * this.beatDur;
      return this.clockStart + Math.ceil((now + 0.03 - this.clockStart) / step) * step;
    }
    setBpm(bpm) {
      if (!this.ctx) { this.bpm = bpm; return; }
      const now = this.ctx.currentTime, pos = this.beatPos(now);
      this.bpm = bpm;
      this.clockStart = now - pos * this.beatDur;   // keep the beat phase continuous
    }

    tick() {
      const now = this.ctx.currentTime, dt = Math.min(0.2, now - (this.lastTick || now));
      this.lastTick = now;
      for (const s of this.slots) s.tick(now, dt);
      this.drums.tick(now);
    }

    applyAll() {
      this.drums?.applyAll();
      this.applySection('delay'); this.applySection('reverb'); this.applySection('master'); this.applySection('looper');
    }
    applySection(section) {
      if (!this.ctx) return;
      const st = AM.state, ctx = this.ctx;
      if (section === 'delay') this.delay.update(st.delay, this.beatDur);
      if (section === 'reverb') this.reverb.update(st.reverb);
      if (section === 'master') {
        const m = st.master;
        if (Math.round(m.bpm) !== this.bpm) { this.setBpm(Math.round(m.bpm)); this.delay.update(st.delay, this.beatDur); }
        ramp(this.master.gain, m.volume * m.volume, ctx);
        this.limiter.threshold.value = m.limiter ? m.ceiling - 3 : 0;
        this.limiter.ratio.value = m.limiter ? 20 : 1;
      }
      if (section === 'looper' && this.looper) {
        ramp(this.looper.out.gain, st.looper.level * st.looper.level, ctx);
        this.looper.send({ type: 'keep', value: st.looper.keep });
      }
    }

    /* sounds */
    async loadUrl(id, url, name, group) {
      await this.init();
      let res;
      for (let attempt = 0; ; attempt++) {           // one retry: a busy local server can drop a burst
        try { res = await fetch(url); break; } catch (err) { if (attempt) throw err; await new Promise(r => setTimeout(r, 400)); }
      }
      if (!res.ok) throw new Error(url + ' ' + res.status);
      return this.addBuffer(id, await this.ctx.decodeAudioData(await res.arrayBuffer()), name, group);
    }
    async loadFile(file) {
      await this.init();
      const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      const id = 'file:' + file.name + ':' + Date.now().toString(36);
      return this.addBuffer(id, buf, file.name.replace(/\.[^.]+$/, ''), 'dropped');
    }
    addBuffer(id, buffer, name, group) {
      let peak = 0;                                 // peak-normalise: the earcons are mastered quietly
      for (let c = 0; c < buffer.numberOfChannels; c++) for (const x of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
      if (peak > 0.001 && peak < 0.89) for (let c = 0; c < buffer.numberOfChannels; c++) {
        const d = buffer.getChannelData(c), k = 0.89 / peak;
        for (let i = 0; i < d.length; i++) d[i] *= k;
      }
      const reversed = this.ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
      for (let c = 0; c < buffer.numberOfChannels; c++) reversed.getChannelData(c).set(buffer.getChannelData(c).slice().reverse());
      // Onset: first sample above 6% of full scale, minus 2 ms. Generated one-shots often start late.
      const ch0 = buffer.getChannelData(0);
      let first = 0; while (first < ch0.length && Math.abs(ch0[first]) < 0.06) first++;
      const onset = first >= ch0.length ? 0 : Math.max(0, first / buffer.sampleRate - 0.002);
      const N = 96, peaks = new Float32Array(N), d = buffer.getChannelData(0), per = Math.floor(d.length / N);
      for (let i = 0; i < N; i++) { let m = 0; for (let j = i * per; j < (i + 1) * per; j++) m = Math.max(m, Math.abs(d[j])); peaks[i] = m; }
      const max = Math.max(...peaks) || 1;
      for (let i = 0; i < N; i++) peaks[i] /= max;
      const sound = { id, name, group, buffer, reversed, peaks, onset };
      this.sounds.set(id, sound);
      this.emit('sounds');
      return sound;
    }
    preview(id) {
      const s = this.sounds.get(id); if (!s) return;
      const src = this.ctx.createBufferSource(), g = gain(this.ctx, 0.7);
      src.buffer = s.buffer; src.connect(g).connect(this.master); src.start();
    }

    /* looper helpers */
    async resampleToLibrary() {
      if (!this.looper) return null;
      const d = await this.looper.export();
      if (!d.L.length) return null;
      const buf = this.ctx.createBuffer(2, d.L.length, this.ctx.sampleRate);
      buf.getChannelData(0).set(d.L); buf.getChannelData(1).set(d.R);
      this.takes = (this.takes || 0) + 1;
      return this.addBuffer('take:' + Date.now().toString(36), buf, 'loop take ' + this.takes, 'resampled');
    }
    async loopWav() {
      const d = await this.looper.export();
      if (!d.L.length) return null;
      return encodeWav([d.L, d.R], this.ctx.sampleRate);
    }

    on(fn) { this.listeners.add(fn); }
    emit(what) { for (const fn of this.listeners) fn(what); }
  }

  function encodeWav(chans, sr) {
    const n = chans[0].length, nc = chans.length, bytes = 44 + n * nc * 2;
    const v = new DataView(new ArrayBuffer(bytes));
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * nc * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { v.setInt16(o, clamp(chans[c][i], -1, 1) * 32767, true); o += 2; }
    return new Blob([v.buffer], { type: 'audio/wav' });
  }

  AM.engine = new Engine();
})();
