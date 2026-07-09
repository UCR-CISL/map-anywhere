/* Map Anywhere — 3DGS multi-view app: file browser → Load → navigate → "+ Add model"
 * splits the view; every pane is driven by ONE shared camera (spark-2up scissor
 * pattern, generalized to a grid: 1 → full, 2 → side-by-side, 3-4 → 2×2).
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
// Difix3D+ live fixer. Resolution order:
//   1. ?fixer=<url>                      — explicit override
//   2. same-origin /fixer reverse proxy  — when served via serve.py / the xylo
//      port card (works from any laptop, no tunnel, no CORS, no mixed content)
//   3. http://127.0.0.1:8750             — fixer-live running on this machine
const FIXER = await (async () => {
  if (Q.get('fixer')) return Q.get('fixer').replace(/\/$/, '');
  try {
    const proxied = new URL('./fixer', location).href.replace(/\/$/, '');
    const r = await fetch(proxied + '/api/ping');
    if (r.ok) return proxied;
  } catch (_) { /* no proxy on this origin (e.g. GitHub Pages) */ }
  return 'http://127.0.0.1:8750';
})();

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
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });   // buffer kept readable for Difix pane capture
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
// grid geometry: 1 pane → full, 2 → two columns, 3-4 → 2×2. Single source of
// truth for the render tiles, the labels, the DIFIX PiPs and the DIFIX capture.
const grid = (n) => ({ cols: n > 1 ? 2 : 1, rows: n > 2 ? 2 : 1 });
function tileRect(i, n, w, h) {          // CSS px, y from the TOP edge
  const { cols, rows } = grid(n);
  const col = i % cols, row = Math.floor(i / cols);
  const tw = Math.floor(w / cols), th = Math.floor(h / rows);
  const x = col * tw, y = row * th;
  return { col, row, cols, rows, x, y,
           vw: col === cols - 1 ? w - x : tw,
           vh: row === rows - 1 ? h - y : th };
}
function relayoutLabels() {
  labelsEl.innerHTML = '';
  const n = panes.length || 1;
  const { cols, rows } = grid(n);
  panes.forEach((p, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const d = document.createElement('div');
    d.className = 'pane-label';
    d.style.left = `calc(${(100 * col) / cols}vw + 10px)`;
    d.style.top = `calc(${(100 * row) / rows}vh + 10px)`;
    d.style.maxWidth = `calc(${100 / cols}vw - 60px)`;
    d.innerHTML = `<b title="${esc(p.label)}">${esc(p.label)}</b>` +
      `<span class="fx${p.fixOn ? ' on' : ''}" title="Toggle the Difix3D+ live PiP for this view">DIFIX</span>` +
      `<span class="x" title="Remove this view">✕</span>`;
    d.querySelector('.fx').addEventListener('click', () => toggleFix(p));
    d.querySelector('.x').addEventListener('click', () => removePane(p));
    labelsEl.appendChild(d);
    p.labelEl = d;
    if (p.pip) {   // keep the DIFIX PiP window glued to its tile's bottom-right
      p.pip.style.left = `calc(${(100 * (col + 1)) / cols}vw - 330px)`;
      p.pip.style.bottom = `calc(${(100 * (rows - 1 - row)) / rows}vh + ${row === rows - 1 ? 46 : 12}px)`;
    }
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
  pane.fixOn = false;                        // stops its fix loop; overlay removed there
  panes.splice(i, 1);
  reslot();
  pane.mesh?.dispose?.();
  relayoutLabels(); updateStat();
}

// ---- Difix3D+ live fix: capture this pane's tile -> /api/fix_frame -> PiP window ----
// Raw JPEG in/out at PiP resolution (512px wide) keeps the loop at streaming rates.
// Capture = gl.readPixels INSIDE the render loop, right after that tile is drawn
// (mid-frame default-FBO readback is guaranteed by the WebGL spec). Both
// drawImage(webglCanvas) and between-frame readPixels return black under
// SwiftShader/headless and intermittently on some mobile GPUs.
const fullCanvas = document.createElement('canvas');   // tile at device res
const capCanvas = document.createElement('canvas');    // downscaled for the fixer
const PIP_W = 512;
const capReqs = new Map();               // pane index -> resolve; serviced by the render loop.
                                         // A Map (not a single slot) so several DIFIX PiPs can
                                         // stream at once — a single pending slot let pane B's
                                         // request overwrite pane A's, hanging A's loop forever.
function grabTile(i, n, gl) {            // called mid-frame, tile i just rendered
  const w = container.clientWidth, h = container.clientHeight;
  const t = tileRect(i, n, w, h);
  const s = gl.drawingBufferWidth / w;   // CSS px -> device px
  const pw = Math.max(1, Math.round(t.vw * s)), ph = Math.max(1, Math.round(t.vh * s));
  const pyGL = gl.drawingBufferHeight - Math.round(t.y * s) - ph;   // GL y is from the BOTTOM
  const buf = new Uint8Array(pw * ph * 4);
  gl.readPixels(Math.round(t.x * s), pyGL, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return { buf, pw, ph };
}
function capturePane(i) {
  return new Promise((resolve) => {
    capReqs.get(i)?.(null);              // supersede a stale pending request for this tile
    capReqs.set(i, resolve);
  })
    .then((grab) => {
      if (!grab) return null;
      const { buf, pw, ph } = grab;
      const img = new ImageData(pw, ph);
      for (let r = 0; r < ph; r++) {     // flip rows (GL is bottom-up) + force opaque
        const row = buf.subarray((ph - 1 - r) * pw * 4, (ph - r) * pw * 4);
        for (let k = 3; k < row.length; k += 4) row[k] = 255;
        img.data.set(row, r * pw * 4);
      }
      fullCanvas.width = pw; fullCanvas.height = ph;
      fullCanvas.getContext('2d').putImageData(img, 0, 0);
      const cw = Math.min(PIP_W, pw), ch = Math.round(cw * ph / pw);
      capCanvas.width = cw; capCanvas.height = ch;
      capCanvas.getContext('2d').drawImage(fullCanvas, 0, 0, pw, ph, 0, 0, cw, ch);
      // synchronous encode: toBlob's callback can be starved for seconds when the
      // render loop saturates the main thread; toDataURL is ~15ms at 512px
      const bin = atob(capCanvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
      const arr = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      return new Blob([arr], { type: 'image/jpeg' });
    });
}
function ensurePip(pane) {
  if (pane.pip) return;
  const d = document.createElement('div');
  d.className = 'fix-pip';
  d.innerHTML = '<div class="hdr"><span class="t">DIFIX …</span><span class="close">✕</span></div><img />';
  d.querySelector('.close').addEventListener('click', () => toggleFix(pane));
  document.body.appendChild(d);
  pane.pip = d;
  pane.pipHdr = d.querySelector('.t');
  pane.pipImg = d.querySelector('img');
  relayoutLabels();                          // positions the pip over its tile
}
async function fixLoop(pane) {
  let ema = 0;
  while (pane.fixOn && panes.includes(pane)) {
    const i = panes.indexOf(pane);
    const blob = await capturePane(i);
    if (!blob) { await new Promise((r) => setTimeout(r, 200)); continue; }
    const t0 = performance.now();
    try {
      const r = await fetch(FIXER + '/api/fix_frame', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const out = await r.blob();
      if (!pane.fixOn || !panes.includes(pane)) break;
      ensurePip(pane);
      const old = pane.pipImg.src;
      // revoke the PREVIOUS frame only after the new one has decoded — revoking
      // immediately can blank the img while the new blob is still decoding
      pane.pipImg.onload = () => { if (old.startsWith('blob:')) URL.revokeObjectURL(old); };
      pane.pipImg.src = URL.createObjectURL(out);
      const ms = performance.now() - t0;
      ema = ema ? ema * 0.7 + ms * 0.3 : ms;
      pane.fixMs = Math.round(ema);
      pane.pipHdr.textContent = `DIFIX ${(1000 / ema).toFixed(1)} fps`;
    } catch (e) {
      pane.fixOn = false;
      relayoutLabels();
      fail(new Error(`Difix fixer unreachable at ${FIXER} (${e.message || e}) — start it with: python webapps/fixer-live/server.py --port 8750`));
      break;
    }
  }
  pane.pip?.remove();
  pane.pip = null;
}
function toggleFix(pane) {
  pane.fixOn = !pane.fixOn;
  pane.fixMs = 0;
  relayoutLabels();
  if (pane.fixOn) fixLoop(pane).catch(fail);
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

// ---- preload: ?load=<scene>:<model>,<scene>:<model>,... fills panes at boot ----
if (manifest && Q.get('load')) {
  for (const tok of Q.get('load').split(',').slice(0, MAX_PANES)) {
    const [sid, mid] = tok.split(':');
    const sc = manifest.scenes.find((s) => s.id === sid);
    const m = sc?.models.find((x) => x.id === mid);
    if (m) addPane({ url: resolveModelUrl(manifest.data_base, m.file) }, m.label, m.camera);
    else fail(new Error(`?load: no such model "${tok}"`));
  }
}

updateStat();
if (!panes.length) openPicker();
window.__dbg = { panes, slots, cam, capturePane, capReqs };   // debug hook (harmless in production)

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
    const n = panes.length;
    const t0 = tileRect(0, n, w, h);
    camera.aspect = t0.vw / t0.vh; camera.updateProjectionMatrix();
    renderer.setScissorTest(true);
    for (let i = 0; i < n; i++) {
      const t = tileRect(i, n, w, h);
      const gy = h - t.y - t.vh;             // WebGL viewport y is from the BOTTOM edge
      renderer.setViewport(t.x, gy, t.vw, t.vh);
      renderer.setScissor(t.x, gy, t.vw, t.vh);
      renderer.render(slots[i], camera);
      const capResolve = capReqs.get(i);     // DIFIX capture: read this tile back mid-frame
      if (capResolve) {
        capReqs.delete(i);
        capResolve(grabTile(i, n, renderer.getContext()));
      }
    }
    for (const [ri, resolve] of capReqs) {   // requests for since-removed panes: resolve empty
      if (ri >= n) { capReqs.delete(ri); resolve(null); }
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
