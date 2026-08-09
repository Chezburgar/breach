// Weapon definitions. Siege-flavoured handling: real recoil patterns, per-weapon
// optics, attachments that actually change the numbers, and damage drop-off.
//
// Shared so the server can validate fire rate / damage and the client can
// predict recoil and build the view model.

import { hashString, makeRng, clamp } from './mathx.js';

// --- Optics -------------------------------------------------------------
// `mag` drives the true ADS field of view, so every scope below is a working
// scope rather than a decal. Anything at 2x or above renders picture-in-picture.
export const SCOPES = {
  iron:   { id: 'iron',   name: 'Iron Sights',      mag: 1.0, reticle: 'iron',    pip: false, glass: false },
  reddot: { id: 'reddot', name: 'Red Dot Sight A',  mag: 1.0, reticle: 'dot',     pip: false, glass: true, tint: 0xff3b30 },
  holo:   { id: 'holo',   name: 'Holo Sight B',     mag: 1.0, reticle: 'holo',    pip: false, glass: true, tint: 0xff4a3a },
  reflex: { id: 'reflex', name: 'Reflex Sight C',   mag: 1.0, reticle: 'chevron', pip: false, glass: true, tint: 0x37ff8b },
  x15:    { id: 'x15',    name: '1.5x Scope',       mag: 1.5, reticle: 'x15',     pip: false, glass: true, tint: 0xff5540 },
  x2:     { id: 'x2',     name: '2.0x Scope',       mag: 2.0, reticle: 'x2',      pip: true,  glass: true, tint: 0xff5540 },
  x25:    { id: 'x25',    name: '2.5x Scope',       mag: 2.5, reticle: 'x25',     pip: true,  glass: true, tint: 0xff5540 },
  x3:     { id: 'x3',     name: '3.0x Scope',       mag: 3.0, reticle: 'x3',      pip: true,  glass: true, tint: 0xff5540 },
};

// --- Attachments --------------------------------------------------------
export const MUZZLES = {
  none:        { id: 'none',        name: 'None',            recoil: 1.00, spread: 1.00, loud: 1.00, flash: 1.00 },
  flash:       { id: 'flash',       name: 'Flash Hider',     recoil: 0.94, spread: 1.00, loud: 1.00, flash: 0.35 },
  compensator: { id: 'compensator', name: 'Compensator',     recoil: 0.82, spread: 1.06, loud: 1.00, flash: 0.85 },
  brake:       { id: 'brake',       name: 'Muzzle Brake',    recoil: 0.88, spread: 0.86, loud: 1.10, flash: 0.90 },
  suppressor:  { id: 'suppressor',  name: 'Suppressor',      recoil: 0.96, spread: 0.96, loud: 0.30, flash: 0.05, damage: 0.94, hideTracer: true },
  extended:    { id: 'extended',    name: 'Extended Barrel', recoil: 1.06, spread: 1.00, loud: 1.05, flash: 1.00, damage: 1.12 },
};

export const GRIPS = {
  none:     { id: 'none',     name: 'None',           recoil: 1.00, adsTime: 1.00 },
  vertical: { id: 'vertical', name: 'Vertical Grip',  recoil: 0.86, adsTime: 1.00 },
  angled:   { id: 'angled',   name: 'Angled Grip',    recoil: 0.96, adsTime: 0.86 },
};

export const LASERS = {
  none:  { id: 'none',  name: 'None',  hipSpread: 1.00, visible: false },
  laser: { id: 'laser', name: 'Laser', hipSpread: 0.80, visible: true },
};

const AR = 'Assault Rifle', SMG = 'SMG', LMG = 'LMG', DMR = 'Marksman Rifle',
      SG = 'Shotgun', PISTOL = 'Sidearm';

/**
 * Every gun. `shape` drives the procedurally built view model, so silhouettes
 * stay distinct without shipping a single mesh file.
 */
