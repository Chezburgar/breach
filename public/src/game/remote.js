// Other players.
//
// Remote entities are rendered a fixed delay in the past and interpolated
// between snapshots, which is what keeps them smooth on a 20 Hz feed. Bodies
// are simple articulated boxes — readable silhouettes matter far more than
// polygon count in a shooter.

import * as THREE from 'three';
import { INTERP_DELAY, PLAYER, TEAM_INFO } from '/shared/constants.js';
import { lerp, lerpAngle, clamp } from '/shared/mathx.js';

const SHARED = {};
function geom(key, make) {
  if (!SHARED[key]) SHARED[key] = make();
  return SHARED[key];
}

function bodyMaterials(teamColor, enemy) {
  return {
    kit: new THREE.MeshStandardMaterial({ color: 0x2f333b, roughness: 0.78, metalness: 0.12 }),
    vest: new THREE.MeshStandardMaterial({ color: enemy ? 0x3a2a26 : 0x252b34, roughness: 0.7, metalness: 0.2 }),
    accent: new THREE.MeshStandardMaterial({
      color: teamColor, roughness: 0.5, metalness: 0.1,
      emissive: teamColor, emissiveIntensity: 0.22,
    }),
    skin: new THREE.MeshStandardMaterial({ color: 0x8d6449, roughness: 0.82 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x1e2024, roughness: 0.5, metalness: 0.6 }),
  };
}

function nameplate(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 128);
  ctx.font = '700 62px Rajdhani, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(name, 256, 64);
  ctx.fillStyle = color;
  ctx.fillText(name, 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.5, 0.375, 1);
  sprite.renderOrder = 20;
  return sprite;
}

export class RemotePlayer {
  constructor(scene, info, isEnemy) {
    this.scene = scene;
    this.id = info.id;
    this.info = info;
    this.isEnemy = isEnemy;
    this.buffer = [];
    this.visible = true;
    this.dead = false;

    const teamColor = info.team >= 0
      ? TEAM_INFO[info.team].colorHex
      : (isEnemy ? 0xff6a3d : 0x39b7ff);
    const M = bodyMaterials(teamColor, isEnemy);
    this.M = M;

    this.root = new THREE.Group();
    this.root.name = `player:${info.id}`;

    // Hips carry the whole body so leaning and crouching are one transform.
    this.hips = new THREE.Group();
    this.root.add(this.hips);

    const mk = (g, m, pos, parent) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (parent || this.hips).add(mesh);
      return mesh;
    };

    // Legs.
    this.legL = new THREE.Group(); this.legL.position.set(-0.11, 0.86, 0);
    this.legR = new THREE.Group(); this.legR.position.set(0.11, 0.86, 0);
    this.hips.add(this.legL, this.legR);
    mk(geom('thigh', () => new THREE.BoxGeometry(0.17, 0.44, 0.19)), M.kit, [0, -0.22, 0], this.legL);
    mk(geom('shin', () => new THREE.BoxGeometry(0.15, 0.42, 0.17)), M.kit, [0, -0.63, 0.02], this.legL);
    mk(geom('boot', () => new THREE.BoxGeometry(0.16, 0.11, 0.26)), M.vest, [0, -0.87, 0.04], this.legL);
    mk(geom('thigh'), M.kit, [0, -0.22, 0], this.legR);
    mk(geom('shin'), M.kit, [0, -0.63, 0.02], this.legR);
    mk(geom('boot'), M.vest, [0, -0.87, 0.04], this.legR);

    // Torso.
    this.torso = new THREE.Group();
    this.torso.position.set(0, 0.88, 0);
    this.hips.add(this.torso);
    mk(geom('chest', () => new THREE.BoxGeometry(0.44, 0.42, 0.26)), M.vest, [0, 0.24, 0], this.torso);
    mk(geom('plate', () => new THREE.BoxGeometry(0.40, 0.30, 0.10)), M.accent, [0, 0.26, -0.15], this.torso);
    mk(geom('belly', () => new THREE.BoxGeometry(0.36, 0.22, 0.22)), M.kit, [0, -0.04, 0], this.torso);
    mk(geom('pouch', () => new THREE.BoxGeometry(0.14, 0.12, 0.10)), M.kit, [0.16, 0.02, -0.14], this.torso);

