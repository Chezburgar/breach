// BLACKMOOR ESTATE — the one competitive map.
//
// A single walled country estate built for 5v5, one life a round: three routes
// from the north gate to the south gardens, a three-storey manor that overlooks
// most of them, and a wine cellar that cuts underneath. Almost every room has
// two ways in, and almost every long sightline has a piece of cover to peek
// from — the intent is that holding an angle is always possible and never safe.

import { MapBuilder, switchback, parapet, headhouse } from './builder.js';

// Manor floor levels.
const F0 = 0.09, F1 = 4.6, F2 = 9.2, ROOF = 13.8;
const CELLAR = -4.6;
// Vertical gap between layered outdoor surface patches.
const PATCH_STEP = 0.012;

// Walls run up to the roof line, so a deck laid flush with them puts two top
// faces on the same plane and the eaves flicker all the way round the
// building. Roofs are laid a few centimetres proud instead; the underside,
// which is the interior ceiling, does not move.
const ROOF_LIFT = 0.06;
const roof = (b, x0, z0, x1, z1, y, t, m, holes) => (holes
  ? b.slabHoles(x0, z0, x1, z1, y + ROOF_LIFT, t + ROOF_LIFT, m, holes)
  : b.slab(x0, z0, x1, z1, y + ROOF_LIFT, t + ROOF_LIFT, m));
// Interior floors clear the tallest patch stack by a comfortable margin.
const FLOOR = 0.09;

// Manor footprint.
const MX0 = -34, MX1 = 34, MZ0 = -26, MZ1 = 24;

// Cellar stair shafts, cut out of every ground-level deck above them.
const STAIR_MANOR = [-5.7, -6.0, -2.3, 1.04];   // inside the great hall
const STAIR_GROTTO = [12.3, 33.0, 15.7, 40.04]; // out in the gardens
const GROUND_HOLES = [STAIR_MANOR, STAIR_GROTTO];

export function buildEstate() {
  const b = new MapBuilder({
    id: 'estate',
    name: 'Blackmoor Estate',
    tagline: 'Private grounds · 17:20 local',
    bounds: { min: [-92, -12, -92], max: [92, 40, 92] },
    ambience: 'evening',
    // Sun sits high and side-on. Down the north-south axis either team would
    // be shooting into it, which decides fights on spawn rather than on play.
    // Low turbidity and rayleigh keep the horizon from blowing out.
    sun: { azimuth: 104, elevation: 44, intensity: 2.6, color: 0xffe7c8 },
    sky: { turbidity: 2.4, rayleigh: 0.85, mieCoefficient: 0.003, mieDirectionalG: 0.76 },
    fog: { color: 0x66748c, density: 0.0030 },
    envIntensity: 0.12,
    exposure: 0.30,
  });

  ground(b);
  perimeter(b);
  gatehouse(b);
  frontCourt(b);
  manor(b);
  chapelWing(b);
  stableWing(b);
  gardens(b);
  cellar(b);
  meta(b);

  return b.build();
}

// ---------------------------------------------------------------- ground
function ground(b) {
  b.slabHoles(-94, -94, 94, 94, -0.35, 0.7, 'dirt', GROUND_HOLES);

  // Overlapping surfaces are layered so no two are coplanar. A hair of
  // separation is not enough: over a 190 m map the depth buffer cannot
  // resolve slabs a millimetre apart at the far end and the ground flickers
  // between materials as you turn. Each patch takes the lowest level that
  // clears everything it touches, so the stack stays a couple of centimetres
  // tall however many patches get added.
  const placed = [];
  const patch = (x0, z0, x1, z1, m) => {
    let level = 0;
    for (const q of placed) {
      // Patches are laid with a 4 cm margin, so ones that merely abut overlap.
      if (x0 - 0.05 < q.x1 && x1 + 0.05 > q.x0 && z0 - 0.05 < q.z1 && z1 + 0.05 > q.z0) {
        level = Math.max(level, q.level + 1);
      }
    }
    placed.push({ x0, z0, x1, z1, level });
    return b.slabHoles(x0 - 0.04, z0 - 0.04, x1 + 0.04, z1 + 0.04,
      level * PATCH_STEP, 0.65, m, GROUND_HOLES);
  };

  patch(-94, -94, 94, 94, 'grass');
  patch(-14, -88, 14, -50, 'gravel');          // the drive
  patch(-30, -50, 30, -26, 'stone');           // front court
  // No patch under the manor: its own ground floor is laid at F0, and a
  // second marble slab five centimetres below only shows as a rim fighting
  // the real floor's edge all the way round the building.
  patch(-70, -22, MX0, 22, 'stone');           // chapel terrace
  patch(MX1, -22, 70, 22, 'gravel');           // stable yard
  patch(-40, 24, 40, 58, 'stone');             // garden terrace
  patch(-20, 58, 20, 84, 'gravel');            // south lawn path
  patch(-64, 26, -30, 62, 'grass');            // hedge maze bed
  patch(30, 26, 64, 62, 'grass');              // orchard bed

  // Kerbs along the drive.
  b.ext(-14.6, 0, -88, -13.8, 0.2, -50, 'stone');
  b.ext(13.8, 0, -88, 14.6, 0.2, -50, 'stone');
}

// ------------------------------------------------------------- perimeter
function perimeter(b) {
  const H = 12, T = 1.2, R = 88;
  b.ext(-R - T, 0, -R - T, R + T, H, -R, 'estatebrick');
  b.ext(-R - T, 0, R, R + T, H, R + T, 'estatebrick');
  b.ext(-R - T, 0, -R, -R, H, R, 'estatebrick');
  b.ext(R, 0, -R, R + T, H, R, 'estatebrick');

  // Pier caps for silhouette.
  for (let x = -R; x < R; x += 8) {
    b.ext(x - 0.6, 0, -R - T - 0.3, x + 0.6, H + 1.1, -R + 0.3, 'stone');
    b.ext(x - 0.6, 0, R - 0.3, x + 0.6, H + 1.1, R + T + 0.3, 'stone');
  }
  for (let z = -R; z < R; z += 8) {
    b.ext(-R - T - 0.3, 0, z - 0.6, -R + 0.3, H + 1.1, z + 0.6, 'stone');
    b.ext(R - 0.3, 0, z - 0.6, R + T + 0.3, H + 1.1, z + 0.6, 'stone');
  }

  // Treeline beyond the wall, visual only. Laid on a circle it fouled the
  // wall near the axes — the perimeter is a square, so a tree at radius 113
  // on the diagonal is 25 m clear while the same radius due east lands on the
  // masonry, and a fifteen-metre pine then grows straight through it into the
  // grounds. Pushed out until it clears the square, not the circle.
  const CLEAR = R + T + 8;
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2;
    const r = 104 + ((i * 37) % 22);
    let x = Math.cos(a) * r, z = Math.sin(a) * r;
    const reach = Math.max(Math.abs(x), Math.abs(z));
    if (reach < CLEAR) { const k = CLEAR / reach; x *= k; z *= k; }
    b.prop('pine', x, 0, z, { scale: 1.4 + ((i * 7) % 5) * 0.2 });
  }
}