const DEFS = [
  // ---------------- Assault rifles ----------------
  {
    id: 'r4c', name: 'R4-C', cls: AR, slot: 'primary', tier: 1,
    damage: 45, rpm: 860, mag: 30, reserve: 150, fireModes: ['auto', 'semi'],
    reload: 2.35, reloadEmpty: 3.05, adsTime: 0.26, mobility: 0.90,
    falloff: { start: 22, end: 48, minMul: 0.62 }, pen: 0.16,
    recoil: { vert: 0.62, vertVar: 0.10, horiz: 0.30, drift: 0.42, recovery: 7.4, firstShot: 1.35, kick: 0.020 },
    spread: { hip: 2.9, hipMove: 2.2, ads: 0.16, adsMove: 0.9, growth: 0.36, decay: 5.2, max: 6.5 },
    scopes: ['iron', 'reddot', 'holo', 'reflex', 'x15', 'x25'], defaultScope: 'holo',
    shape: { family: 'ar', barrel: 0.40, handguard: 'rail', stock: 'collapsible', mag: 'straight', body: 0x2c2e33, furn: 0x24262a, len: 0.62 },
  },
  {
    id: 'ak12', name: 'AK-12', cls: AR, slot: 'primary', tier: 1,
    damage: 46, rpm: 850, mag: 30, reserve: 150, fireModes: ['auto', 'burst', 'semi'],
    reload: 2.55, reloadEmpty: 3.30, adsTime: 0.28, mobility: 0.86,
    falloff: { start: 24, end: 52, minMul: 0.60 }, pen: 0.20,
    recoil: { vert: 0.74, vertVar: 0.12, horiz: 0.34, drift: -0.50, recovery: 6.8, firstShot: 1.30, kick: 0.024 },
    spread: { hip: 3.2, hipMove: 2.4, ads: 0.17, adsMove: 1.0, growth: 0.40, decay: 5.0, max: 7.0 },
    scopes: ['iron', 'reddot', 'holo', 'reflex', 'x15', 'x25'], defaultScope: 'reddot',
    shape: { family: 'ar', barrel: 0.44, handguard: 'polymer', stock: 'fixed', mag: 'curved', body: 0x33302b, furn: 0x3d2f22, len: 0.64 },
  },
  {
    id: 'c416', name: '416-C Carbine', cls: AR, slot: 'primary', tier: 1,
    damage: 38, rpm: 740, mag: 30, reserve: 150, fireModes: ['auto', 'semi'],
    reload: 2.30, reloadEmpty: 3.00, adsTime: 0.25, mobility: 0.91,
    falloff: { start: 24, end: 50, minMul: 0.64 }, pen: 0.16,
    recoil: { vert: 0.52, vertVar: 0.08, horiz: 0.24, drift: 0.30, recovery: 8.0, firstShot: 1.25, kick: 0.017 },
    spread: { hip: 2.7, hipMove: 2.0, ads: 0.14, adsMove: 0.85, growth: 0.31, decay: 5.6, max: 6.0 },
    scopes: ['iron', 'reddot', 'holo', 'reflex', 'x15', 'x2', 'x25'], defaultScope: 'reflex',
    shape: { family: 'ar', barrel: 0.38, handguard: 'rail', stock: 'collapsible', mag: 'straight', body: 0x2a2c30, furn: 0x232529, len: 0.60 },
  },
  {
    id: 'l85a2', name: 'L85A2', cls: AR, slot: 'primary', tier: 2,
    damage: 40, rpm: 670, mag: 30, reserve: 150, fireModes: ['auto', 'semi'],
    reload: 2.60, reloadEmpty: 3.35, adsTime: 0.27, mobility: 0.88,
    falloff: { start: 26, end: 54, minMul: 0.66 }, pen: 0.18,
    recoil: { vert: 0.48, vertVar: 0.07, horiz: 0.20, drift: 0.22, recovery: 8.6, firstShot: 1.20, kick: 0.016 },
    spread: { hip: 3.0, hipMove: 2.1, ads: 0.13, adsMove: 0.80, growth: 0.28, decay: 5.8, max: 6.0 },
    scopes: ['iron', 'reddot', 'holo', 'reflex', 'x15', 'x2', 'x25', 'x3'], defaultScope: 'x15',
    shape: { family: 'bullpup', barrel: 0.34, handguard: 'polymer', stock: 'bullpup', mag: 'straight', body: 0x22261f, furn: 0x1b1f19, len: 0.70 },
  },
  {
    id: 'f2', name: 'F2', cls: AR, slot: 'primary', tier: 2,
    damage: 37, rpm: 980, mag: 25, reserve: 125, fireModes: ['auto', 'burst'],
    reload: 2.45, reloadEmpty: 3.15, adsTime: 0.24, mobility: 0.92,
    falloff: { start: 20, end: 44, minMul: 0.60 }, pen: 0.14,
    recoil: { vert: 0.58, vertVar: 0.11, horiz: 0.36, drift: -0.38, recovery: 8.2, firstShot: 1.15, kick: 0.018 },
    spread: { hip: 3.1, hipMove: 2.3, ads: 0.18, adsMove: 0.95, growth: 0.34, decay: 6.0, max: 6.8 },
    scopes: ['iron', 'reddot', 'holo', 'reflex', 'x15', 'x2'], defaultScope: 'holo',
    shape: { family: 'bullpup', barrel: 0.36, handguard: 'polymer', stock: 'bullpup', mag: 'straight', body: 0x2f3134, furn: 0x26282b, len: 0.68 },
  },
  {
    id: 'aug', name: 'AUG A2', cls: AR, slot: 'primary', tier: 2,
    damage: 38, rpm: 720, mag: 30, reserve: 150, fireModes: ['auto', 'semi'],
    reload: 2.50, reloadEmpty: 3.20, adsTime: 0.26, mobility: 0.89,
    falloff: { start: 25, end: 52, minMul: 0.64 }, pen: 0.17,
    recoil: { vert: 0.50, vertVar: 0.08, horiz: 0.22, drift: 0.34, recovery: 8.4, firstShot: 1.22, kick: 0.016 },
    spread: { hip: 2.9, hipMove: 2.0, ads: 0.14, adsMove: 0.82, growth: 0.30, decay: 5.7, max: 6.2 },
    scopes: ['reddot', 'holo', 'reflex', 'x15', 'x2', 'x25'], defaultScope: 'x2',
    shape: { family: 'bullpup', barrel: 0.35, handguard: 'polymer', stock: 'bullpup', mag: 'straight', body: 0x3a3128, furn: 0x2e281f, len: 0.66 },
  },

  // ---------------- SMGs ----------------
  {
    id: 'mp5', name: 'MP5', cls: SMG, slot: 'primary', tier: 1,
    damage: 27, rpm: 800, mag: 30, reserve: 180, fireModes: ['auto', 'burst', 'semi'],
    reload: 2.20, reloadEmpty: 2.90, adsTime: 0.21, mobility: 0.96,
    falloff: { start: 16, end: 36, minMul: 0.55 }, pen: 0.08,
    recoil: { vert: 0.34, vertVar: 0.06, horiz: 0.18, drift: 0.26, recovery: 9.4, firstShot: 1.10, kick: 0.012 },
    spread: { hip: 2.4, hipMove: 1.7, ads: 0.13, adsMove: 0.72, growth: 0.24, decay: 6.6, max: 5.2 },
    scopes: ['iron', 'reddot', 'holo', 'reflex', 'x15'], defaultScope: 'reddot',
    shape: { family: 'smg', barrel: 0.24, handguard: 'polymer', stock: 'collapsible', mag: 'curved', body: 0x26282c, furn: 0x1f2124, len: 0.46 },
  },
  {
    id: 'vector', name: 'Vector .45 ACP', cls: SMG, slot: 'primary', tier: 1,
    damage: 21, rpm: 1200, mag: 25, reserve: 175, fireModes: ['auto', 'burst'],
    reload: 2.15, reloadEmpty: 2.80, adsTime: 0.20, mobility: 0.97,
    falloff: { start: 13, end: 30, minMul: 0.52 }, pen: 0.06,
    recoil: { vert: 0.26, vertVar: 0.05, horiz: 0.16, drift: -0.20, recovery: 11.0, firstShot: 1.05, kick: 0.010 },
    spread: { hip: 2.2, hipMove: 1.6, ads: 0.15, adsMove: 0.70, growth: 0.20, decay: 7.2, max: 4.8 },
    scopes: ['iron', 'reddot', 'holo', 'reflex'], defaultScope: 'holo',
    shape: { family: 'smg', barrel: 0.16, handguard: 'rail', stock: 'folding', mag: 'straight', body: 0x2b2d31, furn: 0x212327, len: 0.40 },
  },
  {
    id: 'p90', name: 'P90', cls: SMG, slot: 'primary', tier: 2,
    damage: 20, rpm: 970, mag: 50, reserve: 200, fireModes: ['auto'],
    reload: 2.60, reloadEmpty: 3.25, adsTime: 0.22, mobility: 0.95,
    falloff: { start: 15, end: 34, minMul: 0.55 }, pen: 0.12,
    recoil: { vert: 0.24, vertVar: 0.04, horiz: 0.14, drift: 0.18, recovery: 11.5, firstShot: 1.05, kick: 0.009 },
    spread: { hip: 2.3, hipMove: 1.6, ads: 0.14, adsMove: 0.68, growth: 0.19, decay: 7.4, max: 4.6 },
    scopes: ['reddot', 'holo', 'reflex', 'x15'], defaultScope: 'reflex',
    shape: { family: 'p90', barrel: 0.10, handguard: 'shell', stock: 'shell', mag: 'p90', body: 0x232427, furn: 0x1c1d20, len: 0.50 },
  },
  {
    id: 'mp7', name: 'MP7', cls: SMG, slot: 'primary', tier: 2,
    damage: 32, rpm: 900, mag: 30, reserve: 180, fireModes: ['auto', 'burst'],
    reload: 2.10, reloadEmpty: 2.75, adsTime: 0.20, mobility: 0.97,
    falloff: { start: 14, end: 32, minMul: 0.54 }, pen: 0.10,
    recoil: { vert: 0.32, vertVar: 0.06, horiz: 0.20, drift: -0.28, recovery: 10.2, firstShot: 1.08, kick: 0.011 },
    spread: { hip: 2.3, hipMove: 1.7, ads: 0.14, adsMove: 0.72, growth: 0.23, decay: 6.9, max: 5.0 },
    scopes: ['iron', 'reddot', 'holo', 'reflex', 'x15'], defaultScope: 'reflex',
    shape: { family: 'smg', barrel: 0.14, handguard: 'polymer', stock: 'folding', mag: 'straight', body: 0x2a2c2f, furn: 0x212326, len: 0.38 },
  },

  // ---------------- Shotgun ----------------
  {
    id: 'm590', name: 'M590A1', cls: SG, slot: 'primary', tier: 1,
    damage: 22, pellets: 8, rpm: 85, mag: 7, reserve: 42, fireModes: ['pump'],
    reload: 0.62, reloadEmpty: 0.62, shellReload: true, adsTime: 0.24, mobility: 0.92,
    falloff: { start: 6, end: 20, minMul: 0.22 }, pen: 0.02,
    recoil: { vert: 2.1, vertVar: 0.30, horiz: 0.55, drift: 0.2, recovery: 4.2, firstShot: 1.0, kick: 0.075 },
    spread: { hip: 5.2, hipMove: 2.0, ads: 3.1, adsMove: 1.0, growth: 0.0, decay: 5.0, max: 8.0, pelletCone: 3.4 },
    scopes: ['iron', 'reddot', 'holo', 'reflex'], defaultScope: 'iron',
    shape: { family: 'shotgun', barrel: 0.50, handguard: 'pump', stock: 'fixed', mag: 'tube', body: 0x24262a, furn: 0x1e2023, len: 0.66 },
  },

  // ---------------- Marksman ----------------
  {
    id: 'sr25', name: 'SR-25', cls: DMR, slot: 'primary', tier: 2,
    damage: 61, rpm: 450, mag: 20, reserve: 100, fireModes: ['semi'],
    reload: 2.70, reloadEmpty: 3.40, adsTime: 0.34, mobility: 0.80,
    falloff: { start: 45, end: 90, minMul: 0.80 }, pen: 0.30,
    recoil: { vert: 1.35, vertVar: 0.18, horiz: 0.30, drift: 0.25, recovery: 5.6, firstShot: 1.0, kick: 0.042 },
    spread: { hip: 4.4, hipMove: 2.8, ads: 0.04, adsMove: 1.4, growth: 0.55, decay: 4.4, max: 7.5 },
    scopes: ['reddot', 'holo', 'x15', 'x2', 'x25', 'x3'], defaultScope: 'x3',
    shape: { family: 'dmr', barrel: 0.56, handguard: 'rail', stock: 'fixed', mag: 'straight', body: 0x2d2f33, furn: 0x25272b, len: 0.72 },
  },
  {
    id: 'camrs', name: 'CAMRS', cls: DMR, slot: 'primary', tier: 3,
    damage: 65, rpm: 450, mag: 20, reserve: 100, fireModes: ['semi'],
    reload: 2.75, reloadEmpty: 3.45, adsTime: 0.35, mobility: 0.79,
    falloff: { start: 48, end: 95, minMul: 0.82 }, pen: 0.32,
    recoil: { vert: 1.42, vertVar: 0.20, horiz: 0.28, drift: -0.24, recovery: 5.4, firstShot: 1.0, kick: 0.045 },
    spread: { hip: 4.6, hipMove: 2.9, ads: 0.04, adsMove: 1.5, growth: 0.58, decay: 4.2, max: 7.8 },
    scopes: ['reddot', 'x15', 'x2', 'x25', 'x3'], defaultScope: 'x25',
    shape: { family: 'dmr', barrel: 0.60, handguard: 'rail', stock: 'skeleton', mag: 'straight', body: 0x2a2b2e, furn: 0x222326, len: 0.74 },
  },

  // ---------------- LMG ----------------
  {
    id: 'm249', name: 'M249 SAW', cls: LMG, slot: 'primary', tier: 3,
    damage: 48, rpm: 650, mag: 100, reserve: 200, fireModes: ['auto'],
    reload: 5.20, reloadEmpty: 5.60, adsTime: 0.40, mobility: 0.74,
    falloff: { start: 30, end: 62, minMul: 0.68 }, pen: 0.26,
    recoil: { vert: 0.72, vertVar: 0.16, horiz: 0.40, drift: 0.46, recovery: 6.0, firstShot: 1.30, kick: 0.026 },
    spread: { hip: 4.2, hipMove: 3.2, ads: 0.22, adsMove: 1.6, growth: 0.30, decay: 4.6, max: 8.0 },
    scopes: ['iron', 'reddot', 'holo', 'reflex', 'x15', 'x2'], defaultScope: 'x15',
    shape: { family: 'lmg', barrel: 0.52, handguard: 'rail', stock: 'fixed', mag: 'drum', body: 0x2b2d2f, furn: 0x232527, len: 0.78 },
  },

  // ---------------- Sidearms ----------------
  {
    id: 'p226', name: 'P226 Mk 25', cls: PISTOL, slot: 'secondary', tier: 1,
    damage: 50, rpm: 550, mag: 15, reserve: 75, fireModes: ['semi'],
    reload: 1.85, reloadEmpty: 2.45, adsTime: 0.17, mobility: 1.0,
    falloff: { start: 14, end: 34, minMul: 0.55 }, pen: 0.08,
    recoil: { vert: 0.86, vertVar: 0.14, horiz: 0.26, drift: 0.2, recovery: 8.0, firstShot: 1.0, kick: 0.026 },
    spread: { hip: 2.8, hipMove: 2.0, ads: 0.18, adsMove: 1.0, growth: 0.42, decay: 6.0, max: 6.0 },
    scopes: ['iron', 'reddot'], defaultScope: 'iron',
    shape: { family: 'pistol', barrel: 0.11, stock: 'none', mag: 'straight', body: 0x2a2c30, furn: 0x1e2023, len: 0.20 },
  },
  {
    id: 'deagle', name: 'D-50', cls: PISTOL, slot: 'secondary', tier: 2,
    damage: 78, rpm: 480, mag: 7, reserve: 42, fireModes: ['semi'],
    reload: 2.00, reloadEmpty: 2.60, adsTime: 0.20, mobility: 0.97,
    falloff: { start: 18, end: 42, minMul: 0.66 }, pen: 0.22,
    recoil: { vert: 1.90, vertVar: 0.26, horiz: 0.34, drift: -0.3, recovery: 6.2, firstShot: 1.0, kick: 0.056 },
    spread: { hip: 3.4, hipMove: 2.4, ads: 0.14, adsMove: 1.3, growth: 0.70, decay: 5.0, max: 7.0 },
    scopes: ['iron', 'reddot'], defaultScope: 'iron',
    shape: { family: 'pistol', barrel: 0.15, stock: 'none', mag: 'straight', body: 0x8a8f96, furn: 0x24262a, len: 0.24 },
  },
  {
    id: 'usg57', name: '5.7 USG', cls: PISTOL, slot: 'secondary', tier: 1,
    damage: 34, rpm: 550, mag: 20, reserve: 100, fireModes: ['semi'],
    reload: 1.80, reloadEmpty: 2.40, adsTime: 0.16, mobility: 1.0,
    falloff: { start: 15, end: 36, minMul: 0.58 }, pen: 0.12,
    recoil: { vert: 0.52, vertVar: 0.10, horiz: 0.20, drift: 0.24, recovery: 9.2, firstShot: 1.0, kick: 0.018 },
    spread: { hip: 2.5, hipMove: 1.8, ads: 0.16, adsMove: 0.9, growth: 0.34, decay: 6.8, max: 5.6 },
    scopes: ['iron', 'reddot'], defaultScope: 'reddot',
    shape: { family: 'pistol', barrel: 0.10, stock: 'none', mag: 'straight', body: 0x26282c, furn: 0x1c1e21, len: 0.19 },
  },
  {
    id: 'bailiff', name: 'Bailiff 410', cls: PISTOL, slot: 'secondary', tier: 2,
    damage: 18, pellets: 6, rpm: 300, mag: 5, reserve: 30, fireModes: ['semi'],
    reload: 2.40, reloadEmpty: 2.90, adsTime: 0.19, mobility: 0.98,
    falloff: { start: 5, end: 16, minMul: 0.25 }, pen: 0.02,
    recoil: { vert: 1.60, vertVar: 0.22, horiz: 0.40, drift: 0.3, recovery: 6.0, firstShot: 1.0, kick: 0.050 },
    spread: { hip: 4.6, hipMove: 2.2, ads: 2.6, adsMove: 1.0, growth: 0.0, decay: 5.0, max: 7.0, pelletCone: 3.0 },
    scopes: ['iron'], defaultScope: 'iron',
    shape: { family: 'revolver', barrel: 0.13, stock: 'none', mag: 'cylinder', body: 0x3a3d42, furn: 0x2a1d14, len: 0.22 },
  },
];

