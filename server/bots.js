// Bot opponents.
//
// Bots feed the same input structs as human clients into the same authoritative
// controller, so they collide, fall, and shoot under identical rules. Their AI
// is a small state machine — patrol, engage, reposition — over the map's
// navigation graph.

import { BTN, PLAYER } from '../shared/constants.js';
import { hasLineOfSight } from '../shared/collision.js';
import { eyePosition } from '../shared/controller.js';
import { anglesFromDir, angleDelta, clamp, vdist, vsub, vnorm } from '../shared/mathx.js';
import { PRIMARIES, SECONDARIES } from '../shared/weapons.js';
import { BANNERS, DEFAULT_FANFARE, BUILTIN_FANFARES } from '../shared/cosmetics.js';
import { findPath, nearestNode, nearestReachableNode } from './nav.js';

export const BOT_NAMES = [
  'Kestrel', 'Vulcan', 'Marlow', 'Rooke', 'Ozdemir', 'Bellamy', 'Halden', 'Sable',
  'Cruz', 'Novak', 'Reyes', 'Ferris', 'Iwata', 'Okonkwo', 'Lindqvist', 'Marsh',
  'Duval', 'Petrov', 'Achebe', 'Quill',
];

const DIFFICULTIES = [
  { name: 'Recruit', turn: 3.2, error: 3.4, reaction: 0.42, burst: [3, 6], range: 42, accuracy: 0.55 },
  { name: 'Regular', turn: 5.0, error: 2.1, reaction: 0.30, burst: [4, 8], range: 55, accuracy: 0.72 },
  { name: 'Veteran', turn: 7.2, error: 1.25, reaction: 0.21, burst: [5, 11], range: 70, accuracy: 0.86 },
  { name: 'Elite',   turn: 9.4, error: 0.75, reaction: 0.15, burst: [6, 14], range: 90, accuracy: 0.94 },
];

export class Bot {
  constructor(room, name) {
    this.room = room;
    this.name = name;
    this.player = null;

    const tier = Math.min(3, Math.floor(Math.random() * 3.4));
    this.skill = DIFFICULTIES[tier];
    this.level = 8 + Math.floor(Math.random() * 70);
    this.banner = BANNERS[Math.floor(Math.random() * BANNERS.length)].id;
    this.fanfare = (BUILTIN_FANFARES[Math.floor(Math.random() * BUILTIN_FANFARES.length)] || {}).id || DEFAULT_FANFARE;

    const primary = PRIMARIES[Math.floor(Math.random() * PRIMARIES.length)];
    const secondary = SECONDARIES[Math.floor(Math.random() * SECONDARIES.length)];
    this.loadout = {
      primary: {
        id: primary.id,
        scope: primary.scopes[Math.floor(Math.random() * primary.scopes.length)],
        muzzle: Math.random() < 0.5 ? 'compensator' : 'flash',
        grip: Math.random() < 0.6 ? 'vertical' : 'angled',
        laser: 'none',
      },
      secondary: { id: secondary.id, scope: secondary.defaultScope, muzzle: 'none', grip: 'none', laser: 'none' },
    };

    this.reset();
  }

  reset() {
    this.target = null;
    this.targetSeenAt = -99;
    this.lastKnown = null;
    this.reactTimer = 0;
    this.path = null;
    this.pathIndex = 0;
    this.goalTimer = 0;
    this.forceRepath = false;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 0;
    this.jumpTimer = 0;
    this.burstLeft = 0;
    this.burstRest = 0;
    this.scanYaw = Math.random() * Math.PI * 2;
    this.stuckTimer = 0;
    this.lastPos = null;
  }

  onSpawn() {
    this.reset();
    const p = this.player;
    if (p) {
      p.cmd = { seq: 0, btn: 0, yaw: p.state.yaw, pitch: 0 };
      this.aimYaw = p.state.yaw;
      this.aimPitch = 0;
    }
  }

