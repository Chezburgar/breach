// TRAINING GROUND — an offline facility for learning recoil patterns, testing
// every optic, and practising movement. Runs entirely client-side.

import { MapBuilder } from './builder.js';

export function buildTraining() {
  const b = new MapBuilder({
    id: 'training',
    name: 'Training Ground',
    tagline: 'Weapon handling · live range',
    bounds: { min: [-84, -6, -84], max: [84, 30, 84] },
    ambience: 'day',
    offline: true,
    sun: { azimuth: 210, elevation: 46, intensity: 2.4, color: 0xfff6e8 },
    sky: { turbidity: 3.6, rayleigh: 1.5, mieCoefficient: 0.004, mieDirectionalG: 0.78 },
    fog: { color: 0x8fa2b2, density: 0.0026 },
    envIntensity: 0.10,
    exposure: 0.32,
  });

  base(b);
  range(b);
  shootHouse(b);
  movementCourse(b);
  armory(b);
  trainingMeta(b);

  return b.build();
}

function base(b) {
  b.ext(-86, -3, -86, 86, -0.35, 86, 'dirt');
  // Each patch sits a millimetre above the previous one; overlapping patches
  // at the same height z-fight and flicker between materials.
  let layer = 0;
  const patch = (x0, z0, x1, z1, m) =>
    b.slab(x0 - 0.03, z0 - 0.03, x1 + 0.03, z1 + 0.03, (layer++) * 0.0012, 0.6, m);
  patch(-86, -86, 86, 86, 'sand');
  // Downrange is dark asphalt so the targets read against it; the firing line
  // itself stays light concrete.
  patch(-34, -66, 34, 18, 'asphalt');
  patch(-34, 14, 34, 34, 'concrete');
  patch(36, -24, 78, 34, 'concrete');
  patch(-78, -24, -36, 44, 'asphalt');
  patch(-34, 34, 34, 52, 'concrete');

  // Perimeter berm.
  const R = 82, H = 9;
  b.ext(-R - 1, 0, -R - 1, R + 1, H, -R, 'sandstone');
  b.ext(-R - 1, 0, R, R + 1, H, R + 1, 'sandstone');
  b.ext(-R - 1, 0, -R, -R, H, R, 'sandstone');
  b.ext(R, 0, -R, R + 1, H, R, 'sandstone');
}

function range(b) {
  const X0 = -34, X1 = 34, Z_LINE = 24, Z_END = -66;
  const ROOF = 7.2;

  // Covered firing line.
  b.slab(X0, 16, X1, 34, ROOF, 0.4, 'metal');
  for (let x = X0 + 2; x <= X1 - 2; x += 8) {
    b.ext(x - 0.22, 0, 32.4, x + 0.22, ROOF, 32.8, 'metal');
    b.ext(x - 0.22, 0, 16.4, x + 0.22, ROOF, 16.8, 'metal');
  }
  b.wall(X0, 34, X1, 34, 0, ROOF, 0.5, 'concrete', [{ at: 34, width: 5.0, bottom: 0, top: 3.2 }]);

  // Lane dividers and benches at the firing line.
  for (let i = -3; i <= 3; i++) {
    const x = i * 9;
    b.ext(x - 0.16, 0, Z_LINE - 1.2, x + 0.16, 1.25, Z_LINE + 3.4, 'concrete');
    b.ext(x - 3.6, 0, Z_LINE - 1.4, x + 3.6, 1.02, Z_LINE - 0.7, 'wood');
    b.decal('lane_number', x, 0.02, Z_LINE + 2.2, { text: String(i + 4) });
  }

  // Distance markers painted on the deck.
  for (const d of [10, 25, 50, 75]) {
    b.decal('range_marker', 0, 0.02, Z_LINE - d, { text: `${d}m` });
    b.ext(X0, 0, Z_LINE - d - 0.1, X1, 0.04, Z_LINE - d + 0.1, 'trim', { solid: false, blocksSight: false });
  }

  // Backstop berm.
  b.ext(X0 - 2, 0, Z_END, X1 + 2, 8, Z_END + 4, 'dirt');
  b.ext(X0 - 2, 0, Z_END + 4, X1 + 2, 5, Z_END + 7, 'dirt');
  b.ext(X0 - 2, 0, Z_END + 7, X1 + 2, 2.5, Z_END + 9, 'dirt');

  // Side walls so stray rounds stay on the range.
  b.ext(X0 - 1.2, 0, Z_END, X0, 6, 34, 'concrete');
  b.ext(X1, 0, Z_END, X1 + 1.2, 6, 34, 'concrete');

  // Static paper targets at each marked distance, seven lanes wide.
  let tid = 0;
  for (const d of [10, 25, 50, 75]) {
    for (let i = -3; i <= 3; i++) {
      const x = i * 9;
      const z = Z_LINE - d;
      b.prop('target', x, 0, z, {
        target: true, kind: 'static', id: `t${tid++}`, yaw: Math.PI, height: 1.8,
      });
    }
  }

  // Pop-up steel at mid range — they fall when hit and reset on a timer.
  for (let i = -2; i <= 2; i++) {
    b.prop('target', i * 11, 0, Z_LINE - 38, {
      target: true, kind: 'popup', id: `p${tid++}`, yaw: Math.PI, height: 1.7, resetTime: 2.5,
    });
  }

  // Movers on a rail, crossing left to right.
  for (let i = 0; i < 3; i++) {
    b.prop('target', -20 + i * 20, 0, Z_LINE - 58, {
      target: true, kind: 'moving', id: `m${tid++}`, yaw: Math.PI, height: 1.75,
      rail: [-28, 28], speed: 3.2 + i * 1.1, phase: i * 0.6,
    });
  }
  b.ext(X0, 2.6, Z_LINE - 58.3, X1, 2.75, Z_LINE - 58.1, 'metal', { solid: false, blocksSight: false });

  for (const [x, z] of [[-24, 26], [0, 26], [24, 26]]) {
    b.prop('hangar_lamp', x, ROOF - 0.5, z);
    b.light(x, ROOF - 0.9, z, 0xdce8ff, 1.6, 16);
  }
}