    // Head, with a helmet band in the team colour so targets are readable.
    this.head = new THREE.Group();
    this.head.position.set(0, 0.52, 0);
    this.torso.add(this.head);
    mk(geom('head', () => new THREE.BoxGeometry(0.22, 0.24, 0.24)), M.skin, [0, 0.06, 0], this.head);
    mk(geom('helm', () => new THREE.BoxGeometry(0.26, 0.14, 0.28)), M.vest, [0, 0.16, 0], this.head);
    mk(geom('band', () => new THREE.BoxGeometry(0.27, 0.035, 0.29)), M.accent, [0, 0.10, 0], this.head);
    mk(geom('visor', () => new THREE.BoxGeometry(0.20, 0.07, 0.06)), M.gun, [0, 0.06, -0.12], this.head);

    // Arms.
    this.armL = new THREE.Group(); this.armL.position.set(-0.27, 0.36, 0);
    this.armR = new THREE.Group(); this.armR.position.set(0.27, 0.36, 0);
    this.torso.add(this.armL, this.armR);
    mk(geom('upper', () => new THREE.BoxGeometry(0.13, 0.32, 0.15)), M.kit, [0, -0.16, 0], this.armL);
    mk(geom('fore', () => new THREE.BoxGeometry(0.12, 0.30, 0.13)), M.kit, [0, -0.46, 0], this.armL);
    mk(geom('upper'), M.kit, [0, -0.16, 0], this.armR);
    mk(geom('fore'), M.kit, [0, -0.46, 0], this.armR);

    // Held weapon: a simplified silhouette that reads at range.
    this.gun = new THREE.Group();
    this.gun.position.set(0.16, -0.52, -0.24);
    this.armR.add(this.gun);
    mk(geom('gunBody', () => new THREE.BoxGeometry(0.06, 0.10, 0.52)), M.gun, [0, 0, 0], this.gun);
    mk(geom('gunBarrel', () => new THREE.BoxGeometry(0.03, 0.03, 0.30)), M.gun, [0, 0.01, -0.38], this.gun);
    mk(geom('gunMag', () => new THREE.BoxGeometry(0.04, 0.14, 0.05)), M.gun, [0, -0.10, 0.02], this.gun);
    mk(geom('gunStock', () => new THREE.BoxGeometry(0.05, 0.09, 0.18)), M.gun, [0, -0.02, 0.32], this.gun);

    this.plate = nameplate(info.name, info.team >= 0 ? TEAM_INFO[info.team].color : '#e8ecf3');
    this.plate.position.set(0, 2.06, 0);
    this.root.add(this.plate);
    this.plate.visible = false;

    scene.add(this.root);

