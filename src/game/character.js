// The operator character.
//
// The supplied FBX is rigged but carries no animation clips, so every pose here
// is authored procedurally against its bone names. Rotations are specified in
// *model* space and converted into each bone's parent space, which means the
// animation does not depend on how the rig's local axes happen to be oriented.

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER, TEAM_INFO } from '../../shared/constants.js';
import { clamp, damp } from '../../shared/mathx.js';

// Resolved against this module rather than the site root: the game is served
// from a subpath on GitHub Pages, where a leading slash points at the domain
// root and quietly 404s.
const MODEL_URL = new URL('../../assets/models/operator.fbx', import.meta.url).href;

// Bone names in the supplied rig.
const B = {
  root: 'root',
  neck: 'neck',
  head: 'head',
  shoulderL: 'shoulder_left',
  shoulderR: 'shoulder_right',
  armLTop: 'arm_left_top',
  armLBot: 'arm_left_bot',
  armLHand: 'arm_left_hand',
  armRTop: 'arm_right_top',
  armRBot: 'arm_right_bot',
  armRHand: 'arm_right_hand',
  legLTop: 'leg_left_top',
  legLBot: 'leg_left_bot',
  legLFoot: 'leg_left_foot',
  legRTop: 'leg_right_top',
  legRBot: 'leg_right_bot',
  legRFoot: 'leg_right_foot',
};

let templatePromise = null;

/** Load the FBX once; every operator is a skeleton-aware clone of it. */
export function loadOperatorTemplate() {
  if (templatePromise) return templatePromise;
  templatePromise = new Promise((resolve, reject) => {
    new FBXLoader().load(
      MODEL_URL,
      (fbx) => {
        // Normalise scale: exporters disagree wildly on units, so measure the
        // model and fit it to the player capsule instead of trusting them.
        const box = new THREE.Box3().setFromObject(fbx);
        const height = Math.max(0.001, box.max.y - box.min.y);
        const scale = PLAYER.standHeight / height;
        fbx.scale.setScalar(scale);
        fbx.updateMatrixWorld(true);

        // Wrap it so the feet-to-origin offset lives *inside* the template.
        // Baking it onto the outer object would be wiped the moment a caller
        // positioned the character.
        const fitted = new THREE.Box3().setFromObject(fbx);
        const holder = new THREE.Group();
        holder.name = 'operator';
        fbx.position.y -= fitted.min.y;
        holder.add(fbx);

        resolve({ object: holder, scale });
      },
      undefined,
      (err) => reject(err)
    );
  });
  return templatePromise;
}

/** Walk a bone hierarchy and record its bind pose. */
function indexRig(rootObject) {
  const bones = new Map();
  rootObject.traverse((o) => {
    if (o.isBone) bones.set(o.name, o);
  });

  // Hierarchy order (parents before children) for model-space accumulation.
  const order = [];
  const visit = (bone) => {
    order.push(bone);
    for (const c of bone.children) if (c.isBone) visit(c);
  };
  for (const bone of bones.values()) {
    if (!bone.parent || !bone.parent.isBone) visit(bone);
  }

  const bind = new Map();
  for (const bone of order) bind.set(bone, bone.quaternion.clone());
  return { bones, order, bind };
}

const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _qDelta = new THREE.Quaternion();
const _axis = new THREE.Vector3();

