// Procedurally built first-person weapons.
//
// Each gun is assembled from its `shape` descriptor, so every weapon has a
// distinct silhouette without shipping a single model file. Critically, each
// optic carries an `aimPoint` marker at the centre of its sight line: aiming
// down sights simply moves the weapon so that marker sits on the camera axis,
// which is what makes every scope line up correctly on every gun.

import * as THREE from 'three';
import { SCOPES } from '/shared/weapons.js';
import { damp, clamp } from '/shared/mathx.js';

const MATS = {};
function mat(name, params) {
  if (!MATS[name]) MATS[name] = new THREE.MeshStandardMaterial(params);
  return MATS[name];
}

function materials(shape) {
  return {
    body: new THREE.MeshStandardMaterial({ color: shape.body ?? 0x2c2e33, metalness: 0.55, roughness: 0.46, envMapIntensity: 1.5 }),
    furn: new THREE.MeshStandardMaterial({ color: shape.furn ?? 0x24262a, metalness: 0.15, roughness: 0.66, envMapIntensity: 1.2 }),
    dark: mat('dark', { color: 0x1c1e22, metalness: 0.4, roughness: 0.56, envMapIntensity: 1.4 }),
    steel: mat('steel', { color: 0x9aa1a8, metalness: 0.9, roughness: 0.3, envMapIntensity: 1.6 }),
    rubber: mat('rubber', { color: 0x1a1c1f, metalness: 0.05, roughness: 0.92 }),
    glass: mat('optglass', {
      color: 0x9fd8e8, metalness: 0.1, roughness: 0.05,
      transparent: true, opacity: 0.42, envMapIntensity: 2.4,
    }),
    glove: mat('glove', { color: 0x2b2f36, metalness: 0.1, roughness: 0.85 }),
    skin: mat('skin', { color: 0x8d6449, metalness: 0.0, roughness: 0.8 }),
    brass: mat('brass', { color: 0xc9a227, metalness: 0.9, roughness: 0.3 }),
  };
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r1, r2, h, seg = 12) => new THREE.CylinderGeometry(r1, r2, h, seg);