// -------------------------------------------------------------- gatehouse
function gatehouse(b) {
  const Z = -60, H = 8.5;
  // Twin towers either side of an arched gate — attacker spawn sits behind it.
  for (const sx of [-1, 1]) {
    const x0 = sx > 0 ? 8 : -20, x1 = sx > 0 ? 20 : -8;
    b.slab(x0, Z - 7, x1, Z + 7, FLOOR, 0.5, 'stone');
    b.wall(x0, Z - 7, x1, Z - 7, 0, H, 0.6, 'estatebrick', [
      { at: 6, width: 2.4, bottom: 0, top: 3.0 },
      { at: 6, width: 2.0, bottom: 4.8, top: 6.6, fill: 'glass' },
    ]);
    b.wall(x0, Z + 7, x1, Z + 7, 0, H, 0.6, 'estatebrick', [
      { at: 6, width: 2.4, bottom: 0, top: 3.0 },
      { at: 6, width: 2.0, bottom: 4.8, top: 6.6, fill: 'glass' },
    ]);
    b.wall(x0, Z - 7, x0, Z + 7, 0, H, 0.6, 'estatebrick', [
      { at: 7, width: 2.2, bottom: 1.0, top: 2.9, fill: 'glass' },
      { at: 7, width: 2.0, bottom: 4.8, top: 6.6 },
    ]);
    b.wall(x1, Z - 7, x1, Z + 7, 0, H, 0.6, 'estatebrick', [
      { at: 7, width: 2.2, bottom: 1.0, top: 2.9, fill: 'glass' },
      { at: 7, width: 2.0, bottom: 4.8, top: 6.6 },
    ]);
    b.slabHole(x0, Z - 7, x1, Z + 7, 4.4, 0.4, 'wood', [x0 + 0.6, Z - 5.6, x0 + 6.4, Z - 0.6]);
    switchback(b, x0 + 0.6, Z - 5.6, x0 + 6.4, Z - 0.6, 0, 4.4, 1, 'wood');
    roof(b, x0, Z - 7, x1, Z + 7, H, 0.45, 'slate');
    parapet(b, x0, Z - 7, x1, Z + 7, H, 'stone', 1.1);
    b.prop('flag', x0 + 1.6, H, Z - 5.4, { scale: 1.1 });
  }

  // The arch between them.
  b.ext(-8, 0, Z - 1.4, -6.4, 9.6, Z + 1.4, 'stone');
  b.ext(6.4, 0, Z - 1.4, 8, 9.6, Z + 1.4, 'stone');
  b.ext(-8, 9.6, Z - 1.4, 8, 11.2, Z + 1.4, 'stone');
  // Spans the opening only. Running it into the piers puts its outer face on
  // the same plane as theirs, and the arch flickers.
  b.ext(-6.4, 6.2, Z - 0.3, 6.4, 9.6, Z + 0.3, 'stone', { solid: false, blocksSight: false });

  // Lodge huts flanking the drive, small and enterable.
  for (const sx of [-1, 1]) {
    const cx = sx * 26;
    b.slab(cx - 5, -74, cx + 5, -64, FLOOR, 0.4, 'wood');
    b.wall(cx - 5, -74, cx + 5, -74, 0, 3.4, 0.4, 'wood', [{ at: 5, width: 2.2, bottom: 0, top: 2.5 }]);
    b.wall(cx - 5, -64, cx + 5, -64, 0, 3.4, 0.4, 'wood', [{ at: 5, width: 2.2, bottom: 1.0, top: 2.6, fill: 'glass' }]);
    b.wall(cx - 5, -74, cx - 5, -64, 0, 3.4, 0.4, 'wood', [{ at: 5, width: 2.0, bottom: 0, top: 2.5 }]);
    b.wall(cx + 5, -74, cx + 5, -64, 0, 3.4, 0.4, 'wood', [{ at: 5, width: 2.0, bottom: 1.0, top: 2.6, fill: 'glass' }]);
    roof(b, cx - 5.4, -74.4, cx + 5.4, -63.6, 3.4, 0.5, 'slate');
    b.prop('crate', cx - 3, 0, -71, { yaw: 0.4 });
    b.box([cx - 3, 0.6, -71], [1.18, 1.2, 1.18], 'crate', { r: 0.4 });
  }

  for (const [x, z] of [[-18, -78], [18, -78], [-18, -56], [18, -56], [0, -46]]) {
    b.prop('lamppost', x, 0, z);
    b.light(x, 4.6, z, 0xffcb8a, 1.6, 15);
  }
}

// ------------------------------------------------------------ front court
function frontCourt(b) {
  // Circular fountain on the axis.
  b.ext(-6, 0, -44, 6, 0.55, -32, 'stone');
  b.box([0, 0.55, -38], [11.6, 1.1, 11.6], 'stone', { r: Math.PI / 4 });
  b.ext(-4.6, 1.05, -42.6, 4.6, 1.2, -33.4, 'water', { solid: false, blocksSight: false, water: true });
  b.ext(-1.0, 0.95, -39, 1.0, 3.4, -37, 'marble');
  b.ext(-1.8, 3.4, -39.8, 1.8, 3.8, -36.2, 'marble');
  b.prop('statue', 0, 3.8, -38);

  // Balustrade terrace and the steps up to the manor doors.
  b.slab(-30, -30, 30, -26, 1.2, 1.4, 'stone');
  // Stepped plinth either side of the flight, rising towards the terrace.
  // These courses used to sit in the stair opening itself and ran the wrong
  // way, so anyone who walked into them landed in a trough between a 0.9 m
  // face and the terrace lip — neither of which is a step you can take.
  for (let i = 0; i < 4; i++) {
    // Two centimetres under the terrace deck, so the top course does not end
    // up coplanar with it where the two meet.
    const h = 0.28 + i * 0.3;
    const z0 = -31.85 + i * 0.55, z1 = -31.25 + i * 0.55;
    b.ext(-30, 0, z0, -9, h, z1, 'stone');
    b.ext(9, 0, z0, 30, h, z1, 'stone');
  }
  // The flight lands *against* the terrace face, not inside it. Started at
  // -30.4 its four treads were buried in the 1.2 m deck and the front of the
  // terrace was a wall you could only stare at.
  b.stairs(0, 0, -32.2, Math.PI, 4, 0.3, 0.55, 18, 'stone');
  b.railing(-30, -30, -9.5, -30, 1.2, 'stone', 1.05);
  b.railing(9.5, -30, 30, -30, 1.2, 'stone', 1.05);

  // Low hedges and planters give the open court things to break sightlines.
  for (const [x, z, w, d] of [[-20, -44, 10, 1.4], [20, -44, 10, 1.4], [-24, -34, 1.4, 8], [24, -34, 1.4, 8]]) {
    b.ext(x - w / 2, 0, z - d / 2, x + w / 2, 1.2, z + d / 2, 'hedge');
    b.prop('hedge', x, 0, z, { sx: w, sz: d });
  }
  for (const [x, z] of [[-14, -33], [14, -33], [-14, -47], [14, -47]]) {
    b.ext(x - 1.0, 0, z - 1.0, x + 1.0, 0.85, z + 1.0, 'stone');
    b.prop('bush', x, 0.85, z);
  }
  for (const [x, z, r] of [[-11, -40, 0.3], [11, -40, -0.3], [0, -48, 0]]) {
    b.box([x, 0.55, z], [2.8, 1.1, 0.75], 'stone', { r });
  }
}

