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
    this.marks = new Map();      // id -> { chevron, body }
    this.chevronMat = new THREE.SpriteMaterial({
      map: chevronTexture(),
      depthTest: false,
      depthWrite: false,
      transparent: true,
      color: 0xff7a3d,
      sizeAttenuation: false,     // constant on screen, readable at any range
    });
    // A body-sized slab standing where they are. Additive and depth-blind,
    // so it glows through whatever they are hiding behind.
    this.bodyMat = new THREE.SpriteMaterial({
      map: bodyTexture(),
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      color: 0xff5a2a,
      opacity: 0.85,
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
      let m = this.marks.get(id);
      if (!m) {
        const chevron = new THREE.Sprite(this.chevronMat);
        // Screen-space units, because sizeAttenuation is off.
        chevron.scale.set(0.045, 0.045, 1);
        chevron.renderOrder = 62;
        const body = new THREE.Sprite(this.bodyMat);
        body.scale.set(0.9, 1.9, 1);
        body.renderOrder = 61;
        this.scene.add(chevron, body);
        m = { chevron, body };
        this.marks.set(id, m);
      }
      m.chevron.position.set(at.x, at.y + 2.45, at.z);
      m.body.position.set(at.x, at.y + 0.95, at.z);
    }
    for (const id of [...this.marks.keys()]) if (!live.has(id)) this.drop(id);
  }

  drop(id) {
    const m = this.marks.get(id);
    if (!m) return;
    this.scene.remove(m.chevron, m.body);
    this.marks.delete(id);
  }

  clear() { for (const id of [...this.marks.keys()]) this.drop(id); }
}

/** A soft upright blob — a person-shaped smear, not a hard rectangle. */
function bodyTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 64, 4, 32, 64, 54);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.20)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 128);
  // A brighter core so the outline reads as a figure at distance.
  x.fillStyle = 'rgba(255,255,255,0.5)';
  x.beginPath(); x.ellipse(32, 26, 11, 13, 0, 0, 7); x.fill();
  x.beginPath(); x.roundRect(19, 40, 26, 60, 9); x.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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

/**
 * The operator's phone.
 *
 * Taking the whole screen away and putting you inside the drone left your body
 * standing somewhere you could no longer see. This instead renders the drone's
 * view into a texture and shows it on a handset held up in front of you: you
 * drive from the feed, but you are still standing in the room, still looking
 * at it, and still very much shootable.
 */
export class DronePhone {
  constructor(renderer, worldScene, rig) {
    this.renderer = renderer;
    this.world = worldScene;
    this.active = false;
    this.blend = 0;

    const w = renderer.quality === 'low' ? 320 : 512;
    const h = Math.round(w * 0.62);
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      samples: renderer.quality === 'low' ? 0 : 4,
    });
    this.rt.texture.colorSpace = THREE.NoColorSpace;

    // A drone camera is a wide, cheap lens.
    this.camera = new THREE.PerspectiveCamera(92, w / h, 0.05, 400);

    this.group = new THREE.Group();
    this.group.visible = false;
    rig.add(this.group);

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.168, 0.088, 0.009),
      new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.6, roughness: 0.45 })
    );
    this.group.add(body);

    this.screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.150, 0.074),
      new THREE.MeshBasicMaterial({ map: this.rt.texture, toneMapped: false })
    );
    this.screen.position.z = 0.0051;
    this.group.add(this.screen);

    // A thin bezel glow so the handset reads as powered even in the dark.
    const bezel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.156, 0.080),
      new THREE.MeshBasicMaterial({ color: 0x2b6f8a, transparent: true, opacity: 0.5 })
    );
    bezel.position.z = 0.0049;
    this.group.add(bezel);

    this.group.traverse((o) => { if (o.isMesh) { o.renderOrder = 30; o.frustumCulled = false; } });
  }

  /**
   * @param on    are we driving?
   * @param drone `{ pos }` of the drone we are driving, or null
   * @param yaw   where the pilot is pointing it
   */
  update(dt, on, drone, yaw, pitch) {
    this.blend = THREE.MathUtils.clamp(this.blend + (on ? dt * 5 : -dt * 6), 0, 1);
    this.active = this.blend > 0.02 && !!drone;
    this.group.visible = this.active;
    if (!this.active) return;

    // Held up and slightly to the right, tilted back toward the eye. It rises
    // into place rather than appearing, so the hand-off reads.
    const t = this.blend;
    this.group.position.set(0.085, -0.075 - (1 - t) * 0.16, -0.26);
    this.group.rotation.set(-0.34 + (1 - t) * 0.5, -0.30, 0.06);

    this.camera.position.set(drone.pos.x, drone.pos.y + DRONE.eye, drone.pos.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(pitch, yaw, 0);
  }

  /** Draw the feed. Call before the main composer render. */
  render() {
    if (!this.active) return;
    this.renderer.renderToTarget(this.world, this.camera, this.rt);
  }

  dispose() {
    this.rt.dispose();
    this.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
}
