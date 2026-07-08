/* 3DGS model browser — single-model interactive viewer.
 *
 * Renders one trained Gaussian-splat model with Spark (World Labs @sparkjsdev/spark)
 * on Three.js + WebGL2 (98%+ device coverage incl. iOS Safari). No build step —
 * importmap -> vendored ES modules. Camera convention + controls are lifted verbatim
 * from webapps/spark-viewer/main.js (c2w row-major R; camAxis(2)=forward, up=-camAxis(1)).
 *
 * Three ways to pick the model:
 *   ?scene=<id>&model=<id>   — manifest entry (file + verified initial camera)
 *   ?url=<file url>          — any .sog/.spz/.splat/.ply URL (&name= label,
 *                              &scene=&model= may still supply a camera preset)
 *   (none) / drag-drop       — drop a local splat file anywhere on the page;
 *                              also replaces the current model while viewing
 */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { resolveModelUrl, loadManifest, fileTypeFromName } from './config.js';

const Q = new URLSearchParams(location.search);
const PR = Q.has('pr') ? Number(Q.get('pr')) : Math.min(window.devicePixelRatio || 1, 3);

const hudTitle = document.getElementById('title');
const hudSub = document.getElementById('sub');
const hudStat = document.getElementById('stat');
const hudErr = document.getElementById('err');
const perfEl = document.getElementById('perf');
const dropEl = document.getElementById('drop');
const setStat = (s) => { hudStat.textContent = s; };
const fail = (e) => { hudErr.textContent = 'ERROR: ' + (e?.stack || e?.message || e); console.error(e); };
window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

// Generic fallback camera for models without a manifest preset (identity c2w at a
// small standoff — forward +z, up -y, the OpenCV/3DGS convention our scenes use).
const DEFAULT_CAM = { pos: [0, 0, -5], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], fy: 456.0, height: 512 };

// ---- resolve which model: manifest entry, direct ?url=, or drop-a-file mode ----
const manifest = await loadManifest().catch(() => null);
const sceneId = Q.get('scene'), modelId = Q.get('model');
const scene_ = manifest?.scenes.find((s) => s.id === sceneId);
const model = scene_?.models.find((m) => m.id === modelId);
const urlParam = Q.get('url');

let SPLAT_URL = null, CAM = DEFAULT_CAM, sizeMB = null;
if (urlParam) {
  SPLAT_URL = urlParam;
  CAM = model?.camera || scene_?.models[0]?.camera || DEFAULT_CAM;
  const name = Q.get('name') || urlParam.split('/').pop().split('?')[0];
  document.title = name;
  hudTitle.textContent = name;
  hudSub.textContent = 'custom URL';
} else if (model) {
  SPLAT_URL = resolveModelUrl(manifest.data_base, model.file);
  CAM = model.camera || DEFAULT_CAM;
  sizeMB = model.size_mb;
  document.title = `${scene_.name} — ${model.label}`;
  hudTitle.textContent = `${scene_.name}`;
  hudSub.textContent = `${model.label}${model.metrics ? ' · ' + model.metrics : ''}`;
} else if (sceneId || modelId) {
  fail(`no such model: scene=${sceneId} model=${modelId}`);
  throw new Error('model not found');
} else {
  // local mode: nothing to fetch — wait for a dropped/picked file
  document.title = 'local splat viewer';
  hudTitle.textContent = 'Local file';
  hudSub.textContent = 'nothing loaded yet';
  dropEl.classList.add('show');
}

// ---- camera (same math as spark-viewer) ----
const cam = { R: CAM.R.slice(), pos: CAM.pos.slice() };
const camAxis = (i) => [cam.R[i], cam.R[3 + i], cam.R[6 + i]];
const worldUp = () => [-cam.R[1], -cam.R[4], -cam.R[7]];

