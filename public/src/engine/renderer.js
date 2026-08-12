// Rendering stack: physically based shading, sky-derived IBL, cascaded-ish sun
// shadows, and a post chain of ambient occlusion, bloom, SMAA and grade.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export const QUALITY_PRESETS = {
  low: {
    pixelRatio: 0.8, shadows: false, shadowMap: 1024, shadowExtent: 40,
    ao: false, bloom: false, smaa: false, grade: true, textureSize: 128, lights: 0,
    aoSamples: 8,
  },
  medium: {
    pixelRatio: 1.0, shadows: true, shadowMap: 1024, shadowExtent: 40,
    ao: false, bloom: true, smaa: true, grade: true, textureSize: 192, lights: 3,
    aoSamples: 8,
  },
  high: {
    pixelRatio: 1.0, shadows: true, shadowMap: 2048, shadowExtent: 52,
    ao: true, bloom: true, smaa: true, grade: true, textureSize: 256, lights: 5,
    aoSamples: 10,
  },
  ultra: {
    pixelRatio: 1.35, shadows: true, shadowMap: 4096, shadowExtent: 70,
    ao: true, bloom: true, smaa: true, grade: true, textureSize: 384, lights: 8,
    aoSamples: 18,
  },
};

export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

// Ceiling on the HDR buffer before bloom.
//
// The sky's sun disc is thousands of units bright. Fed into bloom unclamped it
// smears a white blob across half the screen the moment the sun enters frame.
// Clamping first costs nothing visible — the tone mapper maps everything above
// a few units to white anyway — but keeps the glare to a believable size.
const ClampShader = {
  uniforms: { tDiffuse: { value: null }, uMax: { value: 6.0 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uMax;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(min(texel.rgb, vec3(uMax)), texel.a);
    }
  `,
};

// Final grade: vignette, subtle chromatic aberration at the edges, film grain.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.028 },
    uAberration: { value: 0.0006 },
    uHurt: { value: 0.0 },
    uSaturation: { value: 1.06 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAberration, uHurt, uSaturation;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // Lateral chromatic aberration grows toward the corners.
      float ab = uAberration * (1.0 + uHurt * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + c * ab * 1.4).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - c * ab * 1.4).b;

      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSaturation);

      float vig = 1.0 - uVignette * r2 * 2.0;
      col *= clamp(vig, 0.0, 1.0);

      col = mix(col, vec3(lum * 0.9, lum * 0.16, lum * 0.18), uHurt * 0.55);

      float g = hash(vUv * 900.0 + fract(uTime) * 91.0) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Renderer {
  constructor(canvas, quality = 'high') {
    this.canvas = canvas;
    this.quality = QUALITY_PRESETS[quality] ? quality : 'high';
    this.preset = QUALITY_PRESETS[this.quality];

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // The Sky shader is genuinely HDR — a daylight sky is thousands of times
    // brighter than a shaded wall — so the exposure has to sit low.
    this.renderer.toneMappingExposure = 0.50;
    this.renderer.shadowMap.enabled = this.preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.preset.pixelRatio));

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    this.scene = new THREE.Scene();
    this.vmScene = new THREE.Scene();       // view model, drawn over the world
    this.effectTime = 0;
    this.hurt = 0;

    this.setupLights();
    this.setupSky();
  }

  get gl() { return this.renderer; }

  // --------------------------------------------------------------- setup
  setupLights() {
    this.sun = new THREE.DirectionalLight(0xfff0dc, 3.0);
    this.sun.castShadow = this.preset.shadows;
    this.sun.shadow.mapSize.set(this.preset.shadowMap, this.preset.shadowMap);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 340;
    this.setShadowExtent(this.preset.shadowExtent);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Kept deliberately dim: sky fill this strong washes sun shadows flat.
    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x6a5a44, 0.16);
    this.scene.add(this.hemi);

    // The view model gets its own rig so the weapon reads clearly whatever the
    // player is standing in — a gun lit only by the world goes black indoors.
    // Bright enough to read indoors, not so bright that a gunmetal receiver
    // clips to white — which is what was happening: the slide and the optic
    // housing came out the same flat white as the sky and you could not tell
    // one part of the weapon from another down the sights.
    this.vmKey = new THREE.DirectionalLight(0xfff2e0, 1.5);
    this.vmKey.position.set(-0.6, 1.4, 0.9);
    this.vmFill = new THREE.DirectionalLight(0x9fc4ff, 0.5);
    this.vmFill.position.set(1.2, -0.4, -0.8);
    this.vmRim = new THREE.DirectionalLight(0xffd9b0, 0.45);
    this.vmRim.position.set(0.4, 0.6, -1.2);
    this.vmScene.add(this.vmKey, this.vmFill, this.vmRim, new THREE.AmbientLight(0xffffff, 0.16));

    // Gun finishes are largely metallic, and metal lit only by directional
    // lights renders black — it has almost no diffuse term and needs something
    // to reflect. A fixed studio environment also keeps the weapon looking the
    // same indoors and out, which is what players expect.
    const room = new RoomEnvironment();
    this.vmEnvRT = this.pmrem.fromScene(room, 0.02);
    room.dispose?.();
    this.vmScene.environment = this.vmEnvRT.texture;
    this.vmScene.environmentIntensity = 0.55;
  }

  setShadowExtent(extent) {
    const c = this.sun.shadow.camera;
    c.left = -extent; c.right = extent;
    c.top = extent; c.bottom = -extent;
    c.updateProjectionMatrix();
    this.shadowExtent = extent;
  }

  setupSky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    this.scene.add(this.sky);
    this.sunDir = new THREE.Vector3(1, 1, 1).normalize();
  }

  /** Apply a map's sun, sky and fog, and bake the environment for IBL. */
  applyEnvironment(meta) {
    const sky = meta.sky || {};
    const u = this.sky.material.uniforms;
    u.turbidity.value = sky.turbidity ?? 3.2;
    u.rayleigh.value = sky.rayleigh ?? 1.3;
    u.mieCoefficient.value = sky.mieCoefficient ?? 0.007;
    u.mieDirectionalG.value = sky.mieDirectionalG ?? 0.82;

    const sunCfg = meta.sun || {};
    const phi = THREE.MathUtils.degToRad(90 - (sunCfg.elevation ?? 40));
    const theta = THREE.MathUtils.degToRad(sunCfg.azimuth ?? 130);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);

    this.sun.position.copy(this.sunDir).multiplyScalar(120);
    this.sun.color.setHex(sunCfg.color ?? 0xfff0dc);
    this.sun.intensity = sunCfg.intensity ?? 3.0;

    if (meta.fog) {
      this.scene.fog = new THREE.FogExp2(meta.fog.color ?? 0xbfc8cf, meta.fog.density ?? 0.004);
    } else {
      this.scene.fog = null;
    }

    // Sky-derived irradiance: what makes shaded surfaces read as outdoors.
    // The intensity is deliberately low — the PMREM of an HDR sky carries a lot
    // of energy, and at 1.0 it flattens every surface into white.
    if (this.envRT) this.envRT.dispose();
    const skyScene = new THREE.Scene();
    skyScene.add(this.sky);
    this.envRT = this.pmrem.fromScene(skyScene, 0.03);
    skyScene.remove(this.sky);
    this.scene.add(this.sky);

    // Only the world takes the sky as its environment; the view model keeps
    // its own studio lighting so the weapon reads the same everywhere.
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = meta.envIntensity ?? 0.15;
    this.renderer.toneMappingExposure = meta.exposure ?? 0.50;
  }

  /** Keep the shadow frustum tight around the viewer and snapped to texels. */
  updateShadow(target) {
    if (!this.preset.shadows) return;
    const texel = (this.shadowExtent * 2) / this.preset.shadowMap;
    const sx = Math.round(target.x / texel) * texel;
    const sz = Math.round(target.z / texel) * texel;
    const sy = Math.round(target.y / texel) * texel;
    this.sun.target.position.set(sx, sy, sz);
    this.sun.position.set(
      sx + this.sunDir.x * 130,
      sy + this.sunDir.y * 130,
      sz + this.sunDir.z * 130
    );
    this.sun.target.updateMatrixWorld();
  }

  // ---------------------------------------------------------- composer
  buildComposer(camera, vmCamera) {
    this.camera = camera;
    this.vmCamera = vmCamera;
    if (this.composer) this.composer.dispose();

    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);

    this.composer.addPass(new RenderPass(this.scene, camera));

    if (this.preset.ao) {
      this.gtao = new GTAOPass(this.scene, camera, size.x, size.y);
      this.gtao.output = GTAOPass.OUTPUT.Default;
      this.gtao.updateGtaoMaterial({
        radius: 0.32, distanceExponent: 1.6, thickness: 1.0,
        scale: 1.0, samples: this.preset.aoSamples,
        screenSpaceRadius: false,
      });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, samples: 8 });
      this.gtao.blendIntensity = 0.85;
      this.composer.addPass(this.gtao);
    }

    // View model on top of the world, sharing the same post-processing.
    const vmPass = new RenderPass(this.vmScene, vmCamera);
    vmPass.clear = false;
    vmPass.clearDepth = true;
    this.composer.addPass(vmPass);
    this.vmPass = vmPass;

    if (this.preset.bloom) {
      this.composer.addPass(new ShaderPass(ClampShader));
      // Threshold is in linear HDR, where a daylight sky sits well above 1.
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.30, 0.5, 1.6);
      this.composer.addPass(this.bloom);
    }

    this.composer.addPass(new OutputPass());

    if (this.preset.smaa) {
      this.smaa = new SMAAPass();
      this.composer.addPass(this.smaa);
    }

    if (this.preset.grade) {
      this.grade = new ShaderPass(GradeShader);
      this.composer.addPass(this.grade);
    }
  }

  setQuality(name) {
    if (!QUALITY_PRESETS[name] || name === this.quality) return false;
    this.quality = name;
    this.preset = QUALITY_PRESETS[name];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.preset.pixelRatio));
    this.renderer.shadowMap.enabled = this.preset.shadows;
    this.sun.castShadow = this.preset.shadows;
    this.sun.shadow.mapSize.set(this.preset.shadowMap, this.preset.shadowMap);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.setShadowExtent(this.preset.shadowExtent);
    if (this.camera) this.buildComposer(this.camera, this.vmCamera);
    this.resize();
    return true;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (this.vmCamera) {
      this.vmCamera.aspect = w / h;
      this.vmCamera.updateProjectionMatrix();
    }
  }

  setExposure(v) { this.renderer.toneMappingExposure = v; }

  render(dt) {
    this.effectTime += dt;
    if (this.grade) {
      this.grade.uniforms.uTime.value = this.effectTime;
      this.grade.uniforms.uHurt.value = this.hurt;
    }
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.trackPerformance(dt);
  }

  /**
   * Drop a quality preset if the frame rate stays poor. Sustained low frame
   * rate in a shooter is worse than any visual setting, so this gives ground
   * automatically rather than waiting for the player to find the menu.
   */
  trackPerformance(dt) {
    if (!this.autoQuality || dt <= 0) return;
    this._perfWindow = (this._perfWindow || 0) + dt;
    this._perfFrames = (this._perfFrames || 0) + 1;
    if (this._perfWindow < 4) return;

    const fps = this._perfFrames / this._perfWindow;
    this._perfWindow = 0;
    this._perfFrames = 0;
    if (this._perfGrace > 0) { this._perfGrace--; return; }

    const idx = QUALITY_ORDER.indexOf(this.quality);
    // Stepping down to 'low' is a big visual sacrifice, so it takes a much
    // worse frame rate than the first step down does.
    const threshold = idx > 1 ? 40 : 28;
    if (fps < threshold && idx > 0) {
      const next = QUALITY_ORDER[idx - 1];
      this._perfGrace = 4;
      this.setQuality(next);
      this.onAutoQuality?.(next, Math.round(fps));
    }
  }

  /** Off-screen render, used by the picture-in-picture scopes. */
  renderToTarget(scene, camera, target) {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(prev);
  }

  dispose() {
    this.composer?.dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
  }
}
