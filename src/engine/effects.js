// Combat effects: tracers, impact sparks, bullet holes, blood, casings,
// muzzle flash and ambient dust. Everything is pooled — nothing is allocated
// during a firefight.

import * as THREE from 'three';

const MAX_TRACERS = 96;
const MAX_PARTICLES = 900;
const MAX_DECALS = 160;
const MAX_CASINGS = 48;

function sparkTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,220,160,0.85)');
  g.addColorStop(1, 'rgba(255,140,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function holeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  // Dark core with a scuffed rim.
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(8,8,10,0.95)');
  g.addColorStop(0.32, 'rgba(20,18,18,0.8)');
  g.addColorStop(0.62, 'rgba(120,110,100,0.32)');
  g.addColorStop(1, 'rgba(140,130,120,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(32, 32, 30, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(150,140,130,0.28)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + Math.random();
    ctx.beginPath();
    ctx.moveTo(32 + Math.cos(a) * 8, 32 + Math.sin(a) * 8);
    ctx.lineTo(32 + Math.cos(a) * (16 + Math.random() * 12), 32 + Math.sin(a) * (16 + Math.random() * 12));
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  constructor(scene, vmScene) {
    this.scene = scene;
    this.vmScene = vmScene;
    this.time = 0;

    this.initTracers();
    this.initParticles();
    this.initDecals();
    this.initCasings();
    this.initMuzzle();
    this.initDust();
  }

  // ------------------------------------------------------------ tracers
  initTracers() {
    // A unit cylinder along +Y, scaled into a streak between two points.
    const geo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.tracerMesh = new THREE.InstancedMesh(geo, mat, MAX_TRACERS);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.count = MAX_TRACERS;
    this.scene.add(this.tracerMesh);

    this.tracers = [];
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracers.push({ alive: false, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0, life: 0, width: 0.02 });
    }
    this.tracerNext = 0;
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._dir = new THREE.Vector3();
    this._mid = new THREE.Vector3();
    this._scale = new THREE.Vector3();
  }

  /** Streak from muzzle to impact, travelling at a readable speed. */
  tracer(from, to, opts = {}) {
    const t = this.tracers[this.tracerNext];
    this.tracerNext = (this.tracerNext + 1) % MAX_TRACERS;
    t.alive = true;
    t.from.set(from.x, from.y, from.z);
    t.to.set(to.x, to.y, to.z);
    t.t = 0;
    t.life = opts.life ?? 0.09;
    t.width = opts.width ?? 0.018;
    t.trail = opts.trail ?? 0.34;
  }

  updateTracers(dt) {
    const m = this.tracerMesh;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const tr = this.tracers[i];
      if (!tr.alive) {
        this._m4.makeScale(0, 0, 0);
        m.setMatrixAt(i, this._m4);
        continue;
      }
      tr.t += dt;
      const f = tr.t / tr.life;
      if (f >= 1) {
        tr.alive = false;
        this._m4.makeScale(0, 0, 0);
        m.setMatrixAt(i, this._m4);
        continue;
      }

      // Head races along the segment; tail follows a fraction behind.
      this._dir.copy(tr.to).sub(tr.from);
      const total = this._dir.length();
      if (total < 1e-4) { tr.alive = false; continue; }
      this._dir.divideScalar(total);

      const head = Math.min(1, f * 1.6) * total;
      const tail = Math.max(0, head - Math.max(1.2, total * tr.trail));
      const len = head - tail;
      if (len <= 0.001) { this._m4.makeScale(0, 0, 0); m.setMatrixAt(i, this._m4); continue; }

      this._mid.copy(tr.from).addScaledVector(this._dir, tail);
      this._q.setFromUnitVectors(this._up, this._dir);
      const fade = 1 - Math.max(0, (f - 0.5) * 2);
      this._scale.set(tr.width * fade, len, tr.width * fade);
      this._m4.compose(this._mid, this._q, this._scale);
      m.setMatrixAt(i, this._m4);
    }
    m.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------- particles
  initParticles() {
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));

    // PointsMaterial has no per-particle size, so this is a small custom shader
    // instead: size and colour both come from attributes.
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: sparkTexture() }, uScale: { value: 400 } },
      vertexShader: /* glsl */`
        uniform float uScale;
        attribute float size;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / max(0.001, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec3 vColor;
        void main() {
          vec4 tex = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(vColor, 1.0) * tex;
          if (gl_FragColor.a < 0.01) discard;
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      toneMapped: false,
    });

    this.pointsGeo = geo;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.particles = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, age: 0, r: 1, g: 1, b: 1, size: 0.05, gravity: 1, drag: 0.9, additive: true,
      });
    }
    this.pNext = 0;
  }

  spawnParticle(p) {
    const slot = this.particles[this.pNext];
    this.pNext = (this.pNext + 1) % MAX_PARTICLES;
    Object.assign(slot, p, { alive: true, age: 0 });
  }

  updateParticles(dt) {
    let write = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) { p.alive = false; continue; }

      p.vy -= 9.8 * p.gravity * dt;
      const d = Math.pow(p.drag, dt * 60);
      p.vx *= d; p.vy *= d; p.vz *= d;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      const f = 1 - p.age / p.life;
      this.pPos[write * 3] = p.x;
      this.pPos[write * 3 + 1] = p.y;
      this.pPos[write * 3 + 2] = p.z;
      this.pCol[write * 3] = p.r * f;
      this.pCol[write * 3 + 1] = p.g * f;
      this.pCol[write * 3 + 2] = p.b * f;
      this.pSize[write] = p.size * (0.5 + f * 0.5);
      write++;
    }
    this.pointsGeo.setDrawRange(0, write);
    this.pointsGeo.attributes.position.needsUpdate = true;
    this.pointsGeo.attributes.color.needsUpdate = true;
    this.pointsGeo.attributes.size.needsUpdate = true;
  }

  // ------------------------------------------------------------- decals
  initDecals() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: holeTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      opacity: 0.95,
    });
    this.decalMesh = new THREE.InstancedMesh(geo, mat, MAX_DECALS);
    this.decalMesh.frustumCulled = false;
    this.decalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decalMesh.renderOrder = 1;
    this.scene.add(this.decalMesh);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_DECALS; i++) this.decalMesh.setMatrixAt(i, zero);
    this.decalNext = 0;
    this._normalQ = new THREE.Quaternion();
    this._zAxis = new THREE.Vector3(0, 0, 1);
    this._pos = new THREE.Vector3();
  }

  bulletHole(point, normal, size = 0.1) {
    this._pos.set(
      point.x + normal.x * 0.012,
      point.y + normal.y * 0.012,
      point.z + normal.z * 0.012
    );
    this._dir.set(normal.x, normal.y, normal.z).normalize();
    this._normalQ.setFromUnitVectors(this._zAxis, this._dir);
    // Random roll so repeated hits do not look stamped.
    const roll = new THREE.Quaternion().setFromAxisAngle(this._zAxis, Math.random() * Math.PI * 2);
    this._normalQ.multiply(roll);
    const s = size * (0.8 + Math.random() * 0.5);
    this._scale.set(s, s, s);
    this._m4.compose(this._pos, this._normalQ, this._scale);
    this.decalMesh.setMatrixAt(this.decalNext, this._m4);
    this.decalNext = (this.decalNext + 1) % MAX_DECALS;
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ casings
  initCasings() {
    const geo = new THREE.CylinderGeometry(0.006, 0.007, 0.023, 6);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.9, roughness: 0.34 });
    this.casingMesh = new THREE.InstancedMesh(geo, brass, MAX_CASINGS);
    this.casingMesh.frustumCulled = false;
    this.casingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.casingMesh);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_CASINGS; i++) this.casingMesh.setMatrixAt(i, zero);
    this.casings = [];
    for (let i = 0; i < MAX_CASINGS; i++) {
      this.casings.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), spin: new THREE.Vector3(), q: new THREE.Quaternion(), age: 0, life: 3 });
    }
    this.casingNext = 0;
  }

  ejectCasing(pos, dir, up) {
    const c = this.casings[this.casingNext];
    this.casingNext = (this.casingNext + 1) % MAX_CASINGS;
    c.alive = true;
    c.age = 0;
    c.life = 2.4 + Math.random();
    c.p.set(pos.x, pos.y, pos.z);
    c.v.set(
      dir.x * (1.6 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.5,
      up.y * 1.4 + Math.random() * 0.8,
      dir.z * (1.6 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.5
    );
    c.spin.set(Math.random() * 22 - 11, Math.random() * 22 - 11, Math.random() * 22 - 11);
    c.q.identity();
  }

  updateCasings(dt) {
    const zero = this._m4;
    for (let i = 0; i < MAX_CASINGS; i++) {
      const c = this.casings[i];
      if (!c.alive) continue;
      c.age += dt;
      if (c.age > c.life) {
        c.alive = false;
        zero.makeScale(0, 0, 0);
        this.casingMesh.setMatrixAt(i, zero);
        continue;
      }
      c.v.y -= 12 * dt;
      c.p.addScaledVector(c.v, dt);
      const e = new THREE.Euler(c.spin.x * dt, c.spin.y * dt, c.spin.z * dt);
      c.q.multiply(new THREE.Quaternion().setFromEuler(e));
      const fade = c.age > c.life - 0.4 ? (c.life - c.age) / 0.4 : 1;
      this._scale.set(fade, fade, fade);
      zero.compose(c.p, c.q, this._scale);
      this.casingMesh.setMatrixAt(i, zero);
    }
    this.casingMesh.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------- muzzle
  initMuzzle() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: sparkTexture(),
      color: 0xffd08a,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.muzzle = new THREE.Mesh(geo, mat);
    this.muzzle.visible = false;
    this.muzzle.renderOrder = 30;
    this.vmScene.add(this.muzzle);

    this.muzzleLight = new THREE.PointLight(0xffc07a, 0, 9, 2);
    this.scene.add(this.muzzleLight);
    this.muzzleTimer = 0;

    // A separate world-space flash so other players' shots are visible.
    this.worldFlash = new THREE.Mesh(geo, mat.clone());
    this.worldFlash.visible = false;
    this.worldFlash.renderOrder = 30;
    this.scene.add(this.worldFlash);
    this.worldFlashTimer = 0;
  }

  flashMuzzle(localPos, scale = 1, worldPos = null) {
    if (localPos) {
      this.muzzle.position.copy(localPos);
      this.muzzle.rotation.z = Math.random() * Math.PI * 2;
      const s = (0.16 + Math.random() * 0.09) * scale;
      this.muzzle.scale.set(s, s, s);
      this.muzzle.visible = true;
      this.muzzleTimer = 0.045;
    }
    if (worldPos) {
      this.muzzleLight.position.set(worldPos.x, worldPos.y, worldPos.z);
      this.muzzleLight.intensity = 26 * scale;
      this.worldFlash.position.set(worldPos.x, worldPos.y, worldPos.z);
      this.worldFlash.rotation.z = Math.random() * Math.PI * 2;
      const s = (0.34 + Math.random() * 0.2) * scale;
      this.worldFlash.scale.set(s, s, s);
      this.worldFlash.visible = true;
      this.worldFlashTimer = 0.05;
    }
  }

  updateMuzzle(dt, camera) {
    if (this.muzzleTimer > 0) {
      this.muzzleTimer -= dt;
      if (this.muzzleTimer <= 0) this.muzzle.visible = false;
    }
    if (this.worldFlashTimer > 0) {
      this.worldFlashTimer -= dt;
      this.muzzleLight.intensity *= Math.pow(0.0005, dt);
      if (this.worldFlashTimer <= 0) {
        this.worldFlash.visible = false;
        this.muzzleLight.intensity = 0;
      } else if (camera) {
        this.worldFlash.quaternion.copy(camera.quaternion);
      }
    }
    // The first-person flash lives in the view-model scene, so it faces the
    // view-model camera rather than the scene's default axis.
    if (this.muzzle.visible && camera) this.muzzle.quaternion.copy(camera.quaternion);
  }

  // --------------------------------------------------------------- dust
  initDust() {
    const count = 260;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 34;
      pos[i * 3 + 1] = Math.random() * 12;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 34;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.035, color: 0xfff0d8, transparent: true, opacity: 0.30,
      depthWrite: false, sizeAttenuation: true, toneMapped: false,
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
    this.dustBase = pos.slice();
  }

  updateDust(dt, cameraPos) {
    const pos = this.dust.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += dt * 0.16;
      arr[i + 1] += dt * 0.06 * Math.sin(this.time * 0.7 + i);
      // Keep the volume wrapped around the viewer.
      const dx = arr[i] - cameraPos.x;
      const dz = arr[i + 2] - cameraPos.z;
      if (dx > 17) arr[i] -= 34; else if (dx < -17) arr[i] += 34;
      if (dz > 17) arr[i + 2] -= 34; else if (dz < -17) arr[i + 2] += 34;
      const dy = arr[i + 1] - cameraPos.y;
      if (dy > 9) arr[i + 1] -= 12; else if (dy < -3) arr[i + 1] += 12;
    }
    pos.needsUpdate = true;
  }

  // ------------------------------------------------------------ recipes
  impact(point, normal, material) {
    const palette = {
      metal: [1.0, 0.85, 0.5], metalRust: [1.0, 0.72, 0.36], container: [1.0, 0.8, 0.45],
      containerB: [1.0, 0.8, 0.45], glass: [0.8, 0.95, 1.0], wood: [0.85, 0.6, 0.35],
      woodDark: [0.7, 0.5, 0.3], crate: [0.85, 0.65, 0.4], sand: [0.85, 0.75, 0.55],
      dirt: [0.6, 0.5, 0.38], grass: [0.5, 0.7, 0.35], water: [0.7, 0.9, 1.0],
    };
    const col = palette[material] || [0.85, 0.82, 0.78];
    const sparky = material === 'metal' || material === 'metalRust' ||
      material === 'container' || material === 'containerB';

    const n = Math.min(14, sparky ? 12 : 7);
    for (let i = 0; i < n; i++) {
      const spread = sparky ? 1.5 : 0.9;
      this.spawnParticle({
        x: point.x, y: point.y, z: point.z,
        vx: normal.x * (1 + Math.random() * 2) + (Math.random() - 0.5) * spread * 2,
        vy: normal.y * (1 + Math.random() * 2) + Math.random() * spread,
        vz: normal.z * (1 + Math.random() * 2) + (Math.random() - 0.5) * spread * 2,
        life: sparky ? 0.22 + Math.random() * 0.3 : 0.34 + Math.random() * 0.4,
        r: col[0], g: col[1], b: col[2],
        size: sparky ? 0.03 : 0.05,
        gravity: sparky ? 1.1 : 0.5,
        drag: sparky ? 0.93 : 0.88,
      });
    }

    // Dust puff for soft materials.
    if (!sparky) {
      for (let i = 0; i < 5; i++) {
        this.spawnParticle({
          x: point.x + (Math.random() - 0.5) * 0.15,
          y: point.y + (Math.random() - 0.5) * 0.15,
          z: point.z + (Math.random() - 0.5) * 0.15,
          vx: normal.x * 0.6 + (Math.random() - 0.5) * 0.4,
          vy: normal.y * 0.6 + Math.random() * 0.5,
          vz: normal.z * 0.6 + (Math.random() - 0.5) * 0.4,
          life: 0.5 + Math.random() * 0.5,
          r: col[0] * 0.8, g: col[1] * 0.8, b: col[2] * 0.8,
          size: 0.13, gravity: 0.05, drag: 0.9,
        });
      }
    }

    if (material !== 'water') this.bulletHole(point, normal, material === 'glass' ? 0.14 : 0.1);
  }

  /** Frag detonation: fireball, smoke, debris and a bright flash of light. */
  blast(point, radius) {
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * Math.PI * 0.5;
      const sp = 6 + Math.random() * 14;
      this.spawnParticle({
        x: point.x, y: point.y + 0.1, z: point.z,
        vx: Math.cos(a) * Math.cos(e) * sp,
        vy: Math.sin(e) * sp * 0.9,
        vz: Math.sin(a) * Math.cos(e) * sp,
        life: 0.3 + Math.random() * 0.45,
        r: 1.0, g: 0.62 + Math.random() * 0.3, b: 0.22,
        size: 0.09 + Math.random() * 0.09,
        gravity: 0.8, drag: 0.9,
      });
    }
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawnParticle({
        x: point.x, y: point.y + 0.2, z: point.z,
        vx: Math.cos(a) * (1 + Math.random() * 3),
        vy: 1 + Math.random() * 2.5,
        vz: Math.sin(a) * (1 + Math.random() * 3),
        life: 0.8 + Math.random() * 0.7,
        r: 0.3, g: 0.29, b: 0.28,
        size: 0.4, gravity: -0.05, drag: 0.88,
      });
    }
    this.muzzleLight.position.set(point.x, point.y + 0.6, point.z);
    this.muzzleLight.color.setHex(0xffa040);
    this.muzzleLight.intensity = 120;
    this.worldFlashTimer = 0.28;
    this.worldFlash.visible = false;
    void radius;
  }

  /** Flashbang burst — the screen white-out itself is handled by the HUD. */
  flashPop(point) {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.5) * Math.PI;
      const sp = 8 + Math.random() * 12;
      this.spawnParticle({
        x: point.x, y: point.y, z: point.z,
        vx: Math.cos(a) * Math.cos(e) * sp,
        vy: Math.sin(e) * sp,
        vz: Math.sin(a) * Math.cos(e) * sp,
        life: 0.18 + Math.random() * 0.2,
        r: 1, g: 1, b: 1,
        size: 0.07, gravity: 0.2, drag: 0.86,
      });
    }
    this.muzzleLight.position.set(point.x, point.y + 0.4, point.z);
    this.muzzleLight.color.setHex(0xffffff);
    this.muzzleLight.intensity = 200;
    this.worldFlashTimer = 0.2;
    this.worldFlash.visible = false;
  }

  blood(point, dir) {
    for (let i = 0; i < 10; i++) {
      this.spawnParticle({
        x: point.x, y: point.y, z: point.z,
        vx: dir.x * (1 + Math.random() * 2.5) + (Math.random() - 0.5) * 1.4,
        vy: dir.y * 1.2 + Math.random() * 1.4,
        vz: dir.z * (1 + Math.random() * 2.5) + (Math.random() - 0.5) * 1.4,
        life: 0.3 + Math.random() * 0.3,
        r: 0.75, g: 0.05, b: 0.06,
        size: 0.055, gravity: 1.4, drag: 0.9,
      });
    }
  }

  update(dt, camera) {
    this.time += dt;
    this.updateTracers(dt);
    this.updateParticles(dt);
    this.updateCasings(dt);
    this.updateMuzzle(dt, camera);
    if (camera) this.updateDust(dt, camera.position);
  }
}