function addMesh(parent, geo, material, pos, rot) {
  const m = new THREE.Mesh(geo, material);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  m.castShadow = false;
  m.receiveShadow = false;
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------- optics
/**
 * Build an optic and return `{ group, aimHeight, length }`.
 * `aimHeight` is the height of the sight line above the rail.
 */
function buildOptic(scopeId, M) {
  const g = new THREE.Group();
  const scope = SCOPES[scopeId] || SCOPES.iron;

  if (scopeId === 'iron') {
    // Front post and rear aperture, sitting low on the receiver.
    addMesh(g, box(0.006, 0.026, 0.006), M.dark, [0, 0.016, -0.30]);
    addMesh(g, box(0.03, 0.006, 0.008), M.dark, [0, 0.028, -0.30]);
    addMesh(g, box(0.03, 0.018, 0.008), M.dark, [0, 0.018, 0.09]);
    addMesh(g, box(0.008, 0.018, 0.008), M.dark, [-0.011, 0.02, 0.09]);
    addMesh(g, box(0.008, 0.018, 0.008), M.dark, [0.011, 0.02, 0.09]);
    return { group: g, aimHeight: 0.022, length: 0.4 };
  }

  const mag = scope.mag;
  const tube = mag > 1.2;
  const bodyLen = tube ? 0.10 + mag * 0.038 : 0.062;
  const radius = tube ? 0.019 + mag * 0.0035 : 0.017;
  const height = tube ? 0.052 : 0.042;

  // Mount.
  addMesh(g, box(0.030, height - radius, 0.052), M.dark, [0, (height - radius) / 2, 0.01]);
  addMesh(g, box(0.044, 0.007, 0.062), M.dark, [0, 0.004, 0.01]);

  if (tube) {
    addMesh(g, cyl(radius, radius, bodyLen, 16), M.dark, [0, height, 0], [Math.PI / 2, 0, 0]);
    addMesh(g, cyl(radius * 1.18, radius * 1.18, 0.016, 16), M.dark, [0, height, -bodyLen / 2 + 0.01], [Math.PI / 2, 0, 0]);
    addMesh(g, cyl(radius * 1.22, radius * 1.22, 0.018, 16), M.dark, [0, height, bodyLen / 2 - 0.01], [Math.PI / 2, 0, 0]);
    // Elevation turret.
    addMesh(g, cyl(0.011, 0.011, 0.016, 10), M.dark, [0, height + radius + 0.006, 0.005]);
    addMesh(g, cyl(0.010, 0.010, 0.014, 10), M.dark, [radius + 0.005, height, 0.005], [0, 0, Math.PI / 2]);
    // Objective and ocular glass.
    addMesh(g, cyl(radius * 0.94, radius * 0.94, 0.004, 16), M.glass, [0, height, -bodyLen / 2 + 0.004], [Math.PI / 2, 0, 0]);
    addMesh(g, cyl(radius * 0.94, radius * 0.94, 0.004, 16), M.glass, [0, height, bodyLen / 2 - 0.004], [Math.PI / 2, 0, 0]);
  } else {
    // Open reflex / holo housing.
    addMesh(g, box(0.042, 0.010, bodyLen), M.dark, [0, height - 0.021, 0]);
    addMesh(g, box(0.042, 0.034, 0.008), M.dark, [0, height - 0.002, bodyLen / 2 - 0.004]);
    addMesh(g, box(0.008, 0.034, bodyLen), M.dark, [-0.017, height - 0.002, 0]);
    addMesh(g, box(0.008, 0.034, bodyLen), M.dark, [0.017, height - 0.002, 0]);
    const glass = addMesh(g, box(0.030, 0.030, 0.003), M.glass, [0, height - 0.002, -bodyLen / 2 + 0.012]);
    glass.rotation.x = scopeId === 'reflex' ? -0.18 : 0;
    if (scopeId === 'holo') {
      addMesh(g, box(0.030, 0.030, 0.003), M.glass, [0, height - 0.002, bodyLen / 2 - 0.014]);
    }
  }

  return { group: g, aimHeight: height, length: bodyLen };
}

// --------------------------------------------------------------- weapons
function buildBody(shape, M) {
  const g = new THREE.Group();
  const len = shape.len ?? 0.6;
  const fam = shape.family;

  // Receiver.
  const recH = fam === 'pistol' || fam === 'revolver' ? 0.052 : 0.072;
  const recW = fam === 'pistol' || fam === 'revolver' ? 0.030 : 0.042;
  const recLen = fam === 'pistol' || fam === 'revolver' ? len : len * 0.52;
  addMesh(g, box(recW, recH, recLen), M.body, [0, 0, 0]);
  addMesh(g, box(recW * 0.86, 0.010, recLen * 0.98), M.dark, [0, recH / 2 + 0.004, 0]);

  const front = -recLen / 2;
  const back = recLen / 2;

  if (fam === 'pistol' || fam === 'revolver') {
    // Slide, frame, grip.
    addMesh(g, box(recW * 0.92, 0.028, recLen * 0.96), M.steel, [0, 0.026, 0]);
    addMesh(g, box(0.028, 0.075, 0.038), M.furn, [0, -0.062, back - 0.02], [0.22, 0, 0]);
    addMesh(g, box(0.026, 0.016, 0.052), M.dark, [0, -0.028, 0.006]);
    addMesh(g, cyl(0.008, 0.008, shape.barrel, 10), M.steel, [0, 0.006, front - shape.barrel / 2], [Math.PI / 2, 0, 0]);
    if (fam === 'revolver') {
      addMesh(g, cyl(0.021, 0.021, 0.042, 10), M.body, [0, -0.004, 0.01], [Math.PI / 2, 0, 0]);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        addMesh(g, cyl(0.005, 0.005, 0.044, 6), M.dark,
          [Math.cos(a) * 0.013, -0.004 + Math.sin(a) * 0.013, 0.01], [Math.PI / 2, 0, 0]);
      }
    }
    return { group: g, front, back, recH, magPos: [0, -0.075, back - 0.02], ejectPos: [recW * 0.6, 0.03, 0.01] };
  }

  // Barrel and handguard.
  addMesh(g, cyl(0.010, 0.010, shape.barrel, 12), M.steel,
    [0, 0.004, front - shape.barrel / 2], [Math.PI / 2, 0, 0]);

  const hgLen = shape.barrel * 0.72;
  const hgZ = front - hgLen / 2 - 0.01;
  if (shape.handguard === 'rail') {
    addMesh(g, box(0.040, 0.040, hgLen), M.dark, [0, 0.004, hgZ]);
    for (let i = 0; i < 5; i++) {
      addMesh(g, box(0.044, 0.004, 0.008), M.dark, [0, 0.024, hgZ - hgLen / 2 + 0.02 + i * (hgLen / 5.5)]);
    }
  } else if (shape.handguard === 'pump') {
    addMesh(g, box(0.038, 0.036, hgLen * 0.6), M.furn, [0, -0.014, hgZ]);
    addMesh(g, cyl(0.011, 0.011, shape.barrel * 0.9, 10), M.steel,
      [0, -0.020, front - shape.barrel / 2], [Math.PI / 2, 0, 0]);
  } else if (shape.handguard === 'shell') {
    addMesh(g, box(0.050, 0.058, len * 0.62), M.body, [0, 0.006, front + len * 0.16]);
  } else {
    addMesh(g, box(0.044, 0.042, hgLen), M.furn, [0, 0.002, hgZ]);
    for (let i = 0; i < 4; i++) {
      addMesh(g, box(0.048, 0.004, 0.006), M.dark, [0, 0.02, hgZ - hgLen / 2 + 0.024 + i * (hgLen / 4.4)]);
    }
  }

  // Muzzle device.
  addMesh(g, cyl(0.014, 0.013, 0.030, 10), M.dark,
    [0, 0.004, front - shape.barrel - 0.012], [Math.PI / 2, 0, 0]);

  // Pistol grip and trigger guard.
  const gripZ = fam === 'bullpup' ? front + 0.06 : back - 0.03;
  addMesh(g, box(0.030, 0.088, 0.040), M.furn, [0, -0.070, gripZ], [0.26, 0, 0]);
  addMesh(g, box(0.026, 0.012, 0.056), M.dark, [0, -0.030, gripZ - 0.03]);

  // Stock.
  if (shape.stock === 'fixed') {
    addMesh(g, box(0.036, 0.062, 0.16), M.furn, [0, -0.010, back + 0.08]);
    addMesh(g, box(0.040, 0.070, 0.016), M.rubber, [0, -0.014, back + 0.164]);
  } else if (shape.stock === 'collapsible') {
    addMesh(g, cyl(0.014, 0.014, 0.13, 8), M.dark, [0, 0.002, back + 0.065], [Math.PI / 2, 0, 0]);
    addMesh(g, box(0.032, 0.056, 0.06), M.furn, [0, -0.006, back + 0.11]);
    addMesh(g, box(0.036, 0.064, 0.014), M.rubber, [0, -0.008, back + 0.145]);
  } else if (shape.stock === 'folding') {
    addMesh(g, box(0.012, 0.030, 0.10), M.dark, [0.024, 0.014, back + 0.05], [0, 0.18, 0]);
    addMesh(g, box(0.026, 0.040, 0.014), M.rubber, [0.03, 0.014, back + 0.10]);
  } else if (shape.stock === 'bullpup') {
    addMesh(g, box(0.044, 0.078, len * 0.44), M.furn, [0, -0.010, back - len * 0.02]);
    addMesh(g, box(0.046, 0.086, 0.016), M.rubber, [0, -0.012, back + len * 0.20]);
    addMesh(g, box(0.036, 0.026, 0.09), M.furn, [0, 0.048, back - len * 0.10]);
  } else if (shape.stock === 'shell') {
    addMesh(g, box(0.050, 0.070, 0.09), M.body, [0, 0.0, back + 0.02]);
    addMesh(g, box(0.052, 0.076, 0.014), M.rubber, [0, 0.0, back + 0.072]);
  }

  // Magazine.
  let magPos = [0, -0.058, 0.0];
  const magGroup = new THREE.Group();
  if (shape.mag === 'curved') {
    for (let i = 0; i < 4; i++) {
      addMesh(magGroup, box(0.028, 0.036, 0.036), M.furn,
        [0, -0.018 - i * 0.032, i * i * 0.006], [i * 0.06, 0, 0]);
    }
  } else if (shape.mag === 'drum') {
    addMesh(magGroup, box(0.070, 0.090, 0.11), M.dark, [0, -0.062, 0.01]);
    addMesh(magGroup, cyl(0.046, 0.046, 0.052, 12), M.dark, [0, -0.062, 0.01], [0, 0, Math.PI / 2]);
  } else if (shape.mag === 'p90') {
    magPos = [0, 0.036, -0.10];
    addMesh(magGroup, box(0.046, 0.020, 0.20), M.glass, [0, 0, 0]);
    addMesh(magGroup, box(0.048, 0.024, 0.018), M.dark, [0, 0, -0.10]);
  } else if (shape.mag === 'tube') {
    magPos = [0, -0.026, -0.16];
    addMesh(magGroup, cyl(0.012, 0.012, 0.30, 10), M.steel, [0, 0, 0], [Math.PI / 2, 0, 0]);
  } else if (shape.mag === 'cylinder') {
    magPos = [0, 0, 0];
  } else {
    addMesh(magGroup, box(0.028, 0.115, 0.040), M.furn, [0, -0.058, 0], [0.04, 0, 0]);
    addMesh(magGroup, box(0.030, 0.010, 0.042), M.dark, [0, -0.116, 0]);
  }
  if (fam === 'bullpup' && shape.mag !== 'p90') magPos = [0, -0.050, back - 0.14];
  magGroup.position.set(magPos[0], magPos[1], magPos[2]);
  g.add(magGroup);

  // Charging handle.
  const charging = addMesh(g, box(0.014, 0.012, 0.036), M.dark, [recW / 2 + 0.006, 0.014, front + 0.05]);

  return {
    group: g, front, back, recH,
    magGroup, magHome: magPos.slice(),
    charging,
    ejectPos: [recW / 2 + 0.01, 0.012, front + 0.09],
  };
}

