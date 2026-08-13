// Drone rendering, and the marks a drone's scan leaves behind.
//
// Both are driven straight off the snapshot: `dr` carries every live drone in
// the match, `mk` the ids this client's team is allowed to see through walls.

import * as THREE from 'three';
import { DRONE } from '../../shared/drone.js';
import { TEAM_INFO } from '../../shared/constants.js';

/** A squat two-wheeled chassis with a camera head. Read at a glance, small. */
function buildChassis(team) {
  const g = new THREE.Group();
  const tint = team >= 0 ? TEAM_INFO[team].colorHex : 0x9aa3b0;

  const shell = new THREE.MeshStandardMaterial({ color: 0x25282d, metalness: 0.5, roughness: 0.5 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x121316, metalness: 0.0, roughness: 0.95 });
  const lens = new THREE.MeshStandardMaterial({
    color: tint, emissive: tint, emissiveIntensity: 1.6, roughness: 0.3,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.13, 0.30), shell);
  body.position.y = DRONE.height * 0.55;
  g.add(body);

  // Wheels either side, big relative to the body — it is a toy car.
  for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.05, 14), rubber);
    w.rotation.z = Math.PI / 2;
    w.position.set(sx * 0.125, 0.115, 0);
    g.add(w);
  }

  // Camera head on a short mast, which is what the pilot looks along.
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.04), shell);
  mast.position.set(0, DRONE.height * 0.9, 0.02);
  g.add(mast);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), shell);
  head.position.set(0, DRONE.eye + 0.02, 0.02);
  g.add(head);
  const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.012, 12), lens);
  eye.rotation.x = Math.PI / 2;
  eye.position.set(0, DRONE.eye + 0.02, -0.03);
  g.add(eye);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
  return { group: g, lens };
}

export class DroneView {
  constructor(scene) {
    this.scene = scene;
    this.drones = new Map();     // id -> { group, lens, pos, yaw }
  }

  /** @param rows snapshot `dr`: `[id, owner, team, x, y, z, yaw, pitch]` */
  sync(rows, dt) {
    const seen = new Set();
    for (const r of rows || []) {
      const [id, owner, team, x, y, z, yaw] = r;
      seen.add(id);
      let d = this.drones.get(id);
      if (!d) {
        const built = buildChassis(team);
        this.scene.add(built.group);
        d = { ...built, owner, pos: new THREE.Vector3(x, y, z), yaw };
        this.drones.set(id, d);
      }
      // Smoothed, like remote players — snapshots arrive at 20 Hz.
      const k = 1 - Math.exp(-18 * dt);
      d.pos.lerp(_v.set(x, y, z), k);
      let dy = yaw - d.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      d.yaw += dy * k;
      d.group.position.copy(d.pos);
      d.group.rotation.y = d.yaw;
    }

    for (const [id, d] of this.drones) {
      if (seen.has(id)) continue;
      this.remove(id, d);
    }
  }

  /** Hide our own drone from our own camera — we are inside its head. */
  setHidden(id, hidden) {
    const d = this.drones.get(id);
    if (d) d.group.visible = !hidden;
  }

  get(id) { return this.drones.get(id); }

  remove(id, d = this.drones.get(id)) {
    if (!d) return;
    this.scene.remove(d.group);
    d.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.drones.delete(id);
  }

  clear() {
    for (const [id, d] of [...this.drones]) this.remove(id, d);
  }
}

const _v = new THREE.Vector3();

/**
 * Marks. A scanned enemy is carried by a chevron floating over them that
 * ignores depth entirely — the whole point is that you can see it through the
 * wall they are behind.
 */
export class MarkView {
  constructor(scene) {
    this.scene = scene;
    this.marks = new Map();      // id -> sprite
    this.material = new THREE.SpriteMaterial({
      map: chevronTexture(),
      depthTest: false,
      depthWrite: false,
      transparent: true,
      color: 0xff7a3d,
    });
  }

  /**
   * @param ids  marked player ids from the snapshot
   * @param find `(id) => { x, y, z } | null` — where that player is drawn
   */
  sync(ids, find) {
    const live = new Set(ids || []);
    for (const id of live) {
      const at = find(id);
      if (!at) { this.drop(id); continue; }
      let s = this.marks.get(id);
      if (!s) {
        s = new THREE.Sprite(this.material);
        s.scale.set(0.5, 0.5, 1);
        s.renderOrder = 60;
        this.scene.add(s);
        this.marks.set(id, s);
      }
      s.position.set(at.x, at.y + 2.35, at.z);
    }
    for (const id of [...this.marks.keys()]) if (!live.has(id)) this.drop(id);
  }

  drop(id) {
    const s = this.marks.get(id);
    if (!s) return;
    this.scene.remove(s);
    this.marks.delete(id);
  }

  clear() { for (const id of [...this.marks.keys()]) this.drop(id); }
}

function chevronTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.beginPath();
  x.moveTo(32, 46); x.lineTo(10, 16); x.lineTo(22, 16);
  x.lineTo(32, 30); x.lineTo(42, 16); x.lineTo(54, 16);
  x.closePath();
  x.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