// ------------------------------------------------------------------ manor
function manor(b) {
  const T = 0.7;

  // --- decks ------------------------------------------------------------
  // The great hall is double height, so the first floor is a gallery ring
  // around a void — that void is the map's signature vertical fight. Both
  // service stairwells need their own hole through every deck they pass, or
  // the stairs simply run into the ceiling.
  const hallHole = [-13, -12, 13, 8];
  const westWell = [-32.8, -20.2, -25.4, -12.8];
  const eastWell = [25.4, 11.8, 32.8, 19.2];

  b.slabHoles(MX0, MZ0, MX1, MZ1, F0, 0.6, 'marble', [STAIR_MANOR]);
  b.slabHoles(MX0, MZ0, MX1, MZ1, F1, 0.5, 'wood', [hallHole, westWell, eastWell]);
  b.slabHoles(MX0, MZ0, MX1, MZ1, F2, 0.5, 'wood', [westWell, eastWell]);
  roof(b, MX0, MZ0, MX1, MZ1, ROOF, 0.55, 'slate', [westWell, eastWell]);

  // --- exterior shell ---------------------------------------------------
  const winG = { bottom: 1.0, top: 3.2, fill: 'glass' };
  const win1 = { bottom: 5.6, top: 7.8, fill: 'glass' };
  const win2 = { bottom: 10.2, top: 12.2 };

  // North face — onto the front court. The main doors and the balcony above.
  b.wall(MX0, MZ0, MX1, MZ0, 0, ROOF, T, 'estatebrick', [
    { at: 34, width: 5.0, bottom: 0, top: 4.0 },
    { at: 34, width: 6.0, bottom: 4.62, top: 7.8 },
    { at: 10, width: 2.6, ...winG }, { at: 20, width: 2.6, ...winG },
    { at: 48, width: 2.6, ...winG }, { at: 58, width: 2.6, ...winG },
    { at: 10, width: 2.6, ...win1 }, { at: 20, width: 2.6, ...win1 },
    { at: 48, width: 2.6, ...win1 }, { at: 58, width: 2.6, ...win1 },
    { at: 16, width: 2.4, ...win2 }, { at: 34, width: 3.0, ...win2 }, { at: 52, width: 2.4, ...win2 },
  ]);
  // South face — onto the gardens.
  b.wall(MX0, MZ1, MX1, MZ1, 0, ROOF, T, 'estatebrick', [
    { at: 34, width: 5.4, bottom: 0, top: 3.6 },
    { at: 14, width: 4.0, bottom: 0, top: 3.4 },
    { at: 54, width: 4.0, bottom: 0, top: 3.4 },
    { at: 34, width: 6.0, bottom: 4.62, top: 7.8 },
    { at: 14, width: 2.6, ...win1 }, { at: 54, width: 2.6, ...win1 },
    { at: 20, width: 2.4, ...win2 }, { at: 48, width: 2.4, ...win2 },
  ]);
  // West face.
  b.wall(MX0, MZ0, MX0, MZ1, 0, ROOF, T, 'estatebrick', [
    { at: 16, width: 3.2, bottom: 0, top: 3.2 },
    { at: 34, width: 3.2, bottom: 0, top: 3.2 },
    { at: 8, width: 2.4, ...winG }, { at: 25, width: 2.4, ...winG }, { at: 43, width: 2.4, ...winG },
    { at: 8, width: 2.4, ...win1 }, { at: 25, width: 2.4, ...win1 }, { at: 43, width: 2.4, ...win1 },
    { at: 16, width: 2.4, ...win2 }, { at: 34, width: 2.4, ...win2 },
  ]);
  // East face.
  b.wall(MX1, MZ0, MX1, MZ1, 0, ROOF, T, 'estatebrick', [
    { at: 16, width: 3.2, bottom: 0, top: 3.2 },
    { at: 34, width: 3.2, bottom: 0, top: 3.2 },
    { at: 8, width: 2.4, ...winG }, { at: 25, width: 2.4, ...winG }, { at: 43, width: 2.4, ...winG },
    { at: 8, width: 2.4, ...win1 }, { at: 25, width: 2.4, ...win1 }, { at: 43, width: 2.4, ...win1 },
    { at: 16, width: 2.4, ...win2 }, { at: 34, width: 2.4, ...win2 },
  ]);

  // --- great hall -------------------------------------------------------
  // Columns around the void, and the grand staircase on the axis.
  for (const x of [-13, 13]) {
    for (const z of [-12, -1, 10]) b.pillar(x, z, 0, F1 - 0.5, 0.42, 'marble', 'stone');
    for (const z of [-12, -1, 10]) b.pillar(x, z, F1, F2 - 0.5, 0.36, 'marble', 'stone');
  }
  // Railings guard the edge of the void and nothing else. Run round a
  // rectangle two metres deeper than the hole they were, they fenced the top
  // of the grand stair into a pocket — you could climb to the first floor and
  // then not set foot on it. The south run is broken where the two returns
  // come up through it.
  b.railing(-13, -12, -13, 8, F1, 'wood', 1.05);
  b.railing(13, -12, 13, 8, F1, 'wood', 1.05);
  b.railing(-13, -12, 13, -12, F1, 'wood', 1.05);
  b.railing(-13, 8, -7.6, 8, F1, 'wood', 1.05);
  b.railing(-3.6, 8, 3.6, 8, F1, 'wood', 1.05);
  b.railing(7.6, 8, 13, 8, F1, 'wood', 1.05);

  // Grand stair: a wide flight up to a half landing, then two returns.
  // Twelve treads of 0.34 carry the flight from z 8.6 to z 4.52, so that is
  // where the half landing has to start. Sitting it at 6.0 put its underside
  // across the flight at head height: you climbed five steps into a ceiling.
  b.stairs(0, 0, 8.6, 0, 12, F1 / 2 / 12, 0.34, 7.0, 'marble');
  // The flight's top tread runs under this landing, so the landing is laid a
  // centimetre and a half proud — level with it the two top faces flicker.
  // Wide enough to carry both returns as well as the flight — at 3.6 either
  // side of centre the returns started over thin air.
  b.slab(-7.4, 2.6, 7.4, 4.52, F1 / 2 + 0.015, 0.415, 'marble');
  // The returns leave the landing and climb back the way you came, either
  // side of the main flight, arriving on the gallery at z 8.6.
  b.stairs(-5.6, F1 / 2, 4.52, Math.PI, 12, F1 / 2 / 12, 0.34, 3.4, 'marble');
  b.stairs(5.6, F1 / 2, 4.52, Math.PI, 12, F1 / 2 / 12, 0.34, 3.4, 'marble');
  b.railing(-7.4, 2.6, -7.4, 4.52, F1 / 2, 'wood');
  b.railing(7.4, 2.6, 7.4, 4.52, F1 / 2, 'wood');
  b.railing(-7.4, 2.6, 7.4, 2.6, F1 / 2, 'wood');

  // Service stairs, west and east, all the way to the attic.
  switchback(b, MX0 + 1.4, -20, MX0 + 8.4, -13, 0, F1, 3, 'wood');
  switchback(b, MX1 - 8.4, 12, MX1 - 1.4, 19, 0, F1, 3, 'wood', 'metal', true);

  // --- ground floor rooms ----------------------------------------------
  // Library (west), dining (east), kitchen (north-east), study (north-west).
  b.wall(MX0 + 10, MZ0, MX0 + 10, -12, 0, F1 - 0.5, 0.45, 'plaster', [{ at: 8, width: 2.6, bottom: 0, top: 2.6 }]);
  b.wall(MX0 + 10, -12, MX0 + 10, MZ1, 0, F1 - 0.5, 0.45, 'plaster', [
    { at: 10, width: 2.6, bottom: 0, top: 2.6 }, { at: 28, width: 2.6, bottom: 0, top: 2.6 },
  ]);
  b.wall(MX1 - 10, MZ0, MX1 - 10, -12, 0, F1 - 0.5, 0.45, 'plaster', [{ at: 8, width: 2.6, bottom: 0, top: 2.6 }]);
  b.wall(MX1 - 10, -12, MX1 - 10, MZ1, 0, F1 - 0.5, 0.45, 'plaster', [
    { at: 10, width: 2.6, bottom: 0, top: 2.6 }, { at: 28, width: 2.6, bottom: 0, top: 2.6 },
  ]);
  b.wall(MX0, -12, MX0 + 10, -12, 0, F1 - 0.5, 0.45, 'plaster', [{ at: 5, width: 2.6, bottom: 0, top: 2.6 }]);
  b.wall(MX1 - 10, -12, MX1, -12, 0, F1 - 0.5, 0.45, 'plaster', [{ at: 5, width: 2.6, bottom: 0, top: 2.6 }]);

  // Library shelving — dense cover with gaps to peek through. Kept clear of
  // the z = -12 doorway so the room keeps both its entrances.
  // Clear of the service stairwell at x -32.6..-25.6: a 2.3 m bookcase laid
  // across the bottom flight walls the stairs off completely.
  // Nothing between z -20 and -13: that is the service stairwell, and a
  // 2.3 m bookcase laid across the bottom flight walls the stairs off.
  for (const z of [-23, -9, -3, 3, 10]) {
    b.box([MX0 + 5, 1.15, z], [7.0, 2.3, 0.55], 'woodDark');
    b.prop('shelf', MX0 + 5, 0, z, { yaw: 0 });
  }
  b.box([MX0 + 5, 0.4, 18], [3.0, 0.8, 1.4], 'woodDark');

  // Dining: a long table and chairs.
  b.ext(MX1 - 9, 0, -6, MX1 - 2, 0.78, 8, 'woodDark');
  for (let i = 0; i < 6; i++) {
    b.prop('chair', MX1 - 10.2, 0, -5 + i * 2.4);
    b.prop('chair', MX1 - 0.8, 0, -5 + i * 2.4);
  }
  b.prop('chandelier', MX1 - 5.5, F1 - 0.7, 1);
  b.light(MX1 - 5.5, F1 - 1.1, 1, 0xffd9a0, 2.2, 13);

  // Kitchen counters.
  for (const [x, z, w, d] of [[MX1 - 5, -20, 9, 1.2], [MX1 - 5, -15, 9, 1.2]]) {
    b.ext(x - w / 2, 0, z - d / 2, x + w / 2, 0.95, z + d / 2, 'stone');
  }

  // --- first floor: gallery ring and bedrooms ---------------------------
  b.wall(MX0 + 10, MZ0, MX0 + 10, MZ1, F1, F2 - 0.5, 0.45, 'plaster', [
    { at: 9, width: 2.6, bottom: 0, top: 2.6 }, { at: 30, width: 2.6, bottom: 0, top: 2.6 },
  ]);
  b.wall(MX1 - 10, MZ0, MX1 - 10, MZ1, F1, F2 - 0.5, 0.45, 'plaster', [
    { at: 9, width: 2.6, bottom: 0, top: 2.6 }, { at: 30, width: 2.6, bottom: 0, top: 2.6 },
  ]);
  b.wall(MX0 + 10, -4, MX1 - 10, -4, F1, F2 - 0.5, 0.45, 'plaster', [
    { at: 8, width: 2.6, bottom: 0, top: 2.6 }, { at: 34, width: 2.6, bottom: 0, top: 2.6 },
  ]);
  // Bedrooms. Kept out of the stairwell voids at x ±(25.4..32.8): a bed
  // floating over the shaft is furniture you climb your head into.
  for (const [x, z] of [[MX0 + 7, -22], [MX0 + 5, 10], [MX1 - 7, -22], [MX1 - 5, 10]]) {
    b.ext(x - 1.4, F1, z - 1.1, x + 1.4, F1 + 0.62, z + 1.1, 'woodDark');
    b.prop('bed', x, F1, z);
  }

  // Balcony over the front court — the strongest angle onto the drive.
  b.slab(-6, MZ0 - 4.6, 6, MZ0, F1, 0.4, 'stone');
  b.railing(-6, MZ0 - 4.6, 6, MZ0 - 4.6, F1, 'stone', 1.05);
  b.railing(-6, MZ0 - 4.6, -6, MZ0, F1, 'stone', 1.05);
  b.railing(6, MZ0 - 4.6, 6, MZ0, F1, 'stone', 1.05);

  // Rear balcony over the gardens.
  b.slab(-6, MZ1, 6, MZ1 + 4.6, F1, 0.4, 'stone');
  b.railing(-6, MZ1 + 4.6, 6, MZ1 + 4.6, F1, 'stone', 1.05);
  b.railing(-6, MZ1, -6, MZ1 + 4.6, F1, 'stone', 1.05);
  b.railing(6, MZ1, 6, MZ1 + 4.6, F1, 'stone', 1.05);

  // --- attic ------------------------------------------------------------
  b.wall(MX0 + 12, MZ0 + 6, MX1 - 12, MZ0 + 6, F2, ROOF - 0.55, 0.4, 'wood',
    [{ at: 12, width: 2.4, bottom: 0, top: 2.4 }, { at: 32, width: 2.4, bottom: 0, top: 2.4 }]);
  for (const [x, z] of [[-18, -8], [18, 6], [0, 14], [-6, -18]]) {
    b.box([x, F2 + 0.6, z], [1.18, 1.2, 1.18], 'crate', { r: (x + z) % 1 });
    b.box([x + 1.3, F2 + 0.6, z + 0.4], [1.18, 1.2, 1.18], 'crate', { r: (x - z) % 1 });
  }

  // --- roof -------------------------------------------------------------
  parapet(b, MX0, MZ0, MX1, MZ1, ROOF, 'stone', 1.2);
  // Each headhouse door sits at the end where its flight tops out: the west
  // well climbs toward -Z, the east one (entered from the garden side) toward +Z.
  headhouse(b, MX0 + 1.0, -20.4, MX0 + 8.8, -12.6, ROOF, 2.6, 'estatebrick', 'north');
  headhouse(b, MX1 - 8.8, 11.6, MX1 - 1.0, 19.4, ROOF, 2.6, 'estatebrick', 'south');
  for (const [x, z] of [[-24, -18], [-24, 16], [24, -18], [24, 16], [0, -20]]) {
    b.ext(x - 1.2, ROOF, z - 1.2, x + 1.2, ROOF + 3.4, z + 1.2, 'estatebrick');
    b.ext(x - 1.5, ROOF + 3.4, z - 1.5, x + 1.5, ROOF + 3.9, z + 1.5, 'stone');
  }

  // Interior lighting.
  for (const [x, y, z] of [
    [0, F1 - 0.6, -1], [-18, F1 - 0.7, -18], [-18, F1 - 0.7, 8], [18, F1 - 0.7, -18],
    [-18, F2 - 0.7, -14], [18, F2 - 0.7, 12], [0, F2 - 0.7, 14],
    [-26, F1 - 0.7, -16], [26, F1 - 0.7, 14],
  ]) {
    b.prop('ceiling_lamp', x, y, z);
    b.light(x, y - 0.35, z, 0xffdcae, 1.6, 14);
  }
}

