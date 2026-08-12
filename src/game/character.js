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
const MODEL_DIR = new URL('../../assets/models/', import.meta.url).href;
const MODEL_URL = `${MODEL_DIR}operator.fbx`;

// The FBX does not embed its maps — it names them, and they have to sit
// beside it. Without them three.js builds a texture with no image, the mesh
// samples nothing, and every operator renders as a flat silhouette, which is
// exactly what was happening. Loaded here explicitly rather than through the
// FBX's own reference, because that path depends on how the exporter wrote
// the relative filename and it had a folder prefix in front of it.
const SKIN = {
  color: 'Color_b32e675f-6421-4861-8965-0117541f4582.jpg',
  normal: 'NormalGL_b32e675f-6421-4861-8965-0117541f4582.jpg',
  // Occlusion / roughness / metalness packed into R / G / B.
  orm: 'ORM_b32e675f-6421-4861-8965-0117541f4582.jpg',
};

/**
 * Load whichever of the maps are actually present. Missing ones come back
 * null and the material falls back to a plain finish rather than to black.
 */
async function loadSkin() {
  const loader = new THREE.TextureLoader();
  const get = (file, srgb) => new Promise((resolve) => {
    loader.load(
      MODEL_DIR + file,
      (tex) => {
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.flipY = false;             // FBX UVs, same convention as glTF
        tex.anisotropy = 4;
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });

  const [color, normal, orm] = await Promise.all([
    get(SKIN.color, true), get(SKIN.normal, false), get(SKIN.orm, false),
  ]);
  return { color, normal, orm };
}

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
  const skinPromise = loadSkin();
  templatePromise = new Promise((resolve, reject) => {
    const loader = new FBXLoader();
    loader.setResourcePath(MODEL_DIR);
    loader.load(
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
        // The rig is authored facing +Z (shoulder_left sits at +X), but the
        // controller's forward at yaw 0 is -Z. Left uncorrected every operator
        // is turned a half circle from the way they are travelling, which is
        // what made the bots look like they were walking backwards. Baked in
        // here rather than at each call site; it sits above the bone hierarchy
        // so the model-space pose maths is untouched.
        fbx.rotation.y = Math.PI;
        holder.add(fbx);

        skinPromise.then((skin) => resolve({ object: holder, scale, skin }));
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
    this.skin = template.skin || {};
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
   * The model keeps the white-and-gold it was authored with — tinting the
   * whole body toward the team colour threw away the texture and made every
   * operator look like painted plastic.
   *
   * Team identity comes from a rim instead: the colour rides the edge of the
   * silhouette, which is the part you actually see when someone is peeking a
   * corner, and leaves the material alone everywhere else. Done in the shader
   * rather than as an inverted hull because a second pass over 28k skinned
   * vertices, ten times a frame, costs more than shadows did.
   */
  makeMaterial(src, opts) {
    const base = Array.isArray(src) ? src[0] : src;
    const tint = new THREE.Color(opts.team >= 0 ? TEAM_INFO[opts.team].colorHex : 0x9aa3b0);

    // The FBX's own material carries a texture object with no image behind it,
    // so it is ignored entirely; the maps come from `loadSkin`.
    const skin = this.skin || {};
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xffffff),
      roughness: 0.58,
      metalness: 0.2,
    });

    if (skin.color) {
      mat.map = skin.color;
      if (skin.normal) mat.normalMap = skin.normal;
      if (skin.orm) {
        // Occlusion in R, roughness in G, metalness in B — the glTF packing.
        // The occlusion channel is left unused: three.js reads aoMap from a
        // second UV set and this mesh only has one.
        mat.roughnessMap = skin.orm;
        mat.metalnessMap = skin.orm;
        mat.roughness = 1.0;
        mat.metalness = 1.0;
      }
      // The estate is lit for dusk and the range for dawn; under either, a
      // character lit only by the scene falls to a cut-out and the white and
      // gold might as well not be there. A touch of self-lit texture keeps
      // the material readable without flattening the shading.
      mat.emissiveMap = skin.color;
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = 0.14;
    } else {
      // No maps on disk. A plain warm off-white is a poor substitute for the
      // real thing, but it is a readable operator rather than a silhouette.
      mat.color.setHex(0xd8d4cb);
      mat.roughness = 0.5;
      mat.metalness = 0.32;
    }

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.teamTint = { value: tint };
      // A body is a narrow shape on screen, so a wide rim swallows it whole
      // and the operator becomes a coloured cut-out. Tight and modest: an edge,
      // not a coat of paint.
      shader.uniforms.rimStrength = { value: opts.enemy ? 1.1 : 0.7 };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 teamTint;
          uniform float rimStrength;`)
        // Added *before* tone mapping, in linear light. Added afterwards it
        // lands in display space, where a fifth of a saturated colour is an
        // enormous shift and washes the whole body — which is exactly what
        // it was doing.
        .replace('#include <tonemapping_fragment>', `
          {
            // Facing ratio: 0 head-on, 1 at the silhouette edge.
            vec3 vn = normalize(vNormal);
            vec3 vv = normalize(vViewPosition);
            float rim = 1.0 - abs(dot(vn, vv));
            // A high exponent keeps it to the outer edge and nowhere else.
            rim = pow(clamp(rim, 0.0, 1.0), 12.0);
            gl_FragColor.rgb += teamTint * rim * rimStrength;
          }
          #include <tonemapping_fragment>`);
    };
    // Materials that compile differently must not share a program cache slot.
    mat.customProgramCacheKey = () => `op_${opts.team}_${opts.enemy ? 1 : 0}`;
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
    // The rig faces +Z, so a body leaning to its own right tips toward -X,
    // which is a *positive* roll about +Z. `lean` is +1 for lean-right.
    const stoop = 0.12 + stride * 0.16 + this.crouchBlend * 0.28;
    this.rotate('root', 1, 0, 0, stoop);
    this.rotate('root', 0, 0, 1, this.leanBlend * 0.42 + Math.sin(this.phase) * 0.03 * stride);
    this.rotate('root', 0, 1, 0, -swing * 0.07 * stride);

    // --- head: counter the torso so the eyes stay level, then apply pitch ---
    // Engine pitch is positive looking up; a positive rotation about the rig's
    // +X tips its face down, so the sign flips.
    const pitch = -clamp(s.pitch || 0, -0.9, 0.9);
    this.rotate('neck', 1, 0, 0, -stoop * 0.45);
    this.rotate('head', 1, 0, 0, pitch - stoop * 0.35);
    this.rotate('head', 0, 1, 0, swing * 0.05 * stride);

    // --- arms -------------------------------------------------------------
    // Weapon-ready pose: both arms forward, right hand on the grip, left
    // supporting. Aiming tightens both in toward the centre line.
    const readyPitch = -1.25 - this.aimBlend * 0.16 + pitch * 0.85;

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
