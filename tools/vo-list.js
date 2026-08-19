// List the commentary clips and which slot each one is in.
//
//   node tools/vo-list.js
//
// Slots decide when a line can play. Move a clip between them by editing
// `slot` in public/assets/vo/manifest.json — nothing in the game code names
// a clip, so that file is the only place the booth is configured.
//
//   intro   plays under the pre-game fly-through; must fit inside it
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
for (const slot of ['intro', 'round', 'sting']) {
  const list = (bySlot.get(slot) || []).sort((a, b) => a.seconds - b.seconds);
  if (!list.length) continue;
  console.log(`${slot.toUpperCase()}  (${list.length})`);
  for (const c of list) {
    console.log(`  ${String(c.seconds).padStart(5)}s  ${c.persona.padEnd(8)} ${c.id}`
      + (c.text ? `  "${c.text}"` : '  (unlabelled)'));
  }
  console.log();
}
const unknown = [...bySlot.keys()].filter((s) => !['intro', 'round', 'sting'].includes(s));
if (unknown.length) console.log(`Slots the game never plays: ${unknown.join(', ')}`);
const unlabelled = clips.filter((c) => !c.text).length;
if (unlabelled) console.log(`${unlabelled} clips have no text — fill them in to know what you are placing.`);
