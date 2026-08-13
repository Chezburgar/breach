// The recon drone.
//
// One per operator per round. While you are driving it your body stays exactly
// where you left it, upright and shootable — the drone is information bought
// with risk, not a free camera. It rolls, sprints and hops, it dies to a single
// round, and its one weapon is a scan that paints whoever it is looking at for
// your team to see through walls.
//
// Movement is deliberately its own small controller rather than the player's:
// a drone is a 40 cm puck, and reusing a 1.78 m capsule would have it snagging
// on things it should roll straight under.

import { BTN, MOVE } from './constants.js';
import { resolveCylinder, groundUnder, ceilingAbove, hasLineOfSight } from './collision.js';
import { clamp } from './mathx.js';

export const DRONE = {
  radius: 0.20,
  height: 0.26,
  eye: 0.19,              // camera height above the chassis floor

  rollSpeed: 4.6,
  sprintSpeed: 7.6,
  accel: 34,
  friction: 11,
  airAccel: 12,

  jumpVelocity: 7.4,
  gravity: MOVE.gravity,
  maxFallSpeed: 40,

  // A drone left alone stays where it is. You get one per round; stepping
  // out of the feed parks it rather than destroying it, and the only thing
  // that takes it off the board is a bullet.

  scanRange: 34,
  scanCooldown: 2.2,
  scanArc: 0.28,          // radians off the drone's centre line
  markDuration: 20.0,

  deployRange: 1.6,       // how far in front of the operator it lands
};

/** A fresh drone belonging to `owner`, placed just ahead of them. */
export function createDrone(id, owner, pos, yaw) {
  return {
    id,
    owner: owner.id,
    team: owner.team,
    pos: { x: pos.x, y: pos.y, z: pos.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: 0,
    onGround: false,
    alive: true,
    piloted: true,
    scanReadyAt: 0,
    idleSince: 0,
    cmd: { btn: 0, yaw, pitch: 0 },
  };
}

/**
 * One fixed step of drone movement. Same shape as the player controller —
 * horizontal move, resolve, then vertical — but with a puck's dimensions and
 * no crouch, lean or slide.
 */
export function stepDrone(d, cmd, world, dt) {
  d.yaw = cmd.yaw;
  d.pitch = clamp(cmd.pitch, -0.9, 0.9);

  const wantFwd = (cmd.btn & BTN.FORWARD ? 1 : 0) - (cmd.btn & BTN.BACK ? 1 : 0);
  const wantSide = (cmd.btn & BTN.RIGHT ? 1 : 0) - (cmd.btn & BTN.LEFT ? 1 : 0);

  const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw);
  const rx = Math.cos(d.yaw), rz = -Math.sin(d.yaw);
  let dx = fx * wantFwd + rx * wantSide;
  let dz = fz * wantFwd + rz * wantSide;
  const len = Math.hypot(dx, dz);
  if (len > 1e-6) { dx /= len; dz /= len; }

  const sprinting = !!(cmd.btn & BTN.SPRINT) && wantFwd > 0;
  const top = sprinting ? DRONE.sprintSpeed : DRONE.rollSpeed;
  const accel = d.onGround ? DRONE.accel : DRONE.airAccel;

  // Accelerate toward the wanted velocity, and coast to a stop when idle.
  const tx = dx * top, tz = dz * top;
  d.vel.x += clamp(tx - d.vel.x, -accel * dt, accel * dt);
  d.vel.z += clamp(tz - d.vel.z, -accel * dt, accel * dt);
  if (len < 1e-6 && d.onGround) {
    const drop = DRONE.friction * dt;
    const speed = Math.hypot(d.vel.x, d.vel.z);
    const k = speed > drop ? (speed - drop) / speed : 0;
    d.vel.x *= k; d.vel.z *= k;
  }

  if ((cmd.btn & BTN.JUMP) && d.onGround) {
    d.vel.y = DRONE.jumpVelocity;
    d.onGround = false;
  }

  // Horizontal, then resolve out of anything it drove into.
  d.pos.x += d.vel.x * dt;
  d.pos.z += d.vel.z * dt;
  resolveCylinder(world, d.pos, DRONE.radius, DRONE.height);

  // Vertical.
  d.vel.y = Math.max(-DRONE.maxFallSpeed, d.vel.y - DRONE.gravity * dt);
  const prevY = d.pos.y;
  d.pos.y += d.vel.y * dt;
  d.onGround = false;

  if (d.vel.y <= 0) {
    const g = groundUnder(world, d.pos.x, d.pos.z, DRONE.radius, prevY + 0.02, d.pos.y);
    if (g > -Infinity && d.pos.y <= g) {
      d.pos.y = g;
      d.vel.y = 0;
      d.onGround = true;
    }
  } else {
    const c = ceilingAbove(world, d.pos.x, d.pos.z, DRONE.radius,
      prevY + DRONE.height, d.pos.y + DRONE.height);
    if (c < Infinity && d.pos.y + DRONE.height > c) {
      d.pos.y = c - DRONE.height - 0.001;
      d.vel.y = 0;
    }
  }
  return d;
}

/** Where the drone's camera sits. */
export function droneEye(d) {
  return { x: d.pos.x, y: d.pos.y + DRONE.eye, z: d.pos.z };
}

/**
 * Whoever the drone is looking at, close enough and clearly enough to paint.
 * Deliberately a narrow cone and a hard line-of-sight test: a scan through a
 * wall would make the thing an oracle rather than a tool.
 */
export function scanTarget(d, players, world) {
  const eye = droneEye(d);
  const fx = -Math.sin(d.yaw) * Math.cos(d.pitch);
  const fy = Math.sin(d.pitch);
  const fz = -Math.cos(d.yaw) * Math.cos(d.pitch);

  let best = null;
  let bestDot = Math.cos(DRONE.scanArc);
  for (const q of players) {
    if (!q.alive || q.team === d.team) continue;
    const cx = q.state.pos.x - eye.x;
    const cy = q.state.pos.y + q.state.height * 0.55 - eye.y;
    const cz = q.state.pos.z - eye.z;
    const dist = Math.hypot(cx, cy, cz);
    if (dist > DRONE.scanRange || dist < 1e-3) continue;
    const dot = (cx * fx + cy * fy + cz * fz) / dist;
    if (dot <= bestDot) continue;
    if (!hasLineOfSight(world, eye, { x: q.state.pos.x, y: q.state.pos.y + q.state.height * 0.55, z: q.state.pos.z })) continue;
    bestDot = dot;
    best = q;
  }
  return best;
}