function shootHouse(b) {
  const X0 = 38, Z0 = -20, X1 = 76, Z1 = 30, H = 4.4;
  b.slab(X0, Z0, X1, Z1, 0, 0.4, 'concrete');

  // Open-topped CQB maze — walls only, so instructors (and spectators) can
  // look down into it from the catwalk.
  const w = (ax, az, bx, bz, openings = []) =>
    b.wall(ax, az, bx, bz, 0, H, 0.35, 'plywood', openings);

  w(X0, Z0, X1, Z0, [{ at: 10, width: 2.4, bottom: 0, top: 2.5 }, { at: 28, width: 2.4, bottom: 0, top: 2.5 }]);
  w(X0, Z1, X1, Z1, [{ at: 18, width: 2.4, bottom: 0, top: 2.5 }]);
  w(X0, Z0, X0, Z1, [{ at: 12, width: 2.4, bottom: 0, top: 2.5 }, { at: 38, width: 2.4, bottom: 0, top: 2.5 }]);
  w(X1, Z0, X1, Z1, [{ at: 25, width: 2.4, bottom: 0, top: 2.5 }]);

  w(48, Z0, 48, 6, [{ at: 8, width: 2.2, bottom: 0, top: 2.4 }, { at: 22, width: 2.2, bottom: 0, top: 2.4 }]);
  w(60, -8, 60, Z1, [{ at: 10, width: 2.2, bottom: 0, top: 2.4 }, { at: 26, width: 2.2, bottom: 0, top: 2.4 }]);
  w(X0, 6, 60, 6, [{ at: 6, width: 2.2, bottom: 0, top: 2.4 }, { at: 17, width: 2.2, bottom: 0, top: 2.4 }]);
  w(48, -8, X1, -8, [{ at: 7, width: 2.2, bottom: 0, top: 2.4 }, { at: 21, width: 2.2, bottom: 0, top: 2.4 }]);
  w(X0, 18, 60, 18, [{ at: 14, width: 2.2, bottom: 0, top: 2.4 }]);

  // Furniture and cover inside.
  for (const [x, z, r] of [[43, -14, 0], [54, 2, 0.6], [66, 12, 1.4], [44, 24, 0.2], [70, -14, 0]]) {
    b.box([x, 0.6, z], [1.18, 1.2, 1.18], 'crate', { r });
    b.box([x + 1.2, 0.6, z + 0.4], [1.18, 1.2, 1.18], 'crate', { r: r + 0.5 });
    b.box([x, 1.8, z], [1.18, 1.2, 1.18], 'crate', { r: r + 0.9 });
  }
  for (const [x, z] of [[52, -16], [64, 22], [42, 12]]) {
    b.box([x, 0.55, z], [0.62, 1.1, 0.62], 'metalRust');
    b.prop('barrel', x, 0, z);
  }

  // Hostile / no-shoot targets scattered through the rooms.
  const spots = [
    [43, -16, 0], [45, 2, 1], [52, -3, 0], [56, 12, 0], [44, 26, 1],
    [66, -14, 0], [70, 2, 0], [64, 16, 1], [72, 26, 0], [54, 22, 0],
  ];
  let i = 0;
  for (const [x, z, friendly] of spots) {
    b.prop('target', x, 0, z, {
      target: true, kind: 'popup', id: `h${i++}`, yaw: Math.random() * 0, height: 1.75,
      friendly: !!friendly, resetTime: 3.5, house: true,
    });
  }

  // Observation catwalk around two sides.
  b.slab(X0 - 2.4, Z0 - 2.4, X1 + 2.4, Z0, 5.6, 0.28, 'metal');
  b.slab(X0 - 2.4, Z0, X0, Z1 + 2.4, 5.6, 0.28, 'metal');
  b.railing(X0 - 2.4, Z0 - 2.4, X1 + 2.4, Z0 - 2.4, 5.6, 'metal');
  b.railing(X0, Z0, X0, Z1 + 2.4, 5.6, 'metal');
  b.railing(X0 - 2.4, Z0 - 2.4, X0 - 2.4, Z1 + 2.4, 5.6, 'metal');
  b.stairs(X0 - 1.2, 0, Z1 + 2.0, 0, 24, 5.6 / 24, 0.30, 2.0, 'metal');

  b.decal('sign_text', (X0 + X1) / 2, 3.2, Z0 - 0.4, { text: 'SHOOT HOUSE' });
}