export class Operator {
  /**
   * @param {{object:THREE.Object3D}} template
   * @param {{team:number, enemy:boolean}} opts
   */
  constructor(template, opts = {}) {
    this.root = cloneSkinned(template.object);
    this.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      // The operator is ~28k skinned vertices. Casting shadows would re-skin
      // and redraw every one of them a second time per frame, for ten players —
      // by far the most expensive thing in the frame, and barely visible.
      o.castShadow = false;
      o.receiveShadow = true;
      o.material = this.makeMaterial(o.material, opts);

      // Poses stay well inside this, so the mesh can be culled normally
      // instead of being drawn even when it is behind the camera.
      o.frustumCulled = true;
      if (o.geometry) {
        o.geometry.computeBoundingSphere();
        if (o.geometry.boundingSphere) o.geometry.boundingSphere.radius *= 1.6;
      }
    });

    const rig = indexRig(this.root);
    this.bones = rig.bones;
    this.order = rig.order;
    this.bind = rig.bind;
    this.modelQuat = new Map();

    this.phase = Math.random() * 10;
    this.leanBlend = 0;
    this.crouchBlend = 0;
    this.aimBlend = 0;
    this.deathT = 0;
    this.ready = this.bones.size > 0;
  }

  /**
   * Team colours are applied as a tint over whatever the FBX shipped with, so
   * friend and foe stay readable at range.
   */
  makeMaterial(src, opts) {
    const base = Array.isArray(src) ? src[0] : src;
    const tint = opts.team >= 0 ? TEAM_INFO[opts.team].colorHex : 0x9aa3b0;
    const mat = new THREE.MeshStandardMaterial({
      color: base?.color ? base.color.clone() : new THREE.Color(0x8d939c),
      map: base?.map || null,
      roughness: 0.72,
      metalness: 0.08,
      skinning: true,
    });
    // Darken the base and push it toward the team colour.
    mat.color.multiplyScalar(0.55).lerp(new THREE.Color(tint), 0.28);
    mat.emissive = new THREE.Color(tint).multiplyScalar(0.05);
    return mat;
  }

  bone(key) { return this.bones.get(B[key]); }

  /** Reset every bone to its bind pose and seed model-space accumulation. */
  beginPose() {
    for (const bone of this.order) {
      bone.quaternion.copy(this.bind.get(bone));
    }
    for (const bone of this.order) {
      const parent = bone.parent && bone.parent.isBone ? this.modelQuat.get(bone.parent) : null;
      const m = this.modelQuat.get(bone) || new THREE.Quaternion();
      if (parent) m.copy(parent).multiply(bone.quaternion);
      else m.copy(bone.quaternion);
      this.modelQuat.set(bone, m);
    }
  }

  /**
   * Rotate a bone about a model-space axis.
   * Local' = inv(Pmodel) * R * Pmodel * Local, which keeps the pose independent
   * of the rig's own axis conventions.
   */
  rotate(key, ax, ay, az, angle) {
    if (!angle) return;
    const bone = this.bone(key);
    if (!bone) return;

    const parent = bone.parent && bone.parent.isBone ? this.modelQuat.get(bone.parent) : null;
    _axis.set(ax, ay, az).normalize();
    _qDelta.setFromAxisAngle(_axis, angle);

    if (parent) {
      _q.copy(parent);
      _qInv.copy(_q).invert();
      // inv(P) * R * P
      bone.quaternion.premultiply(_q).premultiply(_qDelta).premultiply(_qInv);
    } else {
      bone.quaternion.premultiply(_qDelta);
    }

    const m = this.modelQuat.get(bone);
    if (parent) m.copy(parent).multiply(bone.quaternion);
    else m.copy(bone.quaternion);

    // Children inherit the change; refresh their accumulated model rotations.
    this.refreshChildren(bone);
  }

  refreshChildren(bone) {
    for (const child of bone.children) {
      if (!child.isBone) continue;
      const m = this.modelQuat.get(child);
      if (!m) continue;
      m.copy(this.modelQuat.get(bone)).multiply(child.quaternion);
      this.refreshChildren(child);
    }
  }

  /**
   * Pose for one frame.
   * @param {object} s `{ speed, moving, onGround, crouch, ads, pitch, lean, dead, deadTime }`
   */
  update(dt, s) {
    if (!this.ready) return;
    this.beginPose();

    this.crouchBlend = damp(this.crouchBlend, s.crouch ? 1 : 0, 12, dt);
    this.aimBlend = damp(this.aimBlend, s.ads ? 1 : 0, 12, dt);
    this.leanBlend = damp(this.leanBlend, s.lean || 0, 10, dt);

    if (s.dead) {
      this.poseDeath(dt, s);
      return;
    }

    const stride = clamp(s.speed / 6.5, 0, 1.3);
    const running = stride > 0.05;
    this.phase += dt * (running ? 3.2 + stride * 6.5 : 1.1);

    const swing = Math.sin(this.phase);
    const swing2 = Math.sin(this.phase + Math.PI);
    const bounce = Math.abs(Math.sin(this.phase)) * stride;

    // --- legs -------------------------------------------------------------
    if (s.onGround) {
      const amp = 0.85 * stride;
      this.rotate('legLTop', 1, 0, 0, swing * amp - this.crouchBlend * 0.75);
      this.rotate('legRTop', 1, 0, 0, swing2 * amp - this.crouchBlend * 0.75);
      // Knees only bend one way.
      this.rotate('legLBot', 1, 0, 0, Math.max(0, -swing) * 1.15 * stride + this.crouchBlend * 1.35);
      this.rotate('legRBot', 1, 0, 0, Math.max(0, -swing2) * 1.15 * stride + this.crouchBlend * 1.35);
      this.rotate('legLFoot', 1, 0, 0, -Math.max(0, -swing) * 0.4 * stride - this.crouchBlend * 0.5);
      this.rotate('legRFoot', 1, 0, 0, -Math.max(0, -swing2) * 0.4 * stride - this.crouchBlend * 0.5);
    } else {
      // Airborne: legs tuck.
      this.rotate('legLTop', 1, 0, 0, 0.55);
      this.rotate('legRTop', 1, 0, 0, -0.25);
      this.rotate('legLBot', 1, 0, 0, 0.9);
      this.rotate('legRBot', 1, 0, 0, 0.35);
    }

    // --- torso ------------------------------------------------------------
    const lean = 0.12 + stride * 0.16 + this.crouchBlend * 0.28;
    this.rotate('root', 1, 0, 0, lean);
    this.rotate('root', 0, 0, 1, -this.leanBlend * 0.28 + Math.sin(this.phase) * 0.03 * stride);
    this.rotate('root', 0, 1, 0, -swing * 0.07 * stride);

    // --- head: counter the torso so the eyes stay level, then apply pitch ---
    this.rotate('neck', 1, 0, 0, -lean * 0.45);
    this.rotate('head', 1, 0, 0, clamp(s.pitch || 0, -0.9, 0.9) - lean * 0.35);
    this.rotate('head', 0, 1, 0, swing * 0.05 * stride);

    // --- arms -------------------------------------------------------------
    // Weapon-ready pose: both arms forward, right hand on the grip, left
    // supporting. Aiming tightens both in toward the centre line.
    const readyPitch = -1.25 - this.aimBlend * 0.16 + clamp(s.pitch || 0, -0.9, 0.9) * 0.85;

    this.rotate('shoulderR', 0, 1, 0, -0.12 - this.aimBlend * 0.12);
    this.rotate('armRTop', 1, 0, 0, readyPitch);
    this.rotate('armRTop', 0, 0, 1, -0.34 + this.aimBlend * 0.16);
    this.rotate('armRBot', 1, 0, 0, -0.55 - this.aimBlend * 0.22);
    this.rotate('armRBot', 0, 1, 0, 0.35);

    this.rotate('shoulderL', 0, 1, 0, 0.16 + this.aimBlend * 0.16);
    this.rotate('armLTop', 1, 0, 0, readyPitch + 0.1);
    this.rotate('armLTop', 0, 0, 1, 0.5 - this.aimBlend * 0.26);
    this.rotate('armLBot', 1, 0, 0, -0.85 - this.aimBlend * 0.25);
    this.rotate('armLBot', 0, 1, 0, -0.5);

    // A little arm sway while running, damped hard when aiming.
    const armSway = stride * (1 - this.aimBlend * 0.85) * 0.22;
    this.rotate('armRTop', 1, 0, 0, swing2 * armSway);
    this.rotate('armLTop', 1, 0, 0, swing * armSway);

    // --- breathing / weight -----------------------------------------------
    this.root.position.y = -this.crouchBlend * 0.30 - bounce * 0.045;
    void bounce;
  }

  poseDeath(dt, s) {
    // Collapse forward over half a second and stay down.
    this.deathT = Math.min(1, (s.deadTime || 0) / 0.55);
    const t = this.deathT;
    const ease = t * t * (3 - 2 * t);
    this.rotate('root', 1, 0, 0, ease * 1.5);
    this.rotate('neck', 1, 0, 0, ease * 0.5);
    this.rotate('legLTop', 1, 0, 0, -ease * 0.6);
    this.rotate('legRTop', 1, 0, 0, -ease * 0.35);
    this.rotate('legLBot', 1, 0, 0, ease * 0.9);
    this.rotate('legRBot', 1, 0, 0, ease * 1.2);
    this.rotate('armLTop', 1, 0, 0, -ease * 0.8);
    this.rotate('armRTop', 1, 0, 0, -ease * 1.0);
    this.root.position.y = -ease * 0.55;
  }

  /** World-space position of the right hand, for attaching a weapon. */
  handMatrix(target) {
    const hand = this.bone('armRHand');
    if (!hand) return null;
    hand.updateWorldMatrix(true, false);
    return target.copy(hand.matrixWorld);
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose?.();
      }
    });
  }
}
