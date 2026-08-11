// Throwables.
//
// One shared cooldown across all three, so choosing which to carry into a peek
// is a real decision rather than a rotation.

export const GRENADE_COOLDOWN = 15;   // seconds, shared across all types
export const GRENADE_GRAVITY = 20;

export const GRENADES = {
  frag: {
    id: 'frag',
    name: 'Frag',
    blurb: 'Lethal at the centre, survivable at the edge. Cooks for three seconds.',
    fuse: 3.0,
    throwSpeed: 17,
    bounce: 0.32,
    friction: 0.62,
    radius: 7.5,
    damage: 135,
    minDamage: 12,
    color: 0x3f4a33,
  },
  flash: {
    id: 'flash',
    name: 'Flashbang',
    blurb: 'Blinds anyone looking at it. Turn away or lose the duel.',
    fuse: 1.7,
    throwSpeed: 19,
    bounce: 0.46,
    friction: 0.7,
    radius: 16,
    maxBlind: 3.4,
    minBlind: 0.35,
    damage: 0,
    color: 0xb9b19a,
  },
  smoke: {
    id: 'smoke',
    name: 'Smoke',
    blurb: 'Fifteen seconds of cover. Break a sightline or cover a push.',
    fuse: 1.4,
    throwSpeed: 16,
    bounce: 0.22,
    friction: 0.5,
    radius: 6.0,
    duration: 15,
    growTime: 1.4,
    damage: 0,
    color: 0x6d7377,
  },
};

export const GRENADE_IDS = Object.keys(GRENADES);

export function getGrenade(id) {
  return GRENADES[id] || GRENADES.frag;
}

/**
 * Damage from a frag at a given distance. Falls off with the square of the
 * distance so the killzone is tight and the edge is survivable.
 */
export function fragDamage(def, distance) {
  if (distance >= def.radius) return 0;
  const t = 1 - distance / def.radius;
  return Math.max(def.minDamage, def.damage * t * t);
}

/**
 * How long a flash blinds for. Scales with proximity and with how directly the
 * victim was looking at it — turning away is the counterplay.
 */
export function flashBlind(def, distance, facingDot) {
  if (distance >= def.radius) return 0;
  const prox = 1 - distance / def.radius;
  // facingDot is 1 looking straight at it, -1 directly away.
  const facing = Math.max(0, (facingDot + 0.25) / 1.25);
  const t = prox * facing;
  return t <= 0.02 ? 0 : Math.max(def.minBlind, def.maxBlind * t);
}
