// Bot opponents.
//
// Bots feed the same input structs as human clients into the same authoritative
// controller, so they collide, fall, and shoot under identical rules. Their AI
// is a small state machine — patrol, engage, reposition — over the map's
// navigation graph.

import { BTN, PLAYER } from '../constants.js';
import { hasLineOfSight } from '../collision.js';
import { eyePosition } from '../controller.js';
import { anglesFromDir, angleDelta, clamp, vdist, vsub, vnorm } from '../mathx.js';
import { PRIMARIES, SECONDARIES } from '../weapons.js';
import { BANNERS, DEFAULT_FANFARE, BUILTIN_FANFARES } from '../cosmetics.js';
import { findPath, nearestNode, nearestReachableNode } from './nav.js';

// Fanfare ids the bots can be given. The simulation cannot read the asset
// manifest itself, so whoever is hosting hands the real list over once it has
// loaded; until then bots fall back to the synthesised set.
let FANFARE_POOL = BUILTIN_FANFARES.map((f) => f.id);

export function setBotFanfarePool(ids) {
  if (Array.isArray(ids) && ids.length) FANFARE_POOL = [...ids];
}

export const BOT_NAMES = [
  'Kestrel', 'Vulcan', 'Marlow', 'Rooke', 'Ozdemir', 'Bellamy', 'Halden', 'Sable',
  'Cruz', 'Novak', 'Reyes', 'Ferris', 'Iwata', 'Okonkwo', 'Lindqvist', 'Marsh',
  'Duval', 'Petrov', 'Achebe', 'Quill',
];

// Bot skill.
//
// The thing that makes a bot feel like an aimbot is not how small its error
// is, it is that the error is *fresh every tick*. Jitter resampled at 120 Hz
// averages out to the centre of your chest over a burst, so a bot with a
// three-degree wobble still kills you in three rounds. Three things fix that,
// and all three are modelled here:
//
//   `bias`    a miss picked once per burst and held for the whole burst, so
//             whole bursts go wide the way a real player's do
//   `lag`     the bot aims at where you were, not where you are, so strafing
//             and repeaking actually beat it
//   `error`   the residual per-shot wobble on top
//
// `settle` is how long aim keeps tightening after acquiring, so a bot that
// has just spotted you is not instantly on target.
const DIFFICULTIES = [
  { name: 'Recruit', turn: 1.5, error: 6.5, bias: 9.0, lag: 0.38, drift: 3.4, reaction: 1.15, burst: [2, 3], rest: [0.70, 1.40], range: 30, accuracy: 0.22, settle: 2.4 },
  { name: 'Regular', turn: 2.0, error: 5.2, bias: 7.0, lag: 0.30, drift: 2.6, reaction: 0.95, burst: [2, 4], rest: [0.55, 1.15], range: 38, accuracy: 0.32, settle: 2.0 },
  { name: 'Veteran', turn: 2.7, error: 4.0, bias: 5.0, lag: 0.22, drift: 1.9, reaction: 0.74, burst: [3, 5], rest: [0.45, 0.95], range: 48, accuracy: 0.44, settle: 1.6 },
  { name: 'Elite',   turn: 3.4, error: 3.0, bias: 3.4, lag: 0.16, drift: 1.4, reaction: 0.58, burst: [3, 6], rest: [0.35, 0.78], range: 58, accuracy: 0.55, settle: 1.2 },
];

// Which tiers turn up, and how often. Weighted towards the bottom: a lobby
// where every bot is Elite is not a hard game, it is an unfair one.
const TIER_WEIGHTS = [0.42, 0.34, 0.18, 0.06];

