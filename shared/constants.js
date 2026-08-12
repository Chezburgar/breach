// Shared tuning constants. Imported by both the browser client and the Node server,
// so this file must stay free of any DOM or Node specific API.

export const PROTOCOL_VERSION = 7;

// --- Simulation ---------------------------------------------------------
export const TICK_RATE = 60;               // fixed simulation steps per second
export const FIXED_DT = 1 / TICK_RATE;     // client prediction and server authority share this
export const SNAPSHOT_RATE = 20;           // state broadcasts per second
export const SNAPSHOT_DT = 1 / SNAPSHOT_RATE;
export const INTERP_DELAY = 0.1;           // remote entities are rendered 100ms in the past
export const MAX_INPUTS_PER_PACKET = 12;   // redundancy against packet loss
export const MAX_ROLLBACK = 0.35;          // hard cap on lag compensation rewind (seconds)

// --- Player -------------------------------------------------------------
export const PLAYER = {
  radius: 0.36,
  standHeight: 1.78,
  crouchHeight: 1.16,
  eyeDrop: 0.16,          // eye sits this far below the top of the capsule
  stepHeight: 0.55,
  maxHealth: 100,
  regenDelay: 5.0,        // seconds after last damage before health regenerates
  regenRate: 22,          // hp per second
  spawnProtection: 1.5,   // seconds of immunity after spawning
};

// --- Movement -----------------------------------------------------------
export const MOVE = {
  walkSpeed: 4.75,
  sprintSpeed: 7.35,
  crouchSpeed: 2.45,
  adsSpeed: 2.95,
  airSpeed: 2.2,          // cap on air-strafe acceleration target
  groundAccel: 62,
  airAccel: 26,
  friction: 9.5,
  gravity: 22.5,
  jumpVelocity: 6.85,
  maxFallSpeed: 55,
  coyoteTime: 0.11,       // grace period for jumping after leaving ground
  jumpBuffer: 0.14,       // grace period for pressing jump before landing
  leanAngle: 0.30,        // radians of roll — a lean, not a barrel roll
  leanOffset: 0.52,       // metres the camera slides sideways when leaning
  leanDrop: 0.10,         // metres the head sinks: you pivot about the waist
  slideSpeed: 8.6,
  slideDuration: 0.62,
  slideCooldown: 0.85,
  fallDamageStart: 12.5,  // m/s of downward velocity before damage begins
  fallDamagePerUnit: 5.2,
};

// --- Camera / view ------------------------------------------------------
export const VIEW = {
  baseFov: 90,
  viewmodelFov: 62,
  // The near plane is the single biggest lever on depth precision: error grows
  // as z²/near, so 0.02 left centimetres of slop on ground a hundred metres out
  // and the layered surface patches flickered against each other. Nothing in
  // the world scene is ever closer than the player's 0.36 m collision radius —
  // the view model has its own camera — so 0.15 costs nothing and buys 7×.
  near: 0.1,
  far: 900,
  sprintFovAdd: 8,
  maxPitch: Math.PI / 2 - 0.02,
};

// --- Input bit flags ----------------------------------------------------
export const BTN = {
  FORWARD: 1 << 0,
  BACK: 1 << 1,
  LEFT: 1 << 2,
  RIGHT: 1 << 3,
  JUMP: 1 << 4,
  CROUCH: 1 << 5,
  SPRINT: 1 << 6,
  ADS: 1 << 7,
  FIRE: 1 << 8,
  LEAN_L: 1 << 9,
  LEAN_R: 1 << 10,
};

// --- Teams --------------------------------------------------------------
export const TEAM = { NONE: -1, ATTACK: 0, DEFEND: 1 };
export const TEAM_INFO = [
  { id: 0, key: 'attack', name: 'VANGUARD', color: '#ff6a3d', colorHex: 0xff6a3d, accent: '#ffb08a' },
  { id: 1, key: 'defend', name: 'SENTINEL', color: '#39b7ff', colorHex: 0x39b7ff, accent: '#9fddff' },
];

// --- Damage -------------------------------------------------------------
export const HITBOX = {
  HEAD: 'head',
  CHEST: 'chest',
  LIMB: 'limb',
};
export const HIT_MULTIPLIER = {
  head: 3.0,
  chest: 1.0,
  limb: 0.78,
};

export const MATCH = {
  introDuration: 11.5,       // pregame banner intro
  warmupDuration: 5.0,       // countdown after the intro
  outroDuration: 14.0,       // victory screen + fanfare
  respawnDelay: 3.2,
  killcamDuration: 2.0,
};
