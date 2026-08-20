// Collision primitives shared by client prediction and server authority.
//
// The whole world is described as yaw-rotated boxes (OBBs with a vertical axis).
// Restricting rotation to yaw keeps every test cheap and — more importantly —
// keeps the client and the server bit-for-bit agreed on what is solid.

import { clamp } from './mathx.js';

const CELL = 8; // broadphase cell size in metres

/**
 * Turn raw map data into a queryable world: prepared boxes plus a uniform XZ grid.
 * @param {{boxes:Array}} mapData
 */
export function buildWorld(mapData) {
  const boxes = [];
  for (const b of mapData.boxes) {
    const yaw = b.r || 0;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const hx = b.s[0] * 0.5, hy = b.s[1] * 0.5, hz = b.s[2] * 0.5;
    // World-space AABB of the rotated box, used only for broadphase insertion.
    const ex = Math.abs(cos) * hx + Math.abs(sin) * hz;
    const ez = Math.abs(sin) * hx + Math.abs(cos) * hz;
    boxes.push({
      cx: b.p[0], cy: b.p[1], cz: b.p[2],
      hx, hy, hz, yaw, sin, cos,
      solid: b.solid !== false,
      blocksSight: b.blocksSight !== false && b.solid !== false,
      mat: b.m || 'concrete',
      tag: b.t || '',
      minx: b.p[0] - ex, maxx: b.p[0] + ex,
      miny: b.p[1] - hy, maxy: b.p[1] + hy,
      minz: b.p[2] - ez, maxz: b.p[2] + ez,
    });
  }

  const grid = new Map();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b.solid) continue;
    const x0 = Math.floor(b.minx / CELL), x1 = Math.floor(b.maxx / CELL);
    const z0 = Math.floor(b.minz / CELL), z1 = Math.floor(b.maxz / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = x * 73856093 ^ z * 19349663;
        let cell = grid.get(key);
        if (!cell) grid.set(key, (cell = []));
        cell.push(i);
      }
    }
  }

  return {
    boxes, grid, cell: CELL, bounds: mapData.bounds, data: mapData,
    // Scratch for the broadphase: one slot per box, stamped with the query
    // number that last touched it.
    stamp: new Int32Array(boxes.length), gen: 0,
  };
}

const _scratch = [];

/**
 * Collect indices of solid boxes whose AABB overlaps the given XZ rectangle.
 *
 * This is the hottest function in the project — a single simulated step calls
 * it half a dozen times, and building a map's navigation graph runs millions
 * of steps. De-duplicating with a fresh Set per call made it more than half
 * the cost of that build, most of it allocation and the garbage collection
 * behind it. A generation stamp does the same job with no allocation at all:
 * bump a counter, and a box already in `out` is the one whose stamp matches.
 */
export function queryXZ(world, minx, minz, maxx, maxz, out = _scratch) {
  out.length = 0;
  const size = world.cell;
  const x0 = Math.floor(minx / size), x1 = Math.floor(maxx / size);
  const z0 = Math.floor(minz / size), z1 = Math.floor(maxz / size);

  // The overwhelmingly common case: everything falls inside one cell, so
  // nothing can be listed twice and the stamping is pure overhead.
  if (x0 === x1 && z0 === z1) {
    const cell = world.grid.get(x0 * 73856093 ^ z0 * 19349663);
    if (cell) for (let k = 0; k < cell.length; k++) out.push(cell[k]);
    return out;
  }

  const stamp = world.stamp;
  const gen = ++world.gen;
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const cell = world.grid.get(x * 73856093 ^ z * 19349663);
      if (!cell) continue;
      for (let k = 0; k < cell.length; k++) {
        const i = cell[k];
        if (stamp[i] === gen) continue;
        stamp[i] = gen;
        out.push(i);
      }
    }
  }
  return out;
}

/** Does a vertical span overlap this box's vertical extent? */
function spanOverlaps(b, y0, y1) {
  return y0 < b.cy + b.hy - 1e-4 && y1 > b.cy - b.hy + 1e-4;
}

/**
 * Push a vertical cylinder out of every solid box it intersects.
 * `pos` is the cylinder's *foot* position and is modified in place.
 * Returns true if anything was moved.
 */
