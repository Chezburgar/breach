// The pre-game camera.
//
// A match used to open with the player standing at their spawn staring at a
// wall while a roster overlay counted down. This flies the map instead: a
// scripted pass over the landmarks that decide the round, ending by settling
// into the eye position the player is about to take control of.
//
// The path comes from the map (`meta.intro`) so each map can frame its own
// architecture; anything without one gets a generic orbit derived from its
// bounds, which is dull but never broken.

import * as THREE from 'three';

const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

/** Smoothstep — the ease that makes a dolly look driven rather than lerped. */
const ease = (t) => t * t * (3 - 2 * t);

export class IntroCamera {
  constructor() {
    this.path = null;
    this.lookPath = null;
    this.duration = 0;
    this.fov = 62;
    this.active = false;
  }

  /**
   * Build a path for this map.
   * @param mapData the map
   * @param duration seconds the intro lasts
   */
  begin(mapData, duration) {
    const shots = mapData?.intro?.length ? mapData.intro : genericShots(mapData);
    this.duration = Math.max(2, duration);
    this.active = true;
    this.t = 0;

    this.path = new THREE.CatmullRomCurve3(
      shots.map((s) => new THREE.Vector3(s.p[0], s.p[1], s.p[2])), false, 'catmullrom', 0.25
    );
    this.lookPath = new THREE.CatmullRomCurve3(
      shots.map((s) => new THREE.Vector3(s.at[0], s.at[1], s.at[2])), false, 'catmullrom', 0.25
    );
    this.fov = mapData?.introFov || 58;
  }

  end() { this.active = false; }

  /**
   * Fly the camera. `settle` is the view to hand over to — position and
   * orientation of the player's eye — and the last stretch blends into it so
   * the cut to gameplay is a landing rather than a jump.
   */
  update(dt, camera, settle) {
    if (!this.active || !this.path) return false;
    this.t = Math.min(1, this.t + dt / this.duration);

    // Ease at both ends: a hard start reads as a glitch, a hard stop as a cut.
    const u = ease(this.t);
    this.path.getPointAt(Math.min(0.999, u), _pos);
    this.lookPath.getPointAt(Math.min(0.999, u), _look);

    _m.lookAt(_pos, _look, _up);
    _qa.setFromRotationMatrix(_m);

    // Final fifth: hand over to where the player actually is.
    const HANDOFF = 0.8;
    if (settle && this.t > HANDOFF) {
      const k = ease((this.t - HANDOFF) / (1 - HANDOFF));
      _pos.lerp(settle.position, k);
      _euler.set(settle.pitch, settle.yaw, 0);
      _qb.setFromEuler(_euler);
      _qa.slerp(_qb, k);
    }

    camera.position.copy(_pos);
    camera.quaternion.copy(_qa);

    const wide = this.fov + (1 - u) * 6;
    if (Math.abs(camera.fov - wide) > 0.05) {
      camera.fov = wide;
      camera.updateProjectionMatrix();
    }
    return this.t < 1;
  }
}

/** A slow high orbit, for a map that has not framed itself. */
function genericShots(mapData) {
  const b = mapData?.bounds || { min: [-60, 0, -60], max: [60, 20, 60] };
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const r = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) * 0.42;
  const y = b.min[1] + (b.max[1] - b.min[1]) * 0.55;
  const shots = [];
  for (let i = 0; i <= 5; i++) {
    const a = (i / 5) * Math.PI * 1.2 - Math.PI * 0.6;
    shots.push({
      p: [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r],
      at: [cx, y * 0.35, cz],
    });
  }
  return shots;
}