function movementCourse(b) {
  const X0 = -76, Z0 = -22, X1 = -38, Z1 = 42;
  b.slab(X0, Z0, X1, Z1, 0, 0.4, 'asphalt');

  // Ledge staircase — every step is exactly at the auto-step limit or above it,
  // so it doubles as a feel test for the step-up controller.
  for (let i = 0; i < 8; i++) {
    b.ext(X0 + 4, 0, Z0 + 4 + i * 3, X0 + 12, 0.5 + i * 0.5, Z0 + 6.5 + i * 3, 'concrete');
  }

  // Slide tunnel: a low overhang you can only get under while sliding.
  b.ext(X0 + 16, 1.05, Z0 + 6, X0 + 30, 3.4, Z0 + 20, 'concrete');
  b.ext(X0 + 16, 0, Z0 + 6, X0 + 16.6, 3.4, Z0 + 20, 'concrete');
  b.ext(X0 + 29.4, 0, Z0 + 6, X0 + 30, 3.4, Z0 + 20, 'concrete');
  b.decal('sign_text', X0 + 23, 3.8, Z0 + 5.6, { text: 'SLIDE' });

  // Gap jumps of increasing width.
  for (let i = 0; i < 4; i++) {
    const z = Z0 + 26 + i * 8;
    b.ext(X0 + 4, 0, z, X0 + 12, 2.2, z + 2.4, 'concrete');
    b.ext(X0 + 4, 0, z + 2.4 + (2.6 + i * 0.7), X0 + 12, 2.2, z + 4.8 + (2.6 + i * 0.7), 'concrete');
    b.decal('sign_text', X0 + 8, 2.6, z + 1.0, { text: `${(2.6 + i * 0.7).toFixed(1)}m` });
  }

  // Vault crates and a mantle wall.
  for (let i = 0; i < 5; i++) {
    b.box([X0 + 20 + i * 3, 0.28 + i * 0.12, Z0 + 30], [1.6, 0.56 + i * 0.24, 1.6], 'crate');
  }
  b.ext(X0 + 18, 0, Z0 + 38, X0 + 34, 1.1, Z0 + 39, 'concrete');
  b.ext(X0 + 18, 0, Z0 + 44, X0 + 34, 1.7, Z0 + 45, 'concrete');
  b.ext(X0 + 18, 0, Z0 + 50, X0 + 34, 2.3, Z0 + 51, 'concrete');

  // Sprint lane with timing gates.
  for (let i = 0; i <= 6; i++) {
    const z = Z0 + 4 + i * 10;
    b.ext(X0 + 34, 0, z, X0 + 34.4, 4.2, z + 0.4, 'metal');
    b.ext(X0 + 37.6 - 0.4, 0, z, X0 + 37.6, 4.2, z + 0.4, 'metal');
    b.ext(X0 + 34, 4.2, z, X0 + 37.6, 4.6, z + 0.4, 'metal');
  }
  b.decal('sign_text', X0 + 36, 5.2, Z0 + 4, { text: 'SPRINT LANE' });
}