function buildHands(M, gripZ, guardZ) {
  const g = new THREE.Group();
  const hand = (x, y, z, rot) => {
    const h = new THREE.Group();
    addMesh(h, box(0.052, 0.062, 0.078), M.glove, [0, 0, 0]);
    addMesh(h, box(0.048, 0.030, 0.030), M.glove, [0, -0.030, -0.014]);
    addMesh(h, box(0.020, 0.026, 0.050), M.skin, [0.028, 0.006, 0.006], [0, 0, -0.4]);
    addMesh(h, box(0.056, 0.052, 0.052), M.glove, [0, 0.044, 0.026]);
    h.position.set(x, y, z);
    if (rot) h.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
    g.add(h);
    return h;
  };
  // Trigger hand on the grip, support hand on the handguard.
  hand(0.012, -0.086, gripZ + 0.012, [0.3, 0, 0.1]);
  hand(-0.008, -0.056, guardZ, [0.16, 0, -0.12]);
  return g;
}

/**
 * Assemble a complete first-person weapon.
 * @returns {{root:THREE.Group, aimPoint:THREE.Object3D, muzzle:THREE.Object3D, …}}
 */
export function buildWeaponModel(resolved) {
  const shape = resolved.shape;
  const M = materials(shape);
  const root = new THREE.Group();
  root.name = `weapon:${resolved.id}`;

  const body = buildBody(shape, M);
  root.add(body.group);

  const optic = buildOptic(resolved.scope.id, M);
  const opticZ = shape.family === 'bullpup' ? -0.02 : (shape.family === 'pistol' || shape.family === 'revolver' ? -0.02 : 0.02);
  optic.group.position.set(0, body.recH / 2 + 0.006, opticZ);
  root.add(optic.group);

  // Where the shooter's eye must sit for this optic to be centred.
  const aimPoint = new THREE.Object3D();
  aimPoint.position.set(0, body.recH / 2 + 0.006 + optic.aimHeight, opticZ);
  root.add(aimPoint);

  // Muzzle marker, for flashes and tracer origins.
  const muzzle = new THREE.Object3D();
  const muzzleZ = (shape.family === 'pistol' || shape.family === 'revolver')
    ? body.front - shape.barrel - 0.02
    : body.front - shape.barrel - 0.03;
  muzzle.position.set(0, 0.004, muzzleZ);
  root.add(muzzle);

  const eject = new THREE.Object3D();
  eject.position.set(body.ejectPos[0], body.ejectPos[1], body.ejectPos[2]);
  root.add(eject);

  const gripZ = shape.family === 'bullpup' ? body.front + 0.06 : body.back - 0.03;
  const guardZ = body.front - shape.barrel * 0.4;
  const hands = buildHands(M, gripZ, guardZ);
  root.add(hands);

  // Attachment: laser dot emitter.
  let laser = null;
  if (resolved.laser?.visible) {
    laser = addMesh(root, box(0.014, 0.012, 0.030), M.dark, [-0.026, -0.004, body.front - 0.06]);
    addMesh(laser, cyl(0.004, 0.004, 0.006, 8), new THREE.MeshBasicMaterial({ color: 0xff2222, toneMapped: false }),
      [0, 0, -0.018], [Math.PI / 2, 0, 0]);
  }

  // Suppressor / muzzle attachment.
  if (resolved.muzzle?.id === 'suppressor') {
    addMesh(root, cyl(0.019, 0.019, 0.14, 12), M.dark, [0, 0.004, muzzleZ - 0.05], [Math.PI / 2, 0, 0]);
    muzzle.position.z = muzzleZ - 0.12;
  } else if (resolved.muzzle?.id === 'extended') {
    addMesh(root, cyl(0.013, 0.012, 0.08, 10), M.steel, [0, 0.004, muzzleZ - 0.03], [Math.PI / 2, 0, 0]);
    muzzle.position.z = muzzleZ - 0.07;
  } else if (resolved.muzzle?.id === 'compensator') {
    addMesh(root, cyl(0.016, 0.016, 0.034, 10), M.dark, [0, 0.004, muzzleZ - 0.012], [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 3; i++) {
      addMesh(root, box(0.034, 0.004, 0.005), M.dark, [0, 0.014, muzzleZ - 0.004 - i * 0.010]);
    }
  }

  // Vertical / angled grip.
  if (resolved.grip?.id === 'vertical') {
    addMesh(root, box(0.024, 0.058, 0.026), M.dark, [0, -0.044, guardZ], [0.05, 0, 0]);
  } else if (resolved.grip?.id === 'angled') {
    addMesh(root, box(0.024, 0.042, 0.034), M.dark, [0, -0.036, guardZ], [0.6, 0, 0]);
  }

  root.traverse((o) => { o.frustumCulled = false; });

  return {
    root,
    aimPoint,
    muzzle,
    eject,
    magGroup: body.magGroup || null,
    magHome: body.magHome || [0, 0, 0],
    charging: body.charging || null,
    opticId: resolved.scope.id,
    magnification: resolved.scope.mag,
  };
}

/**
 * A throwable held in the hand. Returns the same shape as a weapon so the
 * animator does not need to care which is equipped.
 */
export function buildGrenadeModel(kind) {
  const M = materials({ body: 0x3f4a33, furn: 0x2c3327 });
  const root = new THREE.Group();
  root.name = `grenade:${kind}`;

  const tint = { frag: 0x3f4a33, flash: 0xb9b19a, smoke: 0x5c6266 }[kind] || 0x3f4a33;
  const shell = new THREE.MeshStandardMaterial({ color: tint, metalness: 0.55, roughness: 0.5 });

  if (kind === 'frag') {
    addMesh(root, new THREE.SphereGeometry(0.045, 12, 10), shell, [0, 0, 0]);
    addMesh(root, cyl(0.016, 0.016, 0.022, 8), M.dark, [0, 0.05, 0]);
    addMesh(root, box(0.010, 0.052, 0.014), M.steel, [0.022, 0.03, 0]);
    addMesh(root, cyl(0.006, 0.006, 0.018, 8), M.steel, [0.03, 0.052, 0], [Math.PI / 2, 0, 0]);
  } else {
    addMesh(root, cyl(0.032, 0.032, 0.115, 12), shell, [0, 0, 0]);
    addMesh(root, cyl(0.034, 0.034, 0.012, 12), M.dark, [0, 0.052, 0]);
    addMesh(root, cyl(0.014, 0.014, 0.02, 8), M.dark, [0, 0.068, 0]);
    addMesh(root, box(0.010, 0.06, 0.014), M.steel, [0.028, 0.03, 0]);
    for (let i = 0; i < 3; i++) {
      addMesh(root, cyl(0.033, 0.033, 0.004, 12), M.dark, [0, -0.03 + i * 0.03, 0]);
    }
  }

  // Gloved hand wrapped around it.
  const hand = new THREE.Group();
  addMesh(hand, box(0.055, 0.062, 0.08), M.glove, [0, 0, 0]);
  addMesh(hand, box(0.05, 0.03, 0.032), M.glove, [0, -0.03, -0.016]);
  addMesh(hand, box(0.056, 0.052, 0.052), M.glove, [0, 0.046, 0.028]);
  hand.position.set(0.004, -0.055, 0.012);
  hand.rotation.set(0.25, 0, 0.1);
  root.add(hand);

  const aimPoint = new THREE.Object3D();
  aimPoint.position.set(0, 0.05, 0);
  root.add(aimPoint);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.05);
  root.add(muzzle);

  root.traverse((o) => { o.frustumCulled = false; });

  return {
    root, aimPoint, muzzle, eject: muzzle,
    magGroup: null, magHome: [0, 0, 0], charging: null,
    opticId: 'iron', magnification: 1, isGrenade: true, kind,
  };
}

