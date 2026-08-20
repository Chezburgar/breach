// List the commentary clips and which slot each one is in.
//
//   node tools/vo-list.js
//
// Slots decide when a line can play. Move a clip between them by editing
// `slot` in public/assets/vo/manifest.json — nothing in the game code names
// a clip, so that file is the only place the booth is configured.
//
//   intro   plays under the pre-game fly-through; must fit inside it.
//           Give a clip a "map" and it is only ever heard on that map, which
//           is how each map gets its own opening. The total length of a map's
//           intro clips has to fit that map's introDuration.
//   round   a round starting or ending, and the end of the match
//   sting   short punctuation — a three-kill streak
//
// The `text` field is yours to fill in. Nothing reads it, but a line you
// cannot identify is a line you cannot place.

import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('public/assets/vo/manifest.json', 'utf8'));
const clips = manifest.clips || [];
const bySlot = new Map();
for (const c of clips) {
  if (!bySlot.has(c.slot)) bySlot.set(c.slot, []);
  bySlot.get(c.slot).push(c);
}

console.log(`BREACH — commentary booth (${clips.length} clips)\n`);
for (const slot of ['intro', 'elim', 'last', 'round', 'win']) {
  // Intro clips are a sequence, and one sequence per map, so list them the
  // way they play rather than interleaved.
  const list = (bySlot.get(slot) || []).sort((a, b) =>
    String(a.map || '').localeCompare(String(b.map || ''))
    || (a.order || 0) - (b.order || 0) || (a.team ?? 9) - (b.team ?? 9) || a.seconds - b.seconds);
  if (!list.length) continue;
  console.log(`${slot.toUpperCase()}  (${list.length})`);
  for (const c of list) {
    console.log(`  ${String(c.seconds).padStart(5)}s  ${('team ' + (c.team ?? '-')).padEnd(7)}`
      + `${(c.map || 'any map').padEnd(9)} ${c.id}`
      + (c.text ? `  "${c.text}"` : '  (unlabelled)'));
  }
  console.log();
}
const unknown = [...bySlot.keys()].filter((s) => !['intro','elim','last','round','win'].includes(s));
if (unknown.length) console.log(`Slots the game never plays: ${unknown.join(', ')}`);
const unlabelled = clips.filter((c) => !c.text).length;
if (unlabelled) console.log(`${unlabelled} clips have no text — fill them in to know what you are placing.`);