// -------------------------------------------------------------- west wing
function chapelWing(b) {
  const X0 = -68, X1 = -38, Z0 = -18, Z1 = 18, H = 10.5;
  b.slab(X0, Z0, X1, Z1, FLOOR, 0.5, 'stone');

  b.wall(X0, Z0, X1, Z0, 0, H, 0.6, 'stone', [
    { at: 15, width: 3.0, bottom: 0, top: 3.4 },
    { at: 7, width: 2.2, bottom: 3.6, top: 7.6, fill: 'glass' },
    { at: 23, width: 2.2, bottom: 3.6, top: 7.6, fill: 'glass' },
  ]);
  b.wall(X0, Z1, X1, Z1, 0, H, 0.6, 'stone', [
    { at: 15, width: 3.0, bottom: 0, top: 3.4 },
    { at: 7, width: 2.2, bottom: 3.6, top: 7.6, fill: 'glass' },
    { at: 23, width: 2.2, bottom: 3.6, top: 7.6, fill: 'glass' },
  ]);
  b.wall(X0, Z0, X0, Z1, 0, H, 0.6, 'stone', [
    { at: 18, width: 3.4, bottom: 0, top: 3.6 },
    { at: 8, width: 2.4, bottom: 4.0, top: 8.0, fill: 'glass' },
    { at: 28, width: 2.4, bottom: 4.0, top: 8.0, fill: 'glass' },
  ]);
  b.wall(X1, Z0, X1, Z1, 0, H, 0.6, 'stone', [
    { at: 9, width: 3.0, bottom: 0, top: 3.4 },
    { at: 27, width: 3.0, bottom: 0, top: 3.4 },
    { at: 18, width: 3.0, bottom: 4.4, top: 6.6 },
  ]);

  roof(b, X0, Z0, X1, Z1, H, 0.5, 'slate');
  parapet(b, X0, Z0, X1, Z1, H, 'stone', 1.0);

  // Nave columns and pews.
  for (let i = 0; i < 5; i++) {
    const z = Z0 + 5 + i * 7;
    b.pillar(X0 + 8, z, 0, 6.4, 0.4, 'stone');
    b.pillar(X1 - 8, z, 0, 6.4, 0.4, 'stone');
    b.ext(X0 + 12, 0, z - 0.5, X1 - 12, 0.5, z + 0.5, 'woodDark');
    b.ext(X0 + 12, 0.5, z - 0.5, X1 - 12, 1.15, z - 0.2, 'woodDark');
  }
  b.ext(-52, 0, 14, -46, 1.2, 16.5, 'marble');   // altar

  // Choir gallery over the entrance — a strong angle down the nave. The stair
  // is entered from the nave side so it is not jammed against the end wall.
  // The gallery deck is cut back around its own stair. Laid solid, its
  // underside stopped you two thirds of the way up the flight.
  // Deep enough to give the stair somewhere to arrive, and cut back around
  // the upper flight — solid, the deck's own underside caught your head two
  // thirds of the way up.
  b.slabHole(X0 + 1, Z0 + 1, X1 - 1, Z0 + 12, 6.46, 0.46, 'wood',
    [X0 + 3.4, Z0 + 2.6, X0 + 7.4, Z0 + 8.6]);
  b.railing(X0 + 1, Z0 + 12, X1 - 1, Z0 + 12, 6.4, 'wood', 1.05);
  switchback(b, X0 + 1.2, Z0 + 2.6, X0 + 7.2, Z0 + 8.4, 0, 6.4, 1, 'wood', 'metal', true);

  // Bell tower over the west end — a shell, not a solid block.
  const TZ0 = Z0 + 12, TZ1 = Z0 + 24;
  b.slab(X0 - 6, TZ0, X0, TZ1, FLOOR, 0.5, 'stone');
  b.wall(X0 - 6, TZ0, X0, TZ0, 0, 18, 0.5, 'stone', []);
  b.wall(X0 - 6, TZ1, X0, TZ1, 0, 18, 0.5, 'stone', []);
  b.wall(X0 - 6, TZ0, X0 - 6, TZ1, 0, 18, 0.5, 'stone',
    [{ at: 6, width: 2.4, bottom: 13.5, top: 17 }]);
  b.wall(X0, TZ0, X0, TZ1, 0, 18, 0.5, 'stone',
    [{ at: 6, width: 2.6, bottom: 0, top: 3.0 },
     { at: 6, width: 2.4, bottom: 13.5, top: 17 }]);
  roof(b, X0 - 6, TZ0, X0, TZ1, 18, 0.4, 'slate');

  for (const [x, y, z] of [[-52, 7.4, -8], [-52, 7.4, 8]]) {
    b.prop('chandelier', x, y, z);
    b.light(x, y - 0.4, z, 0xffcf9a, 1.8, 16);
  }
}

