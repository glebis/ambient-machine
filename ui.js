'use strict';
// Ambient machine — interface: controls, draggable panels, library, scenes, persistence.
(() => {
  const AM = window.AM, E = AM.engine, { clamp } = AM.util;
  const SETS = ['dawn', 'glass', 'felt', 'tape', 'harbour'];
  const KINDS = ['voice-start', 'voice-stop', 'tool-start', 'tool-done'];
  const $ = (s, el = document) => el.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) el.append(k);
    return el;
  };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  /* ------------------------------------------------------------ state */
  const PRESETS = [
    ['dawn/voice-start', { size: 380, density: 6, spread: 12, scale: 'octaves', reverse: 0.3, sendReverb: 0.55 }],
    ['glass/tool-done', { size: 120, density: 14, pitch: 12, spread: 7, scale: 'fifths', spray: 0.3, sendDelay: 0.5, volume: 0.6 }],
    ['felt/voice-stop', { size: 900, density: 2.5, pitch: -12, sendReverb: 0.7, cutoff: 3000, shape: 0.7 }],
    ['harbour/voice-start', { mode: 'loop', beats: '8', position: 0, sendDelay: 0.4, volume: 0.65 }],
    ['tape/tool-start', { size: 60, density: 4, pitch: 7, spread: 12, scale: 'penta', reverse: 0.5, shape: 0.15, sendDelay: 0.6, volume: 0.65 }],
    ['glass/voice-start', { size: 1500, density: 1.2, pitch: -24, shape: 0.85, lfoTarget: 'position', lfoShape: 'walk', lfoRate: 0.2, lfoDepth: 0.6, sendReverb: 0.8 }],
    ['dawn/tool-done', { mode: 'loop', beats: '4', position: 0, sendDelay: 0.6, pan: -0.3, volume: 0.6 }],
    ['harbour/tool-done', { size: 200, density: 20, spray: 0.8, spread: 12, scale: 'penta', volume: 0.45, lfoTarget: 'volume', lfoRate: 0.05, lfoDepth: 0.6 }],
  ];
  // Default kit (generated once with `python3 server.py --kit`) and a quiet half-time pattern.
  const KIT = [
    ['kick', { decay: 700 }, 'X.........x.....'],
    ['snare', { decay: 420, sendReverb: 0.25 }, '........x.......'],
    ['clap', { decay: 380, sendReverb: 0.3, volume: 0.6 }, '................'],
    ['hat', { decay: 90, volume: 0.55, pan: 0.2 }, '..x...X...x.....'],
    ['open-hat', { decay: 700, volume: 0.5, pan: 0.2 }, '..............x.'],
    ['rim', { decay: 160, volume: 0.55, sendDelay: 0.35, pan: -0.25 }, '...x.......x....'],
    ['tom', { decay: 800, sendReverb: 0.3 }, '...............x'],
    ['shaker', { decay: 160, volume: 0.45, pan: -0.3 }, '.x...x...x...x..'],
  ];
  const parseRow = r => [...r].map(c => c === 'X' ? 2 : c === 'x' ? 1 : 0);
  const freshDrums = () => ({
    ...AM.defaults('drums'),
    tracks: KIT.map(([id, o]) => ({ sound: 'drums/kit/' + id, prompt: '', ...AM.defaults('drum'), ...o })),
    patterns: [KIT.map(k => parseRow(k[2])), ...[1, 2, 3].map(() => KIT.map(() => Array(16).fill(0)))],
  });
  const freshState = () => ({
    slots: PRESETS.map(([sound, p]) => ({ sound, params: { ...AM.defaults('slot'), ...p } })),
    delay: AM.defaults('delay'), reverb: AM.defaults('reverb'), master: AM.defaults('master'), looper: AM.defaults('looper'),
    drums: freshDrums(),
  });
  function loadState() {
    const fresh = freshState(), saved = store.get('am.state');
    if (!saved) return fresh;
    const merge = (def, s, section) => {
      const out = { ...def };
      for (const k of Object.keys(def)) if (s && s[k] !== undefined && valid(AM.SPEC[section][k], s[k])) out[k] = s[k];
      return out;
    };
    return {
      slots: fresh.slots.map((d, i) => ({ sound: saved.slots?.[i]?.sound ?? d.sound,
        params: merge(AM.defaults('slot'), saved.slots?.[i]?.params, 'slot') })),
      delay: merge(fresh.delay, saved.delay, 'delay'), reverb: merge(fresh.reverb, saved.reverb, 'reverb'),
      master: merge(fresh.master, saved.master, 'master'), looper: merge(fresh.looper, saved.looper, 'looper'),
      drums: mergeDrums(fresh.drums, saved.drums, merge),
    };
  }
  function mergeDrums(def, s, merge) {
    if (!s) return def;
    const okPattern = p => Array.isArray(p) && p.length === 8 && p.every(r => Array.isArray(r) && r.length === 16);
    return {
      ...merge(def, s, 'drums'),
      tracks: def.tracks.map((d, i) => {
        const t = s.tracks?.[i] || {};
        return { ...merge(d, t, 'drum'), sound: typeof t.sound === 'string' ? t.sound : d.sound,
          prompt: typeof t.prompt === 'string' ? t.prompt : d.prompt };
      }),
      patterns: def.patterns.map((d, i) => okPattern(s.patterns?.[i]) ? s.patterns[i] : d),
    };
  }
  function valid(spec, v) {
    if (!spec) return false;
    if (spec.type === 'num') return typeof v === 'number' && isFinite(v);
    if (spec.type === 'bool') return typeof v === 'boolean';
    return spec.options.includes(v);
  }
  AM.state = loadState();
  let saveTimer = 0;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('am.state', AM.state), 300); };

  // path: "slot.3.size" | "delay.time" | ...
  function locate(path) {
    const parts = path.split('.');
    if (parts[0] === 'slot') return { section: 'slot', obj: AM.state.slots[+parts[1]].params, key: parts[2], slot: +parts[1] };
    if (parts[0] === 'drum') return { section: 'drum', obj: AM.state.drums.tracks[+parts[1]], key: parts[2], slot: +parts[1] };
    return { section: parts[0], obj: AM.state[parts[0]], key: parts[1] };
  }
  const specOf = path => { const l = locate(path); return AM.SPEC[l.section][l.key]; };
  const getV = path => { const l = locate(path); return l.obj[l.key]; };
  const controls = new Map();
  function setV(path, v, opts = {}) {
    const l = locate(path);
    if (l.obj[l.key] === v) return;
    l.obj[l.key] = v;
    if (l.section === 'drum') E.drums.apply(l.slot);
    else if (l.section !== 'slot' && l.section !== 'drums') E.applySection(l.section);
    controls.get(path)?.forEach(c => c.render());
    if (l.section === 'slot') slotViews[l.slot]?.refresh(l.key);
    if (l.section === 'delay') delayView?.refresh();
    if (l.section === 'drum' || l.section === 'drums') drumView?.refresh(l.key);
    if (!opts.quiet) save();
  }

  /* ------------------------------------------------------------ controls */
  const register = (path, c) => { if (!controls.has(path)) controls.set(path, new Set()); controls.get(path).add(c); return c; };

  // Shared drag behaviour for knobs (vertical) and sliders (horizontal).
  function dragValue(el, path, axis, pxRange) {
    const spec = specOf(path);
    let start = 0, startN = 0, moved = false;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId); el.classList.add('active'); el.focus({ preventScroll: true });
      start = axis === 'y' ? e.clientY : e.clientX; startN = AM.toNorm(spec, getV(path)); moved = false;
      if (axis === 'x' && !e.target.closest('.thumb')) {        // sliders: jump to the click point
        const r = el.querySelector('.rail').getBoundingClientRect();
        startN = clamp((e.clientX - r.left) / r.width, 0, 1);
        setV(path, AM.fromNorm(spec, startN));
      }
    });
    el.addEventListener('pointermove', e => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const d = axis === 'y' ? start - e.clientY : e.clientX - start;
      const range = axis === 'x' ? el.querySelector('.rail').getBoundingClientRect().width : pxRange;
      moved = true;
      setV(path, AM.fromNorm(spec, startN + (d / range) * (e.shiftKey ? 0.15 : 1)));
    });
    const end = e => { if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId); el.classList.remove('active'); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => setV(path, spec.def));
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const step = spec.step ? spec.step / (spec.max - spec.min) : 0.01;
      setV(path, AM.fromNorm(spec, AM.toNorm(spec, getV(path)) + Math.sign(-e.deltaY || e.deltaX) * step * (e.shiftKey ? 0.25 : 2)));
    }, { passive: false });
    el.addEventListener('keydown', e => {
      const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const step = spec.step ? spec.step / (spec.max - spec.min) : 0.01;
      setV(path, AM.fromNorm(spec, AM.toNorm(spec, getV(path)) + dir * Math.max(step, e.shiftKey ? 0.002 : 0.02)));
    });
  }

  const A0 = -135, A1 = 135;
  const polar = (a, r) => [20 + r * Math.sin(a * Math.PI / 180), 20 - r * Math.cos(a * Math.PI / 180)];
  const arc = (a0, a1, r) => {
    if (Math.abs(a1 - a0) < 0.5) a1 = a0 + 0.5 * Math.sign(a1 - a0 || 1);
    const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
    return `M${x0} ${y0} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1} ${y1}`;
  };

  function knob(path, label) {
    const spec = specOf(path);
    const s = svg('svg', { viewBox: '0 0 40 40' });
    s.append(svg('path', { class: 'track', d: arc(A0, A1, 16) }));
    const val = svg('path', { class: 'val' }), needle = svg('line', { class: 'needle' }), mod = svg('circle', { class: 'mod', r: 2, visibility: 'hidden' });
    s.append(val, needle, mod);
    const num = h('span', { class: 'num' });
    const el = h('div', { class: 'knob', tabindex: 0, role: 'slider', 'aria-label': label || spec.label, 'data-path': path },
      s, h('span', { class: 'lab' }, label || spec.label), num);
    const c = {
      el,
      render() {
        const v = getV(path), n = AM.toNorm(spec, v), a = A0 + n * (A1 - A0);
        const from = spec.bipolar ? 0 : A0;
        val.setAttribute('d', arc(Math.min(from, a), Math.max(from, a), 16));
        const [x0, y0] = polar(a, 6), [x1, y1] = polar(a, 12);
        needle.setAttribute('x1', x0); needle.setAttribute('y1', y0); needle.setAttribute('x2', x1); needle.setAttribute('y2', y1);
        num.textContent = spec.fmt(v);
        el.setAttribute('aria-valuetext', spec.fmt(v));
        el.setAttribute('aria-valuenow', v.toFixed(3));
      },
      setMod(n) {
        if (n == null) { mod.setAttribute('visibility', 'hidden'); return; }
        const [x, y] = polar(A0 + n * (A1 - A0), 19.5);
        mod.setAttribute('cx', x); mod.setAttribute('cy', y); mod.setAttribute('visibility', 'visible');
      },
    };
    dragValue(el, path, 'y', 160);
    c.render();
    return register(path, c);
  }

  function slider(path, label) {
    const spec = specOf(path);
    const fill = h('i', { class: 'fill' }), thumb = h('i', { class: 'thumb' }), mod = h('i', { class: 'mod', style: 'display:none' });
    const num = h('span', { class: 'num' });
    const el = h('div', { class: 'slider', tabindex: 0, role: 'slider', 'aria-label': label || spec.label, 'data-path': path },
      h('span', { class: 'lab' }, label || spec.label), h('div', { class: 'rail' }, fill, thumb, mod), num);
    const c = {
      el,
      render() {
        const v = getV(path), n = AM.toNorm(spec, v) * 100, from = spec.bipolar ? 50 : 0;
        fill.style.left = Math.min(from, n) + '%'; fill.style.width = Math.abs(n - from) + '%';
        thumb.style.left = n + '%'; num.textContent = spec.fmt(v);
        el.setAttribute('aria-valuetext', spec.fmt(v));
      },
      setMod(n) { mod.style.display = n == null ? 'none' : ''; if (n != null) mod.style.left = n * 100 + '%'; },
    };
    dragValue(el, path, 'x');
    c.render();
    return register(path, c);
  }

  function select(path, label) {
    const spec = specOf(path);
    const sel = h('select', { 'aria-label': label || spec.label, onchange: () => setV(path, sel.value) },
      spec.options.map(o => h('option', { value: o }, o === 'cutoff' ? 'tone' : o)));
    const el = h('label', { class: 'sel' }, sel, h('span', { class: 'lab' }, label || spec.label));
    register(path, { el, render() { sel.value = getV(path); } }).render();
    return el;
  }

  function toggle(path, label, cls = '') {
    const btn = h('button', { class: 'btn small ' + cls, type: 'button', onclick: () => setV(path, !getV(path)) }, label || specOf(path).label);
    const c = register(path, { el: btn, render() { btn.setAttribute('aria-pressed', String(getV(path))); } });
    c.render();
    return btn;
  }

  /* ------------------------------------------------------------ panels & drag-to-rearrange */
  const rack = $('#rack');
  let draggingPanel = null;
  function panel(id, title, num, cls = '') {
    const header = h('header', { class: 'ph' }, h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
      num ? h('span', { class: 'pnum mono' }, num) : null, h('span', { class: 'ptitle' }, title));
    const body = h('div', { class: 'pb' });
    const el = h('section', { class: 'panel ' + cls, 'data-id': id }, header, body);
    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button, select, input, .sound, .knob, .slider')) return;
      el.draggable = true;
    });
    el.addEventListener('dragstart', e => {
      if (!el.draggable) return;
      draggingPanel = el; el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-am-panel', id);
    });
    el.addEventListener('dragend', () => {
      el.draggable = false; el.classList.remove('dragging'); draggingPanel = null;
      store.set('am.order', [...rack.children].map(p => p.dataset.id));
    });
    document.addEventListener('pointerup', () => { if (!draggingPanel) el.draggable = false; });
    return { el, header, body };
  }
  rack.addEventListener('dragover', e => {
    if (!draggingPanel) return;
    e.preventDefault();
    const target = e.target.closest('.panel');
    if (!target || target === draggingPanel) return;
    const r = target.getBoundingClientRect();
    const after = target.classList.contains('wide') ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    const ref = after ? target.nextSibling : target;
    if (ref !== draggingPanel && ref !== draggingPanel.nextSibling) rack.insertBefore(draggingPanel, ref);
  });
  rack.addEventListener('drop', e => { if (draggingPanel) e.preventDefault(); });

  /* ------------------------------------------------------------ sound drops */
  const isSoundDrag = e => [...e.dataTransfer.types].some(t => t === 'application/x-am-sound' || t === 'Files');
  function dropTarget(el, onSound) {
    el.addEventListener('dragover', e => {
      if (draggingPanel || !isSoundDrag(e)) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('drop');
    });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
    el.addEventListener('drop', async e => {
      if (draggingPanel) return;
      e.preventDefault(); e.stopPropagation(); el.classList.remove('drop');
      const id = e.dataTransfer.getData('application/x-am-sound');
      if (id) return onSound(id);
      const files = [...e.dataTransfer.files].filter(f => /^audio\/|\.(wav|aiff?|mp3|m4a|ogg|flac|caf)$/i.test(f.type + ' ' + f.name));
      let first = null;
      for (const f of files) {
        try { const s = await E.loadFile(f); first ??= s; } catch (err) { notice(`Couldn't decode ${f.name}`); }
      }
      if (first) onSound(first.id);
    });
  }
  const dragSound = (el, getId) => {
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      const id = getId(); if (!id) return e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-am-sound', id);
      e.dataTransfer.setData('text/plain', id);
    });
  };

  /* ------------------------------------------------------------ library */
  let libBody, noticeEl;
  function notice(msg) { if (noticeEl) noticeEl.textContent = msg; }
  function miniWave(peaks) {
    const s = svg('svg', { viewBox: '0 0 34 12' }), N = 12;
    for (let i = 0; i < N; i++) {
      const p = peaks[Math.floor((i / N) * peaks.length)], x = 1.5 + i * 2.8, hh = 0.6 + p * 4.6;
      s.append(svg('line', { x1: x, x2: x, y1: 6 - hh, y2: 6 + hh }));
    }
    return s;
  }
  function buildLibrary() {
    const p = panel('library', 'library', null, 'wide');
    libBody = h('div', { class: 'lib' });
    const input = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true,
      onchange: async () => { for (const f of input.files) { try { await E.loadFile(f); } catch { notice(`Couldn't decode ${f.name}`); } } input.value = ''; } });
    noticeEl = h('span', { class: 'notice' });
    const zone = h('div', { class: 'dropzone' }, 'Drop audio files here, or',
      h('button', { class: 'btn small', type: 'button', onclick: () => input.click() }, 'add files…'), input, noticeEl);
    dropTarget(zone, () => {});
    p.body.append(libBody);
    p.body.append(h('div', { class: 'row' }, h('span', { class: 'lab' }, 'click a sound to audition · drag it onto a slot')));
    p.libZone = zone;
    renderLibrary(zone);
    E.on(what => { if (what === 'sounds') renderLibrary(zone); });
    return p;
  }
  function renderLibrary(zone) {
    const groups = new Map();
    for (const s of E.sounds.values()) { if (!groups.has(s.group)) groups.set(s.group, []); groups.get(s.group).push(s); }
    libBody.replaceChildren();
    const rank = g => { const k = [...SETS, 'drum kit', 'drums · generated'].indexOf(g); return k < 0 ? 99 : k; };
    for (const [g, list] of [...groups].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      const order = id => {
        const [g, k, x] = id.split('/');
        if (g === 'drums') return k === 'kit' ? KIT.findIndex(e => e[0] === x) : 0;
        return KINDS.indexOf(k);
      };
      list.sort((a, b) => order(a.id) - order(b.id));
      libBody.append(h('div', { class: 'lib-group' }, h('span', { class: 'gname' }, g), list.map(s => {
        const chip = h('div', { class: 'chip', title: 'click to audition, drag onto a slot', 'data-id': s.id,
          onclick: () => { E.resume().then(() => E.preview(s.id)); } }, miniWave(s.peaks), s.name);
        dragSound(chip, () => s.id);
        return chip;
      })));
    }
    libBody.append(zone);
  }
  function flashChip(id) {
    const c = libBody?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (c) { c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1500); }
  }

  /* ------------------------------------------------------------ slots */
  const slotViews = [];
  function buildSlot(i) {
    const p = panel('slot-' + i, 'slot', String(i + 1).padStart(2, '0'), 'slot');
    const path = k => `slot.${i}.${k}`;
    const soundLabel = h('span', { class: 'sound', title: 'drag a sound here; drag this to copy the sound to another slot' });
    dragSound(soundLabel, () => AM.state.slots[i].sound);
    const launch = h('button', { class: 'launch', type: 'button', 'aria-label': `launch slot ${i + 1}`,
      onclick: async () => { await E.resume(); E.slots[i].launch(); } });
    const segBtns = AM.SPEC.slot.mode.options.map(m => h('button', { type: 'button', onclick: () => setV(path('mode'), m) }, m));
    p.header.append(soundLabel, h('span', { class: 'seg' }, segBtns), launch);

    const canvas = h('canvas'), hint = h('span', { class: 'hint' }), lvl = h('i', { class: 'level' });
    const wave = h('div', { class: 'wavebox', title: 'drag to set position' }, canvas, hint, lvl);
    wave.addEventListener('pointerdown', e => {
      e.preventDefault(); wave.setPointerCapture(e.pointerId);
      const set = ev => { const r = wave.getBoundingClientRect(); setV(path('position'), clamp((ev.clientX - r.left) / r.width, 0, 1)); };
      set(e);
      wave.onpointermove = ev => { if (wave.hasPointerCapture(ev.pointerId)) set(ev); };
    });

    const K = k => knob(path(k));
    const kn = {};
    for (const k of ['size', 'density', 'position', 'scan', 'spray', 'shape', 'pitch', 'spread', 'reverse', 'width', 'cutoff']) kn[k] = K(k);
    const grid = h('div', { class: 'knobs' },
      kn.size.el, kn.density.el, kn.position.el, kn.scan.el, kn.spray.el, kn.shape.el,
      kn.pitch.el, kn.spread.el, select(path('scale')), kn.reverse.el, kn.width.el, kn.cutoff.el);
    const sl = {};
    for (const k of ['volume', 'pan', 'sendDelay', 'sendReverb']) sl[k] = slider(path(k));
    const sliders = h('div', { class: 'sliders' }, sl.volume.el, sl.pan.el, sl.sendDelay.el, sl.sendReverb.el);
    const lfoRate = knob(path('lfoRate')), lfoDepth = knob(path('lfoDepth'));
    const lfo = h('div', { class: 'lfo' }, h('span', { class: 'tag' }, 'modulation'),
      select(path('lfoTarget')), select(path('lfoShape')), lfoRate.el, lfoDepth.el);
    const every = select(path('beats'), 'loop every (beats)');
    const loopRow = h('div', { class: 'row' }, every);
    p.body.append(wave, grid, loopRow, sliders, lfo);

    dropTarget(p.el, id => { setSound(i, id); flashChip(id); });

    const modTargets = { ...kn, ...sl };
    let lastMod = null;
    const view = {
      p, canvas, lvl, launch,
      refresh(key) {
        const st = AM.state.slots[i], s = E.sounds.get(st.sound);
        soundLabel.textContent = s ? s.name : 'empty — drop a sound';
        soundLabel.classList.toggle('empty', !s);
        hint.textContent = s ? '' : 'drop a sound here';
        const loop = st.params.mode === 'loop';
        segBtns.forEach(b => b.classList.toggle('on', b.textContent === st.params.mode));
        for (const k of ['size', 'density', 'spray', 'shape']) kn[k].el.classList.toggle('dim', loop);
        loopRow.classList.toggle('dim', !loop);
        if (!key || key === 'lfoTarget' || key === 'lfoDepth') { lastMod?.setMod(null); lastMod = null; }
        this.dirty = true;
      },
      updateMod() {
        const m = E.slots[i]?.modNorm();
        const c = m ? modTargets[m.key] : null;
        if (c !== lastMod) { lastMod?.setMod(null); lastMod = c; }
        c?.setMod(m.norm);
      },
    };
    slotViews[i] = view;
    view.refresh();
    return p;
  }
  function setSound(i, id) {
    AM.state.slots[i].sound = id;
    slotViews[i].refresh(); save();
  }

  function drawWave(i, now) {
    const v = slotViews[i], c = v.canvas, st = AM.state.slots[i], slot = E.slots[i];
    const s = E.sounds.get(st.sound);
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    if (!s) return;
    const p = st.params, mid = H / 2, N = Math.min(s.peaks.length, Math.floor(W / 3.4));
    const pos = slot ? AM.util.wrap01(slot.eff('position') + (slot.state === 'playing' ? slot.scanOffset : 0)) : p.position;
    if (p.mode === 'cloud' && p.spray > 0) {                      // spray window
      g.fillStyle = 'rgba(196,22,29,.08)';
      const w = p.spray * W;
      g.fillRect(pos * W - w / 2, 0, w, H);
      if (pos * W - w / 2 < 0) g.fillRect(W + pos * W - w / 2, 0, w, H);
      if (pos * W + w / 2 > W) g.fillRect(pos * W + w / 2 - W - w, 0, w, H);
    }
    g.lineCap = 'round'; g.lineWidth = 1.6; g.strokeStyle = 'rgba(9,9,9,.55)';
    g.beginPath();
    for (let k = 0; k < N; k++) {
      const x = 3 + (k * (W - 6)) / (N - 1), pk = s.peaks[Math.floor((k / N) * s.peaks.length)], hh = 0.8 + pk * (mid - 5);
      g.moveTo(x, mid - hh); g.lineTo(x, mid + hh);
    }
    g.stroke();
    if (slot && E.ctx) {                                          // live grains
      g.lineWidth = 2.2; g.strokeStyle = '#c4161d';
      const t = E.ctx.currentTime;
      for (const gr of slot.grains) {
        const age = (t - gr.t) / gr.dur;
        if (age < 0 || age > 1) continue;
        g.globalAlpha = Math.sin(Math.PI * age);
        const x0 = gr.pos * W, x1 = Math.max(x0 + 2, (gr.pos + gr.len) * W);
        const y = gr.rev ? H - 3 : 3;
        g.beginPath(); g.moveTo(x0, y); g.lineTo(Math.min(W - 1, x1), y); g.stroke();
        const xh = gr.rev ? x1 - (x1 - x0) * age : x0 + (x1 - x0) * age;   // playhead
        g.globalAlpha *= 0.5; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(xh, 6); g.lineTo(xh, H - 6); g.stroke(); g.lineWidth = 2.2;
      }
      g.globalAlpha = 1;
    }
    g.strokeStyle = '#c4161d'; g.lineWidth = 1.5;                 // position marker
    g.beginPath(); g.moveTo(pos * W, 0); g.lineTo(pos * W, H); g.stroke();
  }

  /* ------------------------------------------------------------ fx panels */
  let delayView = null;
  function buildDelay() {
    const p = panel('delay', 'delay', 'fx');
    const time = knob('delay.time');
    const div = select('delay.div');
    p.header.append(h('span', { class: 'spacer' }), toggle('delay.sync', 'tempo sync'), toggle('delay.freeze', 'freeze', 'warn'));
    p.body.append(
      h('div', { class: 'knobs' }, time.el, div, knob('delay.feedback').el, knob('delay.lowcut').el, knob('delay.highcut').el, knob('delay.mix').el,
        knob('delay.pingpong').el, knob('delay.width').el, knob('delay.offset').el, knob('delay.wowRate').el, knob('delay.wowDepth').el, knob('delay.toReverb').el));
    delayView = { refresh() { const s = AM.state.delay.sync; time.el.classList.toggle('dim', s); div.classList.toggle('dim', !s); } };
    delayView.refresh();
    return p;
  }
  function buildReverb() {
    const p = panel('reverb', 'reverb', 'fx');
    p.body.append(h('div', { class: 'knobs cols4' }, ['size', 'damping', 'predelay', 'mix'].map(k => knob('reverb.' + k).el)));
    p.body.append(h('div', { class: 'row lab' }, 'convolution · generated impulse, rebuilt when size or damping change'));
    return p;
  }

  let looperView = null;
  function buildLooper() {
    const p = panel('looper', 'resample looper', 'rec');
    if (!E.looper) { p.body.append(h('p', { class: 'notice' }, 'AudioWorklet unavailable in this browser — looper disabled.')); return p; }
    const status = h('span', { class: 'lstatus' }, 'empty');
    const bar = h('div', { class: 'lbar' }, h('i'));
    const rec = h('button', { class: 'btn small', type: 'button', title: 'record the mix for N bars, starting at the next bar',
      onclick: async () => { await E.resume(); const t = E.nextBoundary('bar'); E.looper.record(t, Number(AM.state.looper.bars) * 4 * E.beatDur); } }, 'record');
    const play = h('button', { class: 'btn small', type: 'button',
      onclick: () => { const st = E.looper.status.state; if (st === 'playing' || st === 'cueing') E.looper.send({ type: 'stop' }); else E.looper.play(E.nextBoundary('bar')); } }, 'play');
    const dub = h('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false',
      onclick: () => E.looper.send({ type: 'dub', on: !E.looper.status.dub }) }, 'overdub');
    const clear = h('button', { class: 'btn small', type: 'button', onclick: () => E.looper.send({ type: 'clear' }) }, 'clear');
    const toLib = h('button', { class: 'btn small', type: 'button', title: 'copy the loop into the library so a slot can granulate it',
      onclick: async () => { const s = await E.resampleToLibrary(); if (s) flashChip(s.id); else notice('Nothing recorded yet.'); } }, '→ library');
    const wav = h('button', { class: 'btn small', type: 'button',
      onclick: async () => {
        const blob = await E.loopWav(); if (!blob) return notice('Nothing recorded yet.');
        const a = h('a', { href: URL.createObjectURL(blob), download: `ambient-loop-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav` });
        document.body.append(a); a.click(); a.remove();
      } }, 'save wav');
    p.header.append(h('span', { class: 'spacer' }), status);
    p.body.append(h('div', { class: 'btnrow' }, rec, play, dub, clear, toLib, wav), bar,
      h('div', { class: 'knobs cols4' }, select('looper.bars', 'bars'), knob('looper.keep').el),
      h('div', { class: 'sliders' }, slider('looper.level').el),
      h('div', { class: 'row lab' }, 'records the slot + fx mix; the loop plays back dry, so overdubs never double it'));
    looperView = { status, bar, rec, play, dub };
    E.looper.onstate = d => {
      status.textContent = { empty: 'empty', armed: 'armed — next bar', recording: 'recording', playing: d.dub ? 'overdubbing' : 'playing', stopped: 'stopped', cueing: 'cued — next bar' }[d.state] || d.state;
      bar.classList.toggle('rec', d.state === 'recording' || d.dub);
      rec.classList.toggle('red', d.state === 'recording' || d.state === 'armed');
      play.textContent = d.state === 'playing' || d.state === 'cueing' ? 'stop' : 'play';
      dub.setAttribute('aria-pressed', String(d.dub));
      dub.classList.toggle('red', d.dub);
      bar.firstChild.style.width = (d.pos * 100) + '%';
    };
    return p;
  }

  let grEl;
  function buildMaster() {
    const p = panel('master', 'master', 'out');
    grEl = h('span', { class: 'gr' }, 'GR 0.0 dB');
    p.header.append(h('span', { class: 'spacer' }), toggle('master.limiter', 'limiter'));
    p.body.append(
      h('div', { class: 'knobs cols4' }, knob('master.bpm').el, select('master.quant', 'launch quantise'), knob('master.ceiling').el,
        h('div', { class: 'sel' }, grEl, h('span', { class: 'lab' }, 'gain reduction'))),
      h('div', { class: 'sliders' }, slider('master.volume').el));
    return p;
  }

  /* ------------------------------------------------------------ drum machine */
  let drumView = null;
  async function loadDrumManifest() {
    let list = [];
    try { const r = await fetch('sounds/drums/manifest.json', { cache: 'no-store' }); if (r.ok) list = await r.json(); } catch { /* no kit yet */ }
    const loaded = await Promise.all(list.map(e => E.loadUrl(e.id, e.url, e.name, e.group).then(s => { s.prompt = e.prompt; return s; }).catch(() => null)));
    AM.state.drums.tracks.forEach(t => { if (!t.prompt) t.prompt = E.sounds.get(t.sound)?.prompt || ''; });
    drumView?.renderAll();
    return loaded.some(Boolean) || null;
  }
  async function generatorStatus() {
    try {
      const r = await fetch('api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      const j = await r.json();
      return j.key ? '' : 'No ElevenLabs key found: set ELEVENLABS_API_KEY or add it to SOPS, then restart the server.';
    } catch { return 'Generating needs the local server: start it with "Open Ambient Machine.command".'; }
  }
  function buildDrums() {
    const p = panel('drums', 'drum machine', 'beat', 'wide');
    const D = () => AM.state.drums, pi = () => D().pattern.charCodeAt(0) - 65;
    let sel = 0;
    const play = h('button', { class: 'launch', type: 'button', 'aria-label': 'play or stop the drum machine',
      onclick: async () => { await E.resume(); E.drums.toggle(); } });
    const patBtns = AM.SPEC.drums.pattern.options.map(o => h('button', { type: 'button', title: `pattern ${o} (switches on the next bar)`, onclick: () => setV('drums.pattern', o) }, o));
    const copy = h('button', { class: 'btn small', type: 'button', title: 'copy this pattern into the next one and switch to it',
      onclick: () => { const i = pi(), j = (i + 1) % 4; D().patterns[j] = D().patterns[i].map(r => r.slice()); setV('drums.pattern', 'ABCD'[j]); renderGrid(); save(); } }, 'copy →');
    const clear = h('button', { class: 'btn small', type: 'button', title: 'clear this pattern',
      onclick: () => { D().patterns[pi()].forEach(r => r.fill(0)); renderGrid(); save(); } }, 'clear');
    p.header.append(h('span', { class: 'spacer' }), h('span', { class: 'mono lab' }, 'pattern'), h('span', { class: 'seg' }, patBtns), copy, clear, play);

    // --- step grid
    const grid = h('div', { class: 'dgrid', role: 'grid', 'aria-label': 'drum steps' });
    const names = [], mutes = [], solos = [], cells = [];
    for (let i = 0; i < 8; i++) {
      const name = h('button', { class: 'dname', type: 'button', title: 'select this track (click auditions it); drop a sound here',
        onclick: async () => { await E.resume(); selectTrack(i); E.drums.trigger(i); } });
      dragSound(name, () => D().tracks[i].sound);
      dropTarget(name, id => { D().tracks[i].sound = id; const s = E.sounds.get(id); if (s?.prompt) D().tracks[i].prompt = s.prompt; selectTrack(i); refreshNames(); save(); flashChip(id); });
      const m = h('button', { class: 'mini', type: 'button', title: 'mute', onclick: () => setV(`drum.${i}.mute`, !D().tracks[i].mute) }, 'M');
      const so = h('button', { class: 'mini', type: 'button', title: 'solo', onclick: () => setV(`drum.${i}.solo`, !D().tracks[i].solo) }, 'S');
      names.push(name); mutes.push(m); solos.push(so);
      grid.append(name, m, so);
      cells.push([]);
      for (let st = 0; st < 16; st++) {
        const c = h('button', { class: 'cell' + (st % 4 === 0 ? ' beat' : ''), type: 'button', 'data-row': i, 'data-step': st,
          'aria-label': `track ${i + 1} step ${st + 1}` });
        cells[i].push(c); grid.append(c);
      }
    }
    // Click toggles a step; shift-click makes it an accent; drag paints the same value across steps.
    let paint = null;
    const setCell = (c, v) => {
      const i = +c.dataset.row, st = +c.dataset.step, row = D().patterns[pi()][i];
      if (row[st] === v) return;
      row[st] = v; c.dataset.v = v; c.setAttribute('aria-pressed', String(v > 0));
    };
    grid.addEventListener('pointerdown', e => {
      const c = e.target.closest('.cell'); if (!c || e.button !== 0) return;
      e.preventDefault();
      const cur = D().patterns[pi()][+c.dataset.row][+c.dataset.step];
      paint = e.shiftKey ? (cur === 2 ? 1 : 2) : (cur ? 0 : 1);
      setCell(c, paint);
      grid.setPointerCapture(e.pointerId);
      E.resume();
    });
    grid.addEventListener('pointermove', e => {
      if (paint === null) return;
      const c = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
      if (c && grid.contains(c)) setCell(c, paint);
    });
    const endPaint = () => { if (paint !== null) { paint = null; save(); } };
    grid.addEventListener('pointerup', endPaint); grid.addEventListener('pointercancel', endPaint);
    grid.addEventListener('keydown', e => {                     // keyboard: space/enter toggles, shift = accent
      const c = e.target.closest('.cell'); if (!c || (e.key !== ' ' && e.key !== 'Enter')) return;
      e.preventDefault();
      const cur = D().patterns[pi()][+c.dataset.row][+c.dataset.step];
      setCell(c, e.shiftKey ? (cur === 2 ? 1 : 2) : (cur ? 0 : 1)); save();
    });

    // --- per-track strips (one per track, only the selected one shown) + generator
    const strips = AM.state.drums.tracks.map((_, i) => h('div', { class: 'knobs cols7 dknobs', hidden: i !== 0 },
      ['volume', 'pitch', 'decay', 'pan', 'shuffle', 'sendDelay', 'sendReverb'].map(k => knob(`drum.${i}.${k}`).el)));
    const selLabel = h('span', { class: 'tag' });
    const prompt = h('textarea', { rows: 3, 'aria-label': 'sound description for ElevenLabs', placeholder: 'describe one drum hit, e.g. "one soft felt mallet kick, warm, dry"' });
    prompt.addEventListener('input', () => { D().tracks[sel].prompt = prompt.value; save(); });
    const status = h('span', { class: 'gstatus mono' });
    const gen = h('button', { class: 'btn small', type: 'button', onclick: () => generate() }, 'generate with ElevenLabs');
    const genBox = h('div', { class: 'gen' }, h('span', { class: 'tag' }, 'new sound for this track'), prompt,
      h('div', { class: 'row' }, knob('drums.seconds').el, knob('drums.influence').el, gen), status);
    const globals = h('div', { class: 'knobs cols4' }, knob('drums.shuffle').el, select('drums.shuffleGrid', 'shuffle grid'),
      knob('drums.humanize').el, knob('drums.level').el);
    p.body.append(h('div', { class: 'dwrap' }, grid),
      h('div', { class: 'dstrip' },
        h('div', {}, selLabel, ...strips),
        genBox,
        h('div', {}, h('span', { class: 'tag' }, 'groove'), globals)),
      h('div', { class: 'row lab' }, 'click a step to toggle · shift-click for an accent · drag to paint · hat chokes open hat · generated sounds are saved to sounds/drums/generated and appear in the library'));

    function takeName(tr) {                                  // "clap" → "clap 2", "clap 3", …
      const base = (E.sounds.get(tr.sound)?.name || 'hit').replace(/ \d+$/, '');
      const taken = new Set([...E.sounds.values()].map(x => x.name));
      let n = 2; while (taken.has(`${base} ${n}`)) n++;
      return `${base} ${n}`;
    }
    async function generate() {
      const i = sel, tr = D().tracks[i], text = prompt.value.trim();
      if (!text) { status.textContent = 'Describe the sound first.'; return; }
      gen.disabled = true; status.textContent = 'Generating… (usually 3–10 s)';
      try {
        const r = await fetch('api/sfx', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, seconds: D().seconds, influence: D().influence, name: takeName(tr) }) });
        const j = await r.json().catch(() => ({ error: `server answered ${r.status}${r.status === 501 ? ' — start server.py to generate' : ''}` }));
        if (!r.ok) throw new Error(j.error || r.status);
        const snd = await E.loadUrl(j.id, j.url, j.name, j.group);
        snd.prompt = j.prompt;
        tr.sound = snd.id; tr.prompt = text; save();
        refreshNames(); flashChip(snd.id);
        await E.resume(); E.drums.trigger(i);
        status.textContent = `Done: ${j.url.split('/').pop()}`;
      } catch (err) {
        status.textContent = String(err.message || err);
      } finally { gen.disabled = false; }
    }
    function selectTrack(i) {
      sel = i;
      strips.forEach((st, k) => { st.hidden = k !== i; });
      names.forEach((n, k) => n.classList.toggle('sel', k === i));
      const s = E.sounds.get(D().tracks[i].sound);
      selLabel.textContent = `track ${i + 1} · ${s ? s.name : 'empty'}`;
      prompt.value = D().tracks[i].prompt || '';
    }
    function refreshNames() {
      D().tracks.forEach((t, i) => {
        const s = E.sounds.get(t.sound);
        names[i].textContent = s ? s.name : 'drop a sound';
        names[i].setAttribute('aria-label', `track ${i + 1}: ${s ? s.name : 'empty'}`);
        names[i].classList.toggle('empty', !s);
        mutes[i].setAttribute('aria-pressed', String(t.mute));
        solos[i].setAttribute('aria-pressed', String(t.solo));
      });
      selectTrack(sel);
    }
    function renderGrid() {
      const pat = D().patterns[pi()];
      cells.forEach((row, i) => row.forEach((c, st) => { c.dataset.v = pat[i][st]; c.setAttribute('aria-pressed', String(pat[i][st] > 0)); }));
      patBtns.forEach(b => b.classList.toggle('on', b.textContent === D().pattern));
    }
    let lastStep = -1;
    drumView = {
      refresh(key) { if (key === 'pattern') renderGrid(); if (key === 'mute' || key === 'solo') refreshNames(); },
      renderAll() { refreshNames(); renderGrid(); },
      update() {
        const st = E.drums.state;
        play.className = 'launch ' + st;
        const cur = st === 'playing' && E.ctx ? E.drums.currentStep(E.ctx.currentTime) : -1;
        if (cur === lastStep) return;
        cells.forEach(row => { row[lastStep]?.classList.remove('now'); row[cur]?.classList.add('now'); });
        lastStep = cur;
      },
    };
    generatorStatus().then(msg => { if (msg) { status.textContent = msg; gen.disabled = true; } });
    drumView.renderAll();
    return p;
  }

  /* ------------------------------------------------------------ scenes */
  let scenes = store.get('am.scenes') || Array(8).fill(null);
  let currentScene = -1, arming = false, morphRaf = 0;
  const sceneBox = $('.scenes'), sceneBtns = $('#sceneBtns'), sceneSave = $('#sceneSave');
  function snapshot() {
    const s = JSON.parse(JSON.stringify(AM.state));
    s.playing = E.slots.map(sl => sl.state === 'playing' || sl.state === 'pending');
    s.drumsPlaying = E.drums.state !== 'stopped';
    delete s.master.morph;
    return s;
  }
  function renderScenes() {
    sceneBtns.replaceChildren(...scenes.map((s, i) => h('button', {
      class: 'scene' + (s ? ' full' : '') + (i === currentScene ? ' current' : ''), type: 'button',
      title: s ? `recall scene ${i + 1} (shift-click to overwrite)` : `empty — shift-click or arm "store" to save`,
      onclick: e => (arming || e.shiftKey) ? storeScene(i) : recallScene(i),
    }, String(i + 1))));
    sceneBox.classList.toggle('arming', arming);
    sceneSave.setAttribute('aria-pressed', String(arming));
  }
  function storeScene(i) {
    scenes[i] = snapshot(); currentScene = i; arming = false;
    store.set('am.scenes', scenes); renderScenes();
  }
  async function recallScene(i) {
    const target = scenes[i]; if (!target) return;
    await E.resume();
    currentScene = i; renderScenes();
    cancelAnimationFrame(morphRaf);
    const ramps = [];
    const plan = (path, to) => {
      const spec = specOf(path); if (!valid(spec, to)) return;
      if (spec.type === 'num') { const from = getV(path); if (from !== to) ramps.push({ path, spec, from, to }); }
      else setV(path, to, { quiet: true });
    };
    target.slots.forEach((s, k) => {
      if (AM.state.slots[k].sound !== s.sound) setSound(k, s.sound);
      for (const [key, v] of Object.entries(s.params)) plan(`slot.${k}.${key}`, v);
    });
    for (const sec of ['delay', 'reverb', 'master', 'looper'])
      for (const [key, v] of Object.entries(target[sec] || {})) if (key !== 'morph') plan(`${sec}.${key}`, v);
    if (target.drums) {                              // drum machine: morph track levels, swap patterns
      const td = target.drums, cur = AM.state.drums;
      for (const k of ['shuffle', 'shuffleGrid', 'level', 'humanize']) plan(`drums.${k}`, td[k]);
      plan('drums.pattern', td.pattern);
      td.tracks?.forEach((t, i) => {
        if (typeof t.sound === 'string') cur.tracks[i].sound = t.sound;
        if (typeof t.prompt === 'string') cur.tracks[i].prompt = t.prompt;
        for (const k of Object.keys(AM.SPEC.drum)) plan(`drum.${i}.${k}`, t[k]);
      });
      if (Array.isArray(td.patterns) && td.patterns.length === 4) cur.patterns = JSON.parse(JSON.stringify(td.patterns));
      drumView?.renderAll();
      const running = E.drums.state !== 'stopped';
      if (target.drumsPlaying && !running) E.drums.toggle(); else if (target.drumsPlaying === false && running) E.drums.stop();
    }
    target.playing?.forEach((on, k) => {
      const sl = E.slots[k], running = sl.state === 'playing' || sl.state === 'pending';
      if (on && !running) sl.launch(); else if (!on && running) sl.stop();
    });
    const dur = AM.state.master.morph * 1000, t0 = performance.now();
    const step = now => {
      const x = dur ? clamp((now - t0) / dur, 0, 1) : 1, e = x * x * (3 - 2 * x);
      for (const r of ramps) {
        const n = AM.toNorm(r.spec, r.from) + (AM.toNorm(r.spec, r.to) - AM.toNorm(r.spec, r.from)) * e;
        setV(r.path, x >= 1 ? r.to : AM.fromNorm({ ...r.spec, step: 0 }, n), { quiet: true });
      }
      if (x < 1) morphRaf = requestAnimationFrame(step); else save();
    };
    morphRaf = requestAnimationFrame(step);
  }
  sceneSave.addEventListener('click', () => { arming = !arming; renderScenes(); });

  /* ------------------------------------------------------------ header bits */
  const meter = $('#meter'), METER_N = 31, meterLines = [];
  meter.setAttribute('viewBox', '0 0 160 36');
  for (let k = 0; k < METER_N; k++) {
    const x = 3 + (k * 154) / (METER_N - 1), l = svg('line', { x1: x, x2: x, y1: 18, y2: 18 });
    meter.append(l); meterLines.push(l);
  }
  const meterH = new Float32Array(METER_N);
  let freq = null;
  function drawMeter() {
    if (!E.analyser) return;
    freq ??= new Uint8Array(E.analyser.frequencyBinCount);
    E.analyser.getByteFrequencyData(freq);
    const bins = freq.length;
    for (let k = 0; k < METER_N; k++) {
      const idx = Math.floor(Math.pow(bins * 0.5, (k + 1) / METER_N));   // log-spaced bins
      const target = (freq[Math.min(bins - 1, idx)] / 255) * 15;
      meterH[k] += (target - meterH[k]) * 0.35;
      const hh = Math.max(0.01, meterH[k]);
      meterLines[k].setAttribute('y1', 18 - hh); meterLines[k].setAttribute('y2', 18 + hh);
    }
  }

  const dots = [...document.querySelectorAll('.dots i')], barEl = $('#bar'), power = $('#power');
  function drawClock() {
    if (!E.ctx) return;
    const pos = E.beatPos();
    if (pos < 0) return;
    const beat = Math.floor(pos) % 4;
    dots.forEach((d, k) => { d.classList.toggle('on', k === beat && pos - Math.floor(pos) < 0.5); d.classList.toggle('down', k === beat); });
    barEl.textContent = 'bar ' + (Math.floor(pos / 4) + 1);
  }
  function updatePower() {
    const live = E.ctx?.state === 'running';
    power.classList.toggle('live', live);
    power.textContent = live ? 'audio on' : 'Audio off — click to start';
  }
  power.addEventListener('click', async () => {
    if (E.ctx?.state === 'running') { await E.ctx.suspend(); } else await E.resume();
    updatePower();
  });
  document.addEventListener('pointerdown', () => { if (E.ctx && E.ctx.state !== 'running') E.resume().then(updatePower); }, { capture: true });
  const stopAll = $('#stopAll');
  stopAll.addEventListener('click', () => E.slots.forEach(s => s.stop()));
  stopAll.addEventListener('dblclick', () => E.slots.forEach(s => s.stopNow()));
  $('#resetLayout').addEventListener('click', () => { store.del('am.order'); location.reload(); });
  $('#resetAll').addEventListener('click', () => {
    if (!confirm('Reset all slots, effects, scenes and layout to the defaults?')) return;
    ['am.state', 'am.order', 'am.scenes'].forEach(k => store.del(k)); location.reload();
  });

  /* ------------------------------------------------------------ frame loop */
  function frame(now) { render(now); requestAnimationFrame(frame); }
  function render(now = performance.now()) {
    drawMeter(); drawClock();
    E.slots.forEach((slot, i) => {
      const v = slotViews[i];
      const st = slot.state;
      v.launch.className = 'launch ' + st;
      v.launch.setAttribute('aria-pressed', String(st === 'playing'));
      if (st !== 'stopped' || v.dirty) { drawWave(i, now); v.dirty = st !== 'stopped'; }
      v.updateMod();
      v.lvl.style.height = Math.min(100, slot.level() * 260) + '%';
    });
    drumView?.update();
    if (grEl && E.limiter) grEl.textContent = 'GR ' + Math.abs(E.limiter.reduction).toFixed(1) + ' dB';
  }

  /* ------------------------------------------------------------ boot */
  async function boot() {
    await E.init();
    updatePower();
    E.ctx.addEventListener('statechange', updatePower);
    const panels = [buildLibrary(), buildDrums()];
    for (let i = 0; i < 8; i++) panels.push(buildSlot(i));
    panels.push(buildDelay(), buildReverb(), buildLooper(), buildMaster());
    const byId = new Map(panels.map(p => [p.el.dataset.id, p.el]));
    const order = store.get('am.order');
    const ordered = Array.isArray(order) ? order.filter(id => byId.has(id)).map(id => byId.get(id)) : [];
    panels.forEach((p, i) => { if (!ordered.includes(p.el)) ordered.splice(Math.min(i, ordered.length), 0, p.el); });
    rack.append(...ordered);
    $('#morphKnob').append(knob('master.morph').el);
    renderScenes();

    const loads = [];
    for (const set of SETS) for (const kind of KINDS)
      loads.push(E.loadUrl(`${set}/${kind}`, `sounds/${set}/${kind}.wav`, kind.replace('-', ' '), set).catch(() => null));
    loads.push(loadDrumManifest());
    const got = await Promise.all(loads);
    if (!got.some(Boolean)) notice(location.protocol === 'file:'
      ? 'Built-in sounds need the local server: double-click "Open Ambient Machine.command". You can still drop files here.'
      : 'Built-in sounds failed to load — drop your own files here.');
    slotViews.forEach(v => v.refresh());
    requestAnimationFrame(frame);
    window.AMui = { setV, getV, recallScene, storeScene, slotViews, render };   // handy for debugging in the console
  }
  boot();
})();
