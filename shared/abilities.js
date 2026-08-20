// Operator abilities. One per loadout, on its own cooldown.
//
// Two families, and the split matters because of how they are made to feel
// right online:
//
//   Movement — dash and vault — change your own velocity. They run inside the
//   shared controller off an input bit, so the client predicts them on exactly
//   the tick the server will apply them and nothing rubber-bands.
//
//   World — shield, scanner, mine — put something into the match. The room
//   owns those outright; a client that guessed would be guessing about other
//   people's screens.
//
// The cooldown lives on the player state so both ends run the same clock.

export const ABILITIES = {
  dash: {
    id: 'dash', name: 'Dash', short: 'DASH', kind: 'move',
    blurb: 'A hard shove in the direction you are moving. Crosses an angle before anyone can track it.',
    cooldown: 5,
    speed: 15.5,          // impulse, m/s
    lift: 1.6,            // a little off the floor so it clears kerbs
  },
  vault: {
    id: 'vault', name: 'Vault', short: 'JUMP', kind: 'move',
    blurb: 'A charged leap that clears three storeys. Rooflines, sky bridges, and the balcony nobody is watching.',
    cooldown: 11,
    // Apex is up^2 / 2g, so at 22.5 m/s^2 this is a shade under ten metres —
    // what it takes to reach a mid-rise roof from the street.
    up: 21.0,
    forward: 4.0,
    // A leap that high lands well past the fall-damage threshold, so it
    // carries its own grace. Spent on the first landing, so it pays for the
    // flight and nothing after it.
    softLand: 6.0,
  },
  shield: {
    id: 'shield', name: 'Bulwark', short: 'SHLD', kind: 'world',
    blurb: 'A hard-light barrier that stops rounds from one side. Yours pass through it.',
    cooldown: 22,
    life: 18,             // seconds before it fails on its own
    health: 340,
    width: 2.4,
    height: 1.9,
    range: 2.2,           // how far ahead it plants
  },
  scanner: {
    id: 'scanner', name: 'Pulse', short: 'SCAN', kind: 'world',
    blurb: 'A ping that paints every enemy caught in it, through walls, for your side.',
    cooldown: 20,
    radius: 26,
    markFor: 6,
    windup: 0.35,
  },
  mine: {
    id: 'mine', name: 'Snare', short: 'MINE', kind: 'world',
    blurb: 'A proximity charge. Arms after a moment, and does not care which way you are facing.',
    cooldown: 16,
    life: 60,
    arm: 1.2,
    trigger: 2.4,
    damage: 92,
    falloff: 4.6,         // radius at which damage has fallen to nothing
    health: 1,            // a single round kills it
  },
};

export const ABILITY_IDS = Object.keys(ABILITIES);
export const DEFAULT_ABILITY = 'dash';

export function getAbility(id) {
  return ABILITIES[id] || ABILITIES[DEFAULT_ABILITY];
}

export function sanitizeAbility(id) {
  return ABILITIES[id] ? id : DEFAULT_ABILITY;
}

/**
 * Apply a movement ability to a player's velocity.
 *
 * Called from the shared controller, so this runs identically on both ends.
 * Returns true if it fired.
 */
export function applyMoveAbility(s, def, wish) {
  if (def.kind !== 'move') return false;

  if (def.id === 'dash') {
    // Along the way you are asking to go, or straight ahead if you are not
    // asking for anything — a dash that dumps you sideways because you were
    // strafing when you pressed it is not a dash, it is a stumble.
    let dx = wish.x, dz = wish.z;
    if (Math.hypot(dx, dz) < 0.01) { dx = wish.fx; dz = wish.fz; }
    const len = Math.hypot(dx, dz) || 1;
    s.vel.x = (dx / len) * def.speed;
    s.vel.z = (dz / len) * def.speed;
    if (s.onGround) s.vel.y = Math.max(s.vel.y, def.lift);
    s.onGround = false;
    return true;
  }

  if (def.id === 'vault') {
    // Only from the floor: an air-launch is a flight, not a leap.
    if (!s.onGround && s.coyote <= 0) return false;
    s.vel.y = def.up;
    s.noFallUntil = s.time + (def.softLand || 0);
    s.vel.x += wish.fx * def.forward;
    s.vel.z += wish.fz * def.forward;
    s.onGround = false;
    s.coyote = 0;
    return true;
  }
  return false;
}
