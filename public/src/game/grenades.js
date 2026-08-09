// Client-side throwables: projectile meshes, smoke volumes, blasts and flash.

import * as THREE from 'three';
import { getGrenade } from '/shared/grenades.js';
import { clamp } from '/shared/mathx.js';

function smokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(226,229,232,0.95)');
  g.addColorStop(0.45, 'rgba(196,201,206,0.55)');
  g.addColorStop(1, 'rgba(170,176,182,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class GrenadeView {
  constructor(scene, effects, audio) {
    this.scene = scene;
    this.effects = effects;
    this.audio = audio;

    this.projectiles = new Map();
    this.smokes = new Map();
    this.time = 0;

    this.bodyGeo = new THREE.CapsuleGeometry(0.045, 0.055, 4, 8);
    this.mats = {
      frag: new THREE.MeshStandardMaterial({ color: 0x3f4a33, roughness: 0.6, metalness: 0.35 }),
      flash: new THREE.MeshStandardMaterial({ color: 0xb9b19a, roughness: 0.45, metalness: 0.55 }),
      smoke: new THREE.MeshStandardMaterial({ color: 0x5c6266, roughness: 0.6, metalness: 0.4 }),
    };

    this.smokeTex = smokeTexture();
    this.smokeGroup = new THREE.Group();
    scene.add(this.smokeGroup);
  }

  /** A grenade has left someone's hand. */
  spawn(msg) {
    const mat = this.mats[msg.kind] || this.mats.frag;
    const mesh = new THREE.Mesh(this.bodyGeo, mat);
    mesh.castShadow = true;
    mesh.position.set(msg.p[0], msg.p[1], msg.p[2]);
    this.scene.add(mesh);

    // A small blinking light so a live frag is readable in a dark room.
    let light = null;
    if (msg.kind === 'frag') {
      light = new THREE.PointLight(0xff4422, 0, 4, 2);
      mesh.add(light);
    }
    this.projectiles.set(msg.id, {
      mesh, light, kind: msg.kind,
      spin: new THREE.Vector3(Math.random() * 9 - 4.5, Math.random() * 9 - 4.5, Math.random() * 9 - 4.5),
      target: new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]),
    });
  }

  /** Server position update for in-flight grenades. */
  sync(list) {
    if (!list) return;
    const seen = new Set();
    for (const [id, kind, x, y, z] of list) {
      seen.add(id);
      let p = this.projectiles.get(id);
      if (!p) {
        this.spawn({ id, kind, p: [x, y, z] });
        p = this.projectiles.get(id);
      }
      p.target.set(x, y, z);
    }
    for (const [id, p] of this.projectiles) {
      if (!seen.has(id)) this.removeProjectile(id, p);
    }
  }

  removeProjectile(id, p) {
    this.scene.remove(p.mesh);
    this.projectiles.delete(id);
  }

  /** Detonation. */
  pop(msg) {
    const pos = { x: msg.p[0], y: msg.p[1], z: msg.p[2] };
    const existing = this.projectiles.get(msg.id);
    if (existing) this.removeProjectile(msg.id, existing);

    const def = getGrenade(msg.kind);
    if (msg.kind === 'frag') {
      this.effects.blast(pos, def.radius);
      this.audio.explosion(pos);
    } else if (msg.kind === 'flash') {
      this.effects.flashPop(pos);
      this.audio.flashbang(pos);
    } else {
      this.audio.smokePop(pos);
    }
  }

  /** Smoke volumes currently active, from the snapshot. */
  syncSmokes(list) {
    const seen = new Set();
    for (const [id, x, y, z, left] of list || []) {
      seen.add(id);
      let s = this.smokes.get(id);
      if (!s) s = this.createSmoke(id, x, y, z);
      s.left = left;
    }
    for (const [id, s] of this.smokes) {
      if (!seen.has(id)) { this.smokeGroup.remove(s.group); this.smokes.delete(id); }
    }
  }

  createSmoke(id, x, y, z) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const puffs = [];
    // A cloud of soft billboards reads better than one big sphere and stays
    // cheap; each puff drifts and rotates on its own.
    for (let i = 0; i < 26; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.smokeTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        color: 0xd8dcdf,
        fog: true,
      });
      const s = new THREE.Sprite(mat);
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.6);
      s.userData.base = new THREE.Vector3(
        Math.cos(a) * r, (Math.random() - 0.25) * 0.75, Math.sin(a) * r
      );
      s.userData.rate = 0.5 + Math.random() * 0.9;
      s.userData.size = 2.6 + Math.random() * 2.2;
      group.add(s);
      puffs.push(s);
    }
    this.smokeGroup.add(group);
    const s = { id, group, puffs, born: this.time, left: 99 };
    this.smokes.set(id, s);
    return s;
  }

  update(dt) {
    this.time += dt;

    for (const p of this.projectiles.values()) {
      // Interpolate toward the authoritative position and tumble.
      p.mesh.position.lerp(p.target, 1 - Math.exp(-24 * dt));
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
      if (p.light) {
        p.light.intensity = (Math.sin(this.time * 18) > 0.4 ? 6 : 0);
      }
    }

    for (const s of this.smokes.values()) {
      const age = this.time - s.born;
      const grow = clamp(age / 1.3, 0, 1);
      // Fade out over the last second and a half of life.
      const fade = clamp(s.left / 1.5, 0, 1);
      for (const puff of s.puffs) {
        const b = puff.userData.base;
        const spread = 3.1 * grow;
        puff.position.set(
          b.x * spread + Math.sin(this.time * puff.userData.rate + b.x * 4) * 0.18,
          b.y * spread * 0.8 + 1.0 * grow + Math.sin(this.time * 0.6 + b.z * 3) * 0.12,
          b.z * spread + Math.cos(this.time * puff.userData.rate + b.z * 4) * 0.18
        );
        const sz = puff.userData.size * (0.35 + grow * 0.65);
        puff.scale.set(sz, sz, 1);
        puff.material.opacity = 0.5 * grow * fade;
      }
    }
  }

  clear() {
    for (const [id, p] of this.projectiles) this.removeProjectile(id, p);
    for (const [, s] of this.smokes) this.smokeGroup.remove(s.group);
    this.smokes.clear();
  }
}
