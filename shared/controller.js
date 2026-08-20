// The one and only movement implementation.
//
// The browser runs this to predict the local player, the server runs the exact
// same function on the exact same inputs to stay authoritative. Anything that
// influences the outcome must live here — never in client-only code — or
// prediction will disagree with the server and the player will rubber-band.

import { BTN, MOVE, PLAYER, VIEW } from './constants.js';
import { getAbility, applyMoveAbility } from './abilities.js';
import { clamp, damp } from './mathx.js';
import { cylinderBlocked, groundUnder, ceilingAbove, resolveCylinder, raycastWorld } from './collision.js';

export function createPlayerState(spawn, ability = null) {
  return {
    pos: { x: spawn?.p?.[0] ?? 0, y: spawn?.p?.[1] ?? 2, z: spawn?.p?.[2] ?? 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: spawn?.yaw ?? 0,
    pitch: 0,
    height: PLAYER.standHeight,
    crouching: false,
    onGround: false,
    coyote: 0,
    jumpBuffer: 0,
    lean: 0,
    leanTarget: 0,
    sliding: false,
    slideTime: 0,
    slideCooldown: 0,
    sprinting: false,
    speed: 0,
    stepDist: 0,        // distance travelled on foot, drives footstep audio
    // Abilities. The clock lives on the state so prediction and authority
    // share it — a cooldown the client cannot see is a cooldown it cannot
    // predict, and every dash would rubber-band.
    time: 0,
    ability,             // id of the equipped ability
    abilityReadyAt: 0,
    abilityFired: 0,     // set for one frame when a movement ability goes off
    noFallUntil: 0,      // a leap pays for its own landing until this time
    landImpact: 0,      // downward speed at the moment of landing (one frame)
    fallDamage: 0,      // damage owed from the last landing (one frame)
    wasOnGround: false,
  };
}

/**
 * Eye position for a given state, including the lean.
 *
 * The lean has to live here rather than in the client's camera code. Shots
 * leave the eye, and if the camera slides out from behind cover while the
 * muzzle stays on the body's centre line, the crosshair stops agreeing with
 * where the round actually goes — you line a target up in the middle of the
 * screen and miss by the width of the lean. Putting it in the state means
 * the view, the client's prediction and the server's hitscan all use the
 * same eye.
 */
export function eyePosition(s) {
  const off = (s.lean || 0) * MOVE.leanOffset;
  const drop = Math.abs(s.lean || 0) * MOVE.leanDrop;
  return {
    x: s.pos.x + Math.cos(s.yaw) * off,
    y: s.pos.y + s.height - PLAYER.eyeDrop - drop,
    z: s.pos.z - Math.sin(s.yaw) * off,
  };
}

function moveHorizontal(world, s, dx, dz, radius) {
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-7) return;
  const steps = Math.max(1, Math.ceil(dist / (radius * 0.5)));
  const sx = dx / steps, sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    s.pos.x += sx;
    s.pos.z += sz;
    resolveCylinder(world, s.pos, radius, s.height);
  }
}

/**
 * Advance one player by exactly one fixed timestep.
 * @param {object} s   player state, mutated in place
 * @param {object} cmd `{ btn, yaw, pitch, dt }`
 * @param {object} world prepared collision world
 * @param {number} dt  fixed timestep — must match on both ends
 */
