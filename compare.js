/* 3DGS model browser — 2-up compare: LEFT/RIGHT split, ONE shared camera.
 *
 * Engine/controls lifted verbatim from webapps/spark-2up/main.js (single renderer,
 * scissor-tiled two columns, one c2w camera driving both). Model picking mirrors
 * viewer.js:
 *   ?scene=<id>&left=<model id>&right=<model id>   — two versions from the manifest
 *   ?lurl=<url>&rurl=<url>                          — any two file URLs (&lname=&rname=)
 *   drag-drop                                       — drop a local file on either half
 * Camera preset comes from the left model (fallback: right, scene's first, generic).
 */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { resolveModelUrl, loadManifest, fileTypeFromName } from './config.js';

const Q = new URLSearchParams(location.search);
const PR = Q.has('pr') ? Number(Q.get('pr')) : Math.min(window.devicePixelRatio || 1, 2.5);

const hudStat = document.getElementById('stat'), hudErr = document.getElementById('err'), perfEl = document.getElementById('perf');
const labels = [document.getElementById('labL'), document.getElementById('labR')];
const dropEl = document.getElementById('drop');
const dropHalves = [document.getElementById('dropL'), document.getElementById('dropR')];
const setStat = (s) => { hudStat.textContent = s; };
const fail = (e) => { hudErr.textContent = 'ERROR: ' + (e?.stack || e?.message || e); console.error(e); };
window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

const DEFAULT_CAM = { pos: [0, 0, -5], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], fy: 456.0, height: 512 };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- resolve the two sides ----
const manifest = await loadManifest().catch(() => null);
const scene_ = manifest?.scenes.find((s) => s.id === Q.get('scene'));
const sides = [
  { key: 'left', urlKey: 'lurl', nameKey: 'lname' },
  { key: 'right', urlKey: 'rurl', nameKey: 'rname' },
].map((k, i) => {
  const m = scene_?.models.find((x) => x.id === Q.get(k.key));
  const url = Q.get(k.urlKey);
  if (m) return { model: m, url: resolveModelUrl(manifest.data_base, m.file), name: m.label, metrics: m.metrics, size_mb: m.size_mb };
  if (url) return { url, name: Q.get(k.nameKey) || url.split('/').pop().split('?')[0], metrics: 'custom URL' };
  return { empty: true, name: i === 0 ? 'left: drop a file' : 'right: drop a file' };
});
if ((Q.get('left') || Q.get('right')) && !scene_) { fail(`no such scene: ${Q.get('scene')}`); throw new Error('scene not found'); }
// shared-camera compare only makes sense when both models live in the same world
// frame; a differing camera preset is our proxy for "different frame" — warn.
if (sides[0].model?.camera && sides[1].model?.camera &&
    JSON.stringify(sides[0].model.camera) !== JSON.stringify(sides[1].model.camera))
  sides[1].metrics = (sides[1].metrics ? sides[1].metrics + ' · ' : '') + '⚠ different world frame — left camera used';
document.title = `compare — ${sides[0].name} vs ${sides[1].name}`;
const setLabel = (i) => { labels[i].innerHTML = `<b>${esc(sides[i].name)}</b>` + (sides[i].metrics ? `<div class="m">${esc(sides[i].metrics)}</div>` : ''); };
setLabel(0); setLabel(1);

// ---- shared camera (left preset wins) ----
const CAM = sides[0].model?.camera || sides[1].model?.camera || scene_?.models[0]?.camera || DEFAULT_CAM;
const cam = { R: CAM.R.slice(), pos: CAM.pos.slice() };
const camAxis = (i) => [cam.R[i], cam.R[3 + i], cam.R[6 + i]];
const worldUp = () => [-cam.R[1], -cam.R[4], -cam.R[7]];
function mat3mul(A, B) { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[3 * r + c] = A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c]; return C; }
function axisAngle(a, ang) { const [x, y, z] = a, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c; return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c]; }

const container = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(PR);
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.autoClear = false;
container.appendChild(renderer.domElement);

const VFOV = 2 * Math.atan(CAM.height / (2 * CAM.fy)) * 180 / Math.PI;
const camera = new THREE.PerspectiveCamera(VFOV, 1, 0.1, 3000);   // aspect set per-frame (half width)

