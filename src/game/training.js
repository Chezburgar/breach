// Training Ground: live range, pop-up steel, movers, a shoot house and weapon
// pickups. Runs entirely offline — no server, no other players.

import * as THREE from 'three';
import { propParts } from '../engine/props.js';
import { getWeapon, resolveWeapon } from '../../shared/weapons.js';
import { clamp, dirFromAngles } from '../../shared/mathx.js';
import { raycastWorld } from '../../shared/collision.js';
import { eyePosition } from '../../shared/controller.js';
import { GRENADE_GRAVITY, getGrenade, fragDamage } from '../../shared/grenades.js';

function buildPropMesh(prop, lab, seed) {
  const group = new THREE.Group();
  const parts = propParts(prop, seed);
  if (!parts) return group;
  for (const part of parts) {
    let geo;
    if (part.k === 'cyl') geo = new THREE.CylinderGeometry(part.s[0], part.s[1], part.s[2], 12);
    else if (part.k === 'cone') geo = new THREE.ConeGeometry(part.s[0], part.s[1], 10);
    else if (part.k === 'sph') geo = new THREE.SphereGeometry(part.s, 10, 7);
    else geo = new THREE.BoxGeometry(part.s[0], part.s[1], part.s[2]);
    const mesh = new THREE.Mesh(geo, lab.material(part.m));
    mesh.position.set(part.p[0], part.p[1], part.p[2]);
    if (part.r) mesh.rotation.set(part.r[0] || 0, part.r[1] || 0, part.r[2] || 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

class Target {
  constructor(def, mesh) {
    this.def = def;
    this.mesh = mesh;
    this.kind = def.kind || 'static';
    this.friendly = !!def.friendly;
    this.home = new THREE.Vector3(def.p[0], def.p[1], def.p[2]);
    this.down = false;
    this.downFor = 0;
    this.railT = def.phase || 0;
    this.height = def.height || 1.8;
    this.box = new THREE.Box3();
    this.updateBox();
  }

  updateBox() {
    const p = this.mesh.position;
    // The scoring face, not the whole prop.
    this.box.min.set(p.x - 0.34, p.y + this.height * 0.44, p.z - 0.09);
    this.box.max.set(p.x + 0.34, p.y + this.height * 1.14, p.z + 0.09);
  }

  hit() {
    if (this.down) return false;
    this.down = true;
    this.downFor = this.def.resetTime || 2.5;
    return true;
  }

  update(dt) {
    if (this.kind === 'moving') {
      const [a, b] = this.def.rail;
      this.railT += dt * (this.def.speed || 3) / Math.max(1, b - a);
      const t = (Math.sin(this.railT) + 1) / 2;
      this.mesh.position.x = a + (b - a) * t;
    }

    if (this.down) {
      this.downFor -= dt;
      // Fall backwards, then pop back up.
      this.mesh.rotation.x = clamp(this.mesh.rotation.x + dt * 7, 0, Math.PI / 2);
      if (this.downFor <= 0 && this.kind !== 'static') {
        this.down = false;
      } else if (this.downFor <= 0) {
        this.down = false;
      }
    } else if (this.mesh.rotation.x > 0) {
      this.mesh.rotation.x = Math.max(0, this.mesh.rotation.x - dt * 5);
    }
    this.updateBox();
  }
}

export class TrainingMode {
  constructor(scene, lab, mapData, effects, audio, world) {
    this.scene = scene;
    this.lab = lab;
    this.map = mapData;
    this.effects = effects;
    this.audio = audio;
    this.world = world;
    this.targets = [];
    this.stands = [];
    this.projectiles = [];
    this.nearStand = null;
    this.root = new THREE.Group();
    scene.add(this.root);

    this.hits = 0;
    this.shots = 0;
    this.streak = 0;
    this.penalties = 0;
    this.lastPickup = null;
    this.onEquip = null;
  }

  build() {
    let seed = 1;
    for (const prop of this.map.props) {
      if (prop.target) {
        const mesh = buildPropMesh(prop, this.lab, seed++);
        mesh.position.set(prop.p[0], prop.p[1], prop.p[2]);
        mesh.rotation.y = prop.yaw || 0;
        this.root.add(mesh);
        this.targets.push(new Target(prop, mesh));
      } else if (prop.pickup && prop.weapon) {
        this.stands.push({
          weapon: prop.weapon,
          pos: new THREE.Vector3(prop.p[0], prop.p[1], prop.p[2]),
        });
      }
    }
  }

  /** Test predicted shots against the targets and give feedback. */
  registerShots(eye, shots) {
    const origin = new THREE.Vector3(eye.x, eye.y, eye.z);
    const ray = new THREE.Ray(origin, new THREE.Vector3());
    for (const shot of shots) {
      this.shots++;
      ray.direction.set(shot.dir.x, shot.dir.y, shot.dir.z).normalize();
      const wallDist = shot.hit
        ? origin.distanceTo(new THREE.Vector3(shot.end.x, shot.end.y, shot.end.z))
        : Infinity;

      let best = null, bestD = wallDist;
      const point = new THREE.Vector3();
      for (const t of this.targets) {
        if (t.down) continue;
        if (!ray.intersectBox(t.box, point)) continue;
        const d = origin.distanceTo(point);
        if (d < bestD) { bestD = d; best = t; }
      }

      if (best) {
        best.hit();
        this.hits++;
        const p = ray.at(bestD, new THREE.Vector3());
        this.effects.impact(p, { x: -ray.direction.x, y: -ray.direction.y, z: -ray.direction.z },
          best.friendly ? 'wood' : 'metal');
        this.audio.impact(best.friendly ? 'wood' : 'metal', p);
        this.audio.hitmarker(!best.friendly);
        if (best.friendly) { this.penalties++; this.streak = 0; }
        else this.streak++;
      }
    }
  }

  /** Throw a grenade. Training is offline, so it is simulated here. */
  throwGrenade(kind, local) {
    const def = getGrenade(kind);
    const eye = eyePosition(local.state);
    const dir = dirFromAngles(local.yaw, local.pitch);
    this.projectiles.push({
      id: `t${this.projSeq = (this.projSeq || 0) + 1}`,
      kind,
      pos: { x: eye.x + dir.x * 0.4, y: eye.y + dir.y * 0.4, z: eye.z + dir.z * 0.4 },
      vel: {
        x: dir.x * def.throwSpeed + local.state.vel.x * 0.35,
        y: dir.y * def.throwSpeed + 2.2,
        z: dir.z * def.throwSpeed + local.state.vel.z * 0.35,
      },
      fuse: def.fuse,
    });
    return this.projectiles[this.projectiles.length - 1];
  }

  stepProjectiles(dt, onSpawn, onPop) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const g = this.projectiles[i];
      const def = getGrenade(g.kind);
      g.vel.y -= GRENADE_GRAVITY * dt;

      let remaining = dt, guard = 0;
      while (remaining > 1e-4 && guard++ < 4) {
        const step = { x: g.vel.x * remaining, y: g.vel.y * remaining, z: g.vel.z * remaining };
        const dist = Math.hypot(step.x, step.y, step.z);
        if (dist < 1e-5) break;
        const dir = { x: step.x / dist, y: step.y / dist, z: step.z / dist };
        const hit = raycastWorld(this.world, g.pos, dir, dist + 0.07, { sightOnly: true });
        if (!hit) { g.pos.x += step.x; g.pos.y += step.y; g.pos.z += step.z; break; }

        const travel = Math.max(0, hit.t - 0.07);
        g.pos.x += dir.x * travel; g.pos.y += dir.y * travel; g.pos.z += dir.z * travel;
        const n = hit.normal;
        const vn = g.vel.x * n.x + g.vel.y * n.y + g.vel.z * n.z;
        g.vel.x = (g.vel.x - 2 * vn * n.x) * def.bounce;
        g.vel.y = (g.vel.y - 2 * vn * n.y) * def.bounce;
        g.vel.z = (g.vel.z - 2 * vn * n.z) * def.bounce;
        g.vel.x *= def.friction; g.vel.z *= def.friction;
        const speed = Math.hypot(g.vel.x, g.vel.y, g.vel.z);
        this.audio.bounce(g.pos, speed);
        if (speed < 1.2) { g.vel.x = g.vel.y = g.vel.z = 0; }
        remaining -= Math.max(1e-3, (travel / Math.max(0.001, dist)) * remaining);
      }

      onSpawn?.(g);
      g.fuse -= dt;
      if (g.fuse <= 0) {
        this.projectiles.splice(i, 1);
        onPop?.(g);
        // Knock over any targets inside a frag's radius.
        if (g.kind === 'frag') {
          const fdef = getGrenade('frag');
          for (const t of this.targets) {
            if (t.down) continue;
            const c = t.mesh.position;
            const d = Math.hypot(c.x - g.pos.x, c.y + 0.9 - g.pos.y, c.z - g.pos.z);
            if (fragDamage(fdef, d) > 0) { t.hit(); this.hits++; }
          }
        }
      }
    }
  }

  update(dt, local, camera) {
    for (const t of this.targets) t.update(dt);
    if (!local?.alive) return;

    // Weapon racks need a deliberate press. Picking up on proximity alone
    // swapped your gun every time you walked past the armoury wall.
    const pos = local.state.pos;
    let near = null;
    for (const s of this.stands) {
      const d = Math.hypot(s.pos.x - pos.x, s.pos.z - pos.z);
      if (d < 1.8 && Math.abs(s.pos.y - pos.y) < 2) { near = s; break; }
    }
    this.nearStand = near;
    void camera;
  }

  /** Take the weapon from the rack the player is standing at. */
  takeNearbyWeapon(local) {
    const near = this.nearStand;
    if (!near) return null;
    const def = getWeapon(near.weapon);
    const slot = def.slot;
    const cfg = { id: def.id, scope: def.defaultScope, muzzle: 'none', grip: 'none', laser: 'none' };
    local.loadout[slot] = cfg;
    const rw = resolveWeapon(cfg);
    local.weapons[slot] = { cfg, rw, mag: rw.mag, reserve: rw.reserve };
    local.slot = slot;
    local.switchUntil = local.time + 0.35;
    local.pendingReload = null;
    this.onEquip?.(def);
    return def;
  }

  get accuracy() {
    return this.shots ? Math.round((this.hits / this.shots) * 100) : 0;
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    this.targets.length = 0;
    this.stands.length = 0;
    this.projectiles.length = 0;
    this.nearStand = null;
  }
}
