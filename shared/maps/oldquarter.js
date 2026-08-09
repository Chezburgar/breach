// OLD QUARTER — the flagship map.
//
// A sun-bleached coastal compound: a tiled plaza ringed by a consulate, a
// market street, a walled villa and a freight warehouse, wired together by
// rooftops and a service tunnel. Roughly 150m x 150m of playable ground.
//
// Everything here is watertight by construction: floors are single slabs with
// explicit holes, walls are split around their openings, and no two surfaces
// are ever left exactly coplanar (which is what causes z-fighting).

import { MapBuilder } from './builder.js';

const F1 = 0, F2 = 4.4, F3 = 8.8, ROOF = 13.2; // consulate floor levels

// The two stair shafts that connect the service tunnel to the surface. Every
// deck at ground level is cut with these so the shafts are actually open.
// Their Z extents match the stair run exactly (22 steps x 0.32m), so the top
// tread lands flush against the deck edge with no lip to fall through.
const SHAFT_N = [-4.7, -39.84, -1.3, -32.8];
const SHAFT_S = [-4.7, 32.8, -1.3, 39.84];
const GROUND_HOLES = [SHAFT_N, SHAFT_S];

/**
 * Switchback stairwell filling the given rectangle, one flight pair per floor.
 * `flip` puts the bottom of the first flight at the +Z end, for stairwells that
 * have to be entered from the other side.
 */
function switchback(b, x0, z0, x1, z1, yBase, floorH, floors, mat, railMat = 'metal', flip = false) {
  const wHalf = (x1 - x0) / 2 - 0.2;
  const leftC = x0 + wHalf / 2 + 0.2;
  const rightC = x1 - wHalf / 2 - 0.2;
  const n = 12;
  const rise = floorH / 2 / n;
  const run = 0.30;
  const runLen = n * run;

  const startA = flip ? z1 - 0.2 : z0 + 0.2;
  const endA = flip ? startA - runLen : startA + runLen;
  const landA = flip ? endA - 1.4 : endA;
  const landB = flip ? endA : endA + 1.4;

  for (let f = 0; f < floors; f++) {
    const y = yBase + f * floorH;
    b.stairs(leftC, y, startA, flip ? 0 : Math.PI, n, rise, run, wHalf, mat);
    b.slab(x0, landA, x1, landB, y + floorH / 2, 0.35, mat);
    b.stairs(rightC, y + floorH / 2, endA, flip ? Math.PI : 0, n, rise, run, wHalf, mat);
    b.railing(x0 + wHalf + 0.2, Math.min(startA, endA), x0 + wHalf + 0.2, Math.max(startA, endA),
      y + floorH / 2, railMat, 1.0);
  }
  return { landing: (landA + landB) / 2, leftC, rightC, entry: startA, runLen };
}

/**
 * Flat roof with a parapet and a slight cornice overhang.
 * `gaps` optionally opens a side up so a bridge or stair can land on the roof:
 * `{ north: [{ at, width }], … }` measured from the low corner of that side.
 */
function parapet(b, x0, z0, x1, z1, y, mat, h = 1.15, gaps = {}) {
  const t = 0.34;
  const o = 0.25;
  const y0 = y + 0.22, y1 = y + h;

  // The cornice is a ring, not a slab — a slab here would roof over every
  // stairwell hole and skylight on the deck below it.
  b.ext(x0 - o, y, z0 - o, x1 + o, y0, z0 + t, mat);
  b.ext(x0 - o, y, z1 - t, x1 + o, y0, z1 + o, mat);
  b.ext(x0 - o, y, z0 + t, x0 + t, y0, z1 - t, mat);
  b.ext(x1 - t, y, z0 + t, x1 + o, y0, z1 - t, mat);

  const open = (list) => (list || []).map((g) => ({ at: g.at, width: g.width, bottom: 0, top: h }));
  b.wall(x0, z0 + t / 2, x1, z0 + t / 2, y0, y1, t, mat, open(gaps.north));
  b.wall(x0, z1 - t / 2, x1, z1 - t / 2, y0, y1, t, mat, open(gaps.south));
  b.wall(x0 + t / 2, z0 + t, x0 + t / 2, z1 - t, y0, y1, t, mat, open(gaps.west));
  b.wall(x1 - t / 2, z0 + t, x1 - t / 2, z1 - t, y0, y1, t, mat, open(gaps.east));
}

/**
 * The little hut that caps a stairwell where it reaches a roof. Built as a
 * shell — a solid block here would seal the stairs off entirely.
 */
function headhouse(b, x0, z0, x1, z1, y, h, mat, door = 'north') {
  const t = 0.4;
  // The doorway sits over the right-hand flight, which is the one that tops out
  // on this level — centring it would put it above a four-metre drop.
  const gap = [{ at: (x1 - x0) * 0.71, width: 2.6, bottom: 0, top: 2.3 }];
  const gapN = door === 'north' ? gap : [];
  const gapS = door === 'south' ? gap : [];
  b.wall(x0, z0, x1, z0, y, y + h, t, mat, gapN);
  b.wall(x0, z1, x1, z1, y, y + h, t, mat, gapS);
  b.wall(x0, z0, x0, z1, y, y + h, t, mat, []);
  b.wall(x1, z0, x1, z1, y, y + h, t, mat, []);
  b.slab(x0 - 0.25, z0 - 0.25, x1 + 0.25, z1 + 0.25, y + h, 0.3, mat);
}

export function buildOldQuarter() {
  const b = new MapBuilder({
    id: 'oldquarter',
    name: 'Old Quarter',
    tagline: 'Coastal compound · 09:40 local',
    bounds: { min: [-78, -10, -78], max: [78, 36, 78] },
    ambience: 'day',
    sun: { azimuth: 128, elevation: 34, intensity: 3.1, color: 0xffe9cf },
    sky: { turbidity: 4.2, rayleigh: 1.1, mieCoefficient: 0.006, mieDirectionalG: 0.80 },
    fog: { color: 0x7d8fa0, density: 0.0026 },
    envIntensity: 0.11,
    exposure: 0.34,
  });

  ground(b);
  perimeter(b);
  plaza(b);
  consulate(b);
  warehouse(b);
  market(b);
  villa(b);
  tunnel(b);
  meta(b);

  return b.build();
}

// ---------------------------------------------------------------- ground
function ground(b) {
  // A backing slab under every surface patch, so a seam between two patches can
  // never become a hole. It stops short of the tunnel, which lives below it.
  b.slabHoles(-80, -80, 80, 80, -0.35, 0.6, 'dirt', GROUND_HOLES);

  // Surface patches overlap each other slightly so no seam can open up. Each
  // one therefore sits a millimetre above the last: coplanar surfaces at the
  // same height would z-fight, and the districts would flicker between
  // materials as the camera moves.
  let layer = 0;
  const patch = (x0, z0, x1, z1, m) =>
    b.slabHoles(x0 - 0.03, z0 - 0.03, x1 + 0.03, z1 + 0.03,
      (layer++) * 0.0012, 0.6, m, GROUND_HOLES);

  patch(-80, -80, 80, 80, 'sand');            // default surface
  patch(-24, -24, 24, 24, 'tile');            // plaza
  patch(-9, -50, 9, -24, 'stone');            // north approach
  patch(-9, 24, 9, 50, 'stone');              // south approach
  patch(22, -30, 72, 38, 'asphalt');          // market street
  patch(-74, -28, -24, 30, 'stone');          // villa forecourt
  patch(-36, 32, 10, 74, 'asphalt');          // warehouse yard
  patch(-30, -72, 18, -28, 'stone');          // consulate forecourt

  // Garden greens, kept slightly proud of the stone so edges read cleanly.
  b.slab(-40, -16, -26, 22, 0.06, 0.7, 'grass');
  b.slab(26, -24, 34, 32, 0.06, 0.7, 'grass');

  // Kerbs along the market street.
  b.ext(21.4, 0, -30, 22.4, 0.18, 38, 'concrete');
  b.ext(71.6, 0, -30, 72.6, 0.18, 38, 'concrete');
}

