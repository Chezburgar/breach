// Picture-in-picture scopes.
//
// Magnified optics render the world a second time through a narrow field of
// view and show that image inside the ocular, so the scope genuinely magnifies
// instead of faking it with a zoom. Low-power optics skip this entirely — they
// only need the reticle overlay, which is both cheaper and more authentic.

import * as THREE from 'three';
import { VIEW } from '/shared/constants.js';

const PIP_MIN_MAG = 2.0;

export class ScopeRenderer {
  constructor(renderer, worldScene, rig) {
    this.renderer = renderer;
    this.world = worldScene;
    this.magnification = 1;
    this.pip = false;
    this.active = false;
    this.blend = 0;

    const size = renderer.quality === 'ultra' ? 1024 : (renderer.quality === 'low' ? 384 : 768);
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      samples: renderer.quality === 'low' ? 0 : 4,
    });
    this.rt.texture.colorSpace = THREE.NoColorSpace;

    this.camera = new THREE.PerspectiveCamera(20, 1, VIEW.near, VIEW.far);

    // The ocular disc lives in the view-model scene so it draws over the world
    // and over the weapon, exactly where the eyepiece is.
    const geo = new THREE.CircleGeometry(1, 72);
    this.material = new THREE.MeshBasicMaterial({
      map: this.rt.texture,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
    this.disc = new THREE.Mesh(geo, this.material);
    this.disc.renderOrder = 40;
    this.disc.visible = false;
    this.disc.frustumCulled = false;
    // Parented to the view-model camera, so its placement is camera-relative.
    rig.add(this.disc);

    this.radiusPx = 0;
  }

  setWeapon(resolved) {
    this.magnification = resolved.scope.mag;
    this.pip = resolved.scope.pip && this.magnification >= PIP_MIN_MAG;
  }

  /** Field of view the main camera should use while aiming this optic. */
  adsFov(baseFov) {
    // 1x optics tighten slightly; magnified optics take their true zoom unless
    // the picture-in-picture path is handling the magnification.
    if (this.pip) {
      const tan = Math.tan(THREE.MathUtils.degToRad(baseFov) / 2);
      return THREE.MathUtils.radToDeg(2 * Math.atan(tan * 0.80));
    }
    const tan = Math.tan(THREE.MathUtils.degToRad(baseFov) / 2);
    return THREE.MathUtils.radToDeg(2 * Math.atan((tan * 0.78) / this.magnification));
  }

  /**
   * @param {number} blend 0..1 aim-down-sights progress
   * @param {THREE.PerspectiveCamera} camera main world camera
   * @param {THREE.PerspectiveCamera} vmCamera view-model camera
   */
  update(blend, camera, vmCamera, baseFov) {
    this.blend = blend;
    this.active = this.pip && blend > 0.55;
    this.disc.visible = this.active;
    if (!this.active) return;

    // Ocular size on screen, and the matching disc size in the view-model view.
    const h = window.innerHeight;
    const minDim = Math.min(window.innerWidth, h);
    this.radiusPx = minDim * 0.33;

    const dist = 0.45;
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(vmCamera.fov) / 2);
    const radiusWorld = (this.radiusPx / (h / 2)) * halfH;

    this.disc.position.set(0, 0, -dist);
    this.disc.scale.setScalar(radiusWorld);
    this.disc.quaternion.identity();

    // Match the world camera, then narrow the field of view by the optic's
    // magnification.
    this.camera.position.copy(camera.position);
    this.camera.quaternion.copy(camera.quaternion);
    const tan = Math.tan(THREE.MathUtils.degToRad(baseFov) / 2);
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((tan * 0.78) / this.magnification));
    this.camera.aspect = 1;
    this.camera.near = camera.near;
    this.camera.far = camera.far;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Render the magnified view. Call before the main composer render. */
  render() {
    if (!this.active) return;
    this.renderer.renderToTarget(this.world, this.camera, this.rt);
  }

  dispose() {
    this.rt.dispose();
    this.material.dispose();
    this.disc.geometry.dispose();
  }
}
