import { XeokitModelViewer } from "./viewer.js";
import DFMViewerAdapter from "./DFMViewerAdapter.js";

const modelId = document.body.dataset.modelId;
const app = new XeokitModelViewer("viewerCanvas");
const viewerAdapter = new DFMViewerAdapter(app);
window.viewerAdapter = viewerAdapter;
if (modelId) {
    app.startPolling(modelId);
}

// --- UI bindings -----------------------------------------------------------
const qualityBtn = document.getElementById("qualityToggle");
qualityBtn.addEventListener("click", async () => {
    const mode = await app.toggleQuality();
    qualityBtn.textContent = `Qualité : ${mode === "final" ? "Haute" : "Preview"}`;
});

document.getElementById("heatmapBtn").onclick = () => {
    app.toggleHeatmap(!app.heatmapActive);
};

document.getElementById("wireframeBtn").onclick = () => {
    app.toggleWireframe(!app.edges.enabled);
};

document.getElementById("snapshotBtn").onclick = () => {
    const url = app.snapshot();
    const a = document.createElement("a");
    a.href = url;
    a.download = "snapshot.png";
    a.click();
};

// expose pour tests manuels
window.viewerApp = app;