function mat3mul(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    C[3 * r + c] = A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c];
  return C;
}
function axisAngle(axis, ang) {
  const [x, y, z] = axis, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

const container = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(PR);
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

const VFOV = 2 * Math.atan(CAM.height / (2 * CAM.fy)) * 180 / Math.PI;
const camera = new THREE.PerspectiveCamera(VFOV, container.clientWidth / container.clientHeight, 0.1, 3000);

const scene = new THREE.Scene();
const spark = new SparkRenderer({ renderer });
scene.add(spark);

let mesh = null;
function setMesh(opts, statusName) {
  if (mesh) { scene.remove(mesh); mesh.dispose?.(); }
  hudErr.textContent = '';
  mesh = new SplatMesh({
    ...opts,
    onProgress: (e) => {
      if (e && e.total) setStat(`downloading ${statusName}: ${(e.loaded / 1e6).toFixed(1)}/${(e.total / 1e6).toFixed(1)} MB (${Math.round(100 * e.loaded / e.total)}%)`);
      else if (e) setStat(`downloading ${statusName}: ${(e.loaded / 1e6).toFixed(1)} MB…`);
    },
  });
  mesh.quaternion.identity();   // our splat frame matches the camera convention un-flipped (verified)
  scene.add(mesh);
  mesh.initialized.then(() => { setStat('ready — drag to look, WASD to move'); dropEl.classList.remove('show'); }).catch(fail);
}

if (SPLAT_URL) {
  const fileName = SPLAT_URL.split('/').pop();
  setStat(`downloading ${fileName}${sizeMB ? ` (~${sizeMB} MB)` : ''} …`);
  setMesh({ url: SPLAT_URL }, fileName);
}

// ---- local files: drag-drop anywhere, or the file picker in the HUD ----
async function openLocalFile(f) {
  const ft = fileTypeFromName(f.name);
  if (!ft) { fail(`unsupported file type: ${f.name} (want .sog/.spz/.splat/.ply/.ksplat)`); return; }
  setStat(`reading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
  const bytes = new Uint8Array(await f.arrayBuffer());
  document.title = f.name;
  hudTitle.textContent = f.name;
  hudSub.textContent = `local file · ${(f.size / 1e6).toFixed(1)} MB`;
  setMesh({ fileBytes: bytes, fileType: ft }, f.name);
}
window.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.classList.add('show'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget && mesh) dropEl.classList.remove('show'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) openLocalFile(f).catch(fail); else if (mesh) dropEl.classList.remove('show');
});
document.getElementById('pick').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) openLocalFile(f).catch(fail);
});

function syncCamera() {
  const f = camAxis(2);
  camera.up.set(-cam.R[1], -cam.R[4], -cam.R[7]);
  camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
  camera.lookAt(cam.pos[0] + f[0], cam.pos[1] + f[1], cam.pos[2] + f[2]);
}
syncCamera();

// ---- controls (verbatim from spark-viewer/main.js) ----
const keys = {};
let dragging = false, lastX = 0, lastY = 0;
container.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('mouseup', () => { dragging = false; });
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
  cam.R = mat3mul(mat3mul(axisAngle(worldUp(), -dx * 0.0025), axisAngle(camAxis(0), -dy * 0.0025)), cam.R);
});
container.addEventListener('wheel', (e) => {
  e.preventDefault();
  const f = camAxis(2), s = (e.deltaY < 0 ? 1 : -1) * 0.9;
  cam.pos = [cam.pos[0] + f[0] * s, cam.pos[1] + f[1] * s, cam.pos[2] + f[2] * s];
}, { passive: false });
window.addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
function stepKeys(dt) {
  const sp = (keys['shift'] ? 8 : 2.5) * dt;
  const mv = (axis, s) => { const a = camAxis(axis); cam.pos = [cam.pos[0] + a[0] * s, cam.pos[1] + a[1] * s, cam.pos[2] + a[2] * s]; };
  if (keys['w']) mv(2, sp); if (keys['s']) mv(2, -sp);
  if (keys['a']) mv(0, -sp); if (keys['d']) mv(0, sp);
  if (keys['q']) mv(1, -sp); if (keys['e']) mv(1, sp);
}
let lastTouches = [];
const snap = (tl) => [...tl].map((t) => ({ x: t.clientX, y: t.clientY }));
container.addEventListener('touchstart', (e) => { e.preventDefault(); lastTouches = snap(e.touches); }, { passive: false });
container.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const cur = snap(e.touches);
  if (cur.length === 1 && lastTouches.length === 1) {
    const dx = cur[0].x - lastTouches[0].x, dy = cur[0].y - lastTouches[0].y;
    cam.R = mat3mul(mat3mul(axisAngle(worldUp(), -dx * 0.0035), axisAngle(camAxis(0), -dy * 0.0035)), cam.R);
  } else if (cur.length >= 2 && lastTouches.length >= 2) {
    const d0 = Math.hypot(lastTouches[0].x - lastTouches[1].x, lastTouches[0].y - lastTouches[1].y);
    const d1 = Math.hypot(cur[0].x - cur[1].x, cur[0].y - cur[1].y);
    const f = camAxis(2), dolly = (d1 - d0) * 0.02;
    const cx = (cur[0].x + cur[1].x - lastTouches[0].x - lastTouches[1].x) / 2;
    const cy = (cur[0].y + cur[1].y - lastTouches[0].y - lastTouches[1].y) / 2;
    const rgt = camAxis(0), dwn = camAxis(1), k = 0.012;
    cam.pos = [cam.pos[0] + f[0] * dolly - (rgt[0] * cx + dwn[0] * cy) * k,
               cam.pos[1] + f[1] * dolly - (rgt[1] * cx + dwn[1] * cy) * k,
               cam.pos[2] + f[2] * dolly - (rgt[2] * cx + dwn[2] * cy) * k];
  }
  lastTouches = cur;
}, { passive: false });
container.addEventListener('touchend', (e) => { e.preventDefault(); lastTouches = snap(e.touches); }, { passive: false });

function onResize() {
  const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setPixelRatio(PR); renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);
new ResizeObserver(onResize).observe(container);

// ---- render loop + FPS ----
let lastT = performance.now(), fpsFrames = 0, fpsLast = lastT, fpsEMA = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - lastT) / 1000, 0.05); lastT = now;
  stepKeys(dt);
  syncCamera();
  renderer.render(scene, camera);
  fpsFrames++;
  if (now - fpsLast >= 500) {
    const fps = fpsFrames * 1000 / (now - fpsLast);
    fpsEMA = fpsEMA ? fpsEMA * 0.6 + fps * 0.4 : fps;
    perfEl.textContent = `${fpsEMA.toFixed(0)} fps`;
    fpsLast = now; fpsFrames = 0;
  }
});
