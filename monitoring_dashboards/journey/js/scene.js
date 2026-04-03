import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BG, BLOOM_S, BLOOM_R, BLOOM_T } from './constants.js';

export const scene = new THREE.Scene();

export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(BG);
document.body.prepend(renderer.domElement);

export const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 800);
camera.position.set(24.7, 25.2, -21.09);

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(-5.88, 1.5, -22.92);
controls.update();

// Let EffectComposer manage render targets internally — it stores
// renderer.getPixelRatio() and multiplies CSS dimensions by it, keeping
// all targets (composer + bloom mips) at the correct drawing-buffer size.
export const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
export const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), BLOOM_S, BLOOM_R, BLOOM_T
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

export const grid = new THREE.GridHelper(300, 120, 0xffffff, 0xffffff);
grid.material.opacity = 0;
grid.material.transparent = true;
scene.add(grid);

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});
