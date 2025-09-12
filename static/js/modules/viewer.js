import { Viewer, XKTLoaderPlugin }
  from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2/dist/xeokit-sdk.es.js";

// Viewer Xeokit v2 avec loader XKT et recherche d'URL robuste
window.viewerAdapter = (() => {
  const viewer = window._viewer || new Viewer({ canvasId: "viewerCanvas" });
  const xktLoader = new XKTLoaderPlugin(viewer);

  async function pickReachableUrl(id) {
    const urls = [`/models/${id}.xkt`, `/static/converted/${id}.xkt`];
    for (const u of urls) {
      try {
        const h = await fetch(u, { method: "HEAD", cache: "no-store" });
        console.log("[viewer] HEAD", u, h.status);
        if (h.ok) return u;
      } catch {}
    }
    return null;
  }

  async function loadFromFileId(id) {
    const url = await pickReachableUrl(id);
    if (!url) { console.error("[viewer] no reachable XKT"); return false; }
    console.log("[viewer] load", url);
    console.time("[viewer] xkt load");
    const model = await xktLoader.load({ src: url });
    console.timeEnd("[viewer] xkt load");
    const aabb = (model && model.aabb) || viewer.scene.aabb;
    if (aabb) viewer.cameraControl.fit(aabb);
    console.log("[viewer] fit ok", aabb);
    try { viewer.canvas.canvas.style.background = "#e9ecef"; } catch (e) {}
    return true;
  }

  return { viewer, loadFromFileId };
})();

export default window.viewerAdapter;

export async function loadCameraPresetOptional(u) {
  try {
    const r = await fetch(u, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