// ------------------------------------------------------------- perimeter
function perimeter(b) {
  const H = 14, T = 1.0, R = 76;
  b.ext(-R - T, 0, -R - T, R + T, H, -R, 'sandstone');
  b.ext(-R - T, 0, R, R + T, H, R + T, 'sandstone');
  b.ext(-R - T, 0, -R, -R, H, R, 'sandstone');
  b.ext(R, 0, -R, R + T, H, R, 'sandstone');

  // Crenellations for silhouette.
  for (let x = -R; x < R; x += 3.2) {
    b.ext(x + 0.4, H, -R - T, x + 2.4, H + 0.9, -R, 'sandstone');
    b.ext(x + 0.4, H, R, x + 2.4, H + 0.9, R + T, 'sandstone');
  }
  for (let z = -R; z < R; z += 3.2) {
    b.ext(-R - T, H, z + 0.4, -R, H + 0.9, z + 2.4, 'sandstone');
    b.ext(R, H, z + 0.4, R + T, H + 0.9, z + 2.4, 'sandstone');
  }

  // Distant skyline — visual only, never collided or shot.
  const skyline = [
    [-120, -140, 40, 26], [30, -150, 60, 34], [110, -120, 44, 20],
    [-150, -40, 36, 30], [130, 20, 50, 24], [-130, 60, 42, 18],
    [-60, 130, 55, 28], [40, 140, 48, 36], [120, 110, 38, 22],
  ];
  for (const [x, z, w, h] of skyline) {
    b.ext(x - w / 2, 0, z - w / 2, x + w / 2, h, z + w / 2, 'sandstone', { solid: false, blocksSight: false, distant: true });
  }
}

// ------------------------------------------------------------------ plaza
function plaza(b) {
  // Fountain: stepped octagon-ish basin built from rotated slabs.
  b.ext(-5.2, 0, -5.2, 5.2, 0.45, 5.2, 'marble');
  b.box([0, 0.45, 0], [7.4, 0.9, 7.4], 'marble', { r: Math.PI / 4 });
  b.ext(-4.4, 0.9, -4.4, 4.4, 1.05, 4.4, 'water', { solid: false, blocksSight: false, water: true });
  b.ext(-4.6, 0.45, -4.6, 4.6, 1.02, 4.6, 'marble', { solid: false, blocksSight: false, hollow: true });
  b.ext(-0.9, 0.9, -0.9, 0.9, 2.6, 0.9, 'marble');
  b.ext(-1.5, 2.6, -1.5, 1.5, 2.9, 1.5, 'marble');
  b.ext(-0.35, 2.9, -0.35, 0.35, 4.1, 0.35, 'marble');
  b.prop('fountain_jet', 0, 4.1, 0);

  // Raised viewing terrace on the west edge with steps up.
  b.slab(-22, -8, -14, 8, 1.2, 1.6, 'stone');
  b.stairs(-13.2, 0, 0, Math.PI / 2, 6, 0.2, 0.34, 8, 'stone');
  b.railing(-22, -8, -14, -8, 1.2, 'metal');
  b.railing(-22, 8, -14, 8, 1.2, 'metal');

  // Market stalls ringing the plaza.
  const stalls = [
    [14, -16, 0.3], [16, -6, 0.0], [15, 6, -0.2], [12, 15, 0.5],
    [-8, 17, 1.6], [2, 18, 1.5], [-16, 14, 1.2], [8, -18, 3.0],
  ];
  for (const [x, z, yaw] of stalls) {
    b.prop('stall', x, 0, z, { yaw });
    b.ext(x - 1.3, 0, z - 0.5, x + 1.3, 0.95, z + 0.5, 'wood', { r: 0 }); // counter collides
  }

  // Planters and palms.
  for (const [x, z] of [[-10, -10], [10, -10], [-10, 10], [10, 10]]) {
    b.ext(x - 1.1, 0, z - 1.1, x + 1.1, 0.62, z + 1.1, 'stone');
    b.prop('palm', x, 0.62, z, { scale: 1 + ((x + z) % 3) * 0.08 });
  }
  for (const [x, z, s] of [[-19, -19, 1.1], [19, -19, 0.95], [-19, 19, 1.05], [19, 19, 1.0], [0, -21, 1.15]]) {
    b.prop('palm', x, 0, z, { scale: s });
  }

  // Concrete barriers giving low cover across the open middle.
  const barriers = [
    [-7, -14, 0], [7, -14, 0], [-14, 4, Math.PI / 2], [14, -4, Math.PI / 2],
    [-4, 13, 0.2], [6, 12, -0.15], [18, 2, Math.PI / 2], [-18, -2, Math.PI / 2],
  ];
  for (const [x, z, r] of barriers) {
    b.box([x, 0.55, z], [2.6, 1.1, 0.7], 'concrete', { r });
    b.box([x, 1.1, z], [2.9, 0.14, 0.95], 'concrete', { r });
  }

  for (const [x, z] of [[-16, -16], [16, -16], [-16, 16], [16, 16]]) {
    b.prop('streetlamp', x, 0, z);
    b.light(x, 5.4, z, 0xffd9a0, 0.0, 14, { night: true });
  }

  b.prop('banner_arch', 0, 0, -23.5, { yaw: 0 });
}