export function resolveCylinder(world, pos, radius, height) {
  const y0 = pos.y + 0.06;
  const y1 = pos.y + height - 0.06;
  let moved = false;

  // A few relaxation passes settle corners and wedges cleanly.
  for (let pass = 0; pass < 3; pass++) {
    let hit = false;
    const list = queryXZ(world, pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
    for (const idx of list) {
      const b = world.boxes[idx];
      if (!spanOverlaps(b, y0, y1)) continue;

      // Work in the box's local frame, where it is axis aligned.
      const dx = pos.x - b.cx, dz = pos.z - b.cz;
      const lx = dx * b.cos + dz * b.sin;
      const lz = -dx * b.sin + dz * b.cos;

      const cx = clamp(lx, -b.hx, b.hx);
      const cz = clamp(lz, -b.hz, b.hz);
      let nx = lx - cx, nz = lz - cz;
      const d2 = nx * nx + nz * nz;

      if (d2 > radius * radius - 1e-7) continue; // no overlap

      let push;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        push = radius - d;
        nx /= d; nz /= d;
      } else {
        // Centre is inside the rectangle: escape along the nearest face.
        const ox = b.hx - Math.abs(lx);
        const oz = b.hz - Math.abs(lz);
        if (ox < oz) { nx = lx >= 0 ? 1 : -1; nz = 0; push = ox + radius; }
        else { nx = 0; nz = lz >= 0 ? 1 : -1; push = oz + radius; }
      }

      // Back to world space.
      pos.x += (nx * b.cos - nz * b.sin) * push;
      pos.z += (nx * b.sin + nz * b.cos) * push;
      hit = true;
      moved = true;
    }
    if (!hit) break;
  }
  return moved;
}

/** True if a cylinder at `pos` overlaps anything solid. */
export function cylinderBlocked(world, pos, radius, height) {
  const y0 = pos.y + 0.06;
  const y1 = pos.y + height - 0.06;
  const list = queryXZ(world, pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
  for (const idx of list) {
    const b = world.boxes[idx];
    if (!spanOverlaps(b, y0, y1)) continue;
    const dx = pos.x - b.cx, dz = pos.z - b.cz;
    const lx = dx * b.cos + dz * b.sin;
    const lz = -dx * b.sin + dz * b.cos;
    const cx = clamp(lx, -b.hx, b.hx);
    const cz = clamp(lz, -b.hz, b.hz);
    const ddx = lx - cx, ddz = lz - cz;
    if (ddx * ddx + ddz * ddz < radius * radius - 1e-7) return true;
  }
  return false;
}

/**
 * Highest solid surface under a cylinder footprint, searching downward from
 * `fromY` to `toY`. Returns -Infinity when there is nothing to stand on.
 */
export function groundUnder(world, x, z, radius, fromY, toY) {
  let best = -Infinity;
  const list = queryXZ(world, x - radius, z - radius, x + radius, z + radius);
  for (const idx of list) {
    const b = world.boxes[idx];
    const top = b.cy + b.hy;
    if (top > fromY + 1e-4 || top < toY - 1e-4) continue;
    if (top <= best) continue;
    const dx = x - b.cx, dz = z - b.cz;
    const lx = dx * b.cos + dz * b.sin;
    const lz = -dx * b.sin + dz * b.cos;
    const cx = clamp(lx, -b.hx, b.hx);
    const cz = clamp(lz, -b.hz, b.hz);
    const ddx = lx - cx, ddz = lz - cz;
    if (ddx * ddx + ddz * ddz < radius * radius) best = top;
  }
  return best;
}

/** Lowest ceiling above a cylinder footprint, searching upward from `fromY`. */
export function ceilingAbove(world, x, z, radius, fromY, toY) {
  let best = Infinity;
  const list = queryXZ(world, x - radius, z - radius, x + radius, z + radius);
  for (const idx of list) {
    const b = world.boxes[idx];
    const bottom = b.cy - b.hy;
    if (bottom < fromY - 1e-4 || bottom > toY + 1e-4) continue;
    if (bottom >= best) continue;
    const dx = x - b.cx, dz = z - b.cz;
    const lx = dx * b.cos + dz * b.sin;
    const lz = -dx * b.sin + dz * b.cos;
    const cx = clamp(lx, -b.hx, b.hx);
    const cz = clamp(lz, -b.hz, b.hz);
    const ddx = lx - cx, ddz = lz - cz;
    if (ddx * ddx + ddz * ddz < radius * radius) best = bottom;
  }
  return best;
}

// --- Ray casting --------------------------------------------------------

/**
 * Ray against a yaw-rotated box. Returns entry distance or -1.
 * `nrm` (optional) receives the world-space surface normal.
 */
export function rayOBB(ox, oy, oz, dx, dy, dz, cx, cy, cz, hx, hy, hz, sin, cos, nrm) {
  // Ray into box-local space.
  const rx = ox - cx, ry = oy - cy, rz = oz - cz;
  const lox = rx * cos + rz * sin;
  const loz = -rx * sin + rz * cos;
  const ldx = dx * cos + dz * sin;
  const ldz = -dx * sin + dz * cos;

  let tmin = -Infinity, tmax = Infinity;
  let axis = 0, sign = 1;

  // X slab
  if (Math.abs(ldx) < 1e-9) {
    if (lox < -hx || lox > hx) return -1;
  } else {
    const inv = 1 / ldx;
    let t1 = (-hx - lox) * inv, t2 = (hx - lox) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (ry < -hy || ry > hy) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (-hy - ry) * inv, t2 = (hy - ry) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Z slab
  if (Math.abs(ldz) < 1e-9) {
    if (loz < -hz || loz > hz) return -1;
  } else {
    const inv = 1 / ldz;
    let t1 = (-hz - loz) * inv, t2 = (hz - loz) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  if (tmax < 0) return -1;
  const t = tmin >= 0 ? tmin : 0;

  if (nrm) {
    let lnx = 0, lny = 0, lnz = 0;
    if (axis === 0) lnx = sign; else if (axis === 1) lny = sign; else lnz = sign;
    nrm.x = lnx * cos - lnz * sin;
    nrm.y = lny;
    nrm.z = lnx * sin + lnz * cos;
  }
  return t;
}

/**
 * Cast a ray through the static world.
 * @returns {{t:number, point:{x,y,z}, normal:{x,y,z}, box:object}|null}
 */
export function raycastWorld(world, origin, dir, maxDist, opts = {}) {
  const sightOnly = !!opts.sightOnly;
  let bestT = maxDist;
  let bestBox = null;
  const normal = { x: 0, y: 0, z: 0 };
  const tmpN = { x: 0, y: 0, z: 0 };

  // Walk the broadphase grid along the ray so long shots stay cheap.
  const step = world.cell * 0.75;
  const steps = Math.max(1, Math.ceil(maxDist / step));
  const seen = new Set();
  const list = [];

  for (let s = 0; s <= steps; s++) {
    const d = Math.min(maxDist, s * step);
    const px = origin.x + dir.x * d;
    const pz = origin.z + dir.z * d;
    const found = queryXZ(world, px - world.cell, pz - world.cell, px + world.cell, pz + world.cell, list);
    for (const idx of found) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      const b = world.boxes[idx];
      if (sightOnly && !b.blocksSight) continue;
      const t = rayOBB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
        b.cx, b.cy, b.cz, b.hx, b.hy, b.hz, b.sin, b.cos, tmpN);
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestBox = b;
        normal.x = tmpN.x; normal.y = tmpN.y; normal.z = tmpN.z;
      }
    }
    if (bestBox && bestT < d) break; // nothing further along the ray can win
  }

  if (!bestBox) return null;
  return {
    t: bestT,
    point: { x: origin.x + dir.x * bestT, y: origin.y + dir.y * bestT, z: origin.z + dir.z * bestT },
    normal,
    box: bestBox,
  };
}

