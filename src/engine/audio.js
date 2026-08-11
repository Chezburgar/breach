// Audio.
//
// Everything is synthesised at runtime — gunshots, impacts, footsteps, UI —
// so the game has a full soundscape with no downloads. Victory fanfares can
// either be synthesised from note lists or loaded from real audio files
// dropped into /assets/fanfares.

import { BUILTIN_FANFARES } from '../../shared/cosmetics.js';

const NOTE_BASE = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

function noteToFreq(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) return 440;
  let semis = NOTE_BASE[m[1]];
  if (m[2] === '#') semis += 1;
  if (m[2] === 'b') semis -= 1;
  const octave = parseInt(m[3], 10);
  return 440 * Math.pow(2, (semis + (octave - 4) * 12) / 12);
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buffers = new Map();
    this.fanfareFiles = [];
    this.volumes = { master: 0.8, sfx: 1.0, music: 0.7, ui: 0.8 };
    this.listener = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: -1 }, right: { x: 1, y: 0, z: 0 } };
    this.lastFootstep = 0;
  }

  /** Must be called from a user gesture. */
  async unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volumes.master;
    this.master.connect(this.ctx.destination);

    // A gentle limiter keeps a wall of gunfire from clipping.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.16;
    this.limiter.connect(this.master);

    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = this.volumes.sfx;
    this.sfx.connect(this.limiter);

    this.music = this.ctx.createGain();
    this.music.gain.value = this.volumes.music;
    this.music.connect(this.limiter);

    this.ui = this.ctx.createGain();
    this.ui.gain.value = this.volumes.ui;
    this.ui.connect(this.master);

    this.noise = this.makeNoiseBuffer(2.0);
    this.ready = true;
    await this.loadFanfareManifest();
  }

  setVolume(kind, value) {
    this.volumes[kind] = value;
    if (!this.ready) return;
    if (kind === 'master') this.master.gain.value = value;
    if (kind === 'sfx') this.sfx.gain.value = value;
    if (kind === 'music') this.music.gain.value = value;
    if (kind === 'ui') this.ui.gain.value = value;
  }

  makeNoiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;   // a touch of brown noise for weight
      data[i] = white * 0.7 + last * 3.5;
    }
    return buf;
  }

  setListener(pos, forward, right) {
    this.listener.pos = pos;
    this.listener.fwd = forward;
    this.listener.right = right;
  }

  /** Distance attenuation, stereo pan and air absorption for a world sound. */
  spatial(pos, refDistance = 8, maxDistance = 130) {
    if (!pos) return { gain: 1, pan: 0, lowpass: 20000, delay: 0 };
    const dx = pos.x - this.listener.pos.x;
    const dy = pos.y - this.listener.pos.y;
    const dz = pos.z - this.listener.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxDistance) return null;

    const gain = refDistance / Math.max(refDistance, dist * 0.85);
    const inv = dist > 1e-3 ? 1 / dist : 0;
    const rx = this.listener.right;
    const pan = Math.max(-1, Math.min(1, (dx * rx.x + dz * rx.z) * inv));
    const lowpass = Math.max(700, 20000 - dist * 135);
    return { gain, pan, lowpass, delay: dist / 340 };
  }

  route(node, opts) {
    const bus = opts.bus === 'ui' ? this.ui : (opts.bus === 'music' ? this.music : this.sfx);
    if (opts.spatial) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = opts.spatial.pan;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = opts.spatial.lowpass;
      const g = this.ctx.createGain();
      g.gain.value = opts.spatial.gain * (opts.gain ?? 1);
      node.connect(filter); filter.connect(panner); panner.connect(g); g.connect(bus);
    } else {
      const g = this.ctx.createGain();
      g.gain.value = opts.gain ?? 1;
      node.connect(g); g.connect(bus);
    }
  }

  // ------------------------------------------------------------ weapons
  /**
   * Layered gunshot: a transient crack, a filtered noise body, and a low thump.
   * The weapon class shifts the balance so an SMG and a DMR read differently.
   */
  gunshot(weapon, pos, opts = {}) {
    if (!this.ready) return;
    const sp = pos ? this.spatial(pos, 10, 190) : null;
    if (pos && !sp) return;
    const t = this.ctx.currentTime + (sp?.delay ?? 0);

    const cls = weapon?.cls || 'Assault Rifle';
    const suppressed = opts.suppressed;
    const profile = {
      'Assault Rifle': { crack: 1.0, body: 0.9, thump: 0.8, dur: 0.20, tone: 1700 },
      SMG: { crack: 0.85, body: 0.7, thump: 0.5, dur: 0.15, tone: 2300 },
      LMG: { crack: 1.1, body: 1.1, thump: 1.1, dur: 0.26, tone: 1400 },
      'Marksman Rifle': { crack: 1.3, body: 1.2, thump: 1.2, dur: 0.34, tone: 1200 },
      Shotgun: { crack: 1.15, body: 1.4, thump: 1.3, dur: 0.32, tone: 900 },
      Sidearm: { crack: 0.8, body: 0.6, thump: 0.5, dur: 0.16, tone: 2000 },
    }[cls] || { crack: 1, body: 1, thump: 0.8, dur: 0.2, tone: 1700 };

    const level = (opts.gain ?? 1) * (suppressed ? 0.42 : 1);

    // Body: filtered noise burst.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const bp = this.ctx.createBiquadFilter();
    bp.type = suppressed ? 'lowpass' : 'bandpass';
    bp.frequency.value = suppressed ? 900 : profile.tone;
    bp.Q.value = suppressed ? 1 : 0.8;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.9 * profile.body * level, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + profile.dur);
    src.connect(bp); bp.connect(env);
    this.route(env, { spatial: sp, gain: 0.55 });
    src.start(t); src.stop(t + profile.dur + 0.05);

    // Crack: short high transient.
    if (!suppressed) {
      const c = this.ctx.createBufferSource();
      c.buffer = this.noise;
      c.playbackRate.value = 2.2;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2600;
      const ce = this.ctx.createGain();
      ce.gain.setValueAtTime(0.9 * profile.crack * level, t);
      ce.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      c.connect(hp); hp.connect(ce);
      this.route(ce, { spatial: sp, gain: 0.5 });
      c.start(t); c.stop(t + 0.08);
    }

    // Thump: the low end you feel more than hear.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    const oe = this.ctx.createGain();
    oe.gain.setValueAtTime(0.7 * profile.thump * level, t);
    oe.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(oe);
    this.route(oe, { spatial: sp, gain: 0.5 });
    osc.start(t); osc.stop(t + 0.2);

    this.action(t, sp, level);

    // Tail: a short slap-back so shots sit in the space.
    if (!suppressed && (!sp || sp.gain > 0.2)) {
      const tail = this.ctx.createBufferSource();
      tail.buffer = this.noise;
      tail.playbackRate.value = 0.5;
      const tf = this.ctx.createBiquadFilter();
      tf.type = 'lowpass'; tf.frequency.value = 1100;
      const te = this.ctx.createGain();
      te.gain.setValueAtTime(0.0001, t + 0.03);
      te.gain.exponentialRampToValueAtTime(0.17 * level, t + 0.06);
      te.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      tail.connect(tf); tf.connect(te);
      this.route(te, { spatial: sp, gain: 0.4 });
      tail.start(t + 0.03); tail.stop(t + 0.7);
    }
  }

  /**
   * Mechanical action noise layered over a shot — the bolt cycling is a large
   * part of why a real gun sounds like machinery rather than a firework.
   */
  action(t, sp, level) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 3.0;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3400;
    bp.Q.value = 3;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.22 * level, t + 0.022);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
    src.connect(bp); bp.connect(env);
    this.route(env, { spatial: sp, gain: 0.5 });
    src.start(t + 0.012); src.stop(t + 0.1);
  }

  explosion(pos) {
    if (!this.ready) return;
    const sp = pos ? this.spatial(pos, 18, 260) : null;
    if (pos && !sp) return;
    const t = this.ctx.currentTime + (sp?.delay ?? 0);

    // Sub-bass thump.
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(26, t + 0.55);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(1.0, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(og);
    this.route(og, { spatial: sp, gain: 0.9 });
    o.start(t); o.stop(t + 0.9);

    // Sharp crack.
    const c = this.ctx.createBufferSource();
    c.buffer = this.noise;
    c.playbackRate.value = 1.6;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.9, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    c.connect(hp); hp.connect(cg);
    this.route(cg, { spatial: sp, gain: 0.8 });
    c.start(t); c.stop(t + 0.25);

    // Long rumbling tail.
    const tail = this.ctx.createBufferSource();
    tail.buffer = this.noise;
    tail.playbackRate.value = 0.35;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + 1.4);
    const tg = this.ctx.createGain();
    tg.gain.setValueAtTime(0.55, t + 0.02);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    tail.connect(lp); lp.connect(tg);
    this.route(tg, { spatial: sp, gain: 0.8 });
    tail.start(t); tail.stop(t + 1.8);
  }

  flashbang(pos) {
    if (!this.ready) return;
    const sp = pos ? this.spatial(pos, 16, 200) : null;
    if (pos && !sp) return;
    const t = this.ctx.currentTime + (sp?.delay ?? 0);

    const c = this.ctx.createBufferSource();
    c.buffer = this.noise;
    c.playbackRate.value = 2.2;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2200;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(1.0, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    c.connect(hp); hp.connect(cg);
    this.route(cg, { spatial: sp, gain: 0.9 });
    c.start(t); c.stop(t + 0.35);
  }

  /** The ringing left behind after a flash goes off in your face. */
  tinnitus(duration) {
    if (!this.ready || this.ringing) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 4300;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.10, t + 0.06);
    g.gain.setValueAtTime(0.10, t + Math.max(0.2, duration * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration + 1.4);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + duration + 1.6);
    this.ringing = true;
    setTimeout(() => { this.ringing = false; }, (duration + 1.6) * 1000);

    // Duck everything else while the ears are ringing.
    const s = this.sfx.gain;
    s.cancelScheduledValues(t);
    s.setValueAtTime(s.value, t);
    s.linearRampToValueAtTime(this.volumes.sfx * 0.25, t + 0.05);
    s.linearRampToValueAtTime(this.volumes.sfx, t + duration + 0.8);
  }

  smokePop(pos) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 10, 120);
    if (!sp) return;
    const t = this.ctx.currentTime + sp.delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    src.connect(bp); bp.connect(g);
    this.route(g, { spatial: sp, gain: 0.6 });
    src.start(t); src.stop(t + 2.6);
  }

  /** Grenade bouncing off a hard surface. */
  bounce(pos, speed) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 6, 60);
    if (!sp || speed < 1.5) return;
    const t = this.ctx.currentTime + sp.delay;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(420 + Math.random() * 220, t);
    const g = this.ctx.createGain();
    const amp = Math.min(0.25, speed * 0.02);
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    o.connect(g);
    this.route(g, { spatial: sp, gain: 0.7 });
    o.start(t); o.stop(t + 0.14);
  }

  impact(material, pos) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 6, 70);
    if (!sp) return;
    const t = this.ctx.currentTime + sp.delay;

    const prof = {
      metal: { f: 3200, q: 6, dur: 0.22, tone: true },
      metalRust: { f: 2400, q: 5, dur: 0.2, tone: true },
      container: { f: 2000, q: 7, dur: 0.3, tone: true },
      containerB: { f: 2000, q: 7, dur: 0.3, tone: true },
      glass: { f: 5200, q: 3, dur: 0.34, tone: true },
      wood: { f: 900, q: 2, dur: 0.13, tone: false },
      woodDark: { f: 800, q: 2, dur: 0.13, tone: false },
      crate: { f: 1000, q: 2, dur: 0.14, tone: false },
      sand: { f: 500, q: 0.7, dur: 0.12, tone: false },
      dirt: { f: 420, q: 0.7, dur: 0.12, tone: false },
      grass: { f: 600, q: 0.8, dur: 0.1, tone: false },
      water: { f: 1400, q: 1.2, dur: 0.2, tone: false },
    }[material] || { f: 1500, q: 1.5, dur: 0.14, tone: false };

    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1.4 + Math.random() * 0.5;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = prof.f * (0.85 + Math.random() * 0.3);
    f.Q.value = prof.q;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.6, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + prof.dur);
    src.connect(f); f.connect(env);
    this.route(env, { spatial: sp, gain: 0.5 });
    src.start(t); src.stop(t + prof.dur + 0.05);

    if (prof.tone) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(prof.f * (0.9 + Math.random() * 0.35), t);
      const oe = this.ctx.createGain();
      oe.gain.setValueAtTime(0.16, t);
      oe.gain.exponentialRampToValueAtTime(0.0001, t + prof.dur * 1.4);
      o.connect(oe);
      this.route(oe, { spatial: sp, gain: 0.4 });
      o.start(t); o.stop(t + prof.dur * 1.5);
    }
  }

  flesh(pos) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 6, 60);
    if (!sp) return;
    const t = this.ctx.currentTime + sp.delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.5;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 850;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.7, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    src.connect(f); f.connect(env);
    this.route(env, { spatial: sp, gain: 0.7 });
    src.start(t); src.stop(t + 0.2);
  }

  footstep(surface = 'concrete', pos, running) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this.lastFootstep < 0.09) return;
    this.lastFootstep = now;
    const sp = pos ? this.spatial(pos, 4, 34) : { gain: 1, pan: 0, lowpass: 20000, delay: 0 };
    if (!sp) return;
    const t = now + sp.delay;

    const bright = { metal: 3000, tile: 2200, marble: 2400, stone: 1500, concrete: 1400,
      asphalt: 1100, wood: 1000, sand: 700, dirt: 620, grass: 900 }[surface] ?? 1300;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1.6 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = bright * (0.85 + Math.random() * 0.3);
    f.Q.value = 1.1;
    const env = this.ctx.createGain();
    const amp = (running ? 0.32 : 0.18) * (pos ? 1 : 0.55);
    env.gain.setValueAtTime(amp, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(f); f.connect(env);
    this.route(env, { spatial: pos ? sp : null, gain: 0.7 });
    src.start(t); src.stop(t + 0.12);
  }

  click(kind = 'ui') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const freqs = { ui: 1400, back: 700, hover: 2200, error: 260, reload: 900, dry: 1800 };
    const o = this.ctx.createOscillator();
    o.type = kind === 'error' ? 'sawtooth' : 'square';
    o.frequency.setValueAtTime(freqs[kind] ?? 1400, t);
    o.frequency.exponentialRampToValueAtTime((freqs[kind] ?? 1400) * 0.6, t + 0.05);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.09, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g);
    this.route(g, { bus: 'ui', gain: 1 });
    o.start(t); o.stop(t + 0.09);
  }

  /** Mechanical reload sounds: mag out, mag in, bolt. */
  reloadSequence(duration, empty) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const at = [0.06, duration * 0.46];
    if (empty) at.push(duration * 0.84);
    at.forEach((offset, i) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 2.4;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = i === 0 ? 1800 : (i === 1 ? 1200 : 2600);
      f.Q.value = 4;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.24, t + offset);
      g.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.11);
      src.connect(f); f.connect(g);
      this.route(g, { gain: 0.8 });
      src.start(t + offset); src.stop(t + offset + 0.14);
    });
  }

  hitmarker(killed) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(killed ? 1180 : 1700, t);
    if (killed) o.frequency.setValueAtTime(1560, t + 0.05);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.13, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (killed ? 0.16 : 0.07));
    o.connect(g);
    this.route(g, { bus: 'ui', gain: 1 });
    o.start(t); o.stop(t + 0.2);
  }

  hurt() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.35;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 420;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(f); f.connect(g);
    this.route(g, { bus: 'ui', gain: 1 });
    src.start(t); src.stop(t + 0.35);
  }

  countdownBeep(final) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = final ? 1320 : 880;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 0.5 : 0.18));
    o.connect(g);
    this.route(g, { bus: 'ui', gain: 1 });
    o.start(t); o.stop(t + 0.6);
  }

  // ----------------------------------------------------------- fanfares
  async loadFanfareManifest() {
    try {
      // Resolved against this module — the game is served from a subpath on
      // GitHub Pages, where a leading slash points at the domain root.
      const base = new URL('../../assets/fanfares/', import.meta.url);
      const res = await fetch(new URL('manifest.json', base), { cache: 'no-cache' });
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.fanfares || [];
      this.fanfareFiles = list
        .filter((f) => f && f.file)
        .map((f) => ({
          id: f.id || `file_${f.file}`,
          name: f.name || f.file.replace(/\.[a-z0-9]+$/i, ''),
          file: new URL(f.file, base).href,
        }));

      // Bots draw their victory fanfare from the same pool the players do.
      // Seeding it here rather than off a user gesture means a bot created
      // before anyone touched the page still gets a real one.
      if (this.fanfareFiles.length) {
        const { setBotFanfarePool } = await import('../../shared/sim/bots.js');
        setBotFanfarePool(this.fanfareFiles.map((f) => f.id));
      }
    } catch {
      // No manifest — the built-in synthesised set is used.
    }
  }

  fanfareList() {
    return [...this.fanfareFiles, ...BUILTIN_FANFARES.map((f) => ({ id: f.id, name: f.name, builtin: true }))];
  }

  async loadBuffer(url) {
    if (this.buffers.has(url)) return this.buffers.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fanfare ${url} missing`);
    const raw = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(raw);
    this.buffers.set(url, buf);
    return buf;
  }

  /** Play a victory fanfare — a real audio file if one exists, else synth. */
  /**
   * Play a victory fanfare.
   * @returns {Promise<number>} how long it runs, in seconds — callers use it
   *   to clear whatever is on screen the moment the music stops.
   */
  async playFanfare(id) {
    if (!this.ready) return 0;
    const file = this.fanfareFiles.find((f) => f.id === id);
    if (file) {
      try {
        const buf = await this.loadBuffer(file.file);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.value = 1.0;
        src.connect(g); g.connect(this.music);
        src.start();
        return buf.duration;
      } catch {
        // Fall through to the synthesised version.
      }
    }
    const def = BUILTIN_FANFARES.find((f) => f.id === id) || BUILTIN_FANFARES[0];
    return this.synthFanfare(def);
  }

  /** @returns {number} seconds until the last note has decayed. */
  synthFanfare(def) {
    const t0 = this.ctx.currentTime + 0.05;
    const bus = this.ctx.createGain();
    bus.gain.value = 0.5;
    bus.connect(this.music);

    // A little hall so it does not sound like a phone ringtone.
    const conv = this.ctx.createConvolver();
    conv.buffer = this.makeImpulse(1.8, 2.6);
    const wet = this.ctx.createGain();
    wet.gain.value = 0.32;
    conv.connect(wet); wet.connect(this.music);

    for (const [at, note, dur] of def.notes) {
      const f = noteToFreq(note);
      for (const [mul, level, type] of [[1, 0.5, 'sawtooth'], [2, 0.16, 'triangle'], [0.5, 0.22, 'sine']]) {
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * mul;
        const g = this.ctx.createGain();
        const s = t0 + at;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(level, s + 0.02);
        g.gain.setValueAtTime(level, s + dur * 0.55);
        g.gain.exponentialRampToValueAtTime(0.0001, s + dur + 0.22);
        o.connect(g); g.connect(bus); g.connect(conv);
        o.start(s); o.stop(s + dur + 0.3);
      }
    }

    // A timpani-ish hit on the downbeat.
    const th = this.ctx.createOscillator();
    th.type = 'sine';
    th.frequency.setValueAtTime(120, t0);
    th.frequency.exponentialRampToValueAtTime(52, t0 + 0.4);
    const tg = this.ctx.createGain();
    tg.gain.setValueAtTime(0.5, t0);
    tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    th.connect(tg); tg.connect(bus);
    th.start(t0); th.stop(t0 + 0.7);

    let end = 0.7;
    for (const [at, , dur] of def.notes) end = Math.max(end, at + dur + 0.3);
    return end + 0.05;
  }

  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** Low tension bed during the pre-game intro. */
  startIntroBed() {
    if (!this.ready || this.introBed) return;
    const t = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(0.22, t + 1.5);
    bus.connect(this.music);

    const nodes = [];
    for (const [freq, type, level] of [[55, 'sine', 0.5], [82.5, 'triangle', 0.18], [110, 'sine', 0.22]]) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.value = level;
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.15 + Math.random() * 0.2;
      const lg = this.ctx.createGain();
      lg.gain.value = level * 0.4;
      lfo.connect(lg); lg.connect(g.gain);
      o.connect(g); g.connect(bus);
      o.start(t); lfo.start(t);
      nodes.push(o, lfo);
    }
    this.introBed = { bus, nodes };
  }

  stopIntroBed() {
    if (!this.introBed) return;
    const { bus, nodes } = this.introBed;
    this.introBed = null;
    const t = this.ctx.currentTime;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), t);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    for (const n of nodes) { try { n.stop(t + 0.9); } catch { /* already stopped */ } }
  }
}
