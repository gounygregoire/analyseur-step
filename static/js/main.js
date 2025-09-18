// /static/js/main.js
import {
  Viewer,
  XKTLoaderPlugin,
  NavCubePlugin,
  FastNavPlugin
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

const $ = (sel) => document.querySelector(sel);

// Éléments UI
const fileInput      = $("#fileInput");
const btnPick        = $("#btnPick");
const btnVisualiser  = $("#btnVisualiser");
const dropzone       = document.querySelector("[data-dropzone]");
const fileNameLabel  = $("#fileName");

// Crée le viewer sur NOTRE canvas
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  transparent: true,
  dtxEnabled: true
});
new FastNavPlugin(viewer, { flyToDuration: 0.9 });
new NavCubePlugin(viewer, { size: 150, cameraFlyToDuration: 0.9 });

// Chargeur XKT
const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});

// Ouverture du sélecteur
btnPick.addEventListener("click", () => fileInput.click());

// Affiche le nom du fichier choisi
fileInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) {
    fileNameLabel.textContent = f.name;
    dropzone?.classList.remove("is-error", "is-success");
    dropzone?.classList.add("is-ready");
  } else {
    fileNameLabel.textContent = "Aucun fichier sélectionné";
    dropzone?.classList.remove("is-ready");
  }
});

// Drag & Drop
if (dropzone) {
  ["dragenter", "dragover"].forEach(ev =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("is-ready"); })
  );
  ["dragleave", "drop"].forEach(ev =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("is-ready"); })
  );
  dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      // injecte le fichier dans l'input
      const dt = new DataTransfer();
      dt.items.add(f);
      fileInput.files = dt.files;
      fileNameLabel.textContent = f.name;
      dropzone.classList.add("is-ready");
    }
  });
}

// Util: charge un XKT et centre la caméra
async function loadXKT(xktUrl) {
  try {
    // nettoie les modèles précédents
    try { viewer.scene.clear(); } catch (e) {}

    const id = "m" + Date.now();
    const model = xktLoader.load({ id, src: xktUrl, edges: true });

    model.on("loaded", () => {
      console.log("[viewer] model loaded:", id, xktUrl);
      viewer.cameraFlight.flyTo(model); // centre la caméra
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

// Upload + affichage
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
    const res  = await fetch("/upload", { method: "POST", body: fd });
    const json = await res.json();
    console.log("[upload] response:", json);

    if (!res.ok) throw new Error(JSON.stringify(json));
    if (!json.xkt_url) throw new Error("xkt_url manquant dans la réponse");

    const xktUrl = new URL(json.xkt_url, location.origin).toString();
    await loadXKT(xktUrl);

    dropzone?.classList.remove("is-ready", "is-error");
    dropzone?.classList.add("is-success");
  } catch (e) {
    console.error("[upload] failed:", e);
    dropzone?.classList.remove("is-ready");
    dropzone?.classList.add("is-error");
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
