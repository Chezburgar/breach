// The player you control.
//
// Runs the same shared controller the server runs, one fixed step per input,
// and replays unacknowledged inputs whenever an authoritative state arrives.
// Corrections are absorbed into a decaying visual offset so reconciliation is
// felt as weight rather than as teleporting.

import * as THREE from 'three';
import { BTN, FIXED_DT, MOVE, PLAYER, VIEW } from '/shared/constants.js';
import { createPlayerState, stepPlayer, eyePosition, applyState } from '/shared/controller.js';
import { raycastWorld } from '/shared/collision.js';
import { currentSpread, recoilAt, resolveWeapon } from '/shared/weapons.js';
import { clamp, damp, dirFromAngles, hashString, makeRng } from '/shared/mathx.js';

const DEG = Math.PI / 180;
const BURST_RESET = 0.32;

export class LocalPlayer {
  constructor(world, settings) {
    this.world = world;
    this.settings = settings;
    this.state = createPlayerState({ p: [0, 3, 0], yaw: 0 });

    this.yaw = 0;
    this.pitch = 0;
    this.seq = 0;
    this.history = [];
    this.accumulator = 0;
    this.pendingInputs = [];

    this.correction = new THREE.Vector3();
    this.lookDelta = new THREE.Vector2();

    this.recoilOwed = { x: 0, y: 0 };
    this.shotIndex = 0;
    this.lastFireTime = -99;
    this.bloom = 0;

    this.alive = false;
    this.health = 100;
    this.slot = 'primary';
    this.weapons = { primary: null, secondary: null };
    this.ads = false;
    this.adsBlend = 0;
    this.reloadUntil = 0;
    this.switchUntil = 0;
    this.burstLeft = 0;

    this.fov = settings.fov ?? VIEW.baseFov;
    this.currentFov = this.fov;
    this.landDip = 0;
    this.stepAccum = 0;
    this.time = 0;
    this.viewBob = new THREE.Vector2();
    this.bobPhase = 0;

    this.events = [];
  }

  setLoadout(loadout) {
    this.loadout = loadout;
    this.weapons.primary = {
      cfg: loadout.primary,
      rw: resolveWeapon(loadout.primary),
      mag: loadout.primary.mag ?? resolveWeapon(loadout.primary).mag,
      reserve: loadout.primary.reserve ?? resolveWeapon(loadout.primary).reserve,
    };
    this.weapons.secondary = {
      cfg: loadout.secondary,
      rw: resolveWeapon(loadout.secondary),
      mag: loadout.secondary.mag ?? resolveWeapon(loadout.secondary).mag,
      reserve: loadout.secondary.reserve ?? resolveWeapon(loadout.secondary).reserve,
    };
    this.slot = 'primary';
  }

  get weapon() { return this.weapons[this.slot]; }
  get rw() { return this.weapon?.rw; }

  spawn(pos, yaw) {
    this.state = createPlayerState({ p: [pos[0], pos[1], pos[2]], yaw });
    this.yaw = yaw;
    this.pitch = 0;
    this.alive = true;
    this.health = PLAYER.maxHealth;
    this.correction.set(0, 0, 0);
    this.history.length = 0;
    this.recoilOwed.x = this.recoilOwed.y = 0;
    this.shotIndex = 0;
    this.bloom = 0;
    this.reloadUntil = 0;
    this.burstLeft = 0;
  }

  // -------------------------------------------------------------- looking
  applyLook(delta, adsBlend) {
    // Aiming slows the turn rate, more so the higher the magnification.
    const mag = this.rw?.scope.mag ?? 1;
    const adsScale = 1 - adsBlend * (1 - 1 / Math.max(1, 1 + (mag - 1) * 0.55));
    const dx = delta.x * adsScale;
    const dy = delta.y * adsScale;

    this.yaw -= dx;
    this.pitch -= dy;

    // Pulling against the recoil consumes what the gun owes back, so the view
    // does not spring downward after the player has already compensated.
    if (dy > 0) this.recoilOwed.y = Math.max(0, this.recoilOwed.y - dy);
    if (dx !== 0) {
      const sign = Math.sign(this.recoilOwed.x);
      if (sign !== 0 && Math.sign(dx) === sign) {
        this.recoilOwed.x = sign * Math.max(0, Math.abs(this.recoilOwed.x) - Math.abs(dx));
      }
    }

    this.pitch = clamp(this.pitch, -VIEW.maxPitch, VIEW.maxPitch);
    this.lookDelta.set(dx, dy);
  }

