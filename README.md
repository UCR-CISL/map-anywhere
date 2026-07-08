# Map Anywhere — 3DGS Model Browser

A public, zero-install web browser for our trained Gaussian-splat reconstructions.
Anybody with the link opens a laptop/phone browser, picks a model, and flies around
it in WebGL. Models stay on the cluster; the browser just streams them.

**This mirrors CooperScene.** CooperScene = static `index.html` on GitHub Pages +
big data files (`.mcap`) on `https://data.ucr.edu/datasets/cooperscene/`, picked from
a dropdown. We keep the exact split — only the viewer changes (Foxglove → Spark, and
`.mcap` → `.spz/.sog/.splat`).

```
index.html + gallery.js + styles.css     # gallery landing: model cards + compare picker + custom-URL box
viewer.html + viewer.js                   # Spark viewer — ?scene=&model=, ?url=<any file>, or drag-drop a local file
compare.html + compare.js                 # 2-up compare, ONE shared camera — ?scene=&left=&right=, ?lurl=&rurl=, or drop on either half
config.js                                 # DATA_BASE — where model files (and models.json) load from
models.json                               # the manifest (built by build_manifest.py)
vendor/                                   # three + spark, self-contained (no build step)
models/                                   # staged splat files + manifest copy (gitignored; rsync to data host)
build_manifest.py                         # regenerate models.json + models/ symlinks
```

**File URLs are customizable at every level** (local now → cloud later without code changes):
1. drag-drop / file picker — any local `.sog/.spz/.splat/.ply`, stays in the browser, zero server
2. `?url=` / `?lurl=&rurl=` — point the viewer/compare at any CORS-accessible file URL
3. `?base=<url>` — runtime override of the whole data host, on any page
4. `config.js DATA_BASE` — the deploy-time default (empty = relative `./models/`)

When a base is set, `<base>/models.json` is fetched first (bundled copy is the fallback),
so **adding a model later = rsync the data dir** — no Pages redeploy.

Everything is static — **no server-side rendering, no build, no node_modules.** The
splats render in the visitor's browser (Spark / World Labs on Three.js WebGL2, ~98%
device coverage incl. iOS Safari).

## Run locally

```bash
python webapps/model-browser/build_manifest.py     # stage models/ symlinks + write models.json
python -m http.server 8080 -d webapps/model-browser
# open http://127.0.0.1:8080/
```

## Add a model

Add a row to `SCENES` in `build_manifest.py` (source path, label, metrics, and a
camera preset — reuse a scene's preset or pull the mid-view from its `meta.json`),
then re-run it. That's the single source of truth; `models.json` is generated.

## Deploy — two layouts (pick one; the code supports both)

### A) Self-contained drop-in (simplest, = CooperScene's public dir)
Put the whole folder — code **and** models — in one public dir. Leave
`config.js` `DATA_BASE = ""` (model URLs stay relative to `models/`).

```bash
python webapps/model-browser/build_manifest.py --copy   # real files, not symlinks
rsync -av webapps/model-browser/  <user>@data.ucr.edu:/datasets/map_anywhere/
# → https://data.ucr.edu/datasets/map_anywhere/
```

### B) Split: code on GitHub Pages (UCR-CISL), models on data.ucr.edu (CooperScene-exact)
Small static site on Pages; heavy splats served from the data host (keeps them out
of git — each is 30–180 MB). **This is the deployed layout**: the site lives in the
dedicated public repo `UCR-CISL/map-anywhere` (digital-twin is private, so Pages
can't come from it) and serves at the org Pages domain, path `/map-anywhere/`.

1. Push code updates to the Pages repo (everything except `models/` symlinks):
   ```bash
   # one-time: git clone https://github.com/UCR-CISL/map-anywhere.git
   rsync -av --exclude models --exclude .gitignore --exclude docs \
     webapps/model-browser/  <map-anywhere checkout>/
   # commit + push; Pages redeploys from main automatically
   ```
2. Data — today (local phase): every model file is reachable via drag-drop or any
   `?url=`/`?base=` you can serve. Later (cloud phase): set `config.js`
   `DATA_BASE = "https://data.ucr.edu/datasets/map_anywhere/models/"` and rsync:
   ```bash
   python webapps/model-browser/build_manifest.py --copy
   rsync -av webapps/model-browser/models/  <user>@data.ucr.edu:/datasets/map_anywhere/models/
   ```
   (`models/` includes `models.json`, so future model additions need only this rsync.)
3. The data host must send CORS `Access-Control-Allow-Origin` for the Pages origin
   (Hang Qiu / whoever provisions `data.ucr.edu` sets this — CooperScene already does
   it for its `.mcap`).

> `?base=<url>` on any page URL overrides `DATA_BASE` at runtime — handy for testing a
> new data host without editing files.

## Notes
- `.sog` (smallest) < `.spz` < `.splat` for the same scene — prefer `.sog/.spz` for the web.
- Camera presets are per-model in `models.json` so each opens at a sensible street view.
- Internal/debugging tool — not advertised. Don't post the link publicly until ready.