  think(dt, live) {
    const p = this.player;
    if (!p) return;
    if (!p.alive) { p.cmd = { seq: 0, btn: 0, yaw: p.state.yaw, pitch: 0 }; return; }

    if (this.aimYaw === undefined) { this.aimYaw = p.state.yaw; this.aimPitch = 0; }

    const room = this.room;
    this.acquire(dt, live);

    let btn = 0;
    const eye = eyePosition(p.state);

    // ---- Aim -------------------------------------------------------------
    let desiredYaw = this.aimYaw;
    let desiredPitch = this.aimPitch;
    const engaging = live && this.target && this.target.alive && this.reactTimer <= 0;

    if (this.target && this.target.alive) {
      const aimPoint = this.aimPointFor(this.target);
      const d = vnorm(vsub(aimPoint, eye));
      const a = anglesFromDir(d);
      const wobble = this.skill.error * (Math.PI / 180);
      desiredYaw = a.yaw + Math.sin(room.time * 3.1 + this.seedOffset()) * wobble;
      desiredPitch = a.pitch + Math.cos(room.time * 2.3 + this.seedOffset()) * wobble * 0.6;
    } else if (this.lastKnown) {
      const d = vnorm(vsub(this.lastKnown, eye));
      const a = anglesFromDir(d);
      desiredYaw = a.yaw; desiredPitch = a.pitch;
    } else if (this.path && this.pathIndex < this.path.length) {
      const n = room.nav.nodes[this.path[this.pathIndex]];
      desiredYaw = Math.atan2(-(n.p.x - p.state.pos.x), -(n.p.z - p.state.pos.z));
      desiredPitch = 0;
    } else {
      desiredYaw = this.scanYaw;
      desiredPitch = 0;
    }

    const turn = this.skill.turn * dt * (engaging ? 1.4 : 0.7);
    this.aimYaw += clamp(angleDelta(this.aimYaw, desiredYaw), -turn, turn);
    this.aimPitch += clamp(desiredPitch - this.aimPitch, -turn, turn);
    this.aimPitch = clamp(this.aimPitch, -1.3, 1.3);

    // ---- Movement --------------------------------------------------------
    if (live) {
      const moveTarget = this.moveTarget(dt);
      if (moveTarget) {
        const sep = this.separation();
        const dx = moveTarget.x - p.state.pos.x + (sep ? sep.x * 1.2 : 0);
        const dz = moveTarget.z - p.state.pos.z + (sep ? sep.z * 1.2 : 0);
        const dist = Math.hypot(dx, dz);
        if (dist > 0.6) {
          // Convert world direction into forward/strafe relative to the aim.
          const fx = -Math.sin(this.aimYaw), fz = -Math.cos(this.aimYaw);
          const rx = Math.cos(this.aimYaw), rz = -Math.sin(this.aimYaw);
          const nx = dx / dist, nz = dz / dist;
          const fwd = nx * fx + nz * fz;
          const side = nx * rx + nz * rz;
          if (fwd > 0.35) btn |= BTN.FORWARD;
          else if (fwd < -0.35) btn |= BTN.BACK;
          if (side > 0.35) btn |= BTN.RIGHT;
          else if (side < -0.35) btn |= BTN.LEFT;
          if (!this.target && fwd > 0.8) btn |= BTN.SPRINT;
        }

        // Vertical difference means stairs — nudge forward rather than stalling.
        if (moveTarget.y - p.state.pos.y > 0.8 && dist < 3.5) btn |= BTN.FORWARD;
      }

      // Combat strafing.
      if (engaging) {
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          this.strafeTimer = 0.5 + Math.random() * 0.9;
          this.strafeDir = -this.strafeDir;
        }
        btn &= ~(BTN.LEFT | BTN.RIGHT);
        btn |= this.strafeDir > 0 ? BTN.RIGHT : BTN.LEFT;
        btn &= ~BTN.SPRINT;
        const dist = vdist(p.state.pos, this.target.state.pos);
        if (dist > this.preferredRange() + 6) btn |= BTN.FORWARD;
        else if (dist < this.preferredRange() - 5) btn |= BTN.BACK;
        else btn &= ~(BTN.FORWARD | BTN.BACK);
        // Aiming down sights costs mobility but collapses the cone of fire —
        // hip-firing while strafing, bots simply never hit anything.
        if (dist > 9) btn |= BTN.ADS;
        if (Math.random() < 0.004) btn |= BTN.CROUCH;
      }

      // Unstick. Pressed against a wall, the useful move is to slide along it;
      // only if that fails for a while is it worth hopping and repathing.
      if (this.lastPos) {
        const moved = vdist(p.state.pos, this.lastPos);
        if ((btn & (BTN.FORWARD | BTN.BACK | BTN.LEFT | BTN.RIGHT)) && moved < 0.025) {
          this.stuckTimer += dt;
          if (this.stuckTimer > 0.2) {
            btn &= ~(BTN.LEFT | BTN.RIGHT);
            btn |= this.strafeDir > 0 ? BTN.RIGHT : BTN.LEFT;
          }
          if (this.stuckTimer > 1.1) {
            btn |= BTN.JUMP;
            this.forceRepath = true;
            this.stuckTimer = 0;
            this.strafeDir = -this.strafeDir;
          }
        } else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
      }
      this.lastPos = { ...p.state.pos };
    }

