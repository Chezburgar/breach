// Development harness: boots the renderer and world, then flies a camera
// around the map so geometry and materials can be eyeballed quickly.
// Not part of the game; served only for authoring.

import * as THREE from 'three';
import { Renderer } from './engine/renderer.js';
import { TextureLab } from './engine/textures.js';
import { WorldView } from './engine/world.js';
import { getMap } from '/shared/maps/index.js';

const hud = document.getElementById('hud');
const params = new URLSearchParams(location.search);
const mapId = params.get('map') || 'estate';
const quality = params.get('q') || 'high';

const t0 = performance.now();
const renderer = new Renderer(document.getElementById('scene'), quality);
const lab = new TextureLab(renderer.gl, { size: renderer.preset.textureSize });

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 900);
const vmCamera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.01, 10);

const map = getMap(mapId);
renderer.applyEnvironment(map);

const tTex = performance.now();
const world = new WorldView(renderer.scene, lab, map, { quality });
world.build();
const tBuild = performance.now();

renderer.buildComposer(camera, vmCamera);
renderer.resize();
addEventListener('resize', () => renderer.resize());

// Fly a slow orbit that also dips down into the streets.
const bounds = map.bounds;
const cx = (bounds.min[0] + bounds.max[0]) / 2;
const cz = (bounds.min[2] + bounds.max[2]) / 2;
const radius = (bounds.max[0] - bounds.min[0]) * 0.42;

let paused = false;
let angle = 0;
let manual = null;
addEventListener('keydown', (e) => {
  if (e.code === 'Space') paused = !paused;
  if (e.code === 'Digit1') manual = { p: [0, 2, 20], look: [0, 1.6, -10] };       // plaza
  if (e.code === 'Digit2') manual = { p: [-6, 2, -40], look: [-6, 1.6, -60] };    // consulate
  if (e.code === 'Digit3') manual = { p: [-16, 2, 46], look: [-4, 3, 60] };       // warehouse
  if (e.code === 'Digit4') manual = { p: [33, 2, 4], look: [55, 3, 4] };          // market
  if (e.code === 'Digit5') manual = { p: [-34, 2, 2], look: [-58, 3, -6] };       // villa
  if (e.code === 'Digit6') manual = { p: [-3, -3.4, -20], look: [-3, -3.6, 10] }; // tunnel
  if (e.code === 'Digit0') manual = null;
});

let last = performance.now();
let frames = 0, fpsAcc = 0, fps = 0;

function step(dtOverride) {
  const now = performance.now();
  const dt = dtOverride ?? Math.min(0.1, (now - last) / 1000);
  last = now;
  frames++; fpsAcc += dt;
  if (fpsAcc > 0.5) { fps = frames / fpsAcc; frames = 0; fpsAcc = 0; }

  if (manual) {
    camera.position.set(...manual.p);
    camera.lookAt(...manual.look);
  } else {
    if (!paused) angle += dt * 0.06;
    const h = 26 + Math.sin(angle * 1.7) * 12;
    camera.position.set(cx + Math.cos(angle) * radius, h, cz + Math.sin(angle) * radius);
    camera.lookAt(cx, 6, cz);
  }

  renderer.updateShadow(camera.position);
  world.update(dt, camera.position);
  renderer.render(dt);

  const info = renderer.gl.info;
  hud.textContent =
    `map      ${map.name} (${mapId})\n` +
    `quality  ${quality}\n` +
    `fps      ${fps.toFixed(0)}\n` +
    `draws    ${info.render.calls}\n` +
    `tris     ${info.render.triangles.toLocaleString()}\n` +
    `textures ${(tTex - t0).toFixed(0)}ms  build ${(tBuild - tTex).toFixed(0)}ms\n` +
    `cam      ${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)}\n` +
    `keys     1-6 viewpoints, 0 orbit, space pause`;
}

function loop() {
  step();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Authoring hooks: lets a frame be rendered and captured even when the tab is
// not compositing (which starves requestAnimationFrame).
window.__preview = {
  step,
  camera,
  renderer,
  world,
  map,
  look(p, at) { manual = { p, look: at }; },
  orbit(a) { manual = null; angle = a; },
  async capture(name) {
    step(1 / 60);
    const png = renderer.gl.domElement.toDataURL('image/png');
    const res = await fetch('/dev/shot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, png }),
    });
    return res.json();
  },
};