    this.walkPhase = 0;
    this.renderPos = new THREE.Vector3();
    this.smoothYaw = 0;
    this.aimPitch = 0;
    this.height = PLAYER.standHeight;
    this.flags = 0;
  }

  /** Feed one snapshot entry. `t` is the server time it belongs to. */
  push(t, entry) {
    this.buffer.push({
      t,
      x: entry[1], y: entry[2], z: entry[3],
      yaw: entry[4], pitch: entry[5],
      h: entry[6], flags: entry[7], team: entry[8], weapon: entry[9], lean: entry[10] || 0,
    });
    if (this.buffer.length > 24) this.buffer.shift();
  }

  sampleAt(renderTime) {
    const buf = this.buffer;
    if (!buf.length) return null;
    if (buf.length === 1) return buf[0];

    for (let i = buf.length - 1; i > 0; i--) {
      if (buf[i - 1].t <= renderTime && buf[i].t >= renderTime) {
        const a = buf[i - 1], b = buf[i];
        const span = b.t - a.t;
        const f = span > 1e-6 ? clamp((renderTime - a.t) / span, 0, 1) : 0;
        return {
          x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f),
          yaw: lerpAngle(a.yaw, b.yaw, f), pitch: lerp(a.pitch, b.pitch, f),
          h: lerp(a.h, b.h, f), flags: b.flags, team: b.team, weapon: b.weapon,
          lean: lerp(a.lean, b.lean, f),
        };
      }
    }
    // Ahead of the buffer: hold the newest rather than extrapolating into walls.
    return buf[buf.length - 1];
  }

  update(dt, serverTime, camera) {
    const s = this.sampleAt(serverTime - INTERP_DELAY);
    if (!s) { this.root.visible = false; return; }

    const alive = (s.flags & 1) !== 0;
    this.dead = !alive;
    this.root.visible = alive && this.visible;
    if (!this.root.visible) return;

    const prevX = this.renderPos.x, prevZ = this.renderPos.z;
    this.renderPos.set(s.x, s.y, s.z);
    this.root.position.copy(this.renderPos);

    // Body faces where they are looking; the head adds the pitch.
    this.smoothYaw = lerpAngle(this.smoothYaw, s.yaw, 1 - Math.exp(-16 * dt));
    this.root.rotation.y = this.smoothYaw;
    this.aimPitch = lerp(this.aimPitch, s.pitch, 1 - Math.exp(-18 * dt));

    // Stance: crouch by squashing the hips rather than swapping models.
    const crouchAmount = clamp((PLAYER.standHeight - s.h) / (PLAYER.standHeight - PLAYER.crouchHeight), 0, 1);
    this.hips.position.y = -crouchAmount * 0.34;
    this.hips.scale.y = 1 - crouchAmount * 0.18;
    this.hips.rotation.z = -(s.lean || 0) * 0.3;

    this.torso.rotation.x = this.aimPitch * 0.35 + crouchAmount * 0.22;
    this.head.rotation.x = this.aimPitch * 0.62;

    // Arms follow the aim so the weapon points where the shots come from.
    this.armR.rotation.x = -1.28 + this.aimPitch * 0.72;
    this.armL.rotation.x = -1.34 + this.aimPitch * 0.72;
    this.armL.rotation.z = 0.42;
    this.armR.rotation.z = -0.16;
    const ads = (s.flags & 8) !== 0;
    this.armL.rotation.z = ads ? 0.26 : 0.42;
    this.gun.position.x = ads ? 0.02 : 0.16;

    // Walk cycle driven by real ground speed.
    const dx = this.renderPos.x - prevX, dz = this.renderPos.z - prevZ;
    const speed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
    const stride = clamp(speed / 6.5, 0, 1.25);
    this.walkPhase += dt * (4 + speed * 1.5);
    const swing = Math.sin(this.walkPhase) * 0.66 * stride;
    const swing2 = Math.sin(this.walkPhase + Math.PI) * 0.66 * stride;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = swing2;
    this.legL.children[1].rotation.x = Math.max(0, -swing) * 0.8;
    this.legR.children[1].rotation.x = Math.max(0, -swing2) * 0.8;
    this.torso.rotation.y = -Math.sin(this.walkPhase) * 0.08 * stride;

    // Airborne: tuck the legs.
    if (s.flags & 64) {
      this.legL.rotation.x = 0.5;
      this.legR.rotation.x = -0.2;
    }

    if (this.plate.visible) {
      this.plate.position.y = 2.06 - crouchAmount * 0.5;
      const d = camera ? camera.position.distanceTo(this.renderPos) : 10;
      const scale = clamp(d * 0.055, 0.9, 3.2);
      this.plate.scale.set(1.5 * scale, 0.375 * scale, 1);
    }

    this.height = s.h;
    this.flags = s.flags;
    this.weaponId = s.weapon;
  }

  setNameplateVisible(v) { this.plate.visible = v; }

  dispose() {
    this.scene.remove(this.root);
    this.plate.material.map?.dispose();
    this.plate.material.dispose();
    for (const m of Object.values(this.M)) m.dispose();
  }
}

export class RemoteManager {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map();
  }

  ensure(info, isEnemy) {
    let p = this.players.get(info.id);
    if (!p) {
      p = new RemotePlayer(this.scene, info, isEnemy);
      this.players.set(info.id, p);
    }
    return p;
  }

  remove(id) {
    const p = this.players.get(id);
    if (p) { p.dispose(); this.players.delete(id); }
  }

  clear() {
    for (const p of this.players.values()) p.dispose();
    this.players.clear();
  }

  /** Ingest one snapshot's player array. */
  ingest(entries, serverTime, localId, roster, myTeam, teamsMode) {
    for (const e of entries) {
      const id = e[0];
      if (id === localId) continue;
      const info = roster.get(id) || { id, name: '???', team: e[8] };
      const enemy = !teamsMode || info.team !== myTeam;
      const p = this.ensure(info, enemy);
      p.setNameplateVisible(teamsMode && !enemy);
      p.push(serverTime, e);
    }
  }

  update(dt, serverTime, camera) {
    for (const p of this.players.values()) p.update(dt, serverTime, camera);
  }

  /** Nearest visible remote player along a ray, for local hit feedback. */
  get(id) { return this.players.get(id); }
}