function pickTier() {
  let r = Math.random();
  for (let i = 0; i < TIER_WEIGHTS.length; i++) {
    r -= TIER_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return 0;
}

export class Bot {
  constructor(room, name) {
    this.room = room;
    this.name = name;
    this.player = null;

    this.skill = DIFFICULTIES[pickTier()];
    this.level = 8 + Math.floor(Math.random() * 70);
    this.banner = BANNERS[Math.floor(Math.random() * BANNERS.length)].id;
    this.fanfare = FANFARE_POOL[Math.floor(Math.random() * FANFARE_POOL.length)] || DEFAULT_FANFARE;

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
    this.targetAcquiredAt = -99;
    this.driftT = Math.random() * 10;
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
    this.trail = [];        // where the target has been, for aim lag
    this.biasYaw = 0;       // this burst's miss, held until the burst ends
    this.biasPitch = 0;
    this.kickYaw = 0;       // accumulated muzzle climb
    this.kickPitch = 0;
  }

  /** A fresh miss for the burst about to be fired. */
  rerollBias() {
    const b = this.skill.bias * (Math.PI / 180);
    // Gaussian-ish: most bursts are close, some are badly off.
    const g = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    this.biasYaw = g() * b;
    this.biasPitch = g() * b * 0.6;
  }

  /**
   * Where the bot believes the target is: its position `lag` seconds ago.
   * Aiming at the live position is the single biggest reason bots feel
   * inhuman — nothing you do in the moment can make them miss.
   */
  laggedPosition(target, now) {
    const want = now - this.skill.lag;
    const trail = this.trail;
    if (!trail.length) return target.state.pos;
    for (let i = trail.length - 1; i >= 0; i--) {
      if (trail[i].t <= want) {
        const b = trail[Math.min(i + 1, trail.length - 1)];
        const a = trail[i];
        const span = b.t - a.t;
        const f = span > 1e-4 ? Math.min(1, (want - a.t) / span) : 0;
        return { x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f, z: a.p.z + (b.p.z - a.p.z) * f };
      }
    }
    return trail[0].p;
  }

  recordTrail(target, now) {
    if (!target) { this.trail.length = 0; return; }
    const last = this.trail[this.trail.length - 1];
    if (!last || now - last.t > 0.03) {
      this.trail.push({ t: now, p: { ...target.state.pos } });
      while (this.trail.length > 2 && this.trail[0].t < now - 0.6) this.trail.shift();
    }
  }

  /** Sight is blocked by walls and by smoke alike. */
  canSee(from, to) {
    if (!hasLineOfSight(this.room.world, from, to)) return false;
    if (this.room.smokeBlocks && this.room.smokeBlocks(from, to)) return false;
    return true;
  }

  onFlashed(duration) {
    this.blindUntil = this.room.time + duration;
  }

  get blinded() {
    return this.room.time < (this.blindUntil || 0);
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

    this.recordTrail(this.target, room.time);

    if (this.target && this.target.alive) {
      const aimPoint = this.aimPointFor(this.target);
      const d = vnorm(vsub(aimPoint, eye));
      const a = anglesFromDir(d);

      // Aim converges over `settle` seconds rather than being instantly
      // correct, and never fully converges — there is always residual wobble
      // plus a slow drift the bot has to chase.
      const held = Math.max(0, room.time - this.targetAcquiredAt);
      // Aim tightens while they hold you, but only so far — it tops out at
      // 70% of the starting wobble, so there is no point at which a bot has
      // simply solved the shot.
      const converge = Math.min(1, held / this.skill.settle);
      const wobble = this.skill.error * (1 - converge * 0.3) * (Math.PI / 180);

      this.driftT = (this.driftT || 0) + dt;
      const drift = this.skill.drift * (Math.PI / 180);
      const dy = Math.sin(this.driftT * 0.7 + this.seedOffset()) * drift
               + Math.sin(this.driftT * 2.9 + this.seedOffset() * 2) * drift * 0.4;
      const dp = Math.cos(this.driftT * 0.9 + this.seedOffset()) * drift * 0.7;

      desiredYaw = a.yaw + this.biasYaw + dy + Math.sin(room.time * 3.1 + this.seedOffset()) * wobble;
      desiredPitch = a.pitch + this.biasPitch + dp + Math.cos(room.time * 2.3 + this.seedOffset()) * wobble * 0.6;
    } else if (this.lastKnown && room.time - this.targetSeenAt < 1.6) {
      // Only stare at where they went for a moment. Holding the angle for six
      // seconds while walking somewhere else is what makes bots moonwalk.
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

        // Out of a fight, walk facing where you are going. Bots that hold an
        // angle while their feet carry them somewhere else moonwalk across
        // the map, and the movement keys they end up pressing are BACK and
        // strafe, which is exactly what that looks like.
        if (!engaging && dist > 1.2) {
          const travelYaw = Math.atan2(-dx, -dz);
          if (Math.abs(angleDelta(this.aimYaw, travelYaw)) > 0.7) {
            const t2 = this.skill.turn * dt * 1.2;
            this.aimYaw += clamp(angleDelta(this.aimYaw, travelYaw), -t2, t2);
          }
        }

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
        // Strafe in long, committed steps. Flipping every half second reads as
        // a stutter rather than as movement.
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          this.strafeTimer = 1.4 + Math.random() * 1.6;
          this.strafeDir = -this.strafeDir;
        }
        btn &= ~(BTN.LEFT | BTN.RIGHT);
        btn |= this.strafeDir > 0 ? BTN.RIGHT : BTN.LEFT;
        btn &= ~BTN.SPRINT;

        // Hysteresis on the range band: without a dead zone the bot flips
        // between forward and back every tick and vibrates on the spot.
        const dist = vdist(p.state.pos, this.target.state.pos);
        const want = this.preferredRange();
        if (this.approach === undefined) this.approach = 0;
        if (dist > want + 7) this.approach = 1;
        else if (dist < want - 6) this.approach = -1;
        else if (Math.abs(dist - want) < 3) this.approach = 0;
        btn &= ~(BTN.FORWARD | BTN.BACK);
        if (this.approach > 0) btn |= BTN.FORWARD;
        else if (this.approach < 0) btn |= BTN.BACK;
        // Aiming down sights costs mobility but collapses the cone of fire —
        // hip-firing while strafing, bots simply never hit anything.
        if (dist > 9) btn |= BTN.ADS;
        if (Math.random() < 0.004) btn |= BTN.CROUCH;

        // Occasionally use a throwable at a sensible range.
        if (room.time >= p.grenadeCooldown && dist > 8 && dist < 28 && Math.random() < 0.006) {
          const have = ['frag', 'flash', 'smoke'].filter((k) => p.grenades[k]);
          if (have.length) room.throwGrenade(p, have[Math.floor(Math.random() * have.length)], 1);
        }
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
      // Slow drift counts as stuck too. The per-tick check above catches a
      // bot pressed against a wall; this catches one shuffling on the spot
      // behind cover, which is what leaves a round unfinished.
      this.driftFrom = this.driftFrom || { ...p.state.pos };
      this.driftTimer = (this.driftTimer || 0) + dt;
      if (this.driftTimer > 5) {
        if (vdist(p.state.pos, this.driftFrom) < 3) {
          this.forceRepath = true;
          this.goalTimer = 0;
          this.path = null;
        }
        this.driftFrom = { ...p.state.pos };
        this.driftTimer = 0;
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
          const prev = this.triggerPhase || 0;
          this.triggerPhase = prev + dt;
          const period = Math.max(interval, 0.22) * 2;
          const phase = this.triggerPhase % period;
          // Every pull is its own "burst", so every pull gets its own miss.
          // Without this, marksman rifles and pistols had no bias at all and
          // were the deadliest things on the map.
          if (phase < prev % period) this.rerollBias();
          if (phase < period * 0.5) btn |= BTN.FIRE;
        } else {
          this.burstRest -= dt;
          if (this.burstLeft <= 0 && this.burstRest <= 0) {
            const [lo, hi] = this.skill.burst;
            const shots = lo + Math.floor(Math.random() * (hi - lo + 1));
            this.burstLeft = shots * interval;
            // A new burst gets a new miss. Rerolling per shot would average
            // out to a hit; held for the burst, whole bursts go wide.
            this.rerollBias();
          }
          if (this.burstLeft > 0) {
            btn |= BTN.FIRE;
            this.burstLeft -= dt;
            if (this.burstLeft <= 0) {
              const [rlo, rhi] = this.skill.rest;
              this.burstRest = rlo + Math.random() * (rhi - rlo);
            }
          }
        }
      }
    } else {
      const slot = p.weapons[p.slot];
      if (slot && slot.mag < slot.rw.mag * 0.35 && slot.reserve > 0 && !this.target) {
        room.startReload(p);
      }
    }

    // ---- Recoil ----------------------------------------------------------
    // Nothing else here made bots feel like machines as much as this did:
    // holding the trigger cost them nothing, so the tenth round of a burst
    // was as accurate as the first. Now the muzzle climbs while they fire and
    // settles when they stop, and long bursts walk off target the way yours
    // do. `control` is how much of it the tier fights down.
    const firing = !!(btn & BTN.FIRE);
    if (firing) {
      const slot = p.weapons[p.slot];
      const per = Math.max(0.05, slot?.rw?.shotInterval ?? 0.1);
      const control = 0.42 + this.skill.accuracy * 0.5;
      const kick = (dt / per) * (1 - control) * (Math.PI / 180);
      this.kickPitch += kick * 2.6;
      this.kickYaw += (Math.random() - 0.5) * kick * 2.2;
    }
    const settle = Math.exp(-dt * (firing ? 1.1 : 8));
    this.kickPitch *= settle;
    this.kickYaw *= settle;

    p.cmd = {
      seq: (p.cmd?.seq || 0) + 1,
      btn,
      yaw: this.aimYaw + this.kickYaw,
      pitch: clamp(this.aimPitch + this.kickPitch, -1.3, 1.3),
    };
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

  /**
   * Where the bot aims: centre mass on the target's position a fraction of a
   * second ago. Aiming at the live position means no amount of strafing ever
   * makes it miss, which is what reads as an aimbot.
   */
  aimPointFor(target) {
    const h = target.state.height;
    const p = this.laggedPosition(target, this.room.time);
    // Only creeping upward a little at high skill. Bots that aim at the head
    // land constant one-shot kills.
    return { x: p.x, y: p.y + h * (0.52 + 0.14 * this.skill.accuracy), z: p.z };
  }

  /** Where the target actually is, for visibility tests. */
  truePointFor(target) {
    const h = target.state.height;
    return { x: target.state.pos.x, y: target.state.pos.y + h * 0.55, z: target.state.pos.z };
  }

  /**
   * How much of the target the bot can actually see, 0..1, sampled at chest,
   * head and both shoulders.
   *
   * A single ray to centre mass is far too generous: it threads railings, the
   * gap under a balustrade and the corner of a doorway, so the bot opens up
   * on a sliver of shoulder it should never have noticed — and from the other
   * end that looks exactly like being shot through a wall.
   */
  exposure(from, target) {
    const s = target.state;
    const h = s.height;
    // Shoulder offsets perpendicular to the line, so the samples straddle the
    // body rather than lining up behind one another.
    const dx = s.pos.x - from.x, dz = s.pos.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len * 0.22, pz = dx / len * 0.22;

    const points = [
      { x: s.pos.x, y: s.pos.y + h * 0.55, z: s.pos.z },
      { x: s.pos.x, y: s.pos.y + h * 0.88, z: s.pos.z },
      { x: s.pos.x + px, y: s.pos.y + h * 0.72, z: s.pos.z + pz },
      { x: s.pos.x - px, y: s.pos.y + h * 0.72, z: s.pos.z - pz },
    ];
    let seen = 0;
    for (const q of points) if (this.canSee(from, q)) seen++;
    return seen / points.length;
  }

  canShoot() {
    const p = this.player;
    const t = this.target;
    if (!t || !t.alive) return false;
    if (this.blinded) return false;
    const eye = eyePosition(p.state);

    // Half the target has to be showing. Anything less and it is a sliver
    // through cover that a person would not have taken the shot on.
    if (this.exposure(eye, t) < 0.5) return false;

    // And the muzzle needs its own clearance — an eye above a wall with the
    // barrel still behind it puts every round into the wall.
    const muzzle = { x: eye.x, y: eye.y - 0.22, z: eye.z };
    if (!this.canSee(muzzle, this.truePointFor(t))) return false;

    const aim = this.aimPointFor(t);
    const d = vnorm(vsub(aim, eye));
    const a = anglesFromDir(d);
    const off = Math.abs(angleDelta(this.aimYaw, a.yaw)) + Math.abs(this.aimPitch - a.pitch);
    // The tolerance has to exceed the bot's own aim wobble or a shaky bot
    // waits for an alignment it can never reach and never fires. It must not
    // scale *with* the wobble either, though: that hands the sloppiest bots
    // the widest licence to pull the trigger, which is backwards.
    const tol = (4.0 + this.skill.error * 0.6) * (Math.PI / 180);
    return off < tol;
  }

  acquire(dt, live) {
    const p = this.player;
    const room = this.room;
    this.reactTimer = Math.max(0, this.reactTimer - dt);
    this.scanYaw += dt * 0.5;

    if (!live) { this.target = null; return; }
    // Flashed bots lose track of everything, same as a player would.
    if (this.blinded) { this.target = null; this.lastKnown = null; return; }

    const eye = eyePosition(p.state);
    let best = null, bestScore = -Infinity;

    for (const q of room.players.values()) {
      if (q === p || !q.alive) continue;
      if (room.mode.teams && q.team === p.team) continue;
      if (room.time < q.spawnProtectUntil) continue;
      const d = vdist(p.state.pos, q.state.pos);
      if (d > this.skill.range) continue;
      // Noticing someone is easier than shooting at them: a shoulder round a
      // corner is enough to look. Half a body is still required to fire.
      if (this.exposure(eye, q) < 0.25) continue;

      // Prefer close, and prefer whoever is already in front of us.
      const toward = Math.abs(angleDelta(this.aimYaw, Math.atan2(-(q.state.pos.x - p.state.pos.x), -(q.state.pos.z - p.state.pos.z))));
      const score = 100 - d - toward * 12 + (q === this.target ? 25 : 0);
      if (score > bestScore) { bestScore = score; best = q; }
    }

    if (best) {
      if (best !== this.target) {
        this.reactTimer = this.skill.reaction;
        this.targetAcquiredAt = room.time + this.skill.reaction;
      }
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
      // A long lease on a goal is fine while patrolling and useless while
      // hunting — the target has moved by the time you arrive.
      const push = this.urgency();
      this.goalTimer = (10 + Math.random() * 8) * (1 - push * 0.7);
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

  /**
   * How badly this bot needs to find someone. Climbs as the round clock runs
   * down and as the map empties. Without it the last survivors patrol two
   * different wings and the round only ends when the timer does.
   */
  urgency() {
    const room = this.room;
    const total = room.mode.roundTime || 150;
    const left = Math.max(0, room.phaseEnds - room.time);
    const byClock = 1 - Math.min(1, left / (total * 0.55));
    const standing = room.aliveCount(0) + room.aliveCount(1);
    const byCount = standing <= 3 ? 1 : (standing <= 5 ? 0.6 : 0);
    return Math.max(byClock, byCount);
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
    // Under pressure, head for the closest one rather than a random one, and
    // never wander off to an arbitrary corner of the map.
    const push = this.urgency();
    if (enemies.length && Math.random() < 0.55 + push * 0.45) {
      let pick = enemies[Math.floor(Math.random() * enemies.length)];
      if (push > 0.5) {
        let best = Infinity;
        for (const e of enemies) {
          const d = vdist(this.player.state.pos, e.state.pos);
          if (d < best) { best = d; pick = e; }
        }
      }
      return nearestNode(room.nav, pick.state.pos);
    }
    if (push > 0.5 && enemies.length) return nearestNode(room.nav, enemies[0].state.pos);
    return Math.floor(Math.random() * nodes.length);
  }
}