// -------------------------------------------------------------- consulate
function consulate(b) {
  const X0 = -30, X1 = 18, Z0 = -70, Z1 = -30;
  const T = 0.62;

  // Slab-on-grade plus the two upper floors and the roof. Each has a hole for
  // the stairwell so the flights are actually reachable.
  const swX0 = -29.0, swX1 = -22.0, swZ0 = -37.4, swZ1 = -31.0;
  const hole = [swX0 - 0.1, swZ0 - 0.1, swX1 + 0.1, swZ1 + 0.1];

  b.slabHoles(X0, Z0, X1, Z1, 0, 0.5, 'concrete', [SHAFT_N]);
  b.slabHole(X0, Z0, X1, Z1, F2, 0.42, 'concrete', hole);
  b.slabHole(X0, Z0, X1, Z1, F3, 0.42, 'concrete', hole);
  b.slabHole(X0, Z0, X1, Z1, ROOF, 0.46, 'concrete', hole);

  switchback(b, swX0, swZ0, swX1, swZ1, 0, F2, 3, 'concrete');

  // --- Exterior shell. One call per face, all four floors of openings at once.
  const winF1 = { bottom: 1.05, top: 2.85, fill: 'glass' };
  const winF2 = { bottom: 5.45, top: 7.25, fill: 'glass' };
  const winF3 = { bottom: 9.85, top: 11.65 };            // upper floor already breached

  // South face (faces the plaza) — the money shot.
  b.wall(X0, Z1, X1, Z1, 0, ROOF, T, 'sandstone', [
    { at: 24, width: 4.6, bottom: 0, top: 3.3 },
    { at: 8, width: 2.4, ...winF1 }, { at: 15, width: 2.4, ...winF1 },
    { at: 33, width: 2.4, ...winF1 }, { at: 41, width: 2.4, ...winF1 },
    { at: 8, width: 2.4, ...winF2 }, { at: 15, width: 2.4, ...winF2 },
    { at: 24, width: 6.0, bottom: 4.42, top: 7.4 },      // balcony doors, floor level
    { at: 33, width: 2.4, ...winF2 }, { at: 41, width: 2.4, ...winF2 },
    { at: 8, width: 2.4, ...winF3 }, { at: 17, width: 3.2, ...winF3 },
    { at: 31, width: 3.2, ...winF3 }, { at: 41, width: 2.4, ...winF3 },
  ]);
  // North face
  b.wall(X0, Z0, X1, Z0, 0, ROOF, T, 'sandstone', [
    { at: 12, width: 3.4, bottom: 0, top: 3.1 },
    { at: 36, width: 2.4, ...winF1 }, { at: 24, width: 2.4, ...winF1 },
    { at: 12, width: 2.6, ...winF2 }, { at: 24, width: 2.6, ...winF2 }, { at: 36, width: 2.6, ...winF2 },
    { at: 12, width: 2.6, ...winF3 }, { at: 24, width: 2.6, ...winF3 }, { at: 36, width: 2.6, ...winF3 },
  ]);
  // West face
  b.wall(X0, Z0, X0, Z1, 0, ROOF, T, 'sandstone', [
    { at: 30, width: 3.2, bottom: 0, top: 3.1 },
    { at: 10, width: 2.4, ...winF1 }, { at: 20, width: 2.4, ...winF1 },
    { at: 10, width: 2.4, ...winF2 }, { at: 20, width: 2.4, ...winF2 }, { at: 30, width: 2.4, ...winF2 },
    { at: 10, width: 2.4, ...winF3 }, { at: 20, width: 2.4, ...winF3 }, { at: 30, width: 2.4, ...winF3 },
  ]);
  // East face
  b.wall(X1, Z0, X1, Z1, 0, ROOF, T, 'sandstone', [
    { at: 34, width: 3.2, bottom: 0, top: 3.1 },
    { at: 9, width: 2.4, ...winF1 }, { at: 20, width: 2.4, ...winF1 },
    { at: 9, width: 2.4, ...winF2 }, { at: 20, width: 2.4, ...winF2 }, { at: 30, width: 2.4, ...winF2 },
    { at: 9, width: 2.4, ...winF3 }, { at: 20, width: 2.4, ...winF3 }, { at: 30, width: 2.4, ...winF3 },
  ]);

  // --- Ground floor: lobby, corridor, two offices.
  b.wall(-21.4, -48, X1, -48, 0, 4.0, 0.4, 'plaster', [
    { at: 6, width: 2.6, bottom: 0, top: 2.6 },
    { at: 26, width: 2.6, bottom: 0, top: 2.6 },
  ]);
  b.wall(-4, -70, -4, -48, 0, 4.0, 0.4, 'plaster', [{ at: 11, width: 2.6, bottom: 0, top: 2.6 }]);
  b.wall(-21.4, -60, -4, -60, 0, 4.0, 0.4, 'plaster', [{ at: 9, width: 2.6, bottom: 0, top: 2.6 }]);
  b.wall(-21.4, -48, -21.4, -70, 0, 4.0, 0.4, 'plaster', [
    { at: 8, width: 2.6, bottom: 0, top: 2.6 },
    { at: 18, width: 2.2, bottom: 1.0, top: 2.6 },
  ]);

  b.ext(-14, 0, -46, -6, 1.05, -44.4, 'woodDark');     // reception desk
  b.ext(-14, 1.05, -46, -6, 1.18, -44.2, 'marble');
  b.prop('sign', -10, 3.2, -47.6, { yaw: 0, label: 'CONSULATE' });

  for (const [x, z] of [[-16, -55], [4, -54], [10, -64], [-16, -66]]) {
    b.prop('desk', x, 0, z, { yaw: (x + z) % 2 ? 0 : Math.PI / 2 });
    b.ext(x - 0.85, 0, z - 0.55, x + 0.85, 0.76, z + 0.55, 'woodDark');
    b.prop('chair', x, 0, z + 1.2);
  }
  for (const [x, z, r] of [[-20.8, -52, Math.PI / 2], [17.2, -58, Math.PI / 2], [-2, -69.2, 0]]) {
    b.prop('shelf', x, 0, z, { yaw: r });
    b.box([x, 1.0, z], [0.5, 2.0, 2.4], 'woodDark', { r });
  }

  // --- Second floor: open office, meeting room, balcony.
  b.wall(-21.4, -56, 4, -56, F2, F2 + 4.0, 0.4, 'plaster', [
    { at: 8, width: 2.6, bottom: 0, top: 2.6 },
    { at: 20, width: 3.2, bottom: 1.0, top: 2.8, fill: 'glass' },
  ]);
  b.wall(4, -70, 4, -56, F2, F2 + 4.0, 0.4, 'plaster', [{ at: 7, width: 2.6, bottom: 0, top: 2.6 }]);
  b.wall(-21.4, -42, 6, -42, F2, F2 + 4.0, 0.4, 'plaster', [
    { at: 10, width: 2.6, bottom: 0, top: 2.6 },
    { at: 21, width: 4.0, bottom: 1.0, top: 2.8 },
  ]);
  for (const [x, z] of [[-14, -50], [-8, -50], [-2, -50], [-14, -46], [-8, -46]]) {
    b.ext(x - 0.9, F2, z - 0.6, x + 0.9, F2 + 0.76, z + 0.6, 'woodDark');
    b.ext(x - 0.95, F2 + 0.76, z - 0.65, x + 0.95, F2 + 1.28, z - 0.5, 'plaster'); // cubicle divider
    b.prop('chair', x, F2, z + 1.1);
  }
  b.ext(-2, F2, -64, 12, F2 + 0.78, -60, 'woodDark');    // meeting table
  for (let i = 0; i < 6; i++) b.prop('chair', -1 + i * 2.4, F2, -66);

  // Balcony over the plaza.
  b.slab(-9, -30.6, 3, -26.2, F2, 0.36, 'concrete');
  b.railing(-9, -26.2, 3, -26.2, F2, 'metal', 1.1);
  b.railing(-9, -30.6, -9, -26.2, F2, 'metal', 1.1);
  b.railing(3, -30.6, 3, -26.2, F2, 'metal', 1.1);
  b.ext(-9.3, F2 + 3.1, -30.8, 3.3, F2 + 3.4, -26.0, 'wood');   // canopy
  b.ext(-9.3, F2, -30.8, -8.9, F2 + 3.1, -26.0, 'wood', { solid: false, blocksSight: false });
  b.ext(2.9, F2, -30.8, 3.3, F2 + 3.1, -26.0, 'wood', { solid: false, blocksSight: false });

  // --- Third floor: archive + long gallery.
  b.wall(-21.4, -52, 8, -52, F3, F3 + 4.0, 0.4, 'plaster', [
    { at: 6, width: 2.6, bottom: 0, top: 2.6 },
    { at: 18, width: 2.6, bottom: 0, top: 2.6 },
  ]);
  b.wall(-6, -70, -6, -52, F3, F3 + 4.0, 0.4, 'plaster', [{ at: 9, width: 2.6, bottom: 0, top: 2.6 }]);
  for (const [x, z, r] of [[-18, -58, 0], [-18, -63, 0], [2, -60, Math.PI / 2], [6, -66, 0]]) {
    b.box([x, F3 + 1.05, z], [3.0, 2.1, 0.55], 'metalRust', { r });
    b.prop('shelf', x, F3, z, { yaw: r });
  }
  b.ext(-20, F3, -46, -12, F3 + 1.0, -44, 'crate');
  b.ext(4, F3, -40, 10, F3 + 1.0, -36, 'crate');

  // --- Roof.
  parapet(b, X0, Z0, X1, Z1, ROOF, 'sandstone', 1.25);
  headhouse(b, swX0 - 0.4, swZ0 - 0.4, swX1 + 0.4, swZ1 + 0.4, ROOF, 2.7, 'sandstone', 'north');
  for (const [x, z] of [[-14, -60], [-2, -56], [8, -64]]) b.prop('ac_unit', x, ROOF, z);
  b.ext(-14.9, ROOF, -60.9, -13.1, ROOF + 1.1, -59.1, 'metal');
  b.ext(-2.9, ROOF, -56.9, -1.1, ROOF + 1.1, -55.1, 'metal');
  b.ext(7.1, ROOF, -64.9, 8.9, ROOF + 1.1, -63.1, 'metal');
  b.prop('antenna', 12, ROOF, -46, { scale: 1.4 });
  b.prop('flag', -24, ROOF, -34, { scale: 1.2 });

  // Interior lighting.
  for (const [x, y, z] of [[-10, 3.7, -46], [6, 3.7, -56], [-16, 3.7, -62],
                           [-8, F2 + 3.7, -48], [6, F2 + 3.7, -62],
                           [-12, F3 + 3.7, -58], [2, F3 + 3.7, -46]]) {
    b.prop('ceiling_lamp', x, y, z);
    b.light(x, y - 0.3, z, 0xffe4bd, 1.5, 13);
  }
}

