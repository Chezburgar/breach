// Cashout in the world: the box, the vaults it comes from, and the terminals
// it goes into.
//
// Everything here is driven by the snapshot rather than simulated locally —
// the box's position is authoritative, including while it rides on somebody's
// back — so there is nothing to reconcile and nothing to get out of step.

import * as THREE from 'three';

const BOX_SIZE = 0.46;

export class CashView {
  constructor(scene, lab) {
    this.scene = scene;
    this.lab = lab;
    this.root = new THREE.Group();
    this.root.name = 'cashout';
    scene.add(this.root);

    this.terminals = [];
    this.box = null;
    this.boxId = null;
  }

  /** Lay out the fixed furniture: a plinth per vault, a pad per terminal. */
  setObjectives(list) {
    this.clear();
    if (!list) return;
    this.objectives = list;

    for (const o of list) {
      const g = new THREE.Group();
      g.position.set(o.p[0], o.p[1], o.p[2]);
      g.userData.objective = o;

      if (o.kind === 'vault') {
        // A low steel plinth — somewhere the box obviously belongs.
        const base = new THREE.Mesh(
          new THREE.CylinderGeometry(1.0, 1.15, 0.16, 20),
          new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.75, roughness: 0.42 })
        );
        base.position.y = 0.08;
        g.add(base);
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.92, 0.035, 8, 28),
          new THREE.MeshStandardMaterial({
            color: 0xffd67a, emissive: 0xffb02e, emissiveIntensity: 1.5,
            metalness: 0.4, roughness: 0.3,
          })
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.18;
        g.add(ring);
      } else {
        // Terminal: a pad you have to stand on, so the fight has a shape.
        const pad = new THREE.Mesh(
          new THREE.CylinderGeometry(3.2, 3.2, 0.06, 32),
          new THREE.MeshStandardMaterial({
            color: 0x1a2028, metalness: 0.5, roughness: 0.6,
            transparent: true, opacity: 0.85,
          })
        );
        pad.position.y = 0.03;
        g.add(pad);

        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(3.18, 0.05, 8, 48),
          new THREE.MeshStandardMaterial({
            color: 0x8fa6bb, emissive: 0x3d6480, emissiveIntensity: 1.0,
            metalness: 0.6, roughness: 0.35,
          })
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = 0.07;
        g.add(rim);

        const post = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 1.25, 0.34),
          new THREE.MeshStandardMaterial({ color: 0x252b34, metalness: 0.7, roughness: 0.45 })
        );
        post.position.set(0, 0.68, 0);
        g.add(post);

        const screen = new THREE.Mesh(
          new THREE.PlaneGeometry(0.36, 0.26),
          new THREE.MeshBasicMaterial({ color: 0x7fd4ef })
        );
        screen.position.set(0, 1.0, 0.18);
        g.add(screen);
        g.userData.rim = rim;
        g.userData.screen = screen;
        this.terminals.push(g);
      }
      this.root.add(g);
    }
  }

  /** Nearest terminal to a point, matching the room's own range test. */
  terminalNear(pos, range) {
    for (const g of this.terminals) {
      const o = g.userData.objective;
      if (Math.hypot(o.p[0] - pos.x, o.p[1] - pos.y, o.p[2] - pos.z) < range) return o;
    }
    return null;
  }

  ensureBox() {
    if (this.box) return this.box;
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE * 0.72, BOX_SIZE * 0.8),
      new THREE.MeshStandardMaterial({ color: 0x3b4250, metalness: 0.8, roughness: 0.38 })
    );
    g.add(body);
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(BOX_SIZE * 1.02, BOX_SIZE * 0.16, BOX_SIZE * 0.82),
      new THREE.MeshStandardMaterial({
        color: 0xffd67a, emissive: 0xffab20, emissiveIntensity: 1.9,
        metalness: 0.5, roughness: 0.3,
      })
    );
    g.add(band);
    // A beacon so it can be found across a courtyard.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.14, 7, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffc85a, transparent: true, opacity: 0.16,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    beam.position.y = 3.5;
    g.add(beam);
    this.box = g;
    this.root.add(g);
    return g;
  }

  /** Follow the snapshot. */
  sync(co, teams) {
    // The box.
    if (co.box) {
      const g = this.ensureBox();
      g.visible = !co.box.terminal;
      g.position.set(co.box.p[0], co.box.p[1] + (co.box.carrier ? 0 : 0.3), co.box.p[2]);
      g.rotation.y += 0.02;
    } else if (this.box) {
      this.box.visible = false;
    }

    // Terminal colour follows whoever owns the countdown.
    for (const g of this.terminals) {
      const o = g.userData.objective;
      const live = co.act && co.act.t === o.id;
      const colour = live && teams?.[co.act.team] ? teams[co.act.team].colorHex : 0x3d6480;
      g.userData.rim.material.emissive.setHex(colour);
      g.userData.rim.material.emissiveIntensity = live ? 2.4 : 0.9;
      g.userData.screen.material.color.setHex(live ? colour : 0x7fd4ef);
      const s = live ? 1 + Math.sin(performance.now() / 140) * 0.06 : 1;
      g.userData.rim.scale.setScalar(s);
    }
  }

  clear() {
    for (const c of [...this.root.children]) {
      c.traverse?.((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
      this.root.remove(c);
    }
    this.terminals = [];
    this.box = null;
  }
}
