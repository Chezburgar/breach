// The commentary booth.
//
// Plays recorded lines from /assets/vo against match events. Two rules run
// the whole thing:
//
//   Nothing overlaps. One line at a time, always — two commentators talking
//   over each other is noise, not atmosphere.
//
//   Late is worse than silent. A booth is only convincing if it reacts to
//   what just happened, so a line that has waited too long is dropped rather
//   than played against the wrong moment. Eliminations are frequent and
//   cheap; a round result is worth waiting for.
//
// Which clip belongs to which moment is entirely in manifest.json. Nothing
// here names a file.

const VO_DIR = new URL('../../assets/vo/', import.meta.url);

// How long a queued line stays worth playing, and how hard it pushes.
// A win announcement outranks everything and never expires; an elimination
// call is stale almost immediately.
const SLOTS = {
  win:   { priority: 100, staleAfter: Infinity },
  round: { priority: 80,  staleAfter: 6 },
  intro: { priority: 70,  staleAfter: Infinity },
  last:  { priority: 50,  staleAfter: 3 },
  elim:  { priority: 10,  staleAfter: 1.6 },
};

const GAP = 0.18;   // seconds of air between lines

export class Commentator {
  constructor(settings, audio) {
    this.settings = settings || {};
    this.audio = audio || null;
    this.enabled = true;
    this.clips = [];
    this.queue = [];
    this.current = null;
    this.freeAt = 0;
    this.lastPick = new Map();
    this.ready = this.load();
  }

  async load() {
    try {
      const res = await fetch(new URL('manifest.json', VO_DIR), { cache: 'no-cache' });
      if (!res.ok) return;
      const data = await res.json();
      this.clips = ((Array.isArray(data) ? data : data.clips) || [])
        .filter((c) => c?.file)
        .map((c) => ({ ...c, url: new URL(c.file, VO_DIR).href }));
    } catch {
      // No manifest: the booth stays quiet.
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.reset();
  }

  /** Stop everything and forget what was waiting. */
  reset() {
    this.queue.length = 0;
    this.starting = false;
    if (this.current) {
      try { this.current.stop(); } catch { /* already ended */ }
      this.current = null;
    }
    this.freeAt = 0;
  }

  get now() { return performance.now() / 1000; }

  get volume() {
    return Math.max(0, Math.min(1, this.settings.masterVolume ?? 0.8));
  }

  /** Clips for a slot, optionally for one team. */
  pool(slot, team) {
    return this.clips.filter((c) => c.slot === slot
      && (team == null || c.team == null || c.team === team));
  }

  /**
   * Ask for a line. It joins the queue rather than interrupting; whether it
   * is ever heard depends on how long the booth stays busy.
   *
   * @param opts.team    restrict to one side's clips
   * @param opts.maxSeconds only consider lines that fit
   * @param opts.ordered play the pool in `order`, not at random
   */
  async say(slot, opts = {}) {
    if (!this.enabled) return;
    await this.ready;
    const cfg = SLOTS[slot];
    if (!cfg) return;

    let pool = this.pool(slot, opts.team);
    if (opts.maxSeconds) pool = pool.filter((c) => !c.seconds || c.seconds <= opts.maxSeconds);
    if (!pool.length) return;

    if (opts.ordered) {
      // A sequence: queue the lot, in order, as one block.
      const seq = pool.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const clip of seq) this.enqueue(clip, cfg, slot);
    } else {
      this.enqueue(this.choose(pool, slot), cfg, slot);
    }
    this.pump();
  }

  /** Never the same line twice running, when there is an alternative. */
  choose(pool, slot) {
    const last = this.lastPick.get(slot);
    const fresh = pool.filter((c) => c.id !== last);
    const from = fresh.length ? fresh : pool;
    const clip = from[Math.floor(Math.random() * from.length)];
    this.lastPick.set(slot, clip.id);
    return clip;
  }

  enqueue(clip, cfg, slot) {
    this.queue.push({ clip, slot, priority: cfg.priority, staleAfter: cfg.staleAfter, at: this.now });
    // Highest priority first; within a priority, the order they arrived —
    // which is what keeps a numbered sequence in sequence.
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
  }

  /**
   * Start the next line if nothing is talking.
   *
   * `starting` is not redundant with `current`. Decoding the clip is
   * asynchronous, so between the guard below and the moment a source is
   * actually assigned there is an await — and two events arriving inside that
   * window would both pass the guard and both start playing. That is exactly
   * what a kill landing as a round ends does, and it is why the elimination
   * and round-won lines talked over each other.
   */
  async pump() {
    if (!this.enabled || this.starting || this.current || !this.audio?.ready) return;
    if (this.now < this.freeAt) {
      setTimeout(() => this.pump(), (this.freeAt - this.now) * 1000);
      return;
    }

    // Drop anything that has been waiting past its moment.
    const now = this.now;
    while (this.queue.length && now - this.queue[0].at > this.queue[0].staleAfter) {
      this.queue.shift();
    }
    const next = this.queue.shift();
    if (!next) return;

    // Claimed synchronously, before the first await.
    this.starting = true;
    try {
      const buf = await this.audio.loadBuffer(next.clip.url);
      if (!this.enabled) { this.starting = false; return; }
      const src = this.audio.ctx.createBufferSource();
      src.buffer = buf;
      const gain = this.audio.ctx.createGain();
      gain.gain.value = this.volume;
      src.connect(gain); gain.connect(this.audio.music);
      src.onended = () => {
        if (this.current === src) this.current = null;
        this.freeAt = this.now + GAP;
        this.pump();
      };
      src.start();
      this.current = src;
      this.starting = false;
      this.lastPlayed = next.clip.id;
    } catch {
      this.current = null;
      this.starting = false;
      this.pump();
    }
  }

  // ------------------------------------------------------------- moments
  /** The three opening lines, in order, under the fly-through. */
  callIntro() {
    this.reset();
    return this.say('intro', { ordered: true });
  }

  /**
   * Somebody died. The side that did it gets the call — unless the kill left
   * a team on their last player, which is the more interesting fact.
   */
  callKill(killerTeam, alive) {
    if (killerTeam == null || killerTeam < 0) return;
    const cornered = (alive || []).findIndex((n) => n === 1);
    if (cornered >= 0) return this.say('last', { team: cornered });
    return this.say('elim', { team: killerTeam });
  }

  callRoundWon(team) {
    if (team == null || team < 0) return;
    return this.say('round', { team });
  }

  callMatchWon(team) {
    if (team == null || team < 0) return;
    return this.say('win', { team });
  }

  stop() { this.reset(); }
}