// -------------------------------------------------------------- warehouse
function warehouse(b) {
  const X0 = -34, X1 = 6, Z0 = 30, Z1 = 70;
  const H = 10.5, CAT = 5.2, T = 0.55;

  b.slabHoles(X0, Z0, X1, Z1, 0, 0.5, 'concrete', [SHAFT_S]);

  // Shell: big roller doors north and east, clerestory windows high up.
  b.wall(X0, Z0, X1, Z0, 0, H, T, 'metalRust', [
    { at: 12, width: 6.5, bottom: 0, top: 5.2 },
    { at: 28, width: 6.5, bottom: 0, top: 5.2 },
    { at: 6, width: 3.0, bottom: 7.4, top: 9.2 },
    { at: 20, width: 3.0, bottom: 7.4, top: 9.2 },
    { at: 34, width: 3.0, bottom: 7.4, top: 9.2 },
  ]);
  b.wall(X0, Z1, X1, Z1, 0, H, T, 'metalRust', [
    { at: 20, width: 6.5, bottom: 0, top: 5.2 },
    { at: 8, width: 3.0, bottom: 7.4, top: 9.2 },
    { at: 32, width: 3.0, bottom: 7.4, top: 9.2 },
  ]);
  b.wall(X0, Z0, X0, Z1, 0, H, T, 'metalRust', [
    { at: 10, width: 3.2, bottom: 0, top: 3.1 },
    { at: 30, width: 3.2, bottom: 0, top: 3.1 },
    { at: 20, width: 4.0, bottom: 7.4, top: 9.2 },
  ]);
  b.wall(X1, Z0, X1, Z1, 0, H, T, 'metalRust', [
    { at: 14, width: 6.5, bottom: 0, top: 5.2 },
    { at: 30, width: 3.2, bottom: 0, top: 3.1 },
    { at: 6, width: 3.0, bottom: 7.4, top: 9.2 },
    { at: 24, width: 3.0, bottom: 7.4, top: 9.2 },
  ]);

  // Roof, with skylights punched clean through it. The deck is emitted as
  // bands in Z so each skylight sits in a real hole rather than an overlap;
  // the glass panel that fills it is solid underfoot but clear to sight.
  const sky = [[-26, 38], [-2, 46], [-14, 52]];
  const bands = [[Z0, 35.6], [35.6, 40.4], [40.4, 43.6], [43.6, 48.4], [48.4, 49.6], [49.6, 54.4], [54.4, Z1]];
  for (const [za, zb] of bands) {
    const inBand = sky.filter((s) => s[1] > za && s[1] < zb);
    if (!inBand.length) { b.slab(X0, za, X1, zb, H, 0.4, 'metal'); continue; }
    let cx = X0;
    for (const [sx] of inBand.sort((p, q) => p[0] - q[0])) {
      b.slab(cx, za, sx - 2.4, zb, H, 0.4, 'metal');
      cx = sx + 2.4;
    }
    b.slab(cx, za, X1, zb, H, 0.4, 'metal');
  }
  for (const [sx, sz] of sky) {
    b.ext(sx - 2.2, H - 0.36, sz - 2.2, sx + 2.2, H - 0.06, sz + 2.2, 'glass',
      { solid: true, blocksSight: false, glass: true, skylight: true });
    b.ext(sx - 2.4, H - 0.4, sz - 2.4, sx + 2.4, H + 0.04, sz - 2.2, 'metal');
    b.ext(sx - 2.4, H - 0.4, sz + 2.2, sx + 2.4, H + 0.04, sz + 2.4, 'metal');
    b.ext(sx - 2.4, H - 0.4, sz - 2.2, sx - 2.2, H + 0.04, sz + 2.2, 'metal');
    b.ext(sx + 2.2, H - 0.4, sz - 2.2, sx + 2.4, H + 0.04, sz + 2.2, 'metal');
  }
  parapet(b, X0, Z0, X1, Z1, H, 'metalRust', 0.9);

  // Roof trusses, seen from below.
  for (let z = Z0 + 3; z < Z1; z += 4) {
    b.ext(X0 + 0.6, H - 0.95, z - 0.16, X1 - 0.6, H - 0.45, z + 0.16, 'metal', { solid: false, blocksSight: false });
  }

  // Catwalk ring with stairs up from the floor.
  const cw = 1.8;
  b.slab(X0 + 0.6, Z0 + 0.6, X0 + 0.6 + cw, Z1 - 0.6, CAT, 0.24, 'metal');
  b.slab(X1 - 0.6 - cw, Z0 + 0.6, X1 - 0.6, Z1 - 0.6, CAT, 0.24, 'metal');
  b.slab(X0 + 0.6, Z1 - 0.6 - cw, X1 - 0.6, Z1 - 0.6, CAT, 0.24, 'metal');
  b.railing(X0 + 0.6 + cw, Z0 + 0.6, X0 + 0.6 + cw, Z1 - 0.6, CAT, 'metal');
  b.railing(X1 - 0.6 - cw, Z0 + 0.6, X1 - 0.6 - cw, Z1 - 0.6, CAT, 'metal');
  b.railing(X0 + 0.6 + cw, Z1 - 0.6 - cw, X1 - 0.6 - cw, Z1 - 0.6 - cw, CAT, 'metal');

  // Cross-bridge over the middle of the floor.
  b.slab(X0 + 2.4, 48.2, X1 - 2.4, 50.0, CAT, 0.22, 'metal');
  b.railing(X0 + 2.4, 48.2, X1 - 2.4, 48.2, CAT, 'metal');
  b.railing(X0 + 2.4, 50.0, X1 - 2.4, 50.0, CAT, 'metal');

  b.stairs(-31.6, 0, 36.0, Math.PI, 22, CAT / 22, 0.30, 1.7, 'metal');
  b.stairs(3.6, 0, 64.0, 0, 22, CAT / 22, 0.30, 1.7, 'metal');
  b.railing(-30.6, 36.0, -30.6, 42.6, 0, 'metal', 1.0);

  // Exterior stair to the roof on the west face.
  b.stairs(-36.4, 0, 62.0, 0, 34, H / 34, 0.32, 2.0, 'metal');
  b.slab(-38.0, 48.0, -34.6, 51.4, H, 0.3, 'metal');
  b.railing(-38.0, 48.0, -38.0, 51.4, H, 'metal');

  // Container stacks and pallets — the real cover on the floor.
  const stack = (x, y, z, r, m) => {
    b.box([x, y + 1.3, z], [6.06, 2.6, 2.44], m, { r });
    b.box([x, y + 2.62, z], [6.2, 0.1, 2.56], 'metalRust', { r, solid: false, blocksSight: false });
  };
  stack(-27, 0, 36, 0, 'container');
  stack(-27, 2.6, 36, 0, 'containerB');
  stack(-12, 0, 38, Math.PI / 2, 'containerB');
  stack(-28, 0, 58, 0.05, 'container');
  stack(-28, 2.6, 58, 0.05, 'container');
  stack(-4, 0, 60, Math.PI / 2, 'containerB');
  stack(-18, 0, 66, 0.2, 'container');
  stack(-2, 0, 34, 1.55, 'container');

  for (const [x, z, h] of [[-20, 44, 2], [-8, 48, 3], [-24, 52, 1], [-14, 58, 2], [0, 52, 2], [-30, 46, 1]]) {
    for (let i = 0; i < h; i++) {
      b.box([x, 0.62 + i * 1.24, z], [1.18, 1.2, 1.18], 'crate', { r: (i * 0.3 + x) % 1 });
    }
    b.prop('pallet', x, 0, z + 1.6);
  }
  for (const [x, z] of [[-32, 40], [-6, 42], [-22, 62], [2, 46]]) {
    b.box([x, 0.55, z], [0.62, 1.1, 0.62], 'metalRust');
    b.prop('barrel', x, 0, z);
    b.prop('barrel', x + 0.75, 0, z + 0.3);
    b.box([x + 0.75, 0.55, z + 0.3], [0.62, 1.1, 0.62], 'metalRust');
  }

  // Yard outside: parked containers, fuel drums, a generator.
  stack(10, 0, 44, 0, 'containerB');
  stack(10, 2.6, 44, 0, 'container');
  stack(-40, 0, 40, Math.PI / 2, 'container');
  b.prop('generator', 8, 0, 62, { yaw: 0.4 });
  b.ext(6.6, 0, 60.6, 9.4, 1.5, 63.4, 'metal');

  for (const [x, y, z] of [[-26, 9.4, 40], [-10, 9.4, 46], [-20, 9.4, 60], [-4, 9.4, 66], [-30, 9.4, 52]]) {
    b.prop('hangar_lamp', x, y, z);
    b.light(x, y - 0.5, z, 0xcfe0ff, 2.2, 18);
  }
}