// ---------------------------------------------------------- the animator
// The weapon is drawn slightly under life size and pushed away from the eye,
// which is the standard first-person cheat: at true scale and true distance a
// rifle swallows half the screen.
const VM_SCALE = 0.78;
const HIP = new THREE.Vector3(0.145, -0.135, -0.50);
const HIP_ROT = new THREE.Euler(0.02, 0.10, 0.02);
const SPRINT_POS = new THREE.Vector3(0.20, -0.19, -0.44);
const SPRINT_ROT = new THREE.Euler(-0.35, 0.72, 0.22);

export class ViewModel {
  /**
   * @param {THREE.Object3D} rig the view-model camera. The weapon is parented
   *   to it, so every pose below is expressed directly in camera space.
   */
  constructor(rig) {
    this.rig = rig;
    this.holder = new THREE.Group();
    rig.add(this.holder);
    this.model = null;

    this.adsBlend = 0;
    this.sprintBlend = 0;
    this.recoilPos = new THREE.Vector3();
    this.recoilRot = new THREE.Vector3();
    this.swayTarget = new THREE.Vector2();
    this.sway = new THREE.Vector2();
    this.bobPhase = 0;
    this.bob = new THREE.Vector3();
    this.reload = null;
    this.swap = 0;
    this.melee = 0;
    this.inspect = 0;
    this.throwT = 0;
    this._tmp = new THREE.Vector3();
  }

