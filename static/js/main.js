// /static/js/main.js
import {
  Viewer,
  XKTLoaderPlugin,
  NavCubePlugin,
  FastNavPlugin
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

const $ = (sel) => document.querySelector(sel);
const fileInput = $("#fileInput");
const btnVisualiser = $("#btnVisualiser");

// --- instancie le viewer sur notre canvas
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  transparent: true,
  dtxEnabled: true
});
new FastNavPlugin(viewer, {flyToDuration: 0.9});
new NavCubePlugin(viewer, {size: 160, cameraFlyToDuration: 0.9});

// chargeur XKT (draco si nécessaire)
const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});

// util: load + fit
async function loadXKT(xktUrl) {
  try {
    // nettoie les modèles précédents
    try { viewer.scene.clear(); } catch(e) {}

    const id = "m" + Date.now();
    const model = xktLoader.load({
      id,
      src: xktUrl,
      edges: true
    });

    model.on("loaded", () => {
      console.log("[viewer] model loaded:", id, xktUrl);
      viewer.cameraFlight.flyTo(model); // centre la caméra sur le modèle
    });

    model.on("error", (e) => {
      console.error("[viewer] model error:", e);
      alert("Erreur d'affichage du modèle (console pour détail).");
    });
  } catch (err) {
    console.error("[viewer] loadXKT failed:", err);
    alert("Impossible de charger le XKT (voir console).");
  }
}

// upload + charge
async function uploadAndShow() {
  const f = fileInput.files?.[0];
  if (!f) {
    alert("Choisis un fichier .step / .stp / .stl.");
    return;
  }
  const fd = new FormData();
  fd.append("file", f);

  btnVisualiser.disabled = true;
  btnVisualiser.textContent = "Conversion…";

  try {
    const res = await fetch("/upload", { method: "POST", body: fd });
    const json = await res.json();
    console.log("[upload] response:", json);

    if (!res.ok) {
      throw new Error(JSON.stringify(json));
    }
    if (!json.xkt_url) {
      throw new Error("xkt_url manquant dans la réponse");
    }

    const xktUrl = new URL(json.xkt_url, location.origin).toString();
    await loadXKT(xktUrl);
  } catch (e) {
    console.error("[upload] failed:", e);
    alert("Erreur de conversion ou de chargement.\nOuvre 'Network' et 'Console' pour le détail.");
  } finally {
    btnVisualiser.disabled = false;
    btnVisualiser.textContent = "VISUALISER";
  }
}

btnVisualiser.addEventListener("click", (e) => {
  e.preventDefault();
  uploadAndShow();
});