// ----------------------------------------------------------------- market
function market(b) {
  // Two shop blocks facing each other across the street, plus a corner tower.
  const shop = (x0, z0, x1, z1, roofY, label, gaps = {}) => {
    b.slab(x0, z0, x1, z1, 0, 0.4, 'concrete');
    const T = 0.5;
    b.wall(x0, z0, x1, z0, 0, roofY, T, 'brick', [
      { at: (x1 - x0) * 0.3, width: 3.0, bottom: 0, top: 3.0 },
      { at: (x1 - x0) * 0.7, width: 3.4, bottom: 1.0, top: 3.0, fill: 'glass' },
    ]);
    b.wall(x0, z1, x1, z1, 0, roofY, T, 'brick', [
      { at: (x1 - x0) * 0.5, width: 3.0, bottom: 0, top: 3.0 },
      { at: (x1 - x0) * 0.2, width: 2.4, bottom: 1.2, top: 3.0, fill: 'glass' },
    ]);
    b.wall(x0, z0, x0, z1, 0, roofY, T, 'brick', [
      { at: (z1 - z0) * 0.4, width: 2.8, bottom: 0, top: 3.0 },
      { at: (z1 - z0) * 0.8, width: 2.4, bottom: 1.2, top: 3.0, fill: 'glass' },
    ]);
    b.wall(x1, z0, x1, z1, 0, roofY, T, 'brick', [
      { at: (z1 - z0) * 0.6, width: 2.8, bottom: 0, top: 3.0 },
    ]);
    b.slab(x0, z0, x1, z1, roofY, 0.4, 'concrete');
    parapet(b, x0, z0, x1, z1, roofY, 'brick', 1.0, gaps);
    b.prop('sign', (x0 + x1) / 2, 3.6, z0 - 0.4, { label });
    // Interior partition with a doorway, so shops are not empty shells.
    b.wall(x0 + 0.5, (z0 + z1) / 2, x1 - 0.5, (z0 + z1) / 2, 0, roofY - 0.4, 0.35, 'plaster',
      [{ at: (x1 - x0) * 0.35, width: 2.6, bottom: 0, top: 2.6 }]);
    for (const [sx, sz] of [[x0 + 2, z0 + 2.5], [x1 - 2, z1 - 3]]) {
      b.box([sx, 1.0, sz], [0.5, 2.0, 2.6], 'woodDark');
      b.prop('shelf', sx, 0, sz, { yaw: Math.PI / 2 });
    }
    b.prop('ceiling_lamp', (x0 + x1) / 2, roofY - 0.7, (z0 + z1) / 2 - 4);
    b.light((x0 + x1) / 2, roofY - 1.0, (z0 + z1) / 2 - 4, 0xffe0b0, 1.6, 14);
  };

  // Gaps let the roof bridges and the street stair actually land on the roofs.
  shop(44, -26, 68, -4, 6.0, 'SOUK', {
    north: [{ at: 16, width: 4.6 }],    // bridge down from the tower
    south: [{ at: 10, width: 8.6 }],    // bridge across the alley
    west: [{ at: 19.2, width: 3.4 }],   // top of the street stair
  });
  shop(44, 6, 68, 30, 6.0, 'TEXTILES', {
    north: [{ at: 10, width: 8.6 }],
  });

  // Awnings along the street frontage.
  for (let z = -24; z < 30; z += 4.5) {
    if (z > -6 && z < 4) continue;
    b.ext(41.6, 3.2, z - 1.9, 44.2, 3.55, z + 1.9, 'fabric', { solid: false, blocksSight: false });
    b.ext(41.5, 2.6, z - 1.9, 41.75, 3.3, z - 1.7, 'metal', { solid: false, blocksSight: false });
    b.ext(41.5, 2.6, z + 1.7, 41.75, 3.3, z + 1.9, 'metal', { solid: false, blocksSight: false });
    b.prop('stall', 39.5, 0, z, { yaw: Math.PI / 2 });
    b.ext(38.6, 0, z - 1.3, 39.9, 0.95, z + 1.3, 'wood');
  }

  // Roof access: exterior stair from the street onto SOUK's roof, plank bridge
  // across the alley to TEXTILES, and a second bridge north to the tower.
  b.stairs(40.2, 0, -2.4, Math.PI, 20, 0.30, 0.32, 2.2, 'concrete');
  b.slab(38.6, -9.0, 42.6, -2.6, 6.0, 0.34, 'concrete');
  b.railing(38.6, -9.0, 38.6, -2.6, 6.0, 'metal');
  b.ext(42.6, 5.66, -8.2, 44.4, 6.0, -5.4, 'wood');       // landing onto shop roof
  b.ext(50, 5.7, -4.6, 58, 6.0, 6.6, 'wood');             // plank bridge over the alley
  b.railing(50, -4.6, 50, 6.6, 6.0, 'wood');
  b.railing(58, -4.6, 58, 6.6, 6.0, 'wood');

  // Corner tower. Floors are evenly spaced so the stairwell actually lands on
  // each one, and level 1 matches the shop roofs so the bridge is level.
  const TX0 = 56, TZ0 = -46, TX1 = 70, TZ1 = -32;
  const TOP = 18.0;
  const swZ0 = TZ1 - 6.0, swZ1 = TZ1 - 0.6;
  const thole = [TX0 + 0.5, swZ0 - 0.1, TX0 + 6.5, swZ1 + 0.1];
  b.slab(TX0, TZ0, TX1, TZ1, 0, 0.5, 'stone');
  for (const y of [6.0, 12.0, TOP]) b.slabHole(TX0, TZ0, TX1, TZ1, y, 0.4, 'stone', thole);
  switchback(b, TX0 + 0.6, swZ0, TX0 + 6.4, swZ1, 0, 6.0, 3, 'stone');
  b.railing(thole[0], thole[1], thole[0], thole[3], TOP, 'metal');
  b.railing(thole[2], thole[1], thole[2], thole[3], TOP, 'metal');

  const twin = (y) => ([
    { at: 4, width: 2.2, bottom: y + 1.0, top: y + 2.8 },
    { at: 10, width: 2.2, bottom: y + 1.0, top: y + 2.8 },
  ]);
  b.wall(TX0, TZ0, TX1, TZ0, 0, TOP, 0.55, 'sandstone', [...twin(0), ...twin(6.0), ...twin(12.0)]);
  b.wall(TX0, TZ1, TX1, TZ1, 0, TOP, 0.55, 'sandstone', [
    { at: 10, width: 3.0, bottom: 0, top: 3.0 },
    { at: 4, width: 3.0, bottom: 6.0, top: 8.4 },   // out onto the roof bridge
    ...twin(6.0), ...twin(12.0),
  ]);
  b.wall(TX0, TZ0, TX0, TZ1, 0, TOP, 0.55, 'sandstone', [...twin(6.0), ...twin(12.0)]);
  b.wall(TX1, TZ0, TX1, TZ1, 0, TOP, 0.55, 'sandstone', [...twin(0), ...twin(6.0), ...twin(12.0)]);
  parapet(b, TX0, TZ0, TX1, TZ1, TOP, 'sandstone', 1.3);
  b.prop('flag', TX1 - 2, TOP, TZ0 + 2, { scale: 1.3 });

  // Bridge from the tower's first level down to the SOUK roof.
  b.ext(58, 5.7, -32.6, 62, 6.0, -25.6, 'wood');
  b.railing(58, -32.6, 58, -25.8, 6.0, 'wood');
  b.railing(62, -32.6, 62, -25.8, 6.0, 'wood');

  // Street furniture.
  for (let z = -26; z <= 34; z += 12) {
    b.prop('streetlamp', 23.4, 0, z);
    b.light(23.4, 5.4, z, 0xffd9a0, 0.0, 14, { night: true });
    b.prop('streetlamp', 70.6, 0, z + 6);
  }
  for (const [x, z, r] of [[30, -18, 0.2], [34, 8, 1.4], [28, 24, 0.0], [60, 34, 0.8]]) {
    b.prop('planter', x, 0, z, { yaw: r });
    b.ext(x - 1.0, 0, z - 1.0, x + 1.0, 0.7, z + 1.0, 'stone');
    b.prop('bush', x, 0.7, z);
  }
  for (const [x, z] of [[27, -10], [31, 16], [33, -24], [26, 30]]) {
    b.box([x, 0.55, z], [2.6, 1.1, 0.7], 'concrete', { r: 0.4 });
  }
  b.prop('cypress', 30, 0, -4, { scale: 1.2 });
  b.prop('cypress', 33, 0, 2, { scale: 1.05 });
}