// -------------------------------------------------------------- east wing
function stableWing(b) {
  const X0 = 38, X1 = 68, Z0 = -18, Z1 = 18, H = 6.4, LOFT = 3.6;
  b.slab(X0, Z0, X1, Z1, FLOOR, 0.5, 'wood');

  b.wall(X0, Z0, X1, Z0, 0, H, 0.5, 'estatewood', [
    { at: 8, width: 3.6, bottom: 0, top: 3.6 }, { at: 22, width: 3.6, bottom: 0, top: 3.6 },
  ]);
  b.wall(X0, Z1, X1, Z1, 0, H, 0.5, 'estatewood', [
    { at: 15, width: 4.6, bottom: 0, top: 4.0 },
  ]);
  b.wall(X0, Z0, X0, Z1, 0, H, 0.5, 'estatewood', [
    { at: 10, width: 3.2, bottom: 0, top: 3.2 }, { at: 26, width: 3.2, bottom: 0, top: 3.2 },
    { at: 18, width: 3.0, bottom: 4.2, top: 5.8 },
  ]);
  b.wall(X1, Z0, X1, Z1, 0, H, 0.5, 'estatewood', [
    { at: 18, width: 3.4, bottom: 0, top: 3.4 },
    { at: 8, width: 2.4, bottom: 4.2, top: 5.8 }, { at: 28, width: 2.4, bottom: 4.2, top: 5.8 },
  ]);
  roof(b, X0, Z0, X1, Z1, H, 0.45, 'slate');
  parapet(b, X0, Z0, X1, Z1, H, 'estatewood', 0.9);

  // Hayloft: a partial upper deck overlooking the stalls and the yard door.
  // The stair runs up the aisle and meets the deck across a short landing.
  b.slab(X0 + 1, Z0 + 1, X0 + 14, Z1 - 1, LOFT, 0.35, 'wood');
  b.railing(X0 + 14, Z0 + 1, X0 + 14, Z1 - 1, LOFT, 'wood', 1.0);
  b.stairs(X0 + 15.5, 0, Z1 - 1.0, 0, 14, LOFT / 14, 0.32, 2.0, 'wood');
  b.slab(X0 + 14, Z1 - 7.5, X0 + 17, Z1 - 5.0, LOFT, 0.35, 'wood');
  b.railing(X0 + 17, Z1 - 7.5, X0 + 17, Z1 - 5.0, LOFT, 'wood', 1.0);

  // Stalls: partitions with gaps, good for peeking and repositioning.
  for (let i = 0; i < 5; i++) {
    const z = Z0 + 4 + i * 6.5;
    b.ext(X0 + 16, 0, z - 0.2, X1 - 2, 1.35, z + 0.2, 'estatewood');
    b.ext(X0 + 16, 0, z - 0.2, X0 + 16.4, 2.6, z + 0.2, 'estatewood');
  }
  for (const [x, z] of [[X0 + 6, -12], [X0 + 8, 4], [X0 + 5, 12]]) {
    b.box([x, LOFT + 0.6, z], [1.3, 1.2, 1.3], 'hay');
    b.box([x + 1.4, LOFT + 0.6, z + 0.5], [1.3, 1.2, 1.3], 'hay', { r: 0.4 });
  }
  for (const [x, z] of [[X1 - 6, -14], [X1 - 8, 10]]) {
    b.box([x, 0.55, z], [0.62, 1.1, 0.62], 'metalRust');
    b.prop('barrel', x, 0, z);
  }

  for (const [x, y, z] of [[X0 + 8, H - 0.7, -8], [X0 + 20, H - 0.7, 8]]) {
    b.prop('hangar_lamp', x, y, z);
    b.light(x, y - 0.5, z, 0xffd9a0, 1.5, 14);
  }
}

