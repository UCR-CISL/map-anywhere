#!/usr/bin/env python3
"""Build models.json for the 3DGS model browser + wire up ./models symlinks.

This is the SOURCE OF TRUTH for which trained 3DGS versions the public browser
shows. Each entry points at an existing reconstruction elsewhere in webapps/ (or
on the cluster). Locally we symlink the file into ./models/<file> so a static
server can serve it; for the real deploy the same ./models/ dir is rsync'd to the
public data host (see README).

Camera presets: each model carries an initial c2w camera (row-major R, world pos)
so the browser opens at a sensible street-level view. Presets come from the
matching viewer's verified INIT block or the mid-view of the scene's meta.json.

Run:  python webapps/model-browser/build_manifest.py
      python webapps/model-browser/build_manifest.py --copy   # copy instead of symlink (for deploy staging)
"""
import argparse
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent            # repo root
MODELS_DIR = HERE / "models"

# c2w row-major R, world-frame pos, fy + render height (for vertical FOV).
CAM_RIVERSIDE = {  # rs_riverside_champion_v2_s42 cameras.json mid-view (shared COLMAP frame, verified)
    "pos": [-13.4229, -21.0238, -0.0358],
    "R": [0.192525, -0.004973, -0.981279,
          0.980102, -0.048264,  0.192539,
         -0.048318, -0.998822, -0.004418],
    "fy": 456.02, "height": 512,
}
CAM_SEATTLE = {  # data_freeze_ft/meta.json mid-view (data/seattle COLMAP frame)
    "pos": [-29.5722, 13.1031, -0.1626],
    "R": [0.73955, -0.003521, 0.673092,
         -0.673061, -0.014867, 0.739438,
          0.007403, -0.999883, -0.013364],
    "fy": 456.0, "height": 512,
}