// ------------------------------------------------------------------ villa
function villa(b) {
  const X0 = -68, X1 = -42, Z0 = -22, Z1 = 8;
  const FH = 4.3, ROOF2 = 8.6;

  b.slab(X0, Z0, X1, Z1, 0, 0.45, 'marble');
  const swX0 = -47.6, swZ0 = -21.4, swX1 = -42.6, swZ1 = -15.4;
  b.slabHole(X0, Z0, X1, Z1, FH, 0.4, 'marble', [swX0 - 0.1, swZ0 - 0.1, swX1 + 0.1, swZ1 + 0.1]);
  b.slabHole(X0, Z0, X1, Z1, ROOF2, 0.45, 'stone', [swX0 - 0.1, swZ0 - 0.1, swX1 + 0.1, swZ1 + 0.1]);
  // Entered from the hall side, so the flight runs away from the north wall.
  switchback(b, swX0, swZ0, swX1, swZ1, 0, FH, 2, 'marble', 'metal', true);

  const arches = [];
  for (let i = 0; i < 5; i++) arches.push({ at: 3.4 + i * 5.8, width: 3.2, bottom: 0, top: 3.2 });
  // East face is an arcade opening onto the garden.
  b.wall(X1, Z0, X1, Z1, 0, ROOF2, 0.55, 'sandstone', [
    ...arches,
    { at: 8, width: 2.4, bottom: 5.3, top: 7.3 },
    { at: 20, width: 2.4, bottom: 5.3, top: 7.3 },
  ]);
  b.wall(X0, Z0, X0, Z1, 0, ROOF2, 0.55, 'sandstone', [
    { at: 14, width: 3.0, bottom: 0, top: 3.0 },
    { at: 6, width: 2.2, bottom: 1.1, top: 2.9, fill: 'glass' },
    { at: 22, width: 2.2, bottom: 1.1, top: 2.9, fill: 'glass' },
    { at: 8, width: 2.4, bottom: 5.3, top: 7.3 },
    { at: 20, width: 2.4, bottom: 5.3, top: 7.3 },
  ]);
  b.wall(X0, Z0, X1, Z0, 0, ROOF2, 0.55, 'sandstone', [
    { at: 13, width: 3.2, bottom: 0, top: 3.0 },
    { at: 6, width: 2.4, bottom: 5.3, top: 7.3 },
    { at: 20, width: 2.4, bottom: 5.3, top: 7.3 },
  ]);
  b.wall(X0, Z1, X1, Z1, 0, ROOF2, 0.55, 'sandstone', [
    { at: 8, width: 3.2, bottom: 0, top: 3.0 },
    { at: 18, width: 2.4, bottom: 1.1, top: 2.9, fill: 'glass' },
    { at: 13, width: 2.4, bottom: 5.3, top: 7.3 },
  ]);

  // Interior: a central hall with an arcade of columns, two side rooms.
  for (let i = 0; i < 4; i++) {
    b.pillar(X0 + 7 + i * 4.4, Z0 + 9, 0, FH - 0.4, 0.34, 'marble', 'stone');
    b.pillar(X0 + 7 + i * 4.4, Z0 + 21, 0, FH - 0.4, 0.34, 'marble', 'stone');
  }
  b.wall(X0 + 0.5, -8, X0 + 12, -8, 0, FH - 0.4, 0.4, 'plaster', [{ at: 6, width: 2.6, bottom: 0, top: 2.6 }]);
  b.wall(X0 + 0.5, 0, X0 + 12, 0, 0, FH - 0.4, 0.4, 'plaster', [{ at: 4, width: 2.6, bottom: 0, top: 2.6 }]);
  b.wall(X0 + 12, -8, X0 + 12, 0, 0, FH - 0.4, 0.4, 'plaster', [{ at: 4, width: 2.6, bottom: 0, top: 2.6 }]);

  b.wall(X0 + 0.5, -6, X0 + 14, -6, FH, ROOF2 - 0.45, 0.4, 'plaster', [{ at: 7, width: 2.6, bottom: 0, top: 2.6 }]);
  b.wall(X0 + 14, -20, X0 + 14, 4, FH, ROOF2 - 0.45, 0.4, 'plaster', [
    { at: 8, width: 2.6, bottom: 0, top: 2.6 }, { at: 18, width: 3.0, bottom: 1.0, top: 2.8 },
  ]);

  parapet(b, X0, Z0, X1, Z1, ROOF2, 'sandstone', 1.1);
  headhouse(b, swX0 - 0.4, swZ0 - 0.4, swX1 + 0.4, swZ1 + 0.4, ROOF2, 2.6, 'sandstone', 'south');

  // Garden: reflecting pool, hedges, cypresses.
  b.ext(-38, 0, -12, -28, 0.5, 16, 'stone');
  b.ext(-37.2, 0, -11.2, -28.8, 0.42, 15.2, 'water', { solid: false, blocksSight: false, water: true });
  for (let z = -10; z <= 14; z += 6) {
    b.prop('cypress', -39.6, 0, z, { scale: 1.15 });
    b.prop('cypress', -26.4, 0, z, { scale: 1.05 });
  }
  for (const [x, z, w, d] of [[-34, -15, 8, 1.2], [-34, 19, 8, 1.2], [-24, 4, 1.2, 10]]) {
    b.ext(x - w / 2, 0, z - d / 2, x + w / 2, 1.15, z + d / 2, 'hedge', { blocksSight: true });
    b.prop('hedge', x, 0, z, { sx: w, sz: d });
  }
  b.prop('well', -33, 0, 22);
  b.ext(-34.1, 0, 20.9, -31.9, 1.0, 23.1, 'stone');

  // Garden wall separating villa grounds from the plaza approach.
  b.wall(-24, -26, -24, 28, 0, 3.4, 0.5, 'sandstone', [
    { at: 12, width: 3.4, bottom: 0, top: 3.0 },
    { at: 38, width: 3.4, bottom: 0, top: 3.0 },
  ]);
  b.wall(-70, -26, -24, -26, 0, 3.4, 0.5, 'sandstone', [{ at: 30, width: 3.4, bottom: 0, top: 3.0 }]);
  b.wall(-70, 28, -24, 28, 0, 3.4, 0.5, 'sandstone', [{ at: 24, width: 3.4, bottom: 0, top: 3.0 }]);

  // Plank bridge from the villa roof to the perimeter wall walkway.
  b.ext(-76.0, 8.3, -6.0, -68.0, 8.6, -2.0, 'wood');
  b.railing(-76.0, -6.0, -68.0, -6.0, 8.6, 'wood');
  b.railing(-76.0, -2.0, -68.0, -2.0, 8.6, 'wood');
  b.slab(-76.0, -14.0, -72.0, 6.0, 8.6, 0.35, 'stone');
  b.railing(-72.0, -14.0, -72.0, 6.0, 8.6, 'metal');
  b.stairs(-74.0, 0, 12.0, 0, 28, 8.6 / 28, 0.32, 3.2, 'stone');

  for (const [x, y, z] of [[-56, FH - 0.7, -14], [-56, FH - 0.7, 2], [-50, ROOF2 - 1.1, -10]]) {
    b.prop('ceiling_lamp', x, y, z);
    b.light(x, y - 0.3, z, 0xffd9a8, 1.4, 14);
  }
}

