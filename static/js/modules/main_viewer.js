import { XeokitModelViewer } from "./viewer.js";
import DFMViewerAdapter from "./DFMViewerAdapter.js";

const modelId = document.body.dataset.modelId;
const app = new XeokitModelViewer("viewerCanvas");
const viewerAdapter = new DFMViewerAdapter(app);
window.viewerAdapter = viewerAdapter;

// --- Compatibilité globale CAD -------------------------------------------------
window.CAD = (typeof window !== "undefined" && window.CAD && typeof window.CAD === "object")
    ? window.CAD
    : {};
if (!window.CAD.heatmap || typeof window.CAD.heatmap !== "object") {
    window.CAD.heatmap = { ready: false };
} else if (typeof window.CAD.heatmap.ready !== "boolean") {
    window.CAD.heatmap.ready = !!window.CAD.heatmap.ready;
}
if (typeof window.CAD.viewer === "undefined") window.CAD.viewer = null;
if (typeof window.CAD.model === "undefined") window.CAD.model = null;
if (typeof window.CAD.modelId === "undefined") window.CAD.modelId = null;
if (typeof window.CAD.heatmap.waiting !== "boolean") window.CAD.heatmap.waiting = false;
if (!window.CAD.ui || typeof window.CAD.ui !== "object") window.CAD.ui = {};

function syncCadGlobals(id) {
    const viewer = app?.viewer || null;
    const effectiveId = typeof id !== "undefined" ? id : window.CAD.modelId;
    const model = app?.sceneModel || viewer?.scene?.models?.[effectiveId] || null;
    window.CAD.viewer = viewer;
    window.CAD.model = model;
    if (typeof effectiveId !== "undefined") {
        window.CAD.modelId = effectiveId;
    }
    try {
        document.dispatchEvent(new CustomEvent("dfm:model:ready", {
            detail: { viewer, model, id: window.CAD.modelId }
        }));
    } catch (err) {
        console.warn("[viewer] dfm:model:ready dispatch failed", err);
    }
}

const originalLoadXKT = typeof app.loadXKT === "function" ? app.loadXKT.bind(app) : null;
if (originalLoadXKT) {
    app.loadXKT = async (...args) => {
        const result = await originalLoadXKT(...args);
        syncCadGlobals(args?.[0]);
        return result;
    };
}

const originalStartPolling = typeof app.startPolling === "function" ? app.startPolling.bind(app) : null;
if (originalStartPolling) {
    app.startPolling = async (...args) => {
        const result = await originalStartPolling(...args);
        syncCadGlobals(args?.[0]);
        return result;
    };
}

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

