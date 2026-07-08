/* Gallery landing — renders models.json as scene sections of clickable model cards.
 * Each card opens viewer.html?scene=<id>&model=<id>; each scene gets a 2-up compare
 * picker (compare.html?scene=&left=&right=). Pure static, no framework. */
import { loadManifest } from './config.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Propagate ?base= to viewer/compare links so a runtime data-host override sticks.
const baseQ = new URLSearchParams(location.search).get('base');
const withBase = (href) => baseQ ? `${href}&base=${encodeURIComponent(baseQ)}` : href;

(async () => {
  const m = await loadManifest();
  document.getElementById('h-title').textContent = m.title || '3DGS Model Browser';
  document.getElementById('h-sub').textContent = m.subtitle || '';

  const root = document.getElementById('scenes');
  let total = 0, present = 0;

  for (const sc of m.scenes) {
    const sec = el('section', 'scene');
    sec.append(el('h2', null, esc(sc.name)));
    if (sc.location) sec.append(el('div', 'meta', `📍 ${esc(sc.location)} · ${sc.models.length} versions`));
    if (sc.blurb) sec.append(el('div', 'blurb', esc(sc.blurb)));

    const grid = el('div', 'grid');
    for (const mod of sc.models) {
      total++;
      const has = mod.size_mb != null;
      if (has) present++;
      const card = el('a', 'card' + (has ? '' : ' missing'));
      card.href = has ? withBase(`./viewer.html?scene=${encodeURIComponent(sc.id)}&model=${encodeURIComponent(mod.id)}`) : '#';
      const tag = mod.tag ? `<span class="tag">${esc(mod.tag)}</span>` : '';
      card.append(el('div', 'row1', `<span class="label">${esc(mod.label)}</span>${tag}`));
      card.append(el('div', 'metrics', esc(mod.metrics || '')));
      const size = has ? `${mod.size_mb} MB · .${mod.file.split('.').pop()}` : 'not staged';
      card.append(el('div', 'foot', `<span class="size">${size}</span><span class="open">${has ? 'open viewer →' : '—'}</span>`));
      grid.append(card);
    }
    sec.append(grid);

    // 2-up compare picker — same world frame, one camera drives both sides
    const avail = sc.models.filter((x) => x.size_mb != null);
    if (avail.length >= 2) {
      const cmp = el('div', 'cmp', `<span class="cmp-t">Compare side-by-side:</span>`);
      const mkSel = (defIdx) => {
        const s = document.createElement('select');
        for (const x of avail) s.append(new Option(x.label, x.id));
        s.selectedIndex = defIdx;
        return s;
      };
      const selL = mkSel(0), selR = mkSel(1);
      const go = el('a', 'cmp-go', 'compare →');
      const sync = () => {
        go.href = withBase(`./compare.html?scene=${encodeURIComponent(sc.id)}&left=${encodeURIComponent(selL.value)}&right=${encodeURIComponent(selR.value)}`);
      };
      selL.addEventListener('change', sync); selR.addEventListener('change', sync); sync();
      cmp.append(selL, el('span', 'cmp-vs', 'vs'), selR, go);
      sec.append(cmp);
    }
    root.append(sec);
  }

  // bring-your-own-model: custom URL or a local file (drag-drop, never uploaded)
  const own = el('section', 'scene');
  own.append(el('h2', null, 'Your own model'));
  own.append(el('div', 'blurb', 'Open any .sog / .spz / .splat / .ply — paste a file URL, or open the viewer and drag a local file onto it (stays in your browser, nothing is uploaded).'));
  const row = el('div', 'ownrow');
  const inp = document.createElement('input');
  inp.type = 'url'; inp.placeholder = 'https://…/model.sog  (any CORS-accessible URL)';
  const goBtn = el('a', 'cmp-go', 'open →');
  const syncOwn = () => { goBtn.href = inp.value ? withBase(`./viewer.html?url=${encodeURIComponent(inp.value)}`) : withBase('./viewer.html?local=1'); };
  inp.addEventListener('input', syncOwn); syncOwn();
  const localView = el('a', 'cmp-go alt', 'local file viewer →');
  localView.href = withBase('./viewer.html?local=1');
  const localCmp = el('a', 'cmp-go alt', 'local 2-up compare →');
  localCmp.href = withBase('./compare.html?local=1');
  row.append(inp, goBtn, localView, localCmp);
  own.append(row);
  root.append(own);

  document.getElementById('foot').innerHTML =
    `${present}/${total} models staged · Spark (World Labs) + Three.js WebGL2 · ` +
    `data base <code>${esc(baseQ || m.data_base)}</code>`;
})().catch((e) => {
  document.getElementById('scenes').innerHTML =
    `<div class="note" style="border-left-color:#ff6b6b">Failed to load models.json — ${esc(e.message)}</div>`;
});