    // ---- Trigger ---------------------------------------------------------
    if (engaging && this.canShoot()) {
      const slot = p.weapons[p.slot];
      if (slot && slot.mag <= 0) {
        // Dry: reload, swap, or — with nothing left at all — go for the knife.
        if (slot.reserve > 0) room.startReload(p);
        else {
          const other = p.slot === 'primary' ? 'secondary' : 'primary';
          const alt = p.weapons[other];
          if (alt && (alt.mag > 0 || alt.reserve > 0)) room.switchSlot(p, other);
          else if (vdist(p.state.pos, this.target.state.pos) < 2.2) room.melee(p, p.cmd);
        }
      } else if (slot) {
        const interval = Math.max(slot.rw.shotInterval, 0.05);
        const fireMode = slot.rw.def.fireModes[0];
        if (fireMode === 'semi' || fireMode === 'pump') {
          // Semi-autos need the trigger released between shots, so pulse it.
          this.triggerPhase = (this.triggerPhase || 0) + dt;
          const period = Math.max(interval, 0.16) * 2;
          if (this.triggerPhase % period < period * 0.5) btn |= BTN.FIRE;
        } else {
          this.burstRest -= dt;
          if (this.burstLeft <= 0 && this.burstRest <= 0) {
            const [lo, hi] = this.skill.burst;
            const shots = lo + Math.floor(Math.random() * (hi - lo + 1));
            this.burstLeft = shots * interval;
          }
          if (this.burstLeft > 0) {
            btn |= BTN.FIRE;
            this.burstLeft -= dt;
            if (this.burstLeft <= 0) this.burstRest = 0.15 + Math.random() * 0.35;
          }
        }
      }
    } else {
      const slot = p.weapons[p.slot];
      if (slot && slot.mag < slot.rw.mag * 0.35 && slot.reserve > 0 && !this.target) {
        room.startReload(p);
      }
    }