// ---------------------------------------------------------------- gardens
function gardens(b) {
  // Terrace steps down from the manor's rear doors.
  b.slab(-40, 24, 40, 30, 0.8, 1.0, 'stone');
  b.stairs(0, 0, 30.4, 0, 3, 0.27, 0.5, 12, 'stone');
  b.railing(-40, 30, -6.5, 30, 0.8, 'stone', 1.0);
  b.railing(6.5, 30, 40, 30, 0.8, 'stone', 1.0);

  // Reflecting pool on the axis — open, dangerous, flanked by cover.
  b.ext(-9, 0, 34, 9, 0.5, 54, 'stone');
  b.ext(-8, 0, 35, 8, 0.42, 53, 'water', { solid: false, blocksSight: false, water: true });
  for (let i = 0; i < 5; i++) {
    b.prop('cypress', -12, 0, 35 + i * 4.6, { scale: 1.15 });
    b.prop('cypress', 12, 0, 35 + i * 4.6, { scale: 1.15 });
  }

  // Hedge maze west. Head-height hedges arranged as four north-south lanes
  // with staggered cross-walls: enough cover to rotate through unseen, but the
  // lanes stay wide enough to fight in.
  const maze = [
    // Lane dividers, each broken in a different place.
    [-55.8, 28, -54.6, 45], [-55.8, 50, -54.6, 61],
    [-48.8, 34, -47.6, 61],
    [-41.8, 28, -40.6, 52],
    // Cross-walls.
    [-62, 41, -56, 42.2], [-54.6, 48, -49, 49.2],
    [-47.6, 34, -42, 35.2], [-62, 55, -58.8, 56.2],
    [-40.6, 48, -35, 49.2],
  ];
  for (const [x0, z0, x1, z1] of maze) {
    b.ext(x0, 0, z0, Math.max(x1, x0 + 1.2), 1.9, Math.max(z1, z0 + 1.2), 'hedge');
  }

  // Orchard east — trees as soft cover, plus a greenhouse.
  for (let i = 0; i < 16; i++) {
    const x = 34 + (i % 4) * 8;
    const z = 30 + Math.floor(i / 4) * 8;
    b.prop('tree', x, 0, z, { scale: 1.1 + ((i * 7) % 4) * 0.12 });
    b.ext(x - 0.35, 0, z - 0.35, x + 0.35, 2.4, z + 0.35, 'bark');
  }
  const GX0 = 20, GX1 = 34, GZ0 = 62, GZ1 = 78;
  b.slab(GX0, GZ0, GX1, GZ1, FLOOR, 0.4, 'stone');
  for (const [ax, az, bx, bz, at] of [
    [GX0, GZ0, GX1, GZ0, 7], [GX0, GZ1, GX1, GZ1, 7],
    [GX0, GZ0, GX0, GZ1, 8], [GX1, GZ0, GX1, GZ1, 8],
  ]) {
    b.wall(ax, az, bx, bz, 0, 4.6, 0.3, 'greenframe', [
      { at, width: 2.6, bottom: 0, top: 2.8 },
      { at: at + 0.01, width: 8.0, bottom: 2.9, top: 4.4, fill: 'glass' },
    ]);
  }
  b.slab(GX0, GZ0, GX1, GZ1, 4.66, 0.22, 'glass', { blocksSight: false });
  for (let i = 0; i < 4; i++) {
    b.ext(GX0 + 2, 0, GZ0 + 3 + i * 4, GX1 - 2, 0.9, GZ0 + 4.4 + i * 4, 'wood');
    b.prop('bush', GX0 + 5, 0.9, GZ0 + 3.7 + i * 4);
    b.prop('bush', GX1 - 5, 0.9, GZ0 + 3.7 + i * 4);
  }

  // Gazebo on the axis, and the orangery at the south end (defender spawn).
  b.ext(-3.4, 0, 60, 3.4, 0.45, 66.8, 'wood');
  for (const [x, z] of [[-3, 60.4], [3, 60.4], [-3, 66.4], [3, 66.4]]) {
    b.ext(x - 0.16, 0.45, z - 0.16, x + 0.16, 3.4, z + 0.16, 'wood');
  }
  b.ext(-4.2, 3.4, 59.2, 4.2, 3.9, 67.6, 'slate');

  const OX0 = -30, OX1 = -6, OZ0 = 64, OZ1 = 80;
  b.slab(OX0, OZ0, OX1, OZ1, FLOOR, 0.4, 'stone');
  b.wall(OX0, OZ0, OX1, OZ0, 0, 5.2, 0.5, 'stone', [
    { at: 12, width: 3.4, bottom: 0, top: 3.4 },
    { at: 5, width: 2.6, bottom: 1.0, top: 3.4, fill: 'glass' },
    { at: 19, width: 2.6, bottom: 1.0, top: 3.4, fill: 'glass' },
  ]);
  b.wall(OX0, OZ1, OX1, OZ1, 0, 5.2, 0.5, 'stone', [{ at: 12, width: 3.0, bottom: 0, top: 3.0 }]);
  b.wall(OX0, OZ0, OX0, OZ1, 0, 5.2, 0.5, 'stone', [{ at: 8, width: 3.0, bottom: 0, top: 3.0 }]);
  b.wall(OX1, OZ0, OX1, OZ1, 0, 5.2, 0.5, 'stone', [{ at: 8, width: 3.0, bottom: 0, top: 3.0 }]);
  roof(b, OX0, OZ0, OX1, OZ1, 5.2, 0.4, 'slate');
  parapet(b, OX0, OZ0, OX1, OZ1, 5.2, 'stone', 0.9);
  for (const [x, z] of [[OX0 + 6, OZ0 + 6], [OX1 - 6, OZ0 + 11]]) {
    b.box([x, 0.6, z], [1.18, 1.2, 1.18], 'crate');
  }

  // Garden walls that break the open ground into approaches.
  b.wall(-40, 30, -40, 62, 0, 2.6, 0.5, 'estatebrick', [{ at: 16, width: 3.0, bottom: 0, top: 2.4 }]);
  b.wall(40, 30, 40, 62, 0, 2.6, 0.5, 'estatebrick', [{ at: 16, width: 3.0, bottom: 0, top: 2.4 }]);
  b.wall(-40, 62, 40, 62, 0, 2.6, 0.5, 'estatebrick', [
    { at: 26, width: 3.4, bottom: 0, top: 2.4 },
    { at: 54, width: 3.4, bottom: 0, top: 2.4 },
    { at: 67, width: 3.4, bottom: 0, top: 2.4 },   // through to the greenhouse
  ]);

  for (const [x, z] of [[-20, 40], [20, 40], [-20, 56], [20, 56], [0, 70]]) {
    b.prop('lamppost', x, 0, z);
    b.light(x, 4.6, z, 0xffcb8a, 1.5, 14);
  }
  for (const [x, z, r] of [[-16, 34, 0], [16, 34, 0], [-24, 50, 1.4], [24, 50, 1.4]]) {
    b.box([x, 0.55, z], [3.0, 1.1, 0.8], 'stone', { r });
  }
}