# Curated set (2026-07-09 correction): per scene, the ablation ladder —
# 1 RGB-only baseline, 2 +depth/COLMAP-depth supervision, 3 +semantic-freespace
# floater eviction (FINAL recipe: vis=0, the "viol 4.64%" method — the vis=1
# occlusion-gated variant was retired per docs/paper_evidence_audit_20260708.md
# Appendix D), 4 = rung-3 skeleton + TEMPORAL finetune (all-year geometry 0-20k
# -> freeze geom -> epoch-restricted appearance 20-30k; docs/ Appendix C).
# Labels carry bg-only PSNR; the eval protocol is EPOCH-MATCHED to the finetune
# pool (seattle 2025/117 views; riverside r5 2025/15 views, r4 2024/63 views) —
# cross-protocol numbers are not comparable (see blurbs).
# All exports are FULL resolution (no downsampling), webapps/model-browser/ladder/,
# spz v3 gzip SH3 (gsbox p2z -sh 3 -ov 3; vendored Spark rejects spz v4).
SCENES = [
    {
        "id": "seattle",
        "name": "Seattle — Dense Pano",
        "location": "47.62, -122.35",
        "blurb": "4-rung ablation ladder on the same COLMAP frame. bg-only PSNR vs the 2025 trajectory val set (117 indist views). Rung 3 = final recipe (semantic-freespace eviction, vis=0, free-space violation -48%); rung 4 = +temporal finetune (geometry frozen, appearance re-fit on 2025-only panos — this is where the colors shift to a single epoch).",
        "models": [
            {"id": "r1", "label": "1 Baseline RGB-only · bgPSNR 22.31", "tag": "",
             "source": "webapps/model-browser/ladder/seattle_r1.spz",
             "metrics": "sfml30k_champ_s42 @30k · full res", "cam": CAM_SEATTLE},
            {"id": "r2", "label": "2 +Depth+COLMAP sup · bgPSNR 21.61", "tag": "",
             "source": "webapps/model-browser/ladder/seattle_r2.spz",
             "metrics": "densab_A2_s42 @30k · full res", "cam": CAM_SEATTLE},
            {"id": "r3", "label": "3 +SemFS eviction (final, vis=0) · bgPSNR 21.28 · viol 4.66%", "tag": "",
             "source": "webapps/model-browser/ladder/seattle_r3.spz",
             "metrics": "rs_semfs2_pc_s42 @30k (champion + sem_freespace 0.2 — the 'viol 4.64%, -48%' method; 3-seed bg 21.35±0.07, viol 4.57±0.11%) · full res", "cam": CAM_SEATTLE},
            {"id": "r4", "label": "4 +Temporal finetune (2025 pool) · bgPSNR 23.51 · viol 4.66%", "tag": "flagship",
             "source": "webapps/model-browser/ladder/seattle_r4.spz",
             "metrics": "rs_semfs2ft_s42 @30k (all-year geom 0-20k -> freeze -> 2025-only appearance; 3-seed bg 23.53±0.03, viol 4.60±0.13% — freeze holds rung-3 geometry) · full res", "cam": CAM_SEATTLE},
        ],
    },
    {
        "id": "riverside",
        "name": "Riverside — TC Intersection",
        "location": "33.9757, -117.3399",
        "blurb": "Ablation ladder on the same COLMAP frame. Rungs 1-3: bg-only PSNR vs the 2025 val set (15 views — only 5 panos from 2025, noisy). Rungs 4/5: EPOCH-MATCHED temporal finetune — eval protocol follows the finetune pool (r4: 2024 pool, 21 panos, 63-view val; r5: 2025 pool, 5 panos, 15-view val = narrow-specialization upper bound). Cross-protocol numbers are not directly comparable.",
        "models": [
            {"id": "r1", "label": "1 Baseline RGB-only · bgPSNR 19.12", "tag": "",
             "source": "webapps/model-browser/ladder/riverside_r1.spz",
             "metrics": "rs_riverside_plain_s42 @30k · full res", "cam": CAM_RIVERSIDE},
            {"id": "r2", "label": "2 +Depth+COLMAP sup · bgPSNR 16.77", "tag": "",
             "source": "webapps/model-browser/ladder/riverside_r2.spz",
             "metrics": "rs_riverside_champion_v2_s42 @30k · full res", "cam": CAM_RIVERSIDE},
            {"id": "r3", "label": "3 +SemFS eviction · bgPSNR 16.12", "tag": "",
             "source": "webapps/model-browser/ladder/riverside_r3.spz",
             "metrics": "rs_riverside_semfs02_s42 @30k · full res", "cam": CAM_RIVERSIDE},
            {"id": "r4", "label": "4 +Temporal finetune (2024 pool) · bgPSNR 22.61 @2024-val", "tag": "flagship",
             "source": "webapps/model-browser/ladder/riverside_r4.spz",
             "metrics": "rs_riverside_semfs02ft24_s42 @30k (geom 0-20k -> freeze -> 2024-only appearance; 21 panos, 63-view val; 3-seed bg 22.57±0.05, viol 5.43±0.03%) · full res", "cam": CAM_RIVERSIDE},
            {"id": "r5", "label": "5 +Temporal finetune (2025 pool, narrow) · bgPSNR 24.80 @2025-val", "tag": "",
             "source": "webapps/model-browser/ladder/riverside_r5.spz",
             "metrics": "rs_riverside_semfs02ft_s42 @30k (2025 pool = only 5 panos -> narrow-specialization upper bound; 15-view val; 3-seed bg 24.76±0.04, viol 5.83±0.10%) · full res", "cam": CAM_RIVERSIDE},
        ],
    },
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--copy", action="store_true", help="copy files instead of symlinking (deploy staging)")
    args = ap.parse_args()

    MODELS_DIR.mkdir(exist_ok=True)
    out_scenes = []
    missing = []
    for sc in SCENES:
        out_models = []
        for m in sc["models"]:
            src = ROOT / m["source"]
            ext = src.suffix                       # .sog / .spz / .splat
            fname = f"{sc['id']}_{m['id']}{ext}"
            dst = MODELS_DIR / fname
            size_mb = None
            if src.exists():
                size_mb = round(src.stat().st_size / 1e6, 1)
                if dst.is_symlink() or dst.exists():
                    dst.unlink()
                if args.copy:
                    import shutil
                    shutil.copy2(src, dst)
                else:
                    dst.symlink_to(os.path.relpath(src, MODELS_DIR))
            else:
                missing.append(m["source"])
            out_models.append({
                "id": m["id"], "label": m["label"], "tag": m.get("tag", ""),
                "file": fname, "size_mb": size_mb, "metrics": m["metrics"],
                "camera": m["cam"],
            })
        out_scenes.append({k: sc[k] for k in ("id", "name", "location", "blurb")} | {"models": out_models})

    manifest = {
        "title": "Map Anywhere — 3DGS Model Browser",
        "subtitle": "Interactive viewer for our trained Gaussian-splat reconstructions",
        "data_base": "./models/",   # override at deploy time (see config.js / README)
        "scenes": out_scenes,
    }
    payload = json.dumps(manifest, indent=2)
    (HERE / "models.json").write_text(payload)
    # copy inside models/ too: the data-host rsync then carries the manifest, so the
    # deployed site (which tries <base>/models.json first) picks up new models
    # without a Pages redeploy.
    (MODELS_DIR / "models.json").write_text(payload)
    n = sum(len(s["models"]) for s in out_scenes)
    print(f"wrote models.json (+ models/models.json): {len(out_scenes)} scenes, {n} models")
    if missing:
        print("MISSING sources (listed but no local file):")
        for x in missing:
            print("  -", x)


if __name__ == "__main__":
    main()
