// Tiny dependency free vector/math helpers shared by the client and the server.
// Vectors are plain `{ x, y, z }` objects so they serialise straight to JSON.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const TAU = Math.PI * 2;

/** Frame-rate independent exponential approach. `rate` is roughly "per second". */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vcopy = (a) => ({ x: a.x, y: a.y, z: a.z });
export const vset = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vlen = (a) => Math.hypot(a.x, a.y, a.z);
export const vlenSq = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const vdist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const vdistSq = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const vlerp = (a, b, t) => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});

export function vnorm(a) {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}

export function vcross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Forward vector for a yaw/pitch pair. Yaw 0 looks down -Z, matching three.js. */
export function dirFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

export function anglesFromDir(d) {
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(clamp(d.y, -1, 1)) };
}

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export const lerpAngle = (a, b, t) => a + angleDelta(a, b) * t;

/** Deterministic 32-bit PRNG (mulberry32) — same sequence on client and server. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
