/* Map Anywhere — 3DGS multi-view app: file browser → Load → navigate → "+ Add model"
 * splits the view; every pane is driven by ONE shared camera (spark-2up scissor
 * pattern, generalized to N columns).
 *
 * Model sources per pane: manifest entry (models.json — later the data.ucr.edu
 * links), any file URL, or a local file (fileBytes, never uploaded).
 * Engine/controls/camera convention lifted verbatim from viewer.js / compare.js.
 */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { resolveModelUrl, loadManifest, fileTypeFromName } from './config.js';

const Q = new URLSearchParams(location.search);
const PR = Q.has('pr') ? Number(Q.get('pr')) : Math.min(window.devicePixelRatio || 1, 2.5);
const MAX_PANES = 4;

const statEl = document.getElementById('stat'), errEl = document.getElementById('err'), perfEl = document.getElementById('perf');
const addBtn = document.getElementById('add'), labelsEl = document.getElementById('labels');
const setStat = (s) => { statEl.textContent = s; };
const fail = (e) => { errEl.textContent = 'ERROR: ' + (e?.message || e); console.error(e); };
window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

const DEFAULT_CAM = { pos: [0, 0, -5], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], fy: 456.0, height: 512 };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- shared camera ----
const cam = { R: DEFAULT_CAM.R.slice(), pos: DEFAULT_CAM.pos.slice() };
let camIsDefault = true;   // adopt the first loaded model's preset until the user flies away
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

const VFOV = 2 * Math.atan(DEFAULT_CAM.height / (2 * DEFAULT_CAM.fy)) * 180 / Math.PI;
const camera = new THREE.PerspectiveCamera(VFOV, 1, 0.1, 3000);   // aspect set per-frame (tile width)

// ---- panes ----
// Scenes + SparkRenderers are pre-created (Spark stalls when a SparkRenderer is
// added after the render loop starts); at runtime we only move SplatMeshes between
// these fixed slots.
const slots = Array.from({ length: MAX_PANES }, () => {
  const sc = new THREE.Scene();
  sc.add(new SparkRenderer({ renderer }));
  return sc;
});
const panes = [];   // { mesh, label, loading, progress, labelEl }
function reslot() {
  slots.forEach((sc, i) => {
    for (const m of sc.children.filter((c) => c instanceof SplatMesh)) sc.remove(m);
    if (panes[i]) sc.add(panes[i].mesh);
  });
}
function relayoutLabels() {
  labelsEl.innerHTML = '';
  const n = panes.length || 1;
  panes.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'pane-label';
    d.style.left = `calc(${(100 * i) / n}vw + 10px)`;
    d.innerHTML = `<b title="${esc(p.label)}">${esc(p.label)}</b><span class="x" title="Remove this view">✕</span>`;
    d.querySelector('.x').addEventListener('click', () => removePane(p));
    labelsEl.appendChild(d);
    p.labelEl = d;
  });
  addBtn.disabled = panes.length >= MAX_PANES;
}
function updateStat() {
  const loading = panes.filter((p) => p.loading);
  if (!panes.length) setStat('no model loaded — click “+ Add model”');
  else if (loading.length) setStat(`loading ${panes.length - loading.length}/${panes.length} · ${loading.map((p) => p.progress || '').filter(Boolean).join(' · ')}`);
  else setStat(`ready — ${panes.length} view${panes.length > 1 ? 's' : ''}, one shared camera`);
}
function addPane(meshOpts, label, camPreset) {
  errEl.textContent = '';
  const pane = { mesh: null, label, loading: true, progress: '' };
  const mesh = new SplatMesh({
    ...meshOpts,
    onProgress: (e) => {
      if (e && e.total) pane.progress = `${label}: ${Math.round(100 * e.loaded / e.total)}%`;
      else if (e) pane.progress = `${label}: ${(e.loaded / 1e6).toFixed(0)} MB`;
      updateStat();
    },
  });
  mesh.quaternion.identity();   // our splat frame matches the camera convention un-flipped
  mesh.initialized.then(() => { pane.loading = false; updateStat(); }).catch(fail);
  pane.mesh = mesh;
  panes.push(pane);
  if (camPreset && camIsDefault) { cam.R = camPreset.R.slice(); cam.pos = camPreset.pos.slice(); camIsDefault = false; }
  reslot(); relayoutLabels(); updateStat();
}
function removePane(pane) {
  const i = panes.indexOf(pane);
  if (i < 0) return;
  panes.splice(i, 1);
  reslot();
  pane.mesh?.dispose?.();
  relayoutLabels(); updateStat();
}