  clearModel() {
    if (!this.model) return;
    this.holder.remove(this.model.root);
    this.model.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.model = null;
  }

  setWeapon(resolved) {
    this.clearModel();
    this.model = buildWeaponModel(resolved);
    this.resolved = resolved;
    this.model.root.scale.setScalar(VM_SCALE);
    this.holder.add(this.model.root);
    this.swap = 0.45;
    return this.model;
  }

  setGrenade(kind) {
    this.clearModel();
    this.model = buildGrenadeModel(kind);
    this.resolved = null;
    this.model.root.scale.setScalar(VM_SCALE);
    this.holder.add(this.model.root);
    this.swap = 0.35;
    return this.model;
  }

  /** Over-arm throw. Returns the moment the grenade should actually leave. */
  startThrow() {
    this.throwT = 0.55;
    return 0.18;
  }

  /** Kick from a shot: back, up, and a little roll. */
  applyRecoil(strength) {
    this.recoilPos.z += strength * 0.9;
    this.recoilPos.y += strength * 0.22;
    this.recoilRot.x -= strength * 5.4;
    this.recoilRot.z += (Math.random() - 0.5) * strength * 3.2;
  }

  startReload(duration, empty) {
    this.reload = { t: 0, duration, empty };
  }

  startMelee() { this.melee = 0.6; }
  startInspect() { if (!this.inspect) this.inspect = 1.9; }