/** True when nothing solid sits between two points. */
export function hasLineOfSight(world, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;
  const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
  const hit = raycastWorld(world, a, dir, dist - 0.05, { sightOnly: true });
  return !hit;
}

// --- Player hitboxes ----------------------------------------------------

export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/**
 * Test a ray against a player's three-part hitbox.
 * `p` needs `{ pos, yaw, height }` where pos is the foot position.
 * @returns {{t:number, zone:string}|null}
 */
export function rayPlayer(origin, dir, p, maxDist) {
  const h = p.height;
  const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
  let best = maxDist;
  let zone = null;

  // Head — a sphere, so glancing shots behave predictably.
  const headY = p.pos.y + h - 0.145;
  const th = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, p.pos.x, headY, p.pos.z, 0.155);
  if (th >= 0 && th < best) { best = th; zone = 'head'; }

  // Chest
  const tc = rayOBB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
    p.pos.x, p.pos.y + h * 0.66, p.pos.z, 0.30, h * 0.20, 0.20, sin, cos, null);
  if (tc >= 0 && tc < best) { best = tc; zone = 'chest'; }

  // Legs / arms
  const tl = rayOBB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
    p.pos.x, p.pos.y + h * 0.26, p.pos.z, 0.32, h * 0.26, 0.22, sin, cos, null);
  if (tl >= 0 && tl < best) { best = tl; zone = 'limb'; }

  return zone ? { t: best, zone } : null;
}