// ---- file browser (picker modal) ----
const picker = document.getElementById('picker');
const pkModel = document.getElementById('pk-model'), pkUrl = document.getElementById('pk-url'), pkFile = document.getElementById('pk-file');
const srcBoxes = { manifest: document.getElementById('src-manifest'), url: document.getElementById('src-url'), file: document.getElementById('src-file') };
const srcRadio = () => document.querySelector('input[name=src]:checked').value;
const manifest = await loadManifest().catch(() => null);
if (manifest) {
  for (const sc of manifest.scenes) {
    const grp = document.createElement('optgroup');
    grp.label = sc.name;
    for (const m of sc.models) {
      const o = new Option(`${m.label}${m.size_mb ? ` — ${m.size_mb} MB` : ''}${m.metrics ? ` · ${m.metrics}` : ''}`, `${sc.id}:${m.id}`);
      if (m.size_mb == null) { o.disabled = true; o.text += ' (not staged)'; }
      grp.appendChild(o);
    }
    pkModel.appendChild(grp);
  }
  const first = pkModel.querySelector('option:not([disabled])');
  if (first) first.selected = true;
  document.getElementById('pk-manifest-hint').textContent =
    `Served from: ${new URLSearchParams(location.search).get('base') || manifest.data_base}`;
} else {
  srcBoxes.manifest.style.display = 'none';
  document.querySelector('#src-url input[type=url]')?.focus();
  document.querySelector('#src-url h3 input').checked = true;
}
for (const [k, box] of Object.entries(srcBoxes)) {
  box.addEventListener('click', () => {
    box.querySelector('input[type=radio]').checked = true;
    Object.values(srcBoxes).forEach((b) => b.classList.remove('sel'));
    box.classList.add('sel');
  });
}
pkFile.addEventListener('change', () => { srcBoxes.file.click(); });
pkUrl.addEventListener('focus', () => { srcBoxes.url.click(); });

const openPicker = () => { picker.classList.add('show'); };
const closePicker = () => { picker.classList.remove('show'); };
addBtn.addEventListener('click', openPicker);
document.getElementById('cancel').addEventListener('click', closePicker);

document.getElementById('load').addEventListener('click', async () => {
  try {
    const src = srcRadio();
    if (src === 'manifest') {
      const v = pkModel.value;
      if (!v) return;
      const [sid, mid] = v.split(':');
      const sc = manifest.scenes.find((s) => s.id === sid);
      const m = sc.models.find((x) => x.id === mid);
      closePicker();
      addPane({ url: resolveModelUrl(manifest.data_base, m.file) }, m.label, m.camera);
    } else if (src === 'url') {
      const u = pkUrl.value.trim();
      if (!u) return;
      closePicker();
      addPane({ url: u }, u.split('/').pop().split('?')[0] || 'remote model', null);
    } else {
      const f = pkFile.files?.[0];
      if (!f) return;
      const ft = fileTypeFromName(f.name);
      if (!ft) { fail(`unsupported file type: ${f.name}`); return; }
      closePicker();
      setStat(`reading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      addPane({ fileBytes: bytes, fileType: ft }, f.name, null);
      pkFile.value = '';
    }
  } catch (e) { fail(e); }
});

// drag-drop anywhere also adds a pane
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f || panes.length >= MAX_PANES) return;
  const ft = fileTypeFromName(f.name);
  if (!ft) { fail(`unsupported file type: ${f.name}`); return; }
  const bytes = new Uint8Array(await f.arrayBuffer());
  addPane({ fileBytes: bytes, fileType: ft }, f.name, null);
});

updateStat();
if (!panes.length) openPicker();
window.__dbg = { panes, slots, cam };   // debug hook (harmless in production)

// ---- controls (verbatim from spark-2up) ----
function syncCamera() {
  const f = camAxis(2);
  camera.up.set(-cam.R[1], -cam.R[4], -cam.R[7]);
  camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
  camera.lookAt(cam.pos[0] + f[0], cam.pos[1] + f[1], cam.pos[2] + f[2]);
}
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
window.addEventListener('keydown', (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') keys[e.key.toLowerCase()] = true; });
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

// ---- render loop: clear once, then N column tiles from the shared camera ----
let lastT = performance.now(), fpsFrames = 0, fpsLast = lastT, fpsEMA = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - lastT) / 1000, 0.05); lastT = now;
  stepKeys(dt); syncCamera();
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setScissorTest(false);
  renderer.clear();
  if (panes.length) {
    const n = panes.length, tw = Math.floor(w / n);
    camera.aspect = tw / h; camera.updateProjectionMatrix();
    renderer.setScissorTest(true);
    for (let i = 0; i < n; i++) {
      const x = i * tw, vw = i === n - 1 ? w - x : tw;
      renderer.setViewport(x, 0, vw, h);
      renderer.setScissor(x, 0, vw, h);
      renderer.render(slots[i], camera);
    }
  }
  fpsFrames++;
  if (now - fpsLast >= 500) {
    const fps = fpsFrames * 1000 / (now - fpsLast);
    fpsEMA = fpsEMA ? fpsEMA * 0.6 + fps * 0.4 : fps;
    perfEl.textContent = `${fpsEMA.toFixed(0)} fps`;
    fpsLast = now; fpsFrames = 0;
  }
});
