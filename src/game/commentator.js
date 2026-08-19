// The pre-game announcer.
//
// Reads the two rosters over the fly-through: "On Vanguard we have …, and on
// Sentinel we've got …".
//
// Why the browser's own speech synthesiser rather than recorded audio: player
// names are arbitrary strings. Anything pre-recorded can only ever say the
// names it was recorded with, so the moment a human joins the line breaks. The
// Web Speech API is the only option that can pronounce a name it has never
// seen, and it needs no key, no server and no download — which matters for a
// static deploy where any API key would ship to every visitor.
//
// The voice is chosen, not defaulted: browsers hand back a dozen and the first
// one is often a tinny fallback. Anything better later — a neural voice behind
// a proxy — only has to replace `speak`.

const SILENT = { speak() {}, cancel() {}, get speaking() { return false; } };

/** Names read aloud, not spelled out. */
export function sayable(name) {
  return String(name || '')
    // Trailing digits are lobby disambiguation, not part of the name.
    .replace(/[_\-.]+/g, ' ')
    .replace(/(\D)(\d{1,4})$/, '$1')
    // Split camel case so "RogueCrow" is two words rather than one shout.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim() || 'Operator';
}

/** "a, b, c and d" — the join an announcer actually uses. */
export function readList(names) {
  if (!names.length) return 'nobody';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export class Commentator {
  constructor(settings) {
    this.settings = settings || {};
    this.synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : SILENT;
    this.voice = null;
    this.enabled = true;
    this.pickVoice();
    // Chrome populates the voice list asynchronously and fires this once.
    if (this.synth.addEventListener) {
      this.synth.addEventListener('voiceschanged', () => this.pickVoice());
    }
  }

  /**
   * Prefer a deep English voice. The ranking is deliberately soft — the names
   * differ on every platform, so it scores rather than matches, and always
   * ends up with *something* English if anything English exists.
   */
  pickVoice() {
    if (!this.synth.getVoices) return;
    const all = this.synth.getVoices() || [];
    if (!all.length) return;

    const score = (v) => {
      const n = `${v.name} ${v.voiceURI}`.toLowerCase();
      let s = 0;
      if (/^en(-|_)?(gb|us|au)?/i.test(v.lang)) s += 10;
      if (/\ben-gb\b/i.test(v.lang)) s += 3;          // a touch of gravitas
      if (/(male|david|daniel|george|james|arthur|fred|alex|rishi)/.test(n)) s += 6;
      if (/(natural|neural|premium|enhanced)/.test(n)) s += 5;
      if (/(zira|female|samantha|karen|tessa|susan)/.test(n)) s -= 4;
      if (/(google)/.test(n)) s += 2;
      if (v.localService) s += 1;
      return s;
    };
    this.voice = all.slice().sort((a, b) => score(b) - score(a))[0] || null;
  }

  /** Master switch, so the settings screen can turn it off. */
  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.cancel();
  }

  cancel() {
    try { this.synth.cancel(); } catch { /* not supported */ }
  }

  /**
   * Say one line.
   * @param delay seconds to wait first, so lines can be laid over a camera move
   */
  speak(text, delay = 0) {
    if (!this.enabled || !text) return;
    if (typeof SpeechSynthesisUtterance === 'undefined') return;
    const fire = () => {
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = 0.98;      // just under conversational: it has to carry
      u.pitch = 0.85;     // down a little, for the broadcast register
      u.volume = Math.max(0, Math.min(1, this.settings.masterVolume ?? 0.8));
      try { this.synth.speak(u); } catch { /* blocked before a gesture */ }
    };
    if (delay > 0) setTimeout(fire, delay * 1000);
    else fire();
  }

  /**
   * The roster call. `teams` is TEAM_INFO or null; `players` is the match
   * roster. Split across two utterances so the pause between sides is real
   * rather than a comma the synthesiser might rush.
   */
  callRoster(players, teams, mapName) {
    if (!this.enabled || !players?.length) return;
    this.cancel();

    const named = (t) => players
      .filter((p) => p.team === t)
      .map((p) => sayable(p.name));

    if (mapName) this.speak(`Blackmoor. ${mapName}.`.replace(/^Blackmoor\. /, ''), 0.4);

    if (teams && teams.length >= 2) {
      const a = named(0), b = named(1);
      // Team names are stored in caps for the HUD. Some engines spell caps
      // out letter by letter, so they are spoken title-cased.
      const side = (t) => t.name.charAt(0) + t.name.slice(1).toLowerCase();
      if (a.length) this.speak(`On ${side(teams[0])}, we have ${readList(a)}.`, 1.6);
      if (b.length) this.speak(`And on ${side(teams[1])}, we've got ${readList(b)}.`, 5.4);
    } else {
      const all = players.map((p) => sayable(p.name));
      this.speak(`In the arena: ${readList(all)}.`, 1.6);
    }
  }
}