export function stepPlayer(s, cmd, world, dt) {
  const R = PLAYER.radius;
  s.landImpact = 0;
  s.fallDamage = 0;
  s.wasOnGround = s.onGround;

  // --- Look -------------------------------------------------------------
  s.yaw = cmd.yaw;
  s.pitch = clamp(cmd.pitch, -VIEW.maxPitch, VIEW.maxPitch);

  const btn = cmd.btn | 0;
  const wantFwd = (btn & BTN.FORWARD ? 1 : 0) - (btn & BTN.BACK ? 1 : 0);
  const wantRight = (btn & BTN.RIGHT ? 1 : 0) - (btn & BTN.LEFT ? 1 : 0);
  const wantJump = !!(btn & BTN.JUMP);
  const wantCrouch = !!(btn & BTN.CROUCH);
  const wantAds = !!(btn & BTN.ADS);
  const hasInput = wantFwd !== 0 || wantRight !== 0;

  // --- Lean -------------------------------------------------------------
  s.leanTarget = (btn & BTN.LEAN_R ? 1 : 0) - (btn & BTN.LEAN_L ? 1 : 0);
  s.lean = damp(s.lean, s.leanTarget, 13, dt);

  // Leaning must not push the eye through a wall, and the clamp has to be
  // part of the simulation rather than a client-side nicety: if the client
  // stops the lean short and the server does not, their eyes — and so their
  // shots — end up in different places.
  if (Math.abs(s.lean) > 1e-3) {
    const head = { x: s.pos.x, y: s.pos.y + s.height - PLAYER.eyeDrop, z: s.pos.z };
    const sign = Math.sign(s.lean);
    const dir = { x: Math.cos(s.yaw) * sign, y: 0, z: -Math.sin(s.yaw) * sign };
    const clearance = R * 0.6;
    const reach = Math.abs(s.lean) * MOVE.leanOffset + clearance;
    const hit = raycastWorld(world, head, dir, reach);
    if (hit) {
      const room = Math.max(0, hit.t - clearance) / MOVE.leanOffset;
      s.lean = sign * Math.min(Math.abs(s.lean), room);
    }
  }

  // --- Crouch / stance --------------------------------------------------
  const headroom = ceilingAbove(world, s.pos.x, s.pos.z, R, s.pos.y + s.height - 0.05, s.pos.y + PLAYER.standHeight + 0.1);
  const canStand = headroom - s.pos.y >= PLAYER.standHeight + 0.02;
  s.crouching = wantCrouch || !canStand;

  // --- Slide ------------------------------------------------------------
  if (s.slideCooldown > 0) s.slideCooldown = Math.max(0, s.slideCooldown - dt);
  const horizSpeed = Math.hypot(s.vel.x, s.vel.z);
  if (!s.sliding && wantCrouch && s.onGround && s.slideCooldown === 0 &&
      horizSpeed > MOVE.walkSpeed * 1.05 && wantFwd > 0) {
    s.sliding = true;
    s.slideTime = MOVE.slideDuration;
    const inv = horizSpeed > 1e-4 ? MOVE.slideSpeed / horizSpeed : 0;
    s.vel.x *= inv; s.vel.z *= inv;
  }
  if (s.sliding) {
    s.slideTime -= dt;
    if (s.slideTime <= 0 || !wantCrouch || !s.onGround || wantJump) {
      s.sliding = false;
      s.slideCooldown = MOVE.slideCooldown;
    }
  }

  const targetHeight = (s.crouching || s.sliding) ? PLAYER.crouchHeight : PLAYER.standHeight;
  s.height = damp(s.height, targetHeight, 16, dt);
  if (Math.abs(s.height - targetHeight) < 0.004) s.height = targetHeight;

  // --- Speed target -----------------------------------------------------
  s.sprinting = !!(btn & BTN.SPRINT) && wantFwd > 0 && !wantAds && !s.crouching && !s.sliding && s.onGround;
  let maxSpeed = MOVE.walkSpeed;
  if (s.sliding) maxSpeed = MOVE.slideSpeed;
  else if (s.sprinting) maxSpeed = MOVE.sprintSpeed;
  else if (s.crouching) maxSpeed = MOVE.crouchSpeed;
  else if (wantAds) maxSpeed = MOVE.adsSpeed;
  if (wantFwd < 0) maxSpeed *= 0.86;               // slower backpedal

  // --- Wish direction ---------------------------------------------------
  const sinY = Math.sin(s.yaw), cosY = Math.cos(s.yaw);
  let wx = 0, wz = 0;
  if (hasInput) {
    // Forward is -Z at yaw 0, matching three.js camera convention.
    const fx = -sinY, fz = -cosY;
    const rx = cosY, rz = -sinY;
    wx = fx * wantFwd + rx * wantRight;
    wz = fz * wantFwd + rz * wantRight;
    const l = Math.hypot(wx, wz);
    if (l > 1e-6) { wx /= l; wz /= l; }
  }

  // --- Abilities --------------------------------------------------------
  // Movement abilities run here, inside the shared step, so the browser and
  // the server apply them on the same input and agree about where you ended
  // up. World abilities are the room's business and never touch this file.
  s.time += dt;
  s.abilityFired = 0;
  if ((btn & BTN.ABILITY) && s.ability) {
    const def = getAbility(s.ability);
    if (def.kind === 'move' && s.time >= s.abilityReadyAt) {
      if (applyMoveAbility(s, def, { x: wx, z: wz, fx: -sinY, fz: -cosY })) {
        s.abilityReadyAt = s.time + def.cooldown;
        s.abilityFired = 1;
        s.sliding = false;
        s.slideTime = 0;
      }
    }
  }

  // --- Acceleration -----------------------------------------------------
  if (s.onGround) {
    if (s.sliding) {
      // Slides coast: heavy friction, only a sliver of steering authority.
      const f = Math.max(0, 1 - 2.4 * dt);
      s.vel.x *= f; s.vel.z *= f;
      s.vel.x += wx * 6 * dt;
      s.vel.z += wz * 6 * dt;
    } else {
      const sp = Math.hypot(s.vel.x, s.vel.z);
      if (sp > 1e-4) {
        const drop = sp * MOVE.friction * dt;
        const scale = Math.max(0, sp - drop) / sp;
        s.vel.x *= scale; s.vel.z *= scale;
      }
      if (hasInput) {
        const cur = s.vel.x * wx + s.vel.z * wz;
        const add = Math.min(maxSpeed - cur, MOVE.groundAccel * dt);
        if (add > 0) { s.vel.x += wx * add; s.vel.z += wz * add; }
      }
    }
  } else if (hasInput) {
    // Air control: capped projection so bunny-hopping cannot build speed.
    const cur = s.vel.x * wx + s.vel.z * wz;
    const add = Math.min(Math.max(0, maxSpeed - cur), MOVE.airAccel * dt);
    if (add > 0) {
      s.vel.x += wx * add;
      s.vel.z += wz * add;
      const sp = Math.hypot(s.vel.x, s.vel.z);
      const cap = Math.max(MOVE.sprintSpeed, maxSpeed);
      if (sp > cap) { s.vel.x *= cap / sp; s.vel.z *= cap / sp; }
    }
  }

  // --- Jump -------------------------------------------------------------
  s.coyote = s.onGround ? MOVE.coyoteTime : Math.max(0, s.coyote - dt);
  s.jumpBuffer = wantJump ? MOVE.jumpBuffer : Math.max(0, s.jumpBuffer - dt);
  let jumped = false;
  if (s.jumpBuffer > 0 && s.coyote > 0) {
    s.vel.y = MOVE.jumpVelocity;
    s.onGround = false;
    s.coyote = 0;
    s.jumpBuffer = 0;
    s.sliding = false;
    jumped = true;
  }

  // --- Gravity ----------------------------------------------------------
  s.vel.y -= MOVE.gravity * dt;
  if (s.vel.y < -MOVE.maxFallSpeed) s.vel.y = -MOVE.maxFallSpeed;

  // --- Horizontal integration with step-up ------------------------------
  const startX = s.pos.x, startY = s.pos.y, startZ = s.pos.z;
  const dx = s.vel.x * dt, dz = s.vel.z * dt;
  moveHorizontal(world, s, dx, dz, R);

  const gotX = s.pos.x - startX, gotZ = s.pos.z - startZ;
  const wantSq = dx * dx + dz * dz;
  const gotSq = gotX * gotX + gotZ * gotZ;

  if (wantSq > 1e-8 && gotSq < wantSq * 0.96 && (s.onGround || s.coyote > 0)) {
    const raised = { x: startX, y: startY + PLAYER.stepHeight, z: startZ };
    if (!cylinderBlocked(world, raised, R, s.height)) {
      const blockedX = s.pos.x, blockedY = s.pos.y, blockedZ = s.pos.z;
      s.pos.x = raised.x; s.pos.y = raised.y; s.pos.z = raised.z;
      moveHorizontal(world, s, dx, dz, R);
      const g = groundUnder(world, s.pos.x, s.pos.z, R, s.pos.y + 0.02, startY - 0.02);
      const climbedSq = (s.pos.x - startX) ** 2 + (s.pos.z - startZ) ** 2;
      if (g > -Infinity && g <= startY + PLAYER.stepHeight + 0.02 && climbedSq > gotSq + 1e-6) {
        s.pos.y = Math.max(g, startY);
        s.onGround = true;
        if (s.vel.y < 0) s.vel.y = 0;
      } else {
        s.pos.x = blockedX; s.pos.y = blockedY; s.pos.z = blockedZ;
      }
    }
  }

  // Kill velocity into surfaces we actually collided with, keeping the
  // component that slides along them.
  if (dt > 1e-6) {
    const realX = (s.pos.x - startX) / dt;
    const realZ = (s.pos.z - startZ) / dt;
    if (Math.abs(realX) < Math.abs(s.vel.x)) s.vel.x = realX;
    if (Math.abs(realZ) < Math.abs(s.vel.z)) s.vel.z = realZ;
  }

  // --- Vertical integration ---------------------------------------------
  const prevFeet = s.pos.y;
  s.pos.y += s.vel.y * dt;
  s.onGround = false;

  if (s.vel.y <= 0) {
    const g = groundUnder(world, s.pos.x, s.pos.z, R, prevFeet + 0.02, s.pos.y);
    if (g > -Infinity) {
      s.pos.y = g;
      // A vault throws you ten metres up, and the drop back down would hurt
      // more than the ability is worth. The grace it sets covers exactly one
      // landing — its own — and is spent here whether it was needed or not.
      const graced = s.time < (s.noFallUntil || 0);
      if (s.vel.y < -MOVE.fallDamageStart && !graced) {
        s.landImpact = -s.vel.y;
        s.fallDamage = Math.min(100, (s.landImpact - MOVE.fallDamageStart) * MOVE.fallDamagePerUnit);
      } else if (s.vel.y < -2) {
        s.landImpact = -s.vel.y;
      }
      s.vel.y = 0;
      s.onGround = true;
      s.noFallUntil = 0;
    }
  } else {
    const c = ceilingAbove(world, s.pos.x, s.pos.z, R, prevFeet + s.height, s.pos.y + s.height);
    if (c < Infinity) {
      s.pos.y = c - s.height - 0.001;
      s.vel.y = 0;
    }
  }

  // Stay glued to descending stairs instead of launching off every step.
  if (!s.onGround && !jumped && s.wasOnGround && s.vel.y <= 0.01) {
    const g = groundUnder(world, s.pos.x, s.pos.z, R, s.pos.y + 0.02, s.pos.y - PLAYER.stepHeight);
    if (g > -Infinity) {
      s.pos.y = g;
      s.vel.y = 0;
      s.onGround = true;
    }
  }

  // Final safety: never leave the player embedded in geometry.
  resolveCylinder(world, s.pos, R, s.height);

  // --- Bookkeeping ------------------------------------------------------
  s.speed = Math.hypot(s.vel.x, s.vel.z);
  if (s.onGround) s.stepDist += s.speed * dt;

  // Out-of-world guard (falling through a seam should never be fatal).
  const b = world.bounds;
  if (b) {
    if (s.pos.y < b.min[1] - 20) { s.pos.y = b.min[1] - 20; s.vel.y = 0; s.outOfBounds = true; }
    else s.outOfBounds = false;
    s.pos.x = clamp(s.pos.x, b.min[0] - 4, b.max[0] + 4);
    s.pos.z = clamp(s.pos.z, b.min[2] - 4, b.max[2] + 4);
  }

  return s;
}

/** Pack the fields that must match between prediction and authority. */
export function snapshotState(s) {
  return {
    px: s.pos.x, py: s.pos.y, pz: s.pos.z,
    vx: s.vel.x, vy: s.vel.y, vz: s.vel.z,
    h: s.height, g: s.onGround ? 1 : 0, sl: s.sliding ? 1 : 0,
  };
}

export function applyState(s, n) {
  s.pos.x = n.px; s.pos.y = n.py; s.pos.z = n.pz;
  s.vel.x = n.vx; s.vel.y = n.vy; s.vel.z = n.vz;
  s.height = n.h;
  s.onGround = !!n.g;
  s.sliding = !!n.sl;
}