export const WEAPONS = Object.fromEntries(DEFS.map((w) => [w.id, normalise(w)]));
export const WEAPON_LIST = DEFS.map((w) => WEAPONS[w.id]);
export const PRIMARIES = WEAPON_LIST.filter((w) => w.slot === 'primary');
export const SECONDARIES = WEAPON_LIST.filter((w) => w.slot === 'secondary');

/** Ladder used by Gun Game: cheap-and-easy first, hardest last. */
export const GUNGAME_LADDER = [
  'mp5', 'r4c', 'p90', 'ak12', 'vector', 'c416', 'm590', 'mp7',
  'l85a2', 'aug', 'f2', 'm249', 'sr25', 'camrs', 'usg57', 'p226', 'deagle', 'bailiff',
];

function normalise(w) {
  const out = { ...w };
  out.shotInterval = 60 / w.rpm;
  out.pellets = w.pellets || 1;
  out.fireMode = w.fireModes[0];
  out.burstCount = w.fireModes.includes('burst') ? 3 : 0;
  out.reserve = w.reserve;
  out.seed = hashString(w.id);
  out.dps = (w.damage * out.pellets) / out.shotInterval;
  // Time-to-kill against a full-health target, body shots only.
  out.ttk = (Math.ceil(100 / (w.damage * out.pellets)) - 1) * out.shotInterval;
  return out;
}

