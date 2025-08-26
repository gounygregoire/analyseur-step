const viewer = new xeokit.Viewer({
  canvasId: "viewerCanvas",
  transparent: true
});
const xktLoader = new xeokit.XKTLoaderPlugin(viewer);
new xeokit.AxisGizmoPlugin(viewer, {});

let currentJob = null;
let lowLoaded = false;
let pollHandle = null;

function showPlaceholder() {
  document.getElementById("modeBadge").textContent = "";
  document.getElementById("statusText").textContent = "Prévisualisation en cours…";
}

async function checkStatus() {
  const res = await fetch(`/jobs/${currentJob}/status`);
  if (!res.ok) return;
  const data = await res.json();
  if (!lowLoaded && data.low_url) {
    xktLoader.load({ id: "model", src: data.low_url });
    lowLoaded = true;
    document.getElementById("modeBadge").textContent = "Preview";
    document.getElementById("statusText").textContent = "";
    if (viewer.scene.setEdgesEnabled) viewer.scene.setEdgesEnabled(false);
    if (viewer.scene.setSectionPlanesEnabled) viewer.scene.setSectionPlanesEnabled(false);
  }
  if (data.full_url) {
    clearInterval(pollHandle);
    const lowModel = viewer.scene.models["model"];
    if (lowModel) lowModel.destroy();
    xktLoader.load({ id: "model", src: data.full_url });
    if (viewer.scene.setEdgesEnabled) viewer.scene.setEdgesEnabled(true);
    if (viewer.scene.setSectionPlanesEnabled) viewer.scene.setSectionPlanesEnabled(true);
    document.getElementById("modeBadge").textContent = "Full";
  } else if (data.status === "finished_partial") {
    clearInterval(pollHandle);
    document.getElementById("modeBadge").textContent = "Preview";
    alert("Qualité finale indisponible");
  }
}

document.getElementById("uploadForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = document.getElementById("file").files[0];
  if (!file) return;
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    alert(`Fichier trop volumineux (> ${MAX_UPLOAD_MB}MB)`);
    return;
  }
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/upload", { method: "POST", body: fd });
  const data = await res.json();
  currentJob = data.job_id;
  lowLoaded = false;
  showPlaceholder();
  pollHandle = setInterval(checkStatus, 3000);
});