// ---- two scenes, one per tile ----
const meshes = [null, null], loaded = [false, false], bytes = [0, 0], totals = [0, 0];
const scenes = sides.map(() => {
  const sc = new THREE.Scene();
  sc.add(new SparkRenderer({ renderer }));
  return sc;
});
function updateLoad() {
  const want = sides.filter((s) => !s.empty).length;
  const n = loaded.filter(Boolean).length;
  if (!want) { setStat('drop a splat file on each half to compare'); return; }
  const mb = bytes.reduce((a, b) => a + b, 0) / 1e6, tot = totals.reduce((a, b) => a + b, 0) / 1e6;
  setStat(n >= want ? 'ready — one camera drives both sides' : `loading ${n}/${want} · ${mb.toFixed(0)}${tot ? '/' + tot.toFixed(0) : ''} MB`);
}
function setSide(i, opts) {
  if (meshes[i]) { scenes[i].remove(meshes[i]); meshes[i].dispose?.(); }
  loaded[i] = false; bytes[i] = 0; totals[i] = 0; hudErr.textContent = '';
  const m = new SplatMesh({
    ...opts,
    onProgress: (e) => { if (e) { bytes[i] = e.loaded || 0; totals[i] = e.total || 0; updateLoad(); } },
  });
  m.quaternion.identity();   // same un-flipped frame as viewer.js
  m.initialized.then(() => { loaded[i] = true; updateLoad(); }).catch(fail);
  scenes[i].add(m);
  meshes[i] = m;
  updateLoad();
}
sides.forEach((s, i) => { if (!s.empty) setSide(i, { url: s.url }); });
if (sides.every((s) => s.empty)) dropEl.classList.add('show');
updateLoad();

// ---- local files: drop on a half to swap that side ----
async function openLocalFile(i, f) {
  const ft = fileTypeFromName(f.name);
  if (!ft) { fail(`unsupported file type: ${f.name}`); return; }
  sides[i] = { name: f.name, metrics: `local file · ${(f.size / 1e6).toFixed(1)} MB` };
  setLabel(i);
  const bytesArr = new Uint8Array(await f.arrayBuffer());
  setSide(i, { fileBytes: bytesArr, fileType: ft });
}
const hotHalf = (e) => (e.clientX < window.innerWidth / 2 ? 0 : 1);
window.addEventListener('dragover', (e) => {
  e.preventDefault(); dropEl.classList.add('show');
  const h = hotHalf(e);
  dropHalves.forEach((d, i) => d.classList.toggle('hot', i === h));
});
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget && meshes.some(Boolean)) dropEl.classList.remove('show'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) { openLocalFile(hotHalf(e), f).then(() => dropEl.classList.remove('show')).catch(fail); }
  else if (meshes.some(Boolean)) dropEl.classList.remove('show');
});

function syncCamera() {
  const f = camAxis(2);
  camera.up.set(-cam.R[1], -cam.R[4], -cam.R[7]);
  camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
  camera.lookAt(cam.pos[0] + f[0], cam.pos[1] + f[1], cam.pos[2] + f[2]);
}

// ---- controls (verbatim from spark-2up) ----
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
  renderer.setPixelRatio(PR); renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);
new ResizeObserver(onResize).observe(container);

// ---- render loop: clear once, then 2 LEFT/RIGHT tiles from the shared camera ----
let lastT = performance.now(), fpsFrames = 0, fpsLast = lastT, fpsEMA = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - lastT) / 1000, 0.05); lastT = now;
  stepKeys(dt); syncCamera();
  const w = container.clientWidth, h = container.clientHeight;
  const hw = Math.floor(w / 2);
  camera.aspect = hw / h; camera.updateProjectionMatrix();        // half-width, full-height tile
  const tiles = [[0, 0, hw, h], [hw, 0, w - hw, h]];              // left, right (origin bottom-left)
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setScissorTest(true);
  for (let i = 0; i < 2; i++) {
    const [x, y, vw, vh] = tiles[i];
    renderer.setViewport(x, y, vw, vh);
    renderer.setScissor(x, y, vw, vh);
    renderer.render(scenes[i], camera);
  }
  fpsFrames++;
  if (now - fpsLast >= 500) {
    const fps = fpsFrames * 1000 / (now - fpsLast);
    fpsEMA = fpsEMA ? fpsEMA * 0.6 + fps * 0.4 : fps;
    perfEl.textContent = `${fpsEMA.toFixed(0)} fps`;
    fpsLast = now; fpsFrames = 0;
  }
});
