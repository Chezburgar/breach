// Turns map data into the scene.
//
// Every box and prop primitive is given world-space UVs and merged by material,
// so a 1700-box level draws in roughly twenty calls and textures run
// continuously across seams instead of resetting at every box.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { propParts } from './props.js';
import { hashString } from '/shared/mathx.js';

const TRANSPARENT = new Set(['glass', 'water', 'waterjet']);
const NO_SHADOW = new Set(['glass', 'water', 'waterjet', 'lampglass']);

/**
 * Assign UVs from world position, projected on whichever axis the face points
 * along. Continuous across neighbouring boxes; for yaw-rotated boxes the
 * projection is done in the box's own frame so a rotated wall still tiles.
 */
function applyWorldUV(geo, centre, yaw, uvScale) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);

  const c = Math.cos(yaw), s = Math.sin(yaw);
  const ox = centre[0] * c + centre[2] * s;
  const oz = -centre[0] * s + centre[2] * c;
  const oy = centre[1];

  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (nx >= ny && nx >= nz) { u = lz + oz; v = ly + oy; }
    else if (ny >= nz) { u = lx + ox; v = lz + oz; }
    else { u = lx + ox; v = ly + oy; }
    uv[i * 2] = u * uvScale;
    uv[i * 2 + 1] = v * uvScale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function primitiveGeometry(part) {
  switch (part.k) {
    case 'cyl':
      return new THREE.CylinderGeometry(part.s[0], part.s[1], part.s[2], 12, 1);
    case 'cone':
      return new THREE.ConeGeometry(part.s[0], part.s[1], 10, 1);
    case 'sph':
      return new THREE.SphereGeometry(part.s, 10, 7);
    default:
      return new THREE.BoxGeometry(part.s[0], part.s[1], part.s[2]);
  }
}

export class WorldView {
  constructor(scene, lab, mapData, opts = {}) {
    this.scene = scene;
    this.lab = lab;
    this.map = mapData;
    this.quality = opts.quality || 'high';
    this.root = new THREE.Group();
    this.root.name = 'world';
    scene.add(this.root);
    this.meshes = [];
    this.lightPool = [];
    this.mapLights = [];
    this.waterMeshes = [];
    this.time = 0;
  }

  build() {
    this.buildSolids();
    this.buildProps();
    this.buildDecals();
    this.buildLights();
  }

  // ------------------------------------------------------------- solids
  buildSolids() {
    const byMaterial = new Map();
    const push = (key, geo) => {
      if (!byMaterial.has(key)) byMaterial.set(key, []);
      byMaterial.get(key).push(geo);
    };

    for (const b of this.map.boxes) {
      const mat = this.lab.material(b.m);
      const uvScale = mat.userData.uvScale ?? 0.4;
      const geo = new THREE.BoxGeometry(b.s[0], b.s[1], b.s[2]);
      applyWorldUV(geo, b.p, b.r || 0, uvScale);
      if (b.r) geo.rotateY(b.r);
      geo.translate(b.p[0], b.p[1], b.p[2]);
      push(b.distant ? `${b.m}::distant` : b.m, geo);
    }

    for (const [key, list] of byMaterial) {
      const [matKey, tag] = key.split('::');
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();

      const material = this.lab.material(matKey);
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `solid:${key}`;
      const transparent = TRANSPARENT.has(matKey);
      mesh.castShadow = !transparent && !NO_SHADOW.has(matKey) && tag !== 'distant';
      mesh.receiveShadow = !transparent && tag !== 'distant';
      mesh.renderOrder = transparent ? 2 : 0;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      this.meshes.push(mesh);
      if (matKey === 'water') this.waterMeshes.push(mesh);
    }
  }