  recoverRecoil(dt) {
    const rw = this.rw;
    if (!rw) return;
    const firing = this.time - this.lastFireTime < 0.12;
    if (firing) return;
    const k = 1 - Math.exp(-rw.recoil.recovery * dt);
    const bx = this.recoilOwed.x * k;
    const by = this.recoilOwed.y * k;
    this.yaw += bx;              // owed X was applied as -=, so give it back
    this.pitch -= by;
    this.recoilOwed.x -= bx;
    this.recoilOwed.y -= by;
  }

  // --------------------------------------------------------------- firing
  canFire() {
    if (!this.alive) return false;
    const w = this.weapon;
    if (!w || w.mag <= 0) return false;
    if (this.time < this.reloadUntil || this.time < this.switchUntil) return false;
    return this.time - this.lastFireTime >= w.rw.shotInterval - 0.002;
  }

  /** Predict one shot locally: effects, recoil, ammo. The server rules on hits. */
  predictShot() {
    const w = this.weapon;
    const rw = w.rw;

    if (this.time - this.lastFireTime > BURST_RESET) this.shotIndex = 0;
    this.lastFireTime = this.time;
    w.mag = Math.max(0, w.mag - 1);

    const kick = recoilAt(rw, this.shotIndex);
    this.pitch += kick.y * DEG;
    this.yaw -= kick.x * DEG;
    this.recoilOwed.y += kick.y * DEG * 0.82;
    this.recoilOwed.x -= kick.x * DEG * 0.6;
    this.pitch = clamp(this.pitch, -VIEW.maxPitch, VIEW.maxPitch);

    this.bloom = Math.min(rw.spread.max, this.bloom + rw.spread.growth);

    const eye = eyePosition(this.state);
    const dir = dirFromAngles(this.yaw, this.pitch);
    const spread = this.currentSpreadDeg();
    const cone = rw.spread.pelletCone || spread;

    const shots = [];
    for (let i = 0; i < rw.pellets; i++) {
      const d = this.sampleSpread(dir, rw.pellets > 1 ? cone : spread, this.shotIndex, i);
      const hit = raycastWorld(this.world, eye, d, 260, { sightOnly: true });
      shots.push({
        dir: d,
        end: hit ? hit.point : { x: eye.x + d.x * 260, y: eye.y + d.y * 260, z: eye.z + d.z * 260 },
        hit,
      });
    }

    this.shotIndex++;
    this.events.push({ type: 'shot', eye, shots, weapon: rw });
    return shots;
  }