    p.cmd = { seq: (p.cmd?.seq || 0) + 1, btn, yaw: this.aimYaw, pitch: this.aimPitch };
  }

  seedOffset() {
    if (this._seed === undefined) this._seed = Math.random() * 100;
    return this._seed;
  }

  preferredRange() {
    const p = this.player;
    const slot = p.weapons[p.slot];
    const rw = slot?.rw;
    if (!rw) return 18;
    // Out of ammo entirely: the only play left is to close and knife.
    if (slot.mag <= 0 && slot.reserve <= 0) {
      const other = p.weapons[p.slot === 'primary' ? 'secondary' : 'primary'];
      if (!other || (other.mag <= 0 && other.reserve <= 0)) return 1.2;
    }
    if (rw.cls === 'Shotgun') return 6;
    if (rw.cls === 'SMG') return 14;
    if (rw.cls === 'Marksman Rifle') return 40;
    if (rw.cls === 'LMG') return 26;
    return 22;
  }

  aimPointFor(target) {
    const h = target.state.height;
    // Aim centre mass, drifting up toward the head as skill rises.
    const y = target.state.pos.y + h * (0.62 + 0.28 * this.skill.accuracy);
    return { x: target.state.pos.x, y, z: target.state.pos.z };
  }

  canShoot() {
    const p = this.player;
    const t = this.target;
    if (!t || !t.alive) return false;
    const eye = eyePosition(p.state);
    const aim = this.aimPointFor(t);
    if (!hasLineOfSight(this.room.world, eye, aim)) return false;
    const d = vnorm(vsub(aim, eye));
    const a = anglesFromDir(d);
    const off = Math.abs(angleDelta(this.aimYaw, a.yaw)) + Math.abs(this.aimPitch - a.pitch);
    // The tolerance has to exceed the bot's own aim wobble, or a shaky bot
    // would wait for an alignment it can never reach and simply never fire.
    const tol = 0.05 + this.skill.error * (Math.PI / 180) * 1.8;
    return off < tol;
  }

  acquire(dt, live) {
    const p = this.player;
    const room = this.room;
    this.reactTimer = Math.max(0, this.reactTimer - dt);
    this.scanYaw += dt * 0.5;

    if (!live) { this.target = null; return; }

    const eye = eyePosition(p.state);
    let best = null, bestScore = -Infinity;

    for (const q of room.players.values()) {
      if (q === p || !q.alive) continue;
      if (room.mode.teams && q.team === p.team) continue;
      if (room.time < q.spawnProtectUntil) continue;
      const d = vdist(p.state.pos, q.state.pos);
      if (d > this.skill.range) continue;
      if (!hasLineOfSight(room.world, eye, eyePosition(q.state))) continue;

      // Prefer close, and prefer whoever is already in front of us.
      const toward = Math.abs(angleDelta(this.aimYaw, Math.atan2(-(q.state.pos.x - p.state.pos.x), -(q.state.pos.z - p.state.pos.z))));
      const score = 100 - d - toward * 12 + (q === this.target ? 25 : 0);
      if (score > bestScore) { bestScore = score; best = q; }
    }

    if (best) {
      if (best !== this.target) this.reactTimer = this.skill.reaction;
      this.target = best;
      this.targetSeenAt = room.time;
      this.lastKnown = { ...best.state.pos, y: best.state.pos.y + 1.2 };
    } else if (this.target && room.time - this.targetSeenAt > 2.5) {
      this.target = null;
      this.burstLeft = 0;
    }

    if (this.lastKnown && room.time - this.targetSeenAt > 6) this.lastKnown = null;
  }

  /** Where the bot wants its feet to be next. */
  moveTarget(dt) {
    const p = this.player;
    const room = this.room;
    this.goalTimer -= dt;

    if (this.target && this.target.alive) {
      // In a fight, close to a comfortable range using the direct line.
      return this.target.state.pos;
    }

    const exhausted = !this.path || this.pathIndex >= this.path.length;
    if (exhausted || this.goalTimer <= 0 || this.forceRepath) {
      this.forceRepath = false;
      this.goalTimer = 10 + Math.random() * 8;
      const from = nearestReachableNode(room.nav, room.world, p.state.pos);
      const goal = this.pickGoal();
      this.path = findPath(room.nav, from, goal);
      // Start at the anchor node rather than skipping to the second one: the
      // bot is rarely standing exactly on a waypoint, and the straight line to
      // path[1] may cut through a wall.
      this.pathIndex = 0;
      if (!this.path) { this.goalTimer = 1.5; return this.lastKnown || null; }
    }

    const node = room.nav.nodes[this.path[this.pathIndex]];
    if (!node) { this.path = null; return null; }
    const flat = Math.hypot(node.p.x - p.state.pos.x, node.p.z - p.state.pos.z);
    const vert = Math.abs(node.p.y - p.state.pos.y);
    if (flat < 1.7 && vert < PLAYER.standHeight) {
      this.pathIndex++;
      if (this.pathIndex >= this.path.length) { this.path = null; this.goalTimer = 0; }
    }
    return node.p;
  }

  /** Nudge away from squadmates so bots do not pile onto one another. */
  separation() {
    const p = this.player;
    let sx = 0, sz = 0, n = 0;
    for (const q of this.room.players.values()) {
      if (q === p || !q.alive) continue;
      if (this.room.mode.teams && q.team !== p.team) continue;
      const dx = p.state.pos.x - q.state.pos.x;
      const dz = p.state.pos.z - q.state.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.2 || d < 1e-3) continue;
      sx += dx / d; sz += dz / d; n++;
    }
    return n ? { x: sx / n, z: sz / n } : null;
  }

  pickGoal() {
    const room = this.room;
    const nodes = room.nav.nodes;
    if (!nodes.length) return -1;

    // Objectives first, then whichever part of the map has enemies in it.
    if (room.mode.capture) {
      const pts = room.objectiveState.points.filter((pt) => pt.owner !== this.player.team);
      const pick = pts.length ? pts[Math.floor(Math.random() * pts.length)]
        : room.objectiveState.points[Math.floor(Math.random() * room.objectiveState.points.length)];
      if (pick) return nearestNode(room.nav, { x: pick.p[0], y: pick.p[1], z: pick.p[2] });
    }
    if (room.mode.flags) {
      const enemyFlag = room.objectiveState.flags.find((f) => f.team !== this.player.team);
      const ownFlag = room.objectiveState.flags.find((f) => f.team === this.player.team);
      const f = this.player.hasFlag ? ownFlag : enemyFlag;
      if (f) return nearestNode(room.nav, { x: f.p[0], y: f.p[1], z: f.p[2] });
    }

    const enemies = [...room.players.values()].filter(
      (q) => q.alive && q !== this.player && (!room.mode.teams || q.team !== this.player.team)
    );
    if (enemies.length && Math.random() < 0.65) {
      const e = enemies[Math.floor(Math.random() * enemies.length)];
      return nearestNode(room.nav, e.state.pos);
    }
    return Math.floor(Math.random() * nodes.length);
  }
}
