// Banners and victory fanfares.
//
// Banners are drawn procedurally in the browser from these recipes, so the game
// ships with a full set out of the box. Drop image files into
// `public/assets/banners/` and list them in that folder's manifest.json and they
// are merged in on top of these — same for fanfares in `public/assets/fanfares/`.

export const BANNER_PATTERNS = [
  'diagonal', 'chevron', 'hazard', 'grid', 'camo', 'rays',
  'splitv', 'circuit', 'topo', 'stripes', 'hex', 'smoke',
];

export const BANNER_EMBLEMS = [
  'skull', 'crosshair', 'wolf', 'eagle', 'triangle', 'bolt',
  'anchor', 'star', 'flame', 'shield', 'snake', 'hexmark',
];

/** The built-in banner set. `rarity` only drives the frame treatment. */
export const BANNERS = [
  { id: 'std_ash',     name: 'Ashfall',        pattern: 'diagonal', emblem: 'flame',     colors: ['#1d1f24', '#ff6a3d', '#ffc48a'], rarity: 'common' },
  { id: 'std_frost',   name: 'Coldfront',      pattern: 'chevron',  emblem: 'shield',    colors: ['#101a24', '#39b7ff', '#c9ecff'], rarity: 'common' },
  { id: 'std_hazard',  name: 'Hazard Line',    pattern: 'hazard',   emblem: 'triangle',  colors: ['#17181b', '#ffd23f', '#3c3d42'], rarity: 'common' },
  { id: 'std_grid',    name: 'Gridlock',       pattern: 'grid',     emblem: 'crosshair', colors: ['#0e1418', '#4de0a4', '#0b2620'], rarity: 'common' },
  { id: 'std_dune',    name: 'Dune Recon',     pattern: 'camo',     emblem: 'eagle',     colors: ['#4a4230', '#a89468', '#2c2820'], rarity: 'uncommon' },
  { id: 'std_verdant', name: 'Verdant',        pattern: 'camo',     emblem: 'snake',     colors: ['#26331f', '#5d7a41', '#161d13'], rarity: 'uncommon' },
  { id: 'std_rays',    name: 'Sunburst',       pattern: 'rays',     emblem: 'star',      colors: ['#2a1330', '#ff4d8d', '#ffd166'], rarity: 'uncommon' },
  { id: 'std_split',   name: 'Split Decision', pattern: 'splitv',   emblem: 'skull',     colors: ['#15171c', '#e8e8ea', '#c0392b'], rarity: 'uncommon' },
  { id: 'std_circuit', name: 'Mainline',       pattern: 'circuit',  emblem: 'bolt',      colors: ['#08131a', '#22d3ee', '#0f2f3a'], rarity: 'rare' },
  { id: 'std_topo',    name: 'Contour',        pattern: 'topo',     emblem: 'anchor',    colors: ['#131a22', '#7dd3fc', '#1e2a36'], rarity: 'rare' },
  { id: 'std_wolf',    name: 'Nightpack',      pattern: 'smoke',    emblem: 'wolf',      colors: ['#0d0f14', '#8b95a7', '#e5e9f0'], rarity: 'rare' },
  { id: 'std_stripe',  name: 'Regiment',       pattern: 'stripes',  emblem: 'hexmark',   colors: ['#1b1410', '#c9a227', '#3a2c1c'], rarity: 'rare' },
  { id: 'std_ember',   name: 'Ember Watch',    pattern: 'rays',     emblem: 'flame',     colors: ['#1a0d0a', '#ff7a18', '#ffb703'], rarity: 'epic' },
  { id: 'std_void',    name: 'Voidwalker',     pattern: 'hex',      emblem: 'hexmark',   colors: ['#0a0a12', '#7c3aed', '#c4b5fd'], rarity: 'epic' },
  { id: 'std_apex',    name: 'Apex',           pattern: 'chevron',  emblem: 'crosshair', colors: ['#101010', '#f5f5f5', '#ff2d55'], rarity: 'epic' },
  { id: 'std_gold',    name: 'Laurel',         pattern: 'diagonal', emblem: 'star',      colors: ['#14100a', '#e6c157', '#fff3c4'], rarity: 'legendary' },
];

export const DEFAULT_BANNER = 'std_ash';

export const RARITY_COLORS = {
  common: '#8b93a1',
  uncommon: '#4de0a4',
  rare: '#3ba9ff',
  epic: '#a06bff',
  legendary: '#ffc24a',
};

// Fanfares are real audio files listed in /assets/fanfares/manifest.json.
// There is no synthesised fallback set — a placeholder chiptune played over
// somebody’s elimination banner is worse than silence.
export const BUILTIN_FANFARES = [];

export const DEFAULT_FANFARE = 'ff_charge';

const NAMES_A = ['Iron', 'Silent', 'Grim', 'Red', 'Cold', 'Wired', 'Rogue', 'Steel', 'Ghost', 'Blunt', 'Swift', 'Dead'];
const NAMES_B = ['Wolf', 'Fox', 'Vector', 'Sparrow', 'Anvil', 'Ember', 'Cipher', 'Reaper', 'Vandal', 'Kite', 'Nomad', 'Crow'];

export function randomName(rng = Math.random) {
  const a = NAMES_A[Math.floor(rng() * NAMES_A.length)];
  const bb = NAMES_B[Math.floor(rng() * NAMES_B.length)];
  return `${a}${bb}${Math.floor(rng() * 90 + 10)}`;
}

// Control characters plus the invisible formatting ranges people use to fake
// blank names or spoof someone else's.
const INVISIBLE_RANGES = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f],
  [0x2028, 0x202f], [0x2060, 0x206f], [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(
  '[' + INVISIBLE_RANGES.map(([a, z]) => String.fromCharCode(a) + '-' + String.fromCharCode(z)).join('') + ']',
  'g'
);

export function sanitizeName(raw) {
  const s = String(raw ?? '').replace(INVISIBLE, '').trim();
  if (!s) return null;
  return s.slice(0, 16);
}

export function bannerById(id, extra = []) {
  return [...BANNERS, ...extra].find((b) => b.id === id) || BANNERS[0];
}

/** XP curve: reaching level N takes 500 * (N-1)^1.35 total XP. */
export function xpForLevel(level) {
  return Math.round(500 * Math.pow(Math.max(0, level - 1), 1.35));
}

export function levelFromXp(xp) {
  let lvl = 1;
  while (lvl < 200 && xp >= xpForLevel(lvl + 1)) lvl++;
  return lvl;
}