// ----------------------------------------------------------------- cellar
function cellar(b) {
  const Y = CELLAR, H = 3.4, CTOP = Y + H + 0.6;

  // A vaulted run from under the manor out to a garden grotto.
  const X0 = -14, X1 = 18, Z0 = -8, Z1 = 42;
  b.slab(X0, Z0, X1, Z1, Y, 0.7, 'stone');
  b.slabHoles(X0, Z0, X1, Z1, CTOP, 0.7, 'stone', GROUND_HOLES);
  b.ext(X0 - 0.8, Y, Z0, X0, CTOP, Z1, 'stone');
  b.ext(X1, Y, Z0, X1 + 0.8, CTOP, Z1, 'stone');
  b.ext(X0, Y, Z0 - 0.8, X1, CTOP, Z0, 'stone');
  b.ext(X0, Y, Z1, X1, CTOP, Z1 + 0.8, 'stone');

  // Cross vault piers, giving the cellar its own cover.
  for (let z = Z0 + 6; z < Z1 - 2; z += 8) {
    b.pillar(-8, z, Y, Y + H, 0.5, 'stone');
    b.pillar(12, z, Y, Y + H, 0.5, 'stone');
  }
  // Wine racks.
  for (let i = 0; i < 6; i++) {
    const z = Z0 + 8 + i * 5.5;
    b.box([-2, Y + 1.0, z], [0.6, 2.0, 3.2], 'woodDark');
    b.box([6, Y + 1.0, z], [0.6, 2.0, 3.2], 'woodDark');
  }

  // Stair shafts up into the great hall and the garden grotto.
  const shaft = (hole, dir) => {
    const steps = 22;
    const zStart = dir < 0 ? hole[3] : hole[1];
    b.stairs((hole[0] + hole[2]) / 2, Y, zStart, dir < 0 ? 0 : Math.PI,
      steps, Math.abs(Y) / steps, 0.32, 3.4, 'stone');
    // Below ground the sides are the shaft lining, and they reach three
    // centimetres into the opening: flush with the cut edge of the deck above,
    // the wall face and that edge are the same plane. Above ground they drop
    // to a parapet. Carried full height they turned the head of the stairs
    // into a roofless stone box in the middle of the great hall, which is
    // both an eyesore and somewhere to get wedged.
    const TOP = 1.15;
    b.ext(hole[0] - 0.9, Y, hole[1], hole[0] + 0.03, 0, hole[3], 'stone');
    b.ext(hole[2] - 0.03, Y, hole[1], hole[2] + 0.9, 0, hole[3], 'stone');
    b.ext(hole[0] - 0.5, 0, hole[1], hole[0] + 0.03, TOP, hole[3], 'stone');
    b.ext(hole[2] - 0.03, 0, hole[1], hole[2] + 0.5, TOP, hole[3], 'stone');

    // The flight bottoms out at this end, so from the room above it is a
    // four-metre drop — walled off up there. It carries on down as a facing
    // to just under the cellar vault, because the ground slabs are cut away
    // over the shaft and their edges would otherwise show through it: a band
    // of grass sitting on dirt, halfway up a stone wall. It stops at the
    // vault, which is where the passage to the cellar has to stay open.
    const [bz0, bz1] = dir < 0 ? [hole[3], hole[3] + 0.7] : [hole[1] - 0.7, hole[1]];
    // The facing oversails into the shaft by 20 cm. Started exactly on the
    // cut plane it was coplanar with the very edges it is there to cover,
    // and the two fought over the same pixels.
    const fz0 = dir < 0 ? bz0 - 0.2 : bz0;
    const fz1 = dir < 0 ? bz1 : bz1 + 0.2;
    b.ext(hole[0] - 0.9, CTOP - 0.75, fz0, hole[2] + 0.9, 0, fz1, 'stone');
    b.ext(hole[0] - 0.5, 0, bz0, hole[2] + 0.5, TOP, bz1, 'stone');
  };
  shaft(STAIR_MANOR, -1);
  shaft(STAIR_GROTTO, 1);

  for (let z = Z0 + 4; z < Z1; z += 9) {
    b.prop('cage_lamp', 2, Y + H + 0.3, z);
    b.light(2, Y + H + 0.1, z, 0xffb877, 1.4, 11);
  }
}

