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
CAM_CHAMPION = {  # spark-viewer/main.js INIT — Riverside road+COLMAP frame (verified)
    "pos": [33.909313, -49.517248, -0.025952],
    "R": [-0.99913958, -0.03803566, 0.01653467,
          -0.01645320, -0.00245416, -0.99986163,
           0.03807097, -0.99927337, 0.00182624],
    "fy": 456.0, "height": 512,
}
CAM_RIVERSIDE_V2 = {  # riverside-viewer/main.js INIT (verified)
    "pos": [-0.938530, 6.560274, 0.049549],
    "R": [-0.898136, -0.439413, -0.016387,
           0.018608, -0.000748, -0.999827,
           0.439325, -0.898285,  0.008848],
    "fy": 456.0, "height": 512,
}
CAM_RIVERSIDE_WD = {  # data_winner_d/meta.json mid-view
    "pos": [-13.4229, -21.0238, -0.0358],
    "R": [0.192525, -0.004973, -0.981279,
          0.980102, -0.048264,  0.192539,
         -0.048318, -0.998822, -0.004418],
    "fy": 456.02, "height": 512,
}
CAM_SEATTLE = {  # data_freeze_ft/meta.json mid-view
    "pos": [-29.5722, 13.1031, -0.1626],
    "R": [0.73955, -0.003521, 0.673092,
         -0.673061, -0.014867, 0.739438,
          0.007403, -0.999883, -0.013364],
    "fy": 456.0, "height": 512,
}

# Curated set: the scenes we actually reconstruct (GSV street intersections).
# source is repo-relative. Add rows here to publish a new version.
SCENES = [
    {
        "id": "riverside",
        "name": "Riverside — TC Intersection",
        "location": "33.9757, -117.3399",
        "blurb": "Google Street View pano reconstruction of the traffic-camera intersection. Multiple training recipes over the same COLMAP frame.",
        "models": [
            {"id": "champion", "label": "Champion (road + COLMAP)", "tag": "flagship",
             "source": "webapps/spark-viewer/champion.sog",
             "metrics": "bg PSNR 21.58 · depth-NCC 0.90 · 2.4M splats", "cam": CAM_CHAMPION},
            {"id": "champion_ft2025", "label": "Champion + 2025 finetune", "tag": "",
             "source": "webapps/splat-gradient-viewer/data_champ_ft2025/scene.splat",
             "metrics": "bg PSNR 23.64 · depth-NCC 0.93 (same frame as champion)", "cam": CAM_CHAMPION},
            {"id": "v2_full", "label": "v2 full (all-year)", "tag": "",
             "source": "webapps/riverside-viewer/riverside_v2.splat",
             "metrics": "full 2.4M · GPS-scan frame", "cam": CAM_RIVERSIDE_V2},
            {"id": "winner_d", "label": "winner-D (semantic-freespace)", "tag": "",
             "source": "webapps/splat-compare-riverside/data_winner_d/scene.splat",
             "metrics": "freespace-violation 0.056 (3-seed)", "cam": CAM_RIVERSIDE_WD},
        ],
    },
    {
        "id": "seattle",
        "name": "Seattle — Dense Pano",
        "location": "47.62, -122.35",
        "blurb": "Dense Street View pano capture. Held-out test split; compare training recipes on the same aligned world frame.",
        "models": [
            {"id": "freeze_ft", "label": "Freeze + finetune", "tag": "flagship",
             "source": "webapps/splat-compare-seattle/data_freeze_ft/scene.splat",
             "metrics": "freeze-anchored finetune", "cam": CAM_SEATTLE},
            {"id": "baseline", "label": "Baseline (plain 3DGS)", "tag": "",
             "source": "webapps/splat-compare-seattle/data_baseline/scene.splat",
             "metrics": "canonical baseline", "cam": CAM_SEATTLE},
            {"id": "v4", "label": "v4 (semantic-freespace decay)", "tag": "",
             "source": "webapps/splat-compare-seattle/data_v4/scene.splat",
             "metrics": "semfs violation 0.130 -> 0.056", "cam": CAM_SEATTLE},
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