  /** Where the muzzle currently is, in world space. */
  muzzleWorld(target) {
    if (!this.model) return target.set(0, 0, 0);
    this.model.muzzle.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this.model.muzzle.matrixWorld);
  }

  update(dt, s) {
    if (!this.model) return;
    const m = this.model;

    // --- blends -----------------------------------------------------------
    const adsRate = 1 / Math.max(0.05, s.adsTime);
    this.adsBlend = clamp(this.adsBlend + (s.ads ? dt * adsRate : -dt * adsRate * 1.5), 0, 1);
    this.sprintBlend = damp(this.sprintBlend, s.sprinting && !s.ads ? 1 : 0, 11, dt);

    // --- look sway --------------------------------------------------------
    this.swayTarget.set(
      clamp(-s.lookDelta.x * 0.06, -0.05, 0.05),
      clamp(-s.lookDelta.y * 0.06, -0.05, 0.05)
    );
    this.sway.x = damp(this.sway.x, this.swayTarget.x, 9, dt);
    this.sway.y = damp(this.sway.y, this.swayTarget.y, 9, dt);

    // --- walk bob ---------------------------------------------------------
    const speedRatio = clamp(s.speed / 7.35, 0, 1);
    if (s.onGround) this.bobPhase += dt * (6 + speedRatio * 9);
    const bobAmt = speedRatio * (1 - this.adsBlend * 0.78) * (s.onGround ? 1 : 0.15);
    this.bob.set(
      Math.cos(this.bobPhase) * 0.012 * bobAmt,
      Math.abs(Math.sin(this.bobPhase)) * -0.010 * bobAmt,
      Math.sin(this.bobPhase * 0.5) * 0.006 * bobAmt
    );

    // --- recoil recovery ---------------------------------------------------
    const rec = Math.pow(0.0009, dt);
    this.recoilPos.multiplyScalar(rec);
    this.recoilRot.multiplyScalar(Math.pow(0.0016, dt));

    // --- pose --------------------------------------------------------------
    // ADS pose is derived, not authored: place the weapon so its optic's aim
    // point lands on the camera axis, slightly ahead of the near plane.
    // The aim point is in model space, so the model's own scale has to be
    // folded in before it can be cancelled out in camera space.
    const aim = m.aimPoint.position;
    const adsPos = this._tmp.set(
      -aim.x * VM_SCALE,
      -aim.y * VM_SCALE,
      -0.22 - aim.z * VM_SCALE
    );

    const pos = new THREE.Vector3().copy(HIP).lerp(adsPos, this.adsBlend);
    pos.lerp(SPRINT_POS, this.sprintBlend);

    const rot = new THREE.Euler(
      HIP_ROT.x * (1 - this.adsBlend),
      HIP_ROT.y * (1 - this.adsBlend),
      HIP_ROT.z * (1 - this.adsBlend)
    );
    rot.x += SPRINT_ROT.x * this.sprintBlend;
    rot.y += (SPRINT_ROT.y - rot.y) * this.sprintBlend;
    rot.z += SPRINT_ROT.z * this.sprintBlend;

    // Sway, bob and landing dip all fade out while aiming.
    const free = 1 - this.adsBlend * 0.82;
    pos.x += (this.sway.x + this.bob.x) * free;
    pos.y += (this.sway.y + this.bob.y) * free - s.landDip * 0.05;
    pos.z += this.bob.z * free;
    rot.x += this.sway.y * 1.4 * free;
    rot.y += this.sway.x * 1.4 * free;
    rot.z += -this.sway.x * 2.0 * free + s.lean * 0.16;

    // Recoil.
    pos.z += this.recoilPos.z * 0.06;
    pos.y += this.recoilPos.y * 0.02;
    rot.x += this.recoilRot.x * 0.012;
    rot.z += this.recoilRot.z * 0.006;

    // --- scripted animations ----------------------------------------------
    if (this.swap > 0) {
      this.swap = Math.max(0, this.swap - dt);
      const f = this.swap / 0.45;
      pos.y -= f * f * 0.22;
      rot.x -= f * f * 0.9;
    }

    if (this.throwT > 0) {
      this.throwT = Math.max(0, this.throwT - dt);
      const f = 1 - this.throwT / 0.55;
      // Wind up behind the shoulder, then whip forward.
      const wind = f < 0.34 ? f / 0.34 : 0;
      const release = f >= 0.34 ? Math.min(1, (f - 0.34) / 0.3) : 0;
      pos.z += wind * 0.24 - release * 0.30;
      pos.y += wind * 0.16 - release * 0.06;
      pos.x += wind * 0.05;
      rot.x -= wind * 0.9 - release * 1.5;
      rot.z += wind * 0.3;
      if (this.model?.isGrenade) this.model.root.visible = f < 0.42;
    }

    if (this.melee > 0) {
      this.melee = Math.max(0, this.melee - dt);
      const f = 1 - this.melee / 0.6;
      const swing = Math.sin(f * Math.PI);
      pos.x -= swing * 0.16;
      pos.z += swing * 0.12;
      rot.y += swing * 1.1;
      rot.z -= swing * 0.7;
    }

    if (this.inspect > 0 && !s.ads) {
      this.inspect = Math.max(0, this.inspect - dt);
      const f = 1 - this.inspect / 1.9;
      const e = Math.sin(f * Math.PI);
      pos.x -= e * 0.06;
      pos.y += e * 0.03;
      rot.y += e * 0.9;
      rot.z += e * 0.5;
      rot.x += Math.sin(f * Math.PI * 2) * 0.25;
    } else if (this.inspect > 0) {
      this.inspect = 0;
    }

    if (this.reload) {
      this.reload.t += dt;
      const f = this.reload.t / this.reload.duration;
      if (f >= 1) {
        this.reload = null;
        if (m.magGroup) m.magGroup.position.set(...m.magHome);
      } else {
        // Tilt the weapon in, drop the magazine, seat a fresh one, cycle.
        const tilt = Math.sin(Math.min(1, f * 2.4) * Math.PI * 0.5);
        const settle = f > 0.8 ? (1 - (f - 0.8) / 0.2) : 1;
        pos.y -= 0.09 * tilt * settle;
        pos.x -= 0.03 * tilt * settle;
        rot.x += 0.45 * tilt * settle;
        rot.z += 0.35 * tilt * settle;

        if (m.magGroup) {
          const home = m.magHome;
          let drop = 0;
          if (f < 0.35) drop = (f / 0.35) * 0.16;
          else if (f < 0.62) drop = 0.16;
          else if (f < 0.82) drop = 0.16 * (1 - (f - 0.62) / 0.2);
          m.magGroup.position.set(home[0], home[1] - drop, home[2] + drop * 0.2);
          m.magGroup.rotation.x = drop * 1.6;
        }
        if (this.reload.empty && m.charging && f > 0.86) {
          const c = (f - 0.86) / 0.14;
          m.charging.position.z = (m.charging.userData.z ??= m.charging.position.z) + Math.sin(c * Math.PI) * 0.05;
        }
      }
    }

    this.holder.position.copy(pos);
    this.holder.rotation.copy(rot);

    // Once a magnified optic is deployed the ocular fills the screen, so the
    // weapon itself is hidden. Leaving it drawn puts the scope body and the
    // rest of the gun on top of the very image you are meant to be looking
    // through. Non-magnified sights stay visible — you shoot around them.
    m.root.visible = !(m.magnification > 1.05 && this.adsBlend > 0.7);
  }
}
