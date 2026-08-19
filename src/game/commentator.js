// The pre-game announcer.
//
// Reads the rosters over the fly-through: "On Vanguard we have …, and on
// Sentinel we've got …".
//
// There are two voices behind this, and it prefers the good one:
//
//   1. Recorded clips from /assets/vo. Real audio, however it was produced —
//      a human at a microphone or a neural TTS run offline. Names are their
//      own clips so the frame phrases and the roster can be recombined for
//      any line-up, which is how sports games have always done it.
//   2. The browser's speech synthesiser, for anything with no clip. It sounds
//      synthetic, but it can pronounce a name it has never seen, which no
//      recording can — so it is the floor rather than the ceiling.
//
// Lines are *chained*, not scheduled: each waits for the one before it to
// finish. Fixed delays cut the second roster off whenever the names ran long.

const VO_DIR = new URL('../../assets/vo/', import.meta.url);

/** Names read aloud, not spelled out. */
export function sayable(name) {
  return String(name || '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/(\D)(\d{1,4})$/, '$1')          // trailing lobby digits
    .replace(/([a-z])([A-Z])/g, '$1 $2')      // camel case is two words
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim() || 'Operator';
}

/** The id a recorded clip would have. */
export const clipId = (text) =>
  String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** "a, b, c and d" — the join an announcer actually uses. */
export function readList(names) {
  if (!names.length) return 'nobody';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export class Commentator {
  constructor(settings, audio) {
    this.settings = settings || {};
    this.audio = audio || null;
    this.synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    this.voice = null;
    this.enabled = true;
    this.clips = new Map();      // id -> url
    this.queue = [];
    this.busy = false;
    this.token = 0;              // cancels anything still queued from before

    this.pickVoice();
    this.synth?.addEventListener?.('voiceschanged', () => this.pickVoice());
    this.loadManifest();
  }

  /** Recorded lines, if any have been dropped in. */
  async loadManifest() {
    try {
      const res = await fetch(new URL('manifest.json', VO_DIR), { cache: 'no-cache' });
      if (!res.ok) return;
      const data = await res.json();
      for (const entry of (Array.isArray(data) ? data : data.clips) || []) {
        if (entry?.id && entry.file) {
          this.clips.set(entry.id, new URL(entry.file, VO_DIR).href);
        }
      }
    } catch {
      // No manifest is the normal case; the synthesiser covers everything.
    }
  }

  /**
   * Prefer a deep English voice. Scored rather than matched, because the names
   * differ on every platform and a hard match finds nothing on most of them.
   */
  pickVoice() {
    const all = this.synth?.getVoices?.() || [];
    if (!all.length) return;
    const score = (v) => {
      const n = `${v.name} ${v.voiceURI}`.toLowerCase();
      let s = 0;
      if (/^en(-|_)?(gb|us|au)?/i.test(v.lang)) s += 10;
      if (/\ben-gb\b/i.test(v.lang)) s += 3;
      if (/(male|david|daniel|george|james|arthur|fred|alex|rishi)/.test(n)) s += 6;
      if (/(natural|neural|premium|enhanced)/.test(n)) s += 5;
      if (/(zira|female|samantha|karen|tessa|susan)/.test(n)) s -= 4;
      if (/google/.test(n)) s += 2;
      if (v.localService) s += 1;
      return s;
    };
    this.voice = all.slice().sort((a, b) => score(b) - score(a))[0] || null;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.cancel();
  }

  cancel() {
    this.token++;
    this.queue.length = 0;
    this.busy = false;
    try { this.synth?.cancel(); } catch { /* not supported */ }
    if (this.playing) { try { this.playing.stop(); } catch { /* ended */ } this.playing = null; }
  }

  get volume() {
    return Math.max(0, Math.min(1, this.settings.masterVolume ?? 0.8));
  }

  /**
   * Say a sequence, each line waiting for the last to finish.
   * @param lines `[{ text, clip }]` — `clip` names a recording to prefer.
   */
  say(lines) {
    if (!this.enabled) return;
    this.cancel();
    const token = this.token;
    this.queue = lines.filter(Boolean);
    this.drain(token);
  }

  async drain(token) {
    if (token !== this.token) return;
    const next = this.queue.shift();
    if (!next) { this.busy = false; return; }
    this.busy = true;
    await this.utter(next, token);
    if (token === this.token) this.drain(token);
  }

  /**
   * One line. Played from recordings only if *every* fragment of it exists —
   * a sentence that switches from a real voice to a synthetic one halfway
   * through sounds worse than either voice alone.
   */
  async utter(line, token) {
    const parts = line.parts || (line.clip ? [{ clip: line.clip }] : []);
    const urls = parts.map((f) => f.clip && this.clips.get(f.clip));
    if (parts.length && urls.every(Boolean) && this.audio?.ready) {
      for (const url of urls) {
        if (token !== this.token) return;
        await this.playClip(url, token);
      }
      return;
    }
    await this.speak(line.text, token);
  }

  playClip(url, token) {
    return new Promise((resolve) => {
      this.audio.loadBuffer(url).then((buf) => {
        if (token !== this.token) return resolve();
        const src = this.audio.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.audio.ctx.createGain();
        g.gain.value = this.volume;
        src.connect(g); g.connect(this.audio.music);
        src.onended = () => { this.playing = null; resolve(); };
        src.start();
        this.playing = src;
      }).catch(() => resolve());
    });
  }

  speak(text, token) {
    return new Promise((resolve) => {
      if (!text || typeof SpeechSynthesisUtterance === 'undefined' || !this.synth) {
        return resolve();
      }
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = 0.98;
      u.pitch = 0.85;
      u.volume = this.volume;
      u.onend = resolve;
      u.onerror = resolve;
      // Some engines never fire onend; do not let the chain stall on it.
      const guard = setTimeout(resolve, 2000 + text.length * 90);
      const done = () => clearTimeout(guard);
      u.addEventListener('end', done);
      u.addEventListener('error', done);
      if (token !== this.token) return resolve();
      try { this.synth.speak(u); } catch { resolve(); }
    });
  }

  /**
   * The roster call, as a chain so it always finishes whatever the line-up.
   * Every fragment names a clip, so dropping recordings in upgrades the voice
   * without touching this.
   */
  callRoster(players, teams, mapName) {
    if (!this.enabled || !players?.length) return;
    const named = (t) => players.filter((p) => p.team === t).map((p) => sayable(p.name));
    const lines = [];

    if (mapName) {
      lines.push({ text: `${mapName}.`, parts: [{ clip: `map_${clipId(mapName)}` }] });
    }

    if (teams && teams.length >= 2) {
      const side = (t) => t.name.charAt(0) + t.name.slice(1).toLowerCase();
      const a = named(0), b = named(1);
      // Fragments: the frame, then a clip per name, with "and" before the
      // last. Recording every possible line-up is impossible, so the pieces
      // are recorded once and recombined — the way sports games do it.
      const roster = (frame, names) => [
        { clip: frame },
        ...names.flatMap((n, i) => (
          i === names.length - 1 && names.length > 1
            ? [{ clip: 'frame_and' }, { clip: `name_${clipId(n)}` }]
            : [{ clip: `name_${clipId(n)}` }]
        )),
      ];
      if (a.length) {
        lines.push({
          text: `On ${side(teams[0])}, we have ${readList(a)}.`,
          parts: roster('frame_on_vanguard', a),
        });
      }
      if (b.length) {
        lines.push({
          text: `And on ${side(teams[1])}, we've got ${readList(b)}.`,
          parts: roster('frame_on_sentinel', b),
        });
      }
    } else {
      lines.push({ text: `In the arena: ${readList(players.map((p) => sayable(p.name)))}.` });
    }
    this.say(lines);
  }
}
