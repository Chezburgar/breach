// Abilities in the world: barriers, mines, and the pulse a scanner throws.
//
// Everything is driven from the snapshot — the room owns what is planted, so
// there is nothing to simulate here and nothing that can disagree with the
// server about where a shield is standing.

import * as THREE from 'three';
import { ABILITIES } from '../../shared/abilities.js';
import { TEAM_INFO } from '../../shared/constants.js';

export class AbilityView {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'abilities';
    scene.add(this.root);
    this.objects = new Map();      // id -> mesh
    this.pulses = [];
  }

  colour(team) {
    return TEAM_INFO[team]?.colorHex ?? 0x9aa3b0;
  }

  buildShield(team) {
    const g = new THREE.Group();
    const def = ABILITIES.shield;
    const tint = this.colour(team);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(def.width, def.height),
      new THREE.MeshStandardMaterial({
        color: tint, emissive: tint, emissiveIntensity: 0.5,
        transparent: true, opacity: 0.26, side: THREE.DoubleSide,
        depthWrite: false, roughness: 0.2, metalness: 0.1,
      })
    );
    panel.position.y = def.height / 2;
    g.add(panel);
    // A frame, so the edge of cover is unambiguous when you are behind it.
    const edge = new THREE.Mesh(
      new THREE.TorusGeometry(0.02, 0.02, 4, 4),
      new THREE.MeshBasicMaterial({ color: tint })
    );
    void edge;
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(def.width, 0.06, 0.06),
      new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 1.6 })
    );
    bar.position.y = def.height;
    g.add(bar);
    const foot = bar.clone();
    foot.position.y = 0.03;
    g.add(foot);
    return g;
  }

  buildMine(team, armed) {
    const g = new THREE.Group();
    const tint = this.colour(team);
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.2, 0.09, 12),
      new THREE.MeshStandardMaterial({ color: 0x23262c, metalness: 0.7, roughness: 0.45 })
    );
    body.position.y = 0.045;
    g.add(body);
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 10, 8),
      new THREE.MeshBasicMaterial({ color: armed ? tint : 0x6a7078 })
    );
    light.position.y = 0.11;
    g.add(light);
    g.userData.light = light;
    return g;
  }

  /** Follow the snapshot's list of planted objects. */
  sync(list) {
    const seen = new Set();
    for (const o of list || []) {
      seen.add(o.id);
      let mesh = this.objects.get(o.id);
      if (!mesh) {
        mesh = o.k === 'shield' ? this.buildShield(o.team) : this.buildMine(o.team, o.armed);
        this.root.add(mesh);
        this.objects.set(o.id, mesh);
      }
      mesh.position.set(o.p[0], o.p[1], o.p[2]);
      mesh.rotation.y = o.y || 0;
      if (o.k === 'mine' && mesh.userData.light) {
        mesh.userData.light.material.color.setHex(o.armed ? this.colour(o.team) : 0x6a7078);
      }
    }
    for (const [id, mesh] of [...this.objects]) {
      if (seen.has(id)) continue;
      this.dispose(mesh);
      this.objects.delete(id);
    }
  }

  /** An expanding ring where a scanner went off. */
  pulse(at, radius, team) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.0, 48),
      new THREE.MeshBasicMaterial({
        color: this.colour(team), transparent: true, opacity: 0.75,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(at[0], at[1] + 0.4, at[2]);
    this.root.add(ring);
    this.pulses.push({ mesh: ring, t: 0, radius });
  }

  update(dt) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += dt;
      const k = p.t / 0.85;
      if (k >= 1) {
        this.dispose(p.mesh);
        this.pulses.splice(i, 1);
        continue;
      }
      p.mesh.scale.setScalar(1 + k * p.radius);
      p.mesh.material.opacity = 0.75 * (1 - k);
    }
  }

  dispose(mesh) {
    mesh.traverse?.((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose?.();
      if (o.material?.dispose) o.material.dispose();
    });
    this.root.remove(mesh);
  }

  clear() {
    for (const [, mesh] of this.objects) this.dispose(mesh);
    this.objects.clear();
    for (const p of this.pulses) this.dispose(p.mesh);
    this.pulses.length = 0;
  }
}