  // -------------------------------------------------------------- props
  buildProps() {
    const byMaterial = new Map();
    const push = (key, geo) => {
      if (!byMaterial.has(key)) byMaterial.set(key, []);
      byMaterial.get(key).push(geo);
    };

    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const m4 = new THREE.Matrix4();

    for (const prop of this.map.props) {
      // Targets move and fall over, so they cannot be merged into static
      // geometry — the training mode owns them instead.
      if (prop.target) continue;
      const seed = hashString(`${prop.type}:${prop.p.join(',')}`);
      const parts = propParts(prop, seed);
      if (!parts) continue;
      const scale = prop.scale || 1;

      for (const part of parts) {
        const mat = this.lab.material(part.m);
        const uvScale = mat.userData.uvScale ?? 0.5;
        const geo = primitiveGeometry(part);

        if (part.k === 'box') {
          applyWorldUV(geo, [0, 0, 0], 0, uvScale);
        } else if (geo.attributes.uv) {
          // Scale the primitive's own UVs into world units.
          const span = part.k === 'sph' ? part.s * 2 : Math.max(part.s[0] * 2, part.s[2] ?? part.s[1]);
          const uv = geo.attributes.uv;
          for (let i = 0; i < uv.count; i++) {
            uv.setXY(i, uv.getX(i) * span * uvScale, uv.getY(i) * span * uvScale);
          }
          uv.needsUpdate = true;
        }

        // Local transform, then the prop's own placement.
        if (part.r) {
          e.set(part.r[0] || 0, part.r[1] || 0, part.r[2] || 0);
          q.setFromEuler(e);
          geo.applyQuaternion(q);
        }
        geo.translate(part.p[0], part.p[1], part.p[2]);
        m4.makeRotationY(prop.yaw || 0);
        m4.scale(new THREE.Vector3(scale, scale, scale));
        m4.setPosition(0, 0, 0);
        geo.applyMatrix4(m4);
        geo.translate(prop.p[0], prop.p[1], prop.p[2]);

        push(part.m, geo);
      }
    }

    for (const [matKey, list] of byMaterial) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const material = this.lab.material(matKey);
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `prop:${matKey}`;
      const transparent = TRANSPARENT.has(matKey);
      mesh.castShadow = !transparent && !NO_SHADOW.has(matKey);
      mesh.receiveShadow = !transparent;
      mesh.renderOrder = transparent ? 2 : 0;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      this.meshes.push(mesh);
    }
  }

  // ------------------------------------------------------------- decals
  buildDecals() {
    if (!this.map.decals?.length) return;
    const group = new THREE.Group();
    for (const d of this.map.decals) {
      const text = d.text || '';
      if (!text) continue;
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 256, 128);
      ctx.fillStyle = d.type === 'range_marker' ? '#f2e4c0' : '#e8ecf3';
      ctx.font = 'bold 72px Rajdhani, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.85;
      ctx.fillText(text, 128, 64);

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const w = d.type === 'sign_text' ? 4.4 : 2.6;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.5), mat);
      mesh.position.set(d.p[0], d.p[1], d.p[2]);
      if (d.type === 'sign_text') mesh.rotation.y = d.yaw || 0;
      else mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 1;
      group.add(mesh);
    }
    this.root.add(group);
    this.decals = group;
  }

  // ------------------------------------------------------------- lights
  buildLights() {
    this.mapLights = (this.map.lights || []).filter((l) => !l.night);
    const budget = { low: 0, medium: 3, high: 6, ultra: 8 }[this.quality] ?? 6;
    for (let i = 0; i < budget; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 1.8);
      light.visible = false;
      this.root.add(light);
      this.lightPool.push(light);
    }
  }

  /** Point the small pool of real lights at whichever map lights are nearest. */
  updateLights(cameraPos) {
    if (!this.lightPool.length) return;
    const near = [];
    for (const l of this.mapLights) {
      const dx = l.p[0] - cameraPos.x, dy = l.p[1] - cameraPos.y, dz = l.p[2] - cameraPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 1600) continue;
      near.push({ l, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2);

    for (let i = 0; i < this.lightPool.length; i++) {
      const slot = this.lightPool[i];
      const entry = near[i];
      if (!entry) { slot.visible = false; continue; }
      slot.visible = true;
      slot.position.set(entry.l.p[0], entry.l.p[1], entry.l.p[2]);
      slot.color.setHex(entry.l.color ?? 0xffffff);
      slot.intensity = (entry.l.intensity ?? 1) * 6;
      slot.distance = entry.l.distance ?? 12;
    }
  }

  update(dt, cameraPos) {
    this.time += dt;
    this.updateLights(cameraPos);
    // A slow drift on the water normals is enough to read as moving liquid.
    for (const m of this.waterMeshes) {
      const mat = m.material;
      if (mat.normalMap) {
        mat.normalMap.offset.x = this.time * 0.02;
        mat.normalMap.offset.y = this.time * 0.013;
      }
    }
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    this.scene.remove(this.root);
    this.meshes.length = 0;
  }
}