function armory(b) {
  const X0 = -30, Z0 = 36, X1 = 30, Z1 = 50, H = 5.0;
  b.slab(X0, Z0, X1, Z1, 0, 0.4, 'concrete');
  b.slab(X0, Z0, X1, Z1, H, 0.4, 'metal');
  b.wall(X0, Z0, X1, Z0, 0, H, 0.5, 'concrete', [{ at: 30, width: 6.0, bottom: 0, top: 3.4 }]);
  b.wall(X0, Z1, X1, Z1, 0, H, 0.5, 'concrete', []);
  b.wall(X0, Z0, X0, Z1, 0, H, 0.5, 'concrete', []);
  b.wall(X1, Z0, X1, Z1, 0, H, 0.5, 'concrete', []);

  // Weapon pedestals along the back wall. Walking into one equips that gun.
  const guns = ['r4c', 'ak12', 'c416', 'l85a2', 'f2', 'aug', 'mp5', 'vector', 'p90', 'mp7',
                'm590', 'sr25', 'camrs', 'm249', 'p226', 'deagle', 'usg57', 'bailiff'];
  guns.forEach((id, i) => {
    const x = X0 + 3.5 + (i % 9) * 6.6;
    const z = i < 9 ? Z1 - 3.0 : Z1 - 9.0;
    b.ext(x - 1.1, 0, z - 0.7, x + 1.1, 1.05, z + 0.7, 'metal');
    b.prop('weapon_stand', x, 1.05, z, { weapon: id, pickup: true, yaw: Math.PI });
  });

  for (const [x, z] of [[-18, 42], [0, 42], [18, 42]]) {
    b.prop('hangar_lamp', x, H - 0.5, z);
    b.light(x, H - 0.9, z, 0xdce8ff, 1.8, 16);
  }
  b.decal('sign_text', 0, 3.8, Z0 - 0.4, { text: 'ARMORY' });
}

function trainingMeta(b) {
  b.zone('Firing Range', -36, -66, 36, 34);
  b.zone('Shoot House', 36, -22, 78, 32);
  b.zone('Movement Course', -78, -24, -36, 44);
  b.zone('Armory', -30, 34, 30, 52);

  b.spawn(-1, 0, 0, 30, Math.PI, ['ffa', 'start']);
  b.spawn(-1, 0, 0, 40, Math.PI, ['ffa']);
  b.spawn(-1, 50, 0, 26, Math.PI, ['ffa']);
  b.spawn(-1, -56, 0, 34, 0, ['ffa']);

  b.objective('range', 'info', 0, 0, 24, 6, { name: 'FIRING LINE' });
  b.objective('house', 'info', 57, 0, 5, 8, { name: 'SHOOT HOUSE' });
  b.objective('course', 'info', -57, 0, 10, 8, { name: 'MOVEMENT' });
  b.objective('armory', 'info', 0, 0, 43, 8, { name: 'ARMORY' });

  // A circulation route around the facility. Training has no bots, so this is
  // only here to keep the map queryable by the same tooling as the combat maps.
  const nodes = [
    // Behind the firing line, and out through the north door to the armory.
    [0, 0, 31], [-12, 0, 31], [12, 0, 31], [-24, 0, 31], [24, 0, 31],
    [0, 0, 35], [0, 0, 38], [0, 0, 44], [-14, 0, 44], [14, 0, 44], [-24, 0, 45], [24, 0, 45],
    // Around the range's east wall to the shoot house.
    [31, 0, 33], [37, 0, 33], [37, 0, 24], [37, 0, 10], [37, 0, -5], [37, 0, -16],
    [41, 0, -8], [42, 0, -18], [52, 0, 18], [52, 0, 2], [52, 0, -14], [56, 0, 22],
    [64, 0, -14], [70, 0, -2], [68, 0, 14], [64, 0, 26], [46, 0, 12], [46, 0, -2],
    // Around the range's west wall to the movement course.
    [-31, 0, 33], [-37, 0, 33], [-40, 0, 24], [-40, 0, 10], [-40, 0, -4], [-40, 0, -16],
    [-46, 0, 30], [-54, 0, 34], [-62, 0, 40], [-70, 0, 40],
  ];
  for (const n of nodes) b.node(n[0], n[1], n[2]);
}