// ----------------------------------------------------------------- tunnel
function tunnel(b) {
  // Deep enough to clear the ground backing slab entirely.
  const Y = -5.0, H = 3.2;
  const IN0 = -5.5, IN1 = -0.5;   // inner faces of the corridor
  const Z0 = -42, Z1 = 42;
  const CEIL = Y + H;             // underside of the ceiling
  const CTOP = CEIL + 0.6;        // top of the ceiling slab

  b.slab(IN0 - 0.8, Z0, IN1 + 0.8, Z1, Y, 0.6, 'concrete');
  b.ext(IN0 - 0.8, Y, Z0, IN0, CTOP, Z1, 'concrete');
  // The east wall is split around the side chamber's doorway.
  b.ext(IN1, Y, Z0, IN1 + 0.8, CTOP, 0, 'concrete');
  b.ext(IN1, Y, 9, IN1 + 0.8, CTOP, Z1, 'concrete');
  b.wall(IN1 + 0.4, 0, IN1 + 0.4, 9, Y, CTOP, 0.8, 'concrete',
    [{ at: 4.5, width: 3.0, bottom: 0, top: 2.6 }]);
  b.slabHoles(IN0 - 0.8, Z0, IN1 + 0.8, Z1, CTOP, 0.6, 'concrete', GROUND_HOLES);
  b.ext(IN0, Y, Z0 - 0.8, IN1, CEIL, Z0, 'concrete');
  b.ext(IN0, Y, Z1, IN1, CEIL, Z1 + 0.8, 'concrete');

  // A side chamber halfway along gives the tunnel a fight to have in it.
  const CX1 = 7.0;
  b.slab(IN1, 0, CX1 + 0.6, 9, Y, 0.6, 'concrete');
  b.slab(IN1, 0, CX1 + 0.6, 9, CTOP, 0.6, 'concrete');
  b.ext(CX1, Y, 0, CX1 + 0.6, CTOP, 9, 'concrete');
  b.ext(IN1, Y, -0.6, CX1 + 0.6, CTOP, 0, 'concrete');
  b.ext(IN1, Y, 9, CX1 + 0.6, CTOP, 9.6, 'concrete');
  for (const [x, z] of [[1.6, 3], [4.6, 6.5]]) {
    b.box([x, Y + 0.6, z], [1.18, 1.2, 1.18], 'crate');
    b.box([x, Y + 1.8, z], [1.18, 1.2, 1.18], 'crate', { r: 0.4 });
  }

  // Stair shafts. The north one surfaces inside the consulate lobby, the south
  // one inside the warehouse; both climb within the corridor and exit through
  // the holes cut in every ground-level deck.
  const shaft = (hole, dir) => {
    const steps = 22;
    const zStart = dir < 0 ? hole[3] : hole[1];
    b.stairs(-3, Y, zStart, dir < 0 ? 0 : Math.PI, steps, Math.abs(Y) / steps, 0.32, 3.4, 'concrete');
    b.ext(IN0, Y, hole[1], hole[0], 3.2, hole[3], 'concrete');
    b.ext(hole[2], Y, hole[1], IN1, 3.2, hole[3], 'concrete');
    // Wall off the deep end — the end where the stairs start — so nobody can
    // walk off the surrounding floor straight into the shaft.
    if (dir < 0) b.ext(IN0, 0, hole[3], IN1, 3.2, hole[3] + 0.6, 'concrete');
    else b.ext(IN0, 0, hole[1] - 0.6, IN1, 3.2, hole[1], 'concrete');
    b.railing(hole[0], hole[1], hole[0], hole[3], 0.02, 'metal');
    b.railing(hole[2], hole[1], hole[2], hole[3], 0.02, 'metal');
  };
  shaft(SHAFT_N, -1);
  shaft(SHAFT_S, 1);

  // Caged lamps every few metres.
  for (let z = -38; z <= 40; z += 8) {
    b.prop('cage_lamp', -3, CEIL + 0.3, z);
    b.light(-3, CEIL + 0.1, z, 0xffc98a, 1.3, 11);
  }
  b.prop('cage_lamp', 4, CEIL + 0.3, 4.5);
  b.light(4, CEIL + 0.1, 4.5, 0xffc98a, 1.2, 10);

  for (let z = -36; z < 40; z += 6) {
    b.ext(IN0, CEIL - 0.35, z - 0.12, IN1, CEIL - 0.2, z + 0.12, 'metalRust', { solid: false, blocksSight: false });
  }
  b.prop('pipe_run', -3, CEIL - 0.5, 0, { length: 84 });
}