export function getWeapon(id) {
  return WEAPONS[id] || WEAPONS.r4c;
}

/** Default loadout for a fresh profile. */
export function defaultLoadout() {
  return {
    primary: { id: 'r4c', scope: 'holo', muzzle: 'compensator', grip: 'vertical', laser: 'none' },
    secondary: { id: 'p226', scope: 'iron', muzzle: 'none', grip: 'none', laser: 'none' },
  };
}

export function sanitizeLoadout(l) {
  const d = defaultLoadout();
  const fix = (slotName, given, pool) => {
    const base = d[slotName];
    if (!given || typeof given !== 'object') return base;
    const w = WEAPONS[given.id];
    if (!w || w.slot !== slotName) return base;
    return {
      id: w.id,
      scope: w.scopes.includes(given.scope) ? given.scope : w.defaultScope,
      muzzle: MUZZLES[given.muzzle] ? given.muzzle : 'none',
      grip: (w.slot === 'primary' && GRIPS[given.grip]) ? given.grip : 'none',
      laser: LASERS[given.laser] ? given.laser : 'none',
    };
  };
  return { primary: fix('primary', l?.primary), secondary: fix('secondary', l?.secondary) };
}

/** Fold attachments into a flat set of numbers the runtime can use directly. */
export function resolveWeapon(cfg) {
  const w = getWeapon(cfg?.id);
  const muzzle = MUZZLES[cfg?.muzzle] || MUZZLES.none;
  const grip = GRIPS[cfg?.grip] || GRIPS.none;
  const laser = LASERS[cfg?.laser] || LASERS.none;
  const scope = SCOPES[cfg?.scope] || SCOPES[w.defaultScope];

  return {
    def: w,
    id: w.id,
    name: w.name,
    scope, muzzle, grip, laser,
    damage: w.damage * (muzzle.damage || 1),
    pellets: w.pellets,
    shotInterval: w.shotInterval,
    mag: w.mag,
    reserve: w.reserve,
    reload: w.reload,
    reloadEmpty: w.reloadEmpty,
    shellReload: !!w.shellReload,
    adsTime: w.adsTime * grip.adsTime * (scope.mag > 1.6 ? 1.12 : 1.0),
    falloff: w.falloff,
    pen: w.pen,
    loud: muzzle.loud,
    flash: muzzle.flash,
    hideTracer: !!muzzle.hideTracer,
    recoil: {
      vert: w.recoil.vert * muzzle.recoil * grip.recoil,
      vertVar: w.recoil.vertVar * muzzle.recoil,
      horiz: w.recoil.horiz * muzzle.recoil * grip.recoil,
      drift: w.recoil.drift,
      recovery: w.recoil.recovery,
      firstShot: w.recoil.firstShot,
      kick: w.recoil.kick,
    },
    spread: {
      hip: w.spread.hip * muzzle.spread * laser.hipSpread,
      hipMove: w.spread.hipMove,
      ads: w.spread.ads * muzzle.spread,
      adsMove: w.spread.adsMove,
      growth: w.spread.growth,
      decay: w.spread.decay,
      max: w.spread.max,
      pelletCone: w.spread.pelletCone || 0,
    },
    mobility: w.mobility,
    cls: w.cls,
    slot: w.slot,
    shape: w.shape,
    fireModes: w.fireModes,
  };
}

