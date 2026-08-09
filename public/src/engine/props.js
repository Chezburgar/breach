// Prop geometry.
//
// Props are described as flat lists of primitives in the prop's local frame.
// The world builder transforms and merges them by material, so a hundred palm
// trees cost the same handful of draw calls as one.

const D2R = Math.PI / 180;

const box = (p, s, m, r) => ({ k: 'box', p, s, m, r });
const cyl = (p, s, m, r) => ({ k: 'cyl', p, s, m, r });       // s = [radiusTop, radiusBottom, height]
const cone = (p, s, m, r) => ({ k: 'cone', p, s, m, r });      // s = [radius, height]
const sph = (p, s, m) => ({ k: 'sph', p, s, m });              // s = radius

/** Deterministic jitter so every instance differs but never flickers. */
function rnd(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FACTORIES = {
  palm(o, seed) {
    const r = rnd(seed);
    const parts = [];
    const h = 5.2 + r() * 2.6;
    const lean = (r() - 0.5) * 0.28;
    const segs = 7;
    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const y = t * h;
      parts.push(cyl(
        [Math.sin(lean) * y * 0.5, y + h / segs / 2, Math.cos(lean) * y * 0.12],
        [0.19 - t * 0.07, 0.22 - t * 0.07, h / segs + 0.04], 'bark',
        [lean * 0.25, t * 2, 0]
      ));
    }
    const top = [Math.sin(lean) * h * 0.5, h, Math.cos(lean) * h * 0.12];
    const fronds = 9 + Math.floor(r() * 4);
    for (let i = 0; i < fronds; i++) {
      const a = (i / fronds) * Math.PI * 2 + r() * 0.4;
      const droop = -0.42 - r() * 0.34;
      const len = 2.1 + r() * 0.9;
      for (let s = 0; s < 3; s++) {
        const f = (s + 0.5) / 3;
        parts.push(box(
          [top[0] + Math.cos(a) * len * f, top[1] + Math.sin(droop * f * 2.2) * len * f * 0.8 + 0.25,
           top[2] + Math.sin(a) * len * f],
          [len / 3 + 0.15, 0.06, 0.62 - f * 0.22], 'foliage',
          [0, -a, droop * f]
        ));
      }
    }
    parts.push(sph([top[0], top[1] + 0.1, top[2]], 0.34, 'bark'));
    return parts;
  },

  cypress(o, seed) {
    const r = rnd(seed);
    const parts = [];
    const h = 5.4 + r() * 2.2;
    parts.push(cyl([0, h * 0.28, 0], [0.13, 0.2, h * 0.56], 'bark'));
    const tiers = 6;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      parts.push(cone([0, h * (0.28 + t * 0.62), 0], [1.05 - t * 0.72, h * 0.34], 'foliage', [0, r() * 3, 0]));
    }
    return parts;
  },

  pine(o, seed) {
    const r = rnd(seed);
    const parts = [];
    const h = 8 + r() * 5;
    parts.push(cyl([0, h * 0.2, 0], [0.16, 0.3, h * 0.4], 'bark'));
    const tiers = 7;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      parts.push(cone([0, h * (0.2 + t * 0.72), 0], [1.9 - t * 1.5, h * 0.3], 'foliage', [0, r() * 3, 0]));
    }
    return parts;
  },

  tree(o, seed) {
    const r = rnd(seed);
    const parts = [];
    const h = 4.6 + r() * 2.2;
    parts.push(cyl([0, h * 0.34, 0], [0.22, 0.34, h * 0.68], 'bark'));
    for (let i = 0; i < 3; i++) {
      const a = r() * Math.PI * 2;
      parts.push(cyl(
        [Math.cos(a) * 0.5, h * 0.62, Math.sin(a) * 0.5],
        [0.09, 0.13, 1.4], 'bark', [0.5, -a, 0]
      ));
    }
    const canopy = 5 + Math.floor(r() * 3);
    for (let i = 0; i < canopy; i++) {
      const a = (i / canopy) * Math.PI * 2;
      const rad = 1.1 + r() * 0.7;
      parts.push(sph(
        [Math.cos(a) * rad * 0.8, h * 0.9 + (r() - 0.5) * 0.8, Math.sin(a) * rad * 0.8],
        1.3 + r() * 0.6, 'foliage'
      ));
    }
    parts.push(sph([0, h * 1.02, 0], 1.6, 'foliage'));
    return parts;
  },

  statue(o, seed) {
    const r = rnd(seed);
    return [
      cyl([0, 0.22, 0], [0.75, 0.9, 0.44], 'marble'),
      box([0, 0.9, 0], [0.9, 1.0, 0.5], 'marble'),
      box([0, 1.75, 0], [0.62, 0.8, 0.42], 'marble', [0, r() * 0.4, 0]),
      sph([0, 2.32, 0], 0.24, 'marble'),
      box([-0.42, 1.85, 0.12], [0.18, 0.62, 0.18], 'marble', [0, 0, 0.5]),
      box([0.42, 1.9, -0.1], [0.18, 0.7, 0.18], 'marble', [0.4, 0, -0.3]),
    ];
  },

  lamppost() {
    return [
      cyl([0, 0.2, 0], [0.26, 0.34, 0.4], 'stone'),
      cyl([0, 2.3, 0], [0.07, 0.1, 4.2], 'trim'),
      cyl([0, 4.5, 0], [0.24, 0.1, 0.5], 'trim'),
      box([0, 4.66, 0], [0.34, 0.34, 0.34], 'lampglass'),
      cone([0, 4.98, 0], [0.3, 0.34], 'trim'),
    ];
  },

  chandelier(o, seed) {
    const r = rnd(seed);
    const parts = [
      cyl([0, 0.1, 0], [0.03, 0.03, 0.5], 'trim'),
      cyl([0, -0.2, 0], [0.5, 0.4, 0.08], 'trim'),
    ];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      parts.push(cyl([Math.cos(a) * 0.46, -0.14, Math.sin(a) * 0.46], [0.05, 0.05, 0.16], 'trim'));
      parts.push(sph([Math.cos(a) * 0.46, -0.02, Math.sin(a) * 0.46], 0.075, 'lampglass'));
      void r;
    }
    return parts;
  },

  bed() {
    return [
      box([0, 0.2, 0], [2.0, 0.4, 2.4], 'woodDark'),
      box([0, 0.52, 0], [1.9, 0.28, 2.3], 'fabric'),
      box([0, 0.72, -0.95], [1.5, 0.2, 0.4], 'fabric'),
      box([0, 0.85, -1.22], [2.0, 1.3, 0.14], 'woodDark'),
      box([0, 0.5, 1.22], [2.0, 0.7, 0.14], 'woodDark'),
    ];
  },

  bush(o, seed) {
    const r = rnd(seed);
    const parts = [];
    for (let i = 0; i < 5; i++) {
      parts.push(sph([(r() - 0.5) * 1.1, 0.36 + r() * 0.4, (r() - 0.5) * 1.1], 0.42 + r() * 0.24, 'foliage'));
    }
    return parts;
  },

  hedge(o) {
    const sx = o.sx || 2, sz = o.sz || 1.2;
    const parts = [box([0, 0.58, 0], [sx, 1.16, sz], 'hedge')];
    const r = rnd(97);
    for (let i = 0; i < Math.ceil(sx * sz); i++) {
      parts.push(sph([(r() - 0.5) * sx, 1.1 + r() * 0.16, (r() - 0.5) * sz], 0.3, 'hedge'));
    }
    return parts;
  },

  crate(o, seed) {
    const r = rnd(seed);
    const s = 1.18;
    const parts = [box([0, s / 2, 0], [s, s, s], 'crate', [0, r() * 0.3, 0])];
    return parts;
  },

  barrel(o, seed) {
    const r = rnd(seed);
    const parts = [
      cyl([0, 0.55, 0], [0.31, 0.31, 1.1], r() > 0.5 ? 'metalRust' : 'container'),
      cyl([0, 0.28, 0], [0.33, 0.33, 0.07], 'metalRust'),
      cyl([0, 0.82, 0], [0.33, 0.33, 0.07], 'metalRust'),
      cyl([0, 1.11, 0], [0.29, 0.29, 0.04], 'metalRust'),
    ];
    return parts;
  },

  pallet() {
    const parts = [];
    for (let i = 0; i < 5; i++) parts.push(box([-0.6 + i * 0.3, 0.13, 0], [0.2, 0.05, 1.2], 'wood'));
    for (const z of [-0.5, 0, 0.5]) parts.push(box([0, 0.06, z], [1.32, 0.12, 0.16], 'wood'));
    return parts;
  },

  sandbag(o, seed) {
    const r = rnd(seed);
    const parts = [];
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 4 - row; i++) {
        parts.push(box(
          [(i - (3 - row) / 2) * 0.62 + (row % 2) * 0.3, 0.14 + row * 0.26, 0],
          [0.6, 0.26, 0.42], 'fabric', [0, (r() - 0.5) * 0.2, 0]
        ));
      }
    }
    return parts;
  },

  streetlamp() {
    return [
      cyl([0, 0.16, 0], [0.22, 0.28, 0.32], 'concrete'),
      cyl([0, 2.7, 0], [0.08, 0.11, 5.4], 'trim'),
      box([0, 5.42, 0.34], [0.16, 0.14, 0.9], 'trim'),
      box([0, 5.3, 0.78], [0.42, 0.16, 0.5], 'trim'),
      box([0, 5.2, 0.78], [0.34, 0.06, 0.42], 'lampglass'),
    ];
  },

  ceiling_lamp() {
    return [
      cyl([0, 0.02, 0], [0.03, 0.03, 0.28], 'trim'),
      cyl([0, -0.16, 0], [0.34, 0.16, 0.18], 'trim'),
      cyl([0, -0.24, 0], [0.24, 0.24, 0.04], 'lampglass'),
    ];
  },

  hangar_lamp() {
    return [
      cyl([0, 0.1, 0], [0.03, 0.03, 0.4], 'trim'),
      cone([0, -0.24, 0], [0.46, 0.42], 'metal', [Math.PI, 0, 0]),
      cyl([0, -0.4, 0], [0.3, 0.3, 0.05], 'lampglass'),
    ];
  },

  cage_lamp() {
    const parts = [
      box([0, 0.1, 0], [0.1, 0.2, 0.1], 'trim'),
      sph([0, -0.12, 0], 0.15, 'lampglass'),
    ];
    for (let i = 0; i < 4; i++) {
      parts.push(box([0, -0.12, 0], [0.02, 0.36, 0.36], 'trim', [0, (i / 4) * Math.PI, 0]));
    }
    return parts;
  },

  ac_unit(o, seed) {
    const r = rnd(seed);
    return [
      box([0, 0.55, 0], [1.8, 1.1, 1.8], 'metal', [0, r() * 0.4, 0]),
      box([0, 1.12, 0], [1.6, 0.1, 1.6], 'trim', [0, r() * 0.4, 0]),
      cyl([0, 1.2, 0], [0.5, 0.5, 0.12], 'trim', [0, 0, 0]),
    ];
  },

  antenna(o, seed) {
    const r = rnd(seed);
    const parts = [
      cyl([0, 0.1, 0], [0.5, 0.6, 0.2], 'concrete'),
      cyl([0, 2.6, 0], [0.05, 0.09, 5.2], 'trim'),
    ];
    for (let i = 0; i < 4; i++) {
      const y = 1.6 + i * 0.9;
      parts.push(box([0, y, 0], [1.4 - i * 0.24, 0.05, 0.05], 'trim', [0, r() * 0.4, 0]));
    }
    parts.push(sph([0, 5.3, 0], 0.13, 'lampglass'));
    return parts;
  },

  generator() {
    return [
      box([0, 0.75, 0], [2.6, 1.5, 2.6], 'metalRust'),
      box([0, 1.56, 0], [2.3, 0.12, 2.3], 'trim'),
      cyl([0.7, 2.0, 0.7], [0.14, 0.14, 0.9], 'trim'),
      box([-0.9, 0.9, 1.34], [0.6, 0.5, 0.08], 'trim'),
    ];
  },

  stall(o, seed) {
    const r = rnd(seed);
    const parts = [
      box([0, 0.48, 0], [2.6, 0.12, 1.0], 'wood'),
      box([-1.2, 0.24, -0.4], [0.1, 0.48, 0.1], 'wood'),
      box([1.2, 0.24, -0.4], [0.1, 0.48, 0.1], 'wood'),
      box([-1.2, 0.24, 0.4], [0.1, 0.48, 0.1], 'wood'),
      box([1.2, 0.24, 0.4], [0.1, 0.48, 0.1], 'wood'),
      box([-1.3, 1.2, -0.5], [0.08, 2.4, 0.08], 'wood'),
      box([1.3, 1.2, -0.5], [0.08, 2.4, 0.08], 'wood'),
      box([0, 2.42, 0.1], [2.9, 0.08, 1.5], 'fabric', [0.14, 0, 0]),
    ];
    for (let i = 0; i < 6; i++) {
      parts.push(box(
        [-1.0 + i * 0.4, 0.62 + r() * 0.08, (r() - 0.5) * 0.5],
        [0.26, 0.2, 0.26], r() > 0.5 ? 'crate' : 'fabric', [0, r() * 2, 0]
      ));
    }
    return parts;
  },

  awning() {
    return [box([0, 0, 0], [2.8, 0.08, 1.6], 'fabric', [0.16, 0, 0])];
  },

  bench() {
    return [
      box([0, 0.45, 0], [1.8, 0.09, 0.5], 'wood'),
      box([0, 0.7, -0.22], [1.8, 0.42, 0.08], 'wood', [-0.18, 0, 0]),
      box([-0.75, 0.22, 0], [0.09, 0.44, 0.44], 'trim'),
      box([0.75, 0.22, 0], [0.09, 0.44, 0.44], 'trim'),
    ];
  },

  planter() {
    return [
      box([0, 0.35, 0], [2.0, 0.7, 2.0], 'stone'),
      box([0, 0.72, 0], [2.1, 0.08, 2.1], 'marble'),
    ];
  },

  desk() {
    return [
      box([0, 0.74, 0], [1.7, 0.06, 1.1], 'woodDark'),
      box([-0.78, 0.37, 0], [0.08, 0.74, 1.0], 'woodDark'),
      box([0.78, 0.37, 0], [0.08, 0.74, 1.0], 'woodDark'),
      box([0.4, 0.5, 0], [0.6, 0.44, 0.9], 'woodDark'),
    ];
  },

  chair() {
    return [
      box([0, 0.44, 0], [0.48, 0.06, 0.48], 'woodDark'),
      box([0, 0.72, -0.21], [0.48, 0.5, 0.06], 'woodDark'),
      cyl([0, 0.22, 0], [0.05, 0.05, 0.44], 'trim'),
      cyl([0, 0.03, 0], [0.24, 0.24, 0.06], 'trim'),
    ];
  },

  shelf() {
    const parts = [
      box([-1.18, 1.0, 0], [0.06, 2.0, 0.5], 'metalRust'),
      box([1.18, 1.0, 0], [0.06, 2.0, 0.5], 'metalRust'),
    ];
    for (let i = 0; i < 4; i++) parts.push(box([0, 0.25 + i * 0.55, 0], [2.4, 0.05, 0.5], 'metalRust'));
    const r = rnd(31);
    for (let i = 0; i < 7; i++) {
      parts.push(box([-1 + r() * 2, 0.42 + Math.floor(r() * 3) * 0.55, 0], [0.3, 0.28, 0.34], 'crate', [0, r(), 0]));
    }
    return parts;
  },

  well() {
    const parts = [
      cyl([0, 0.5, 0], [1.1, 1.1, 1.0], 'stone'),
      cyl([0, 1.02, 0], [1.16, 1.16, 0.1], 'marble'),
      box([-1.0, 1.9, 0], [0.1, 1.8, 0.1], 'wood'),
      box([1.0, 1.9, 0], [0.1, 1.8, 0.1], 'wood'),
      box([0, 2.9, 0], [2.6, 0.12, 1.4], 'roofwood', [0, 0, 0]),
    ];
    return parts;
  },

  fountain_jet() {
    const parts = [];
    for (let i = 0; i < 5; i++) {
      parts.push(sph([0, i * 0.3, 0], 0.12 - i * 0.015, 'waterjet'));
    }
    return parts;
  },

  flag(o, seed) {
    const r = rnd(seed);
    const parts = [cyl([0, 2.4, 0], [0.05, 0.07, 4.8], 'trim')];
    for (let i = 0; i < 6; i++) {
      const t = i / 6;
      parts.push(box(
        [0.3 + t * 1.5, 4.2 - t * 0.12, Math.sin(t * 4 + r()) * 0.16],
        [0.3, 0.72, 0.03], 'flagcloth', [0, Math.sin(t * 4) * 0.3, 0]
      ));
    }
    return parts;
  },

  sign(o) {
    return [
      box([0, 0, 0], [Math.max(2.2, (o.label || '').length * 0.42), 0.7, 0.1], 'trim'),
      box([0, 0, 0.06], [Math.max(2.0, (o.label || '').length * 0.38), 0.5, 0.02], 'lampglass'),
    ];
  },

  rubble(o, seed) {
    const r = rnd(seed);
    const parts = [];
    for (let i = 0; i < 9; i++) {
      const s = 0.2 + r() * 0.5;
      parts.push(box(
        [(r() - 0.5) * 2.6, s / 2, (r() - 0.5) * 2.6],
        [s, s * 0.6, s * 0.9], r() > 0.4 ? 'concrete' : 'brick',
        [r() * 0.4, r() * 3, r() * 0.4]
      ));
    }
    return parts;
  },

  pipe_run(o) {
    const len = o.length || 40;
    const parts = [
      cyl([0, 0, 0], [0.11, 0.11, len], 'metalRust', [Math.PI / 2, 0, 0]),
      cyl([0.34, -0.1, 0], [0.07, 0.07, len], 'metal', [Math.PI / 2, 0, 0]),
    ];
    for (let i = -len / 2; i < len / 2; i += 4) {
      parts.push(box([0.17, 0.2, i], [0.7, 0.06, 0.06], 'trim'));
    }
    return parts;
  },

  wire(o) {
    // A catenary between two points, in world space relative to the prop.
    const to = o.to || [0, 0, 10];
    const parts = [];
    const segs = 12;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const sag = (t) => Math.sin(t * Math.PI) * -1.1;
      const p0 = [to[0] * t0, to[1] * t0 + sag(t0), to[2] * t0];
      const p1 = [to[0] * t1, to[1] * t1 + sag(t1), to[2] * t1];
      const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
      const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      const yaw = Math.atan2(p1[0] - p0[0], p1[2] - p0[2]);
      const pitch = Math.asin((p1[1] - p0[1]) / (d || 1));
      parts.push(cyl(mid, [0.025, 0.025, d * 1.04], 'trim', [Math.PI / 2 - pitch, yaw, 0]));
    }
    return parts;
  },

  banner_arch(o, seed) {
    const r = rnd(seed);
    const parts = [
      box([-5, 2.6, 0], [0.4, 5.2, 0.4], 'sandstone'),
      box([5, 2.6, 0], [0.4, 5.2, 0.4], 'sandstone'),
      box([0, 5.3, 0], [10.4, 0.5, 0.5], 'sandstone'),
      box([0, 4.6, 0], [8.4, 0.9, 0.06], 'fabric'),
    ];
    for (let i = 0; i < 6; i++) {
      parts.push(box([-4 + i * 1.6, 3.9, 0], [0.5, 0.8, 0.04], 'fabric', [0, 0, (r() - 0.5) * 0.2]));
    }
    return parts;
  },

  target(o) {
    const h = o.height || 1.8;
    const friendly = !!o.friendly;
    return [
      cyl([0, 0.06, 0], [0.3, 0.34, 0.12], 'trim'),
      box([0, h * 0.32, 0], [0.09, h * 0.64, 0.09], 'trim'),
      box([0, h * 0.78, 0], [0.62, h * 0.62, 0.07], friendly ? 'targetgreen' : 'targetred'),
      box([0, h * 1.02, 0], [0.3, 0.3, 0.09], friendly ? 'targetgreen' : 'targetred'),
    ];
  },

  weapon_stand(o) {
    return [
      box([0, 0.04, 0], [1.6, 0.08, 0.9], 'trim'),
      box([0, 0.34, -0.2], [1.2, 0.6, 0.05], 'trim', [-0.25, 0, 0]),
      box([0, 0.7, 0.1], [1.1, 0.34, 0.03], 'lampglass'),
    ];
  },
};

/**
 * Build the primitive list for one prop instance.
 * @returns {Array|null}
 */
export function propParts(prop, seed) {
  const f = FACTORIES[prop.type];
  if (!f) return null;
  return f(prop, seed);
}

export const PROP_TYPES = Object.keys(FACTORIES);
export { D2R };
