/* Deployment config — the ONE knob that decides where model files are fetched from.
 *
 * Two supported layouts (both mirror CooperScene):
 *
 *   A) Self-contained drop-in  — code + models together in one public dir,
 *      e.g. https://data.ucr.edu/datasets/map_anywhere/ .  Leave DATA_BASE = "".
 *      Model URLs resolve relative to models.json's own "data_base" (./models/).
 *
 *   B) Split (CooperScene-style) — this static site on GitHub Pages (UCR-CISL),
 *      big model files on data.ucr.edu.  Set DATA_BASE to the public data URL;
 *      it overrides models.json's data_base.  CORS must allow the Pages origin.
 *
 * Override at runtime without editing: append ?base=<url> to any page URL.
 * The manifest itself follows the data: when a base is set, <base>/models.json is
 * tried first (so adding models = rsync the data dir, no Pages redeploy) and the
 * copy bundled with the site is only a fallback.
 */
export const DATA_BASE = "";   // "" = use models.json data_base (layout A). e.g. "https://data.ucr.edu/datasets/map_anywhere/models/" for layout B.

const runtimeBase = () => new URLSearchParams(location.search).get("base") || DATA_BASE;

/** Resolve a model's file URL given the manifest's data_base and this override. */
export function resolveModelUrl(manifestDataBase, file) {
  const base = runtimeBase() || manifestDataBase || "./models/";
  return base.replace(/\/?$/, "/") + file;
}

/** Load models.json — from the data base when one is set (fallback: bundled copy).
 * A manifest fetched from the data host describes files sitting next to it, so its
 * data_base is forced to that base. */
export async function loadManifest() {
  const base = runtimeBase();
  if (base) {
    const b = base.replace(/\/?$/, "/");
    try {
      const r = await fetch(b + "models.json", { cache: "no-store" });
      if (r.ok) return { ...(await r.json()), data_base: b };
    } catch (_) { /* fall through to bundled copy */ }
  }
  return await (await fetch("./models.json")).json();
}

/** Map a local file's extension to Spark's SplatFileType (for drag-dropped files,
 * where there is no URL for Spark to sniff). */
export function fileTypeFromName(name) {
  const ext = name.toLowerCase().split(".").pop();
  return { sog: "pcsogszip", zip: "pcsogszip", spz: "spz", splat: "splat", ply: "ply", ksplat: "ksplat" }[ext] || null;
}
