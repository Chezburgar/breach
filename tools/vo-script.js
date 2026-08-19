// Print every line the announcer can say, with the filename each one needs.
//
// Run:  node tools/vo-script.js            (human-readable)
//       node tools/vo-script.js --json     (for feeding a TTS API)
//
// Produce the audio however you like — a microphone, ElevenLabs, Azure, or
// `say -o` on a Mac — drop the files in public/assets/vo/, list them in
// manifest.json, and the game prefers them over the browser's synthesiser.
// Anything missing simply falls back, so a partial set is fine.

import { MAP_INFO, COMBAT_MAPS } from '../shared/maps/index.js';
import { TEAM_INFO } from '../shared/constants.js';
import { BOT_NAMES } from '../shared/sim/bots.js';

const clipId = (text) =>
  String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const lines = [];
const add = (id, text, note) => lines.push({ id, file: `${id}.mp3`, text, note });

// --- map call ------------------------------------------------------------
for (const id of COMBAT_MAPS) {
  add(`map_${clipId(MAP_INFO[id].name)}`, `${MAP_INFO[id].name}.`, 'opens the fly-through');
}

// --- roster frames -------------------------------------------------------
// Recorded whole, per line-up, is impossible for arbitrary players. These are
// the *fragments*: record them with list intonation — rising on the frame,
// falling on the last name — so they sit together when stitched.
add('frame_on_vanguard', `On ${title(TEAM_INFO[0].name)}, we have`, 'leads the first roster');
add('frame_on_sentinel', `And on ${title(TEAM_INFO[1].name)}, we've got`, 'leads the second');
add('frame_and', 'and', 'before the last name in a list');

// --- names ---------------------------------------------------------------
// The bots are a fixed cast, so every one of them can be a real recording.
// Human players fall back to the synthesiser; there is no way around that.
for (const n of BOT_NAMES) add(`name_${clipId(n)}`, n, 'bot name, rising intonation');

function title(s) { return s.charAt(0) + s.slice(1).toLowerCase(); }

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ clips: lines }, null, 2));
} else {
  console.log(`BREACH — announcer script (${lines.length} clips)\n`);
  let group = '';
  for (const l of lines) {
    const g = l.id.split('_')[0];
    if (g !== group) { group = g; console.log(); }
    console.log(`  ${l.file.padEnd(28)} "${l.text}"`);
  }
  console.log(`
Drop the files in public/assets/vo/ and list them in manifest.json:

  { "clips": [ { "id": "map_blackmoor_estate", "file": "map_blackmoor_estate.mp3" } ] }

Only the ids above are looked for. Anything absent falls back to the browser
voice, so you can record the map call first and add names later.`);
}