// ------------------------------------------------------------------- meta
function meta(b) {
  b.zone('Front Drive', -20, -88, 20, -50);
  b.zone('Gatehouse', -22, -70, 22, -50);
  b.zone('Front Court', -32, -50, 32, -26);
  b.zone('Great Hall', -14, -13, 14, 11);
  b.zone('Library', MX0, MZ0, MX0 + 10, MZ1);
  b.zone('Dining Room', MX1 - 10, MZ0, MX1, MZ1);
  b.zone('Manor', MX0, MZ0, MX1, MZ1);
  b.zone('Manor — First Floor', MX0, MZ0, MX1, MZ1, 4.0, 8.8);
  b.zone('Manor — Attic', MX0, MZ0, MX1, MZ1, 8.8, 13.4);
  b.zone('Manor Roof', MX0, MZ0, MX1, MZ1, 13.4, 24);
  b.zone('Chapel', -68, -18, -38, 18);
  b.zone('Stables', 38, -18, 68, 18);
  b.zone('Rear Terrace', -40, 24, 40, 32);
  b.zone('Hedge Maze', -64, 26, -30, 62);
  b.zone('Orchard', 30, 26, 64, 62);
  b.zone('Greenhouse', 20, 62, 34, 78);
  b.zone('Orangery', -30, 64, -6, 80);
  b.zone('Wine Cellar', -16, -10, 20, 44, -8, -0.6);

  // --- spawns: squads deploy together at opposite ends ------------------
  const attack = [
    [-6, 0, -76, 0], [0, 0, -78, 0], [6, 0, -76, 0], [-10, 0, -72, 0], [10, 0, -72, 0],
    [-4, 0, -82, 0], [4, 0, -82, 0], [-14, 0, -80, 0.2], [14, 0, -80, -0.2], [0, 0, -70, 0],
  ];
  for (const [x, y, z, yaw] of attack) b.spawn(0, x, y, z, yaw);

  const defend = [
    [-18, 0, 72, Math.PI], [-12, 0, 74, Math.PI], [0, 0, 74, Math.PI],
    [-18, 0, 68, Math.PI], [-24, 0, 72, Math.PI], [8, 0, 72, Math.PI],
    [26, 0, 70, Math.PI], [26, 0, 74, Math.PI], [-12, 0, 78, Math.PI], [0, 0, 68, Math.PI],
  ];
  for (const [x, y, z, yaw] of defend) b.spawn(1, x, y, z, yaw);

  for (const [x, y, z, yaw] of [
    [0, 0, -40, 0], [0, 0, 40, Math.PI], [-52, 0, 0, 1.57], [52, 0, 0, -1.57],
    [0, F1, 16, 0], [0, 0, -20, 0],
  ]) b.spawn(-1, x, y, z, yaw, ['ffa']);

  // --- navigation -------------------------------------------------------
  // Waypoint positions are taken from the wall openings and stair flights
  // rather than eyeballed; a node inside geometry is dropped, and a doorway
  // without one leaves the room behind it unreachable.
  const n = [
    // Drive and gatehouse
    [0, 0, -80], [-8, 0, -76], [8, 0, -76], [0, 0, -68], [0, 0, -62], [0, 0, -56],
    [-14, 0, -70], [14, 0, -70], [-26, 0, -69], [26, 0, -69],
    [-26, 0, -76], [26, 0, -76],
    [-14, 0, -60], [14, 0, -60], [-14, 0, -52], [14, 0, -52],
    // Gatehouse towers: approach, half landing, upper floor.
    [-17.9, 0, -66.2], [-16.5, 2.2, -60.9], [-15.2, 4.4, -66.2],
    [10.2, 0, -66.2], [11.5, 2.2, -60.9], [12.9, 4.4, -66.2],
    // Front court
    [0, 0, -48], [-16, 0, -44], [16, 0, -44], [-16, 0, -34], [16, 0, -34],
    [-26, 0, -40], [26, 0, -40], [0, 1.2, -28], [-20, 1.2, -28], [20, 1.2, -28],
    // Manor ground
    [0, 0, -22], [0, 0, -16], [0, 0, -6], [0, 0, 4], [0, 0, 14], [0, 0, 20],
    [-8, 0, -18], [8, 0, -18], [-8, 0, 16], [8, 0, 16],
    [-18, 0, -20], [-18, 0, -6], [-18, 0, 10], [-18, 0, 20],
    [18, 0, -20], [18, 0, -6], [18, 0, 10], [18, 0, 20],
    [-28, 0, -16], [-28, 0, 4], [-28, 0, 18], [28, 0, -16], [28, 0, 4], [28, 0, 18],
    // Grand stair and gallery
    [0, 2.3, 5.0], [-5.6, 4.6, 10.8], [5.6, 4.6, 10.8],
    [0, 4.6, 12], [0, 4.6, 18], [-8, 4.6, 12], [8, 4.6, 12],
    [-18, 4.6, 6], [-18, 4.6, -14], [18, 4.6, 6], [18, 4.6, -14],
    [-28, 4.6, -14], [-28, 4.6, 12], [28, 4.6, -14], [28, 4.6, 12],
    [0, 4.6, -22], [0, 4.6, -28], [0, 4.6, 27],
    // West service stairwell (x -32.6..-25.6, z -20..-13): flight centres are
    // at -30.75 and -27.45, landings at z -14.3.
    [-30.8, 0, -20.5], [-29.1, 2.3, -14.3], [-27.5, 4.6, -21.4],
    [-30.8, 4.6, -21.4], [-29.1, 6.9, -14.3], [-27.5, 9.2, -21.4],
    [-30.8, 9.2, -21.4], [-29.1, 11.5, -14.3], [-27.5, 13.8, -21.4],
    // East service stairwell (x 25.6..32.6, z 12..19), entered from +Z.
    [27.5, 0, 20.4], [29.1, 2.3, 13.3], [30.8, 4.6, 20.4],
    [27.5, 4.6, 20.4], [29.1, 6.9, 13.3], [30.8, 9.2, 20.4],
    [27.5, 9.2, 20.4], [29.1, 11.5, 13.3], [30.8, 13.8, 20.4],
    // Attic and roof
    [-18, 9.2, -14], [0, 9.2, -14], [18, 9.2, 12], [0, 9.2, 12], [-18, 9.2, 12],
    [-27.5, 13.8, -22.8], [-14, 13.8, -22.8], [0, 13.8, -22.8],
    [-20, 13.8, -8], [0, 13.8, -8], [0, 13.8, 4], [20, 13.8, 8], [0, 13.8, 14],
    [-20, 13.8, 10], [20, 13.8, -8],
    [30.7, 13.8, 21.4], [16, 13.8, 21.4], [4, 13.8, 21.4],
    // Chapel
    [-44, 0, -12], [-44, 0, 12], [-56, 0, -3], [-56, 0, 11],
    [-52, 0, -17], [-52, 0, 17], [-64, 0, 0], [-64, 0, 10],
    [-63.8, 0, -8.6], [-63.8, 3.2, -13.8], [-62.4, 6.4, -8.6],
    [-52, 6.4, -14], [-44, 6.4, -14],
    [-71, 0, 0], [-71, 0, 4],
    // Stables
    [44, 0, -12], [44, 0, 12], [52, 0, -3], [52, 0, 11],
    [62, 0, -6], [62, 0, 10], [46, 0, -15], [53.5, 0, 18], [53.5, 1.8, 14.8], [53.5, 3.6, 11.6], [46, 3.6, -10], [46, 3.6, 8], [48, 3.6, 8],
    // Rear terrace and gardens
    [0, 0.8, 27], [-20, 0.8, 27], [20, 0.8, 27], [0, 0, 33],
    [-14, 0, 36], [14, 0, 36], [-14, 0, 50], [14, 0, 50], [0, 0, 58],
    [-24, 0, 32], [24, 0, 32], [-24, 0, 58], [24, 0, 58],
    [0, 0, 64], [0, 0, 70], [-12, 0, 68], [12, 0, 68],
    // Hedge maze — one node per lane segment, between the dividers.
    [-57.5, 0, 31], [-57.5, 0, 37], [-57.5, 0, 46], [-57.5, 0, 52], [-57.5, 0, 59],
    [-51.5, 0, 31], [-51.5, 0, 38], [-51.5, 0, 45], [-51.5, 0, 53], [-51.5, 0, 59],
    [-45, 0, 31], [-45, 0, 38], [-45, 0, 45], [-45, 0, 52], [-45, 0, 59],
    [-37.5, 0, 31], [-37.5, 0, 38], [-37.5, 0, 52.5], [-37.5, 0, 55], [-37.5, 0, 59],
    // Orchard — lanes between the tree grid at x 34/42/50/58, z 30/38/46/54.
    [38, 0, 34], [46, 0, 34], [54, 0, 34], [38, 0, 42], [46, 0, 42], [54, 0, 42],
    [38, 0, 50], [46, 0, 50], [54, 0, 50], [38, 0, 58], [46, 0, 58], [54, 0, 58],
    [62, 0, 42], [33, 0, 42],
    // Greenhouse and orangery
    [27, 0, 59], [27, 0, 66], [27, 0, 74], [23, 0, 70], [31, 0, 70],
    [-18, 0, 59], [-18, 0, 70], [-18, 0, 76], [-26, 0, 70], [-10, 0, 70],
    // Cellar — clear of the piers at x -8/12 and the racks at x -2/6.
    [2, -4.6, -4], [2, -4.6, 4], [2, -4.6, 12], [2, -4.6, 20],
    [2, -4.6, 28], [2, -4.6, 36], [14, -4.6, 10], [-11, -4.6, 20],
    [-4, -2.3, -3], [14, -2.3, 37],
  ];
  for (const p of n) b.node(p[0], p[1], p[2]);

  // Doorway waypoints — links are derived by walking, and a doorway needs a
  // node standing in it or the rooms behind it end up unreachable.
  const doors = [
    // Manor: the only ground doors are on the centre line, plus the two
    // garden doors in the south face at x = -20 and x = 20.
    [0, 0, -26], [0, 0, -23], [0, 0, 24], [0, 0, 27],
    [-20, 0, 24], [-20, 0, 27], [20, 0, 24], [20, 0, 27],
    [-34, 0, -10], [-34, 0, 8], [34, 0, -10], [34, 0, 8],
    // Interior partitions at x = -24 and x = 24.
    [-24, 0, -18], [-24, 0, -2], [-24, 0, 16],
    [24, 0, -18], [24, 0, -2], [24, 0, 16],
    [-29, 0, -12], [29, 0, -12],
    [-24, 4.6, -17], [-24, 4.6, 4], [24, 4.6, -17], [24, 4.6, 4],
    [-16, 4.6, -4], [10, 4.6, -4],
    [-10, 9.2, -20], [10, 9.2, -20],
    // Chapel and stables.
    [-53, 0, -18], [-53, 0, 18], [-68, 0, 0], [-38, 0, -9], [-38, 0, 9],
        [46, 0, -18], [60, 0, -18], [53, 0, 18], [38, 0, -8], [38, 0, 8], [68, 0, 0],
    // Garden walls and outbuildings.
    [-40, 0, 45], [40, 0, 45], [-14, 0, 62], [14, 0, 62], [27, 0, 62],
    [27, 0, 79.5], [20, 0, 70], [34, 0, 70],
    [-18, 0, 64], [-18, 0, 80], [-30, 0, 72], [-6, 0, 72],
  ];
  for (const d of doors) b.node(d[0], d[1], d[2], ['door']);

  // --- dressing ---------------------------------------------------------
  // [34, 20] sat on the manor's own east wall and grew through three storeys
  // of it; moved out into the stable yard.
  for (const [x, z] of [[-30, -56], [30, -56], [-44, -30], [44, -30], [-36, 66], [56, -26]]) {
    b.prop('tree', x, 0, z, { scale: 1.5 });
    b.ext(x - 0.45, 0, z - 0.45, x + 0.45, 3.2, z + 0.45, 'bark');
  }
  for (const [x, z] of [[-22, -46], [22, -46], [-36, 36], [36, 52]]) {
    b.prop('bench', x, 0, z, { yaw: (x > 0 ? -1 : 1) * 0.4 });
  }
  b.prop('wire', -40, 7.6, -20, { to: [0, 0, 40] });
}
