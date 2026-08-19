// The commentary booth.
//
// Real recordings, played from /assets/vo. Two personas were supplied — an
// analyst and an Aussie colour commentator — and the booth alternates between
// them so consecutive lines sound like two people rather than one on a loop.
//
// Lines are chosen by *slot*, not by name: the intro wants a monologue that
// can run under the fly-through, the beats inside a round want something
// short. Nothing here reads a player's name, because no recording can say a
// name it has never heard and stitching one in from a synthesiser sounded
// worse than not saying it at all.
//
// Everything is data. Reslot a clip in manifest.json and it moves; add clips
// and they join the pool. There is no list of ids in this file.

const VO_DIR = new URL('../../assets/vo/', import.meta.url);

export class Commentator {
  constructor(settings, audio) {
    this.settings = settings || {};
    this.audio = audio || null;
    this.enabled = true;
    this.bySlot = new Map();     // slot -> clips
    this.lastId = new Map();     // slot -> last clip played
    this.lastPersona = null;
    this.token = 0;
    this.playing = null;
    this.ready = this.load();
  }

  async load() {
    try {
      const res = await fetch(new URL('manifest.json', VO_DIR), { cache: 'no-cache' });
      if (!res.ok) return;
      const data = await res.json();
      for (const c of (Array.isArray(data) ? data : data.clips) || []) {
        if (!c?.file) continue;
        const slot = c.slot || 'sting';
        if (!this.bySlot.has(slot)) this.bySlot.set(slot, []);
        this.bySlot.get(slot).push({ ...c, url: new URL(c.file, VO_DIR).href });
      }
    } catch {
      // No manifest: the booth is simply silent.
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.stop();
  }

  stop() {
    this.token++;
    if (this.playing) {
      try { this.playing.stop(); } catch { /* already ended */ }
      this.playing = null;
    }
  }

  get volume() {
    return Math.max(0, Math.min(1, this.settings.masterVolume ?? 0.8));
  }

  /**
   * Pick a line for a slot.
   *
   * Two rules, both about not sounding like a machine: never the same clip
   * twice running, and prefer the persona who did *not* speak last, so the
   * booth feels like a pair trading lines.
   */
  pick(slot, maxSeconds) {
    let pool = this.bySlot.get(slot) || [];
    if (maxSeconds) pool = pool.filter((c) => !c.seconds || c.seconds <= maxSeconds);
    if (!pool.length) return null;

    const last = this.lastId.get(slot);
    let choices = pool.filter((c) => c.id !== last);
    if (!choices.length) choices = pool;

    const fresh = choices.filter((c) => c.persona && c.persona !== this.lastPersona);
    if (fresh.length) choices = fresh;

    const pickOne = choices[Math.floor(Math.random() * choices.length)];
    this.lastId.set(slot, pickOne.id);
    this.lastPersona = pickOne.persona || null;
    return pickOne;
  }

  /**
   * Play one line from a slot. Interrupts whatever is talking, because two
   * commentators over each other is noise, not atmosphere.
   * @returns the clip played, or null
   */
  async play(slot, { maxSeconds, delay = 0 } = {}) {
    if (!this.enabled || !this.audio?.ready) return null;
    await this.ready;
    const clip = this.pick(slot, maxSeconds);
    if (!clip) return null;

    this.stop();
    const token = this.token;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000));
    if (token !== this.token) return null;

    try {
      const buf = await this.audio.loadBuffer(clip.url);
      if (token !== this.token) return null;
      const src = this.audio.ctx.createBufferSource();
      src.buffer = buf;
      const gain = this.audio.ctx.createGain();
      // Sits above the music: the booth is the thing you are meant to hear.
      gain.gain.value = this.volume;
      src.connect(gain); gain.connect(this.audio.music);
      src.onended = () => { if (this.playing === src) this.playing = null; };
      src.start();
      this.playing = src;
      return clip;
    } catch {
      return null;
    }
  }

  /** Opens the match, under the fly-through. */
  callIntro(seconds) {
    return this.play('intro', { maxSeconds: seconds, delay: 0.6 });
  }

  /** A round begins or ends. */
  callRound() { return this.play('round', { delay: 0.35 }); }

  /** A short punctuation mark — a streak, a clutch, the final blow. */
  callSting() { return this.play('sting', { delay: 0.2 }); }
}
