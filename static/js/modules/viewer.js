import { Viewer, XKTLoaderPlugin }
  from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2/dist/xeokit-sdk.es.js";

// Instancie le viewer v2 sans plugins obsolètes
const viewer = new Viewer({ canvasId: "viewer3d" });
const xktLoader = new XKTLoaderPlugin(viewer);

// Expose un adaptateur global pour l'orchestrateur
window.viewerAdapter = {
  viewer,
  async loadFromFileId(fileId) {
    const urls = [`/static/converted/${fileId}.xkt`, `/models/${fileId}.xkt`];
    let lastErr;
    for (const url of urls) {
      try {
        console.log("[viewer] try xkt", url);
        console.time("[viewer] xkt load");
        const model = await xktLoader.load({ id: fileId, src: url });
        console.timeEnd("[viewer] xkt load");
        if (viewer.model) {
          try { viewer.model.destroy?.(); } catch (err) { console.warn("[viewer] destroy old model", err); }
        }
        viewer.model = model;
        const aabb = (model && model.aabb) || viewer.scene.aabb;
        if (aabb) {
          viewer.cameraControl.fit(aabb);
          console.log("[viewer] fit ok", aabb);
        }
        return true;
      } catch (e) {
        lastErr = e;
      }
    }
    console.error("[viewer] all xkt URLs failed", urls, lastErr);
    return false;
  }
};

try { viewer.canvas.canvas.style.background = "#222"; } catch (e) {}

// Bouton arêtes désactivé (fonction edges indisponible en v2)
const edgesBtn = document.getElementById("edgesBtn");
if (edgesBtn) {
  edgesBtn.disabled = true;
  console.warn("[viewer] edges disabled (xeokit v2)");
  edgesBtn.addEventListener("click", () => {
    console.warn("[viewer] edges disabled (xeokit v2)");
  });
}

export default window.viewerAdapter;

// Charge et applique une position de caméra si disponible
export async function loadCameraPresetOptional(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const cam = await res.json();
    if (cam?.eye && cam?.look && cam?.up) {
      viewer.camera.eye = cam.eye;
      viewer.camera.look = cam.look;
      viewer.camera.up = cam.up;
      console.log("[viewer] preset caméra appliqué", url);
    }
    return cam;
  } catch (e) {
    console.warn("[viewer] preset caméra absent", url);
    return null;
  }
}
