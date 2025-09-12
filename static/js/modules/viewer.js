import { Viewer, XKTLoaderPlugin }
  from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2/dist/xeokit-sdk.es.js";

// Instancie le viewer v2 sans plugins v1
const viewer = new Viewer({ canvasId: "viewer3d" });
const xktLoader = new XKTLoaderPlugin(viewer);

window.viewerAdapter = {
  viewer,
  async loadFromFileId(fileId) {
    const candidates = [`/models/${fileId}.xkt`, `/static/converted/${fileId}.xkt`];
    let chosen = null;
    for (const url of candidates) {
      try {
        const h = await fetch(url, { method: "HEAD", cache: "no-store" });
        console.log("[viewer] HEAD", url, h.status);
        if (h.ok) { chosen = url; break; }
      } catch (_) {}
    }
    if (!chosen) { console.error("[viewer] no XKT reachable", candidates); return false; }
    console.log("[viewer] load", chosen);
    console.time("[viewer] xkt load");
    const model = await xktLoader.load({ src: chosen });
    console.timeEnd("[viewer] xkt load");
    const aabb = (model && model.aabb) || viewer.scene.aabb;
    if (aabb) viewer.cameraControl.fit(aabb);
    console.log("[viewer] fit ok", aabb);
    try { viewer.canvas.canvas.style.background = "#222"; } catch (e) {}
    return true;
  }
};

export default window.viewerAdapter;

export async function loadCameraPresetOptional(u) {
  try {
    const r = await fetch(u, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