/**
 * Deterministic recoil pattern. Vertical climb tapers off while horizontal
 * sway snakes left and right — the same shot index always gives the same
 * offset, so the pattern can be learned and controlled.
 * @returns {{x:number, y:number}} degrees
 */
export function recoilAt(rw, shotIndex) {
  const r = rw.recoil;
  const rng = makeRng((rw.def.seed + shotIndex * 2654435761) >>> 0);
  const ramp = 1 - Math.exp(-shotIndex * 0.55);          // climb settles after ~6 shots
  const first = shotIndex === 0 ? r.firstShot : 1;
  const vert = r.vert * (0.55 + 0.45 * ramp) * first * (1 + (rng() - 0.5) * 2 * r.vertVar);
  // A slow sine gives the pattern a learnable snake, noise keeps it alive.
  const snake = Math.sin(shotIndex * 0.42) * r.drift;
  const horiz = (snake + (rng() - 0.5) * 2 * r.horiz) * (0.4 + 0.6 * ramp);
  return { x: horiz, y: vert };
}

/** Damage after distance drop-off and hitbox multiplier. */
export function damageAt(rw, distance, zoneMul) {
  const f = rw.falloff;
  let mul = 1;
  if (distance > f.start) {
    const t = clamp((distance - f.start) / Math.max(0.001, f.end - f.start), 0, 1);
    mul = 1 + (f.minMul - 1) * t;
  }
  return rw.damage * mul * zoneMul;
}

/** Current cone of fire in degrees for the given movement/stance context. */
export function currentSpread(rw, ctx) {
  const s = rw.spread;
  const base = ctx.ads ? s.ads : s.hip;
  const moveAdd = (ctx.ads ? s.adsMove : s.hipMove) * clamp(ctx.speed / 7.35, 0, 1);
  const airAdd = ctx.onGround ? 0 : (ctx.ads ? 1.6 : 3.2);
  const crouchMul = ctx.crouching ? 0.72 : 1;
  return clamp((base + moveAdd + airAdd) * crouchMul + ctx.bloom, 0, s.max);
}