  /** Matches the server's deterministic cone sampling. */
  sampleSpread(base, spreadDeg, shotIndex, pellet) {
    if (spreadDeg <= 1e-4) return base;
    const rng = makeRng((hashString(this.id || 'local') ^ (shotIndex * 2654435761) ^ (pellet * 40503)) >>> 0);
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * (spreadDeg * DEG);

    const up = Math.abs(base.y) > 0.95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const rx = base.y * up.z - base.z * up.y;
    const ry = base.z * up.x - base.x * up.z;
    const rz = base.x * up.y - base.y * up.x;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const ux = rx / rl, uy = ry / rl, uz = rz / rl;
    const vx = uy * base.z - uz * base.y;
    const vy = uz * base.x - ux * base.z;
    const vz = ux * base.y - uy * base.x;

    const s = Math.sin(rad), c = Math.cos(rad);
    const ox = (ux * Math.cos(ang) + vx * Math.sin(ang)) * s;
    const oy = (uy * Math.cos(ang) + vy * Math.sin(ang)) * s;
    const oz = (uz * Math.cos(ang) + vz * Math.sin(ang)) * s;
    const dx = base.x * c + ox, dy = base.y * c + oy, dz = base.z * c + oz;
    const l = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / l, y: dy / l, z: dz / l };
  }

  currentSpreadDeg() {
    const rw = this.rw;
    if (!rw) return 2;
    return currentSpread(rw, {
      ads: this.adsBlend > 0.7,
      speed: this.state.speed,
      onGround: this.state.onGround,
      crouching: this.state.crouching,
      bloom: this.bloom,
    });
  }

  startReload() {
    const w = this.weapon;
    if (!w || this.time < this.reloadUntil) return null;
    if (w.mag >= w.rw.mag || w.reserve <= 0) return null;
    const empty = w.mag === 0;
    const duration = empty ? w.rw.reloadEmpty : w.rw.reload;
    this.reloadUntil = this.time + duration;
    this.pendingReload = { slot: this.slot, empty };
    this.events.push({ type: 'reload', duration, empty });
    return { duration, empty };
  }

  /**
   * Complete a reload with no authority to do it for us. Online the server owns
   * the magazine and its count arrives in the next snapshot; offline — the
   * training ground — nothing would ever refill it.
   */
  finishReloadLocal() {
    const info = this.pendingReload;
    this.pendingReload = null;
    if (!info) return;
    const w = this.weapons[info.slot];
    if (!w) return;
    const take = Math.min(w.rw.mag - w.mag, w.reserve);
    w.mag += take;
    w.reserve -= take;
  }

  switchSlot(slot) {
    if (slot === this.slot || this.time < this.switchUntil) return false;
    if (!this.weapons[slot]) return false;
    this.slot = slot;
    this.switchUntil = this.time + 0.45;
    this.reloadUntil = 0;
    this.burstLeft = 0;
    this.shotIndex = 0;
    this.events.push({ type: 'swap', slot });
    return true;
  }

  // -------------------------------------------------------------- stepping
  /**
   * Advance simulation. Produces zero or more fixed input commands, each of
   * which is predicted immediately and queued for the server.
   */
  step(dt, buttons, opts = {}) {
    this.time += dt;
    this.accumulator += dt;
    const out = [];
    let guard = 0;

    while (this.accumulator >= FIXED_DT && guard++ < 5) {
      this.accumulator -= FIXED_DT;

      let btn = buttons;
      if (!this.alive || opts.frozen) btn = 0;

      // Fire is only asserted on ticks where the weapon is actually ready, so
      // prediction and the server agree on which tick a shot belongs to.
      let firing = false;
      if ((btn & BTN.FIRE) && !opts.frozen && this.alive) {
        const mode = this.rw?.def.fireModes[0];
        let want = true;
        if (mode === 'semi' || mode === 'pump') want = !this.prevFireHeld;
        else if (mode === 'burst') {
          if (!this.prevFireHeld && this.burstLeft <= 0) this.burstLeft = this.rw.def.burstCount || 3;
          want = this.burstLeft > 0;
        }
        if (want && this.canFire()) {
          firing = true;
          if (mode === 'burst') this.burstLeft--;
        }
      } else {
        this.burstLeft = 0;
      }
      this.prevFireHeld = !!(btn & BTN.FIRE);

      if (!firing) btn &= ~BTN.FIRE;
      else btn |= BTN.FIRE;

      const cmd = { seq: ++this.seq, btn, yaw: this.yaw, pitch: this.pitch };
      stepPlayer(this.state, cmd, this.world, FIXED_DT);
      if (firing) this.predictShot();

      this.history.push(cmd);
      if (this.history.length > 200) this.history.shift();
      out.push(cmd);

      // Landing dip and footsteps come out of the simulation, not a timer.
      if (this.state.landImpact > 3) {
        this.landDip = Math.min(1, this.state.landImpact / 14);
        this.events.push({ type: 'land', force: this.state.landImpact });
      }
      if (this.state.stepDist - this.stepAccum > (this.state.sprinting ? 2.4 : 1.9)) {
        this.stepAccum = this.state.stepDist;
        this.events.push({ type: 'footstep', surface: this.surfaceUnder(), running: this.state.sprinting });
      }
    }

    if (this.offline && this.pendingReload && this.time >= this.reloadUntil) {
      this.finishReloadLocal();
    }

    // Continuous, frame-rate dependent bits.
    this.bloom = Math.max(0, this.bloom - (this.rw?.spread.decay ?? 5) * dt);
    this.landDip = damp(this.landDip, 0, 9, dt);
    this.recoverRecoil(dt);
    this.correction.multiplyScalar(Math.pow(0.002, dt));

    const speedRatio = clamp(this.state.speed / MOVE.sprintSpeed, 0, 1);
    if (this.state.onGround) this.bobPhase += dt * (5.5 + speedRatio * 8);
    const bobAmt = speedRatio * (1 - this.adsBlend * 0.85);
    this.viewBob.set(
      Math.cos(this.bobPhase) * 0.009 * bobAmt,
      Math.abs(Math.sin(this.bobPhase)) * 0.012 * bobAmt
    );

    return out;
  }

  surfaceUnder() {
    const from = { x: this.state.pos.x, y: this.state.pos.y + 0.4, z: this.state.pos.z };
    const hit = raycastWorld(this.world, from, { x: 0, y: -1, z: 0 }, 1.2);
    return hit?.box.mat || 'concrete';
  }

  // -------------------------------------------------------- reconciliation
  /** Apply an authoritative state and replay everything the server has not seen. */
  reconcile(you, ack) {
    if (!you?.s) return;
    const before = { x: this.state.pos.x, y: this.state.pos.y, z: this.state.pos.z };

    applyState(this.state, you.s);

    // Drop acknowledged inputs, replay the rest.
    let i = 0;
    while (i < this.history.length && this.history[i].seq <= ack) i++;
    this.history.splice(0, i);
    for (const cmd of this.history) {
      stepPlayer(this.state, cmd, this.world, FIXED_DT);
    }

    // Fold the residual into a decaying visual offset instead of snapping.
    const dx = before.x - this.state.pos.x;
    const dy = before.y - this.state.pos.y;
    const dz = before.z - this.state.pos.z;
    const err = Math.hypot(dx, dy, dz);
    if (err > 4) {
      this.correction.set(0, 0, 0);          // a real teleport: take it straight
    } else if (err > 0.001) {
      this.correction.set(dx, dy, dz);
    }
  }

  /** Server-authoritative status that prediction must not override. */
  applyStatus(you) {
    this.alive = you.alive;
    this.health = you.hp;
    if (you.slot && you.slot !== this.slot && this.time >= this.switchUntil) this.slot = you.slot;
    const w = this.weapons[you.slot] || this.weapon;
    if (w) {
      // Only trust the server when it disagrees by more than a shot in flight.
      if (Math.abs(w.mag - you.mag) > 1 || you.mag > w.mag) w.mag = you.mag;
      w.reserve = you.reserve;
    }
    if (you.reloading > 0) this.reloadUntil = Math.max(this.reloadUntil, this.time + you.reloading);
  }

  // ---------------------------------------------------------------- camera
  updateCamera(camera, vmCamera, dt, scope) {
    const eye = eyePosition(this.state);
    const right = { x: Math.cos(this.yaw), y: 0, z: -Math.sin(this.yaw) };

    // Leaning slides the camera sideways, which will happily push it through a
    // wall and let you see into the next room. Sweep the offset and stop short
    // of anything solid, then roll by however much lean actually survived.
    const wanted = this.state.lean * MOVE.leanOffset;
    let offset = wanted;
    if (Math.abs(wanted) > 1e-3) {
      const s = Math.sign(wanted);
      const dir = { x: right.x * s, y: 0, z: right.z * s };
      const clearance = PLAYER.radius * 0.6;
      const hit = raycastWorld(this.world, eye, dir, Math.abs(wanted) + clearance);
      if (hit) offset = s * Math.max(0, hit.t - clearance);
    }
    const leanFrac = MOVE.leanOffset > 1e-6 ? offset / MOVE.leanOffset : 0;

    // Step smoothing. The controller lifts the body onto a stair riser in a
    // single tick — correct for collision, but carried straight to the eye it
    // is a 20 cm jolt, five times a second, all the way up a flight. Hold the
    // camera back by however much the body just jumped and let it catch up.
    // Only genuine steps qualify: anything taller than the controller's own
    // step height is a fall or a launch and should be felt.
    const bodyY = this.state.pos.y;
    if (this._stepPrevY !== undefined) {
      const dy = bodyY - this._stepPrevY;
      if (this.state.onGround && Math.abs(dy) > 0.008 && Math.abs(dy) <= PLAYER.stepHeight + 0.02) {
        this.stepLag = clamp((this.stepLag || 0) + dy, -PLAYER.stepHeight, PLAYER.stepHeight);
      }
    }
    this._stepPrevY = bodyY;
    this.stepLag = damp(this.stepLag || 0, 0, 15, dt);

    camera.position.set(
      eye.x + this.correction.x + right.x * offset + this.viewBob.x,
      eye.y + this.correction.y - this.stepLag - this.landDip * 0.16 + this.viewBob.y,
      eye.z + this.correction.z + right.z * offset
    );

    camera.rotation.order = 'YXZ';
    camera.rotation.set(this.pitch, this.yaw, -leanFrac * MOVE.leanAngle);
    this.effectiveLean = leanFrac;

    // Field of view: sprint widens, aiming narrows to the optic's true zoom.
    const base = this.fov;
    const sprintAdd = this.state.sprinting ? VIEW.sprintFovAdd : 0;
    const target = this.adsBlend > 0.01 && scope
      ? THREE.MathUtils.lerp(base + sprintAdd, scope.adsFov(base), this.adsBlend)
      : base + sprintAdd;
    this.currentFov = damp(this.currentFov, target, 16, dt);
    if (Math.abs(camera.fov - this.currentFov) > 0.01) {
      camera.fov = this.currentFov;
      camera.updateProjectionMatrix();
    }

    vmCamera.position.copy(camera.position);
    vmCamera.quaternion.copy(camera.quaternion);
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}