// ------------------------------------------------------------------- meta
function meta(b) {
  // --- Zones (used by the kill feed and callouts) ---
  b.zone('Plaza', -24, -24, 24, 24);
  b.zone('Consulate', -30, -70, 18, -30);
  b.zone('Consulate Forecourt', -30, -78, 18, -22, -1, 4);
  b.zone('Warehouse', -34, 30, 6, 70);
  b.zone('Warehouse Yard', -40, 24, 14, 78, -1, 4);
  b.zone('Market Street', 22, -30, 44, 38);
  b.zone('Souk', 44, -26, 68, -4);
  b.zone('Textiles', 44, 6, 68, 30);
  b.zone('Watchtower', 56, -46, 70, -32);
  b.zone('Villa', -68, -22, -42, 8);
  b.zone('Garden', -42, -22, -24, 28);
  b.zone('Service Tunnel', -12, -36, 8, 40, -8, -0.5);
  b.zone('Rooftops', -78, -78, 78, 78, 5.5, 40);

  // --- Team spawns ---
  const attack = [
    [-6, 0, -60, 0], [2, 0, -62, 0], [-14, 0, -58, 0.2], [8, 0, -58, -0.2],
    [-20, 0, -64, 0.3], [-2, 0, -74, 0], [10, 0, -70, 0], [-24, 0, -74, 0.4],
    [-16, F2, -62, 0], [4, F2, -58, 0],
  ];
  for (const [x, y, z, yaw] of attack) b.spawn(0, x, y, z, yaw);

  const defend = [
    [-14, 0, 56, Math.PI], [-24, 0, 60, Math.PI], [-6, 0, 66, Math.PI],
    [-18, 0, 68, Math.PI], [4, 0, 54, Math.PI + 0.3], [-30, 0, 52, Math.PI - 0.3],
    [8, 0, 68, Math.PI], [-8, 0, 74, Math.PI], [-30, 0, 72, Math.PI],
    [-32.5, 5.2, 62, Math.PI],
  ];
  for (const [x, y, z, yaw] of defend) b.spawn(1, x, y, z, yaw);

  // --- Free-for-all spawns, spread wide so nobody lands on top of anybody ---
  const ffa = [
    [0, 0, -14, 0], [16, 0, 8, -1.2], [-16, 0, 12, 2.4], [-10, 0, -20, 0.4],
    [-52, 0, -12, 1.6], [-52, 0, 2, 1.6], [-58, 4.3, -16, 1.2], [-32, 0, 20, 0.8],
    [32, 0, -20, -1.6], [34, 0, 22, -1.8], [56, 0, -16, 3.0], [56, 0, 18, 3.0],
    [60.9, 6.0, -39.5, 2.2], [54, 6.0, 0, 1.4],
    [-22, 0, 47, 0.2], [-8, 0, 58, 3.0], [-32.5, 5.2, 46, 0.6], [4.5, 5.2, 60, 3.1],
    [-10, F2, -50, 0], [14, F2, -66, 0], [-14, ROOF, -48, 0.6], [4, 8.8, -44, 0],
    [-3, -5.0, -20, 3.14], [-3, -5.0, 24, 0], [3, -5.0, 5, 1.6],
    [-58, 8.6, -8, 1.2], [-74, 8.6, 0, 1.6], [-18, 1.2, 0, 1.57],
  ];
  for (const [x, y, z, yaw] of ffa) b.spawn(-1, x, y, z, yaw, ['ffa']);

  // --- Objectives ---
  b.objective('A', 'capture', -48, 0, -6, 5.2, { name: 'VILLA' });
  b.objective('B', 'capture', 0, 0, 0, 6.0, { name: 'PLAZA' });
  b.objective('C', 'capture', 46, 0, 4, 5.2, { name: 'MARKET' });
  b.objective('flag0', 'flag', -8, 0, -46, 1.6, { team: 0, name: 'CONSULATE' });
  b.objective('flag1', 'flag', -14, 0, 50, 1.6, { team: 1, name: 'WAREHOUSE' });

  // --- Navigation waypoints for bots ---
  const nodes = [
    // Plaza ring
    [0, 0, -12], [0, 0, 12], [-12, 0, 0], [12, 0, 0], [8, 0, 8], [-8, 0, -8],
    [-18, 0, -18], [18, 0, -18], [-18, 0, 18], [18, 0, 18], [-18, 1.2, 0],
    // North approach + consulate
    [0, 0, -26], [-2, 0, -34], [-6, 0, -44], [-16, 0, -52], [6, 0, -52],
    [-10, 0, -62], [8, 0, -64], [-24, 0, -34], [-27.2, 0, -38.6],
    [-25.5, 2.2, -32.9], [-27.2, 4.4, -38.6], [-23.9, 4.4, -38.6],
    [-12, 4.4, -48], [4, 4.4, -50], [-2, 4.4, -28.5],
    [-6, 4.4, -34], [8, 4.4, -36], [-16, 4.4, -34], [-6, 4.4, -44],
    [-25.5, 6.6, -32.9], [-27.2, 8.8, -38.6], [-23.9, 8.8, -38.6],
    [-14, 8.8, -48], [-15.4, 8.8, -52], [-15.4, 8.8, -56], [-2, 8.8, -60], [4, 8.8, -60],
    [-25.5, 11, -32.9], [-23.9, 13.2, -38.6], [-12, 13.2, -50], [-2, 13.2, -56], [6, 13.2, -60],
    // South approach + warehouse
    [0, 0, 26], [-4, 0, 34], [-14, 0, 40], [-24, 0, 44], [-8, 0, 50],
    [-20, 0, 58], [-4, 0, 64], [-28, 0, 66], [-31.6, 0, 35], [-31.6, 5.2, 44],
    [-31.6, 5.2, 56], [-31.6, 5.2, 49], [-20, 5.2, 49], [-10, 5.2, 49], [-4, 5.2, 49],
    [3.6, 5.2, 56], [3.6, 0, 65.5], [4, 0, 44], [8, 0, 56],
    // Market
    [26, 0, -20], [30, 0, -6], [30, 0, 10], [28, 0, 26], [38, 0, -14],
    [38, 0, 16], [50, 0, -16], [58, 0, -12], [52.4, 0, 18], [50, 0, 12], [56, 0, 24],
    [58, 0, 22], [62, 0, -42],
    // Market rooftops
    [40.2, 3, -6], [40.6, 6, -6], [48, 6, -7], [54, 6, -10], [54, 6, 1],
    [54, 6, 12], [50, 6, 20], [60, 6, -28], [60, 6, -31],
    // Watchtower stairwell
    [58.2, 0, -39.5], [59.5, 3, -33.5], [60.9, 6, -39.5], [58.2, 6, -39.5],
    [59.5, 9, -33.5], [60.9, 12, -39.5], [58.2, 12, -39.5], [59.5, 15, -33.5],
    [60.9, 18, -39.5], [64, 18, -42], [62, 6, -43], [62, 12, -43],
    // Villa + garden
    [-26, 0, 0], [-32, 0, -8], [-32, 0, 12], [-36, 0, 20], [-44, 0, -6],
    [-52, 0, -14], [-52, 0, 0], [-60, 0, -16], [-60, 0, 4],
    [-46.3, 0, -14.4], [-45.1, 2.15, -19.9], [-44, 4.3, -14.4],
    [-46.3, 4.3, -14.4], [-45.1, 6.45, -19.9], [-44, 8.6, -14.4],
    [-52, 4.3, -10], [-60, 4.3, -14], [-56, 8.6, -8], [-72, 8.6, -4], [-74, 4, 8],
    // Tunnel
    [-3, -5.0, -30], [-3, -5.0, -16], [-3, -5.0, 0], [-3, -5.0, 16],
    [-3, -5.0, 32], [-3, -5.0, 4.5], [0, -5.0, 4.5], [3, -5.0, 4.5],
    [-3, -2.5, -36], [-3, -2.5, 36],
    [-3, 0, -41], [-3, 0, 41],
  ];
  for (const n of nodes) b.node(n[0], n[1], n[2]);

  // Doorway waypoints. Links are derived from line of sight, so without a node
  // standing in each opening the rooms behind it end up unreachable.
  const doors = [
    [-6, 0, -30], [-6, 0, -27.5], [-18, 0, -70], [-30, 0, -40], [18, 0, -36],   // consulate
    [-15.4, 0, -48], [4.6, 0, -48], [-4, 0, -59], [-12.4, 0, -60], [-21.4, 0, -56],
    [-6, 4.4, -30.2], [-11.4, 4.4, -42], [-15.4, 8.8, -52], [-3.4, 8.8, -52], [-6, 8.8, -61],
    [-22, 0, 30], [-6, 0, 30], [-14, 0, 70], [-34, 0, 40], [-34, 0, 60],        // warehouse
    [6, 0, 44], [6, 0, 60], [-22, 0, 27.5], [-6, 0, 27.5],
    [-42, 0, -18.6], [-42, 0, -12.8], [-42, 0, -7], [-42, 0, -1.2], [-42, 0, 4.6], // villa arcade
    [-68, 0, -8], [-55, 0, -22], [-60, 0, 8],
    [-24, 0, -14], [-24, 0, 12], [-40, 0, -26], [-46, 0, 28],                   // garden walls
    [51.2, 0, -26], [56, 0, -4], [44, 0, -17.2], [68, 0, -12.8],                // souk
    [51.2, 0, 6], [56, 0, 30], [44, 0, 15.6],                                   // textiles
    [66, 0, -32], [62, 0, -34],                                                 // tower
  ];
  for (const d of doors) b.node(d[0], d[1], d[2], ['door']);

  // --- Ambient detail ---
  for (const [x, z] of [[-30, -20], [22, -26], [20, 30], [-24, 32], [12, -24], [-40, 30]]) {
    b.prop('rubble', x, 0, z, { scale: 0.8 + ((x * 7 + z) % 5) * 0.1 });
  }
  b.prop('wire', 0, 7, -24, { to: [0, 6, 24] });
  b.prop('wire', -24, 6.5, -10, { to: [22, 6.5, -10] });
  b.prop('wire', -24, 6.5, 14, { to: [22, 6.5, 14] });
}
