import { XeokitModelViewer } from "./viewer.js";
import DFMViewerAdapter from "./DFMViewerAdapter.js";
import { ensureHeatmapLayer } from "./DraftHeatmap.js";
import { ensureGeometryReady } from "../DFMOrchestrator.js";

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

const scheduleAsyncTask = typeof queueMicrotask === "function"
    ? queueMicrotask
    : (cb) => setTimeout(cb, 0);

function scheduleHeatmapWarmup() {
    const cad = typeof window !== "undefined" ? window.CAD : null;
    if (!cad || !cad.viewer || !cad.model) {
        return;
    }

    const heatmapState = cad.heatmap || (cad.heatmap = {});
    if (heatmapState.prewarm) {
        return;
    }

    heatmapState.prewarm = new Promise((resolve, reject) => {
        scheduleAsyncTask(() => {
            const currentCad = typeof window !== "undefined" ? window.CAD : cad;
            const currentHeatmap = currentCad.heatmap || heatmapState;
            let layer;
            try {
                layer = ensureHeatmapLayer(currentCad);
            } catch (err) {
                console.warn("[heatmap] ensureHeatmapLayer failed", err);
                currentHeatmap.prewarm = null;
                reject(err);
                return;
            }

            if (!layer || typeof layer.awaitReadyAndMaybeWarmup !== "function") {
                currentHeatmap.ready = true;
                resolve(true);
                return;
            }

            let warmupPromise;
            try {
                warmupPromise = layer.awaitReadyAndMaybeWarmup({
                    viewer: currentCad.viewer,
                    model: currentCad.model,
                    maxWaitMs: 12000
                });
            } catch (err) {
                console.warn("[heatmap] warmup start failed", err);
                currentHeatmap.prewarm = null;
                reject(err);
                return;
            }

            if (!warmupPromise || typeof warmupPromise.then !== "function") {
                currentHeatmap.ready = true;
                resolve(true);
                return;
            }

            warmupPromise
                .then((value) => {
                    currentHeatmap.ready = true;
                    resolve(value);
                })
                .catch((err) => {
                    console.warn("[heatmap] warmup failed", err);
                    currentHeatmap.prewarm = null;
                    reject(err);
                });
        });
    });

    if (typeof heatmapState.prewarm?.catch === "function") {
        heatmapState.prewarm.catch(() => {});
    }
}

function syncCadGlobals(id) {
    const previousModel = window.CAD.model || null;
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

    if (model && model !== previousModel) {
        window.CAD.heatmap.ready = false;
        window.CAD.heatmap.prewarm = null;
    }

    if (model && viewer) {
        scheduleHeatmapWarmup();
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

const heatmapBtn = document.getElementById("heatmapBtn");
const HEATMAP_LOADING_MESSAGE = "Chargement de la géométrie…";
const heatmapButtonState = {
    ready: !!(window.CAD?.heatmap?.ready),
    waitingEvent: !!(window.CAD?.heatmap?.waiting),
    fallbackWaiting: false,
    fallbackOverride: false
};

const savedHeatmapTitle = heatmapBtn?.getAttribute("title") || "";

function setHeatmapBusy(waiting) {
    if (!heatmapBtn) {
        return;
    }
    heatmapBtn.setAttribute("aria-busy", waiting ? "true" : "false");
    if (waiting) {
        if (!heatmapBtn.dataset.originalTitle) {
            heatmapBtn.dataset.originalTitle = savedHeatmapTitle;
        }
        heatmapBtn.setAttribute("title", HEATMAP_LOADING_MESSAGE);
    } else {
        const originalTitle = heatmapBtn.dataset.originalTitle ?? "";
        if (originalTitle) {
            heatmapBtn.setAttribute("title", originalTitle);
        } else {
            heatmapBtn.removeAttribute("title");
        }
    }
}

function updateHeatmapButtonState() {
    if (!heatmapBtn) {
        return;
    }
    const waiting = heatmapButtonState.waitingEvent || heatmapButtonState.fallbackWaiting;
    const ready = heatmapButtonState.ready || heatmapButtonState.fallbackOverride;
    const shouldDisable = waiting || !ready;
    heatmapBtn.disabled = shouldDisable;
    setHeatmapBusy(waiting);
}

if (heatmapBtn) {
    document.addEventListener("dfm:heatmap-ready", (event) => {
        const ready = !!(event?.detail?.ready);
        heatmapButtonState.ready = ready;
        if (window.CAD?.heatmap) {
            window.CAD.heatmap.ready = ready;
        }
        if (ready) {
            heatmapButtonState.fallbackOverride = false;
        }
        updateHeatmapButtonState();
    });

    document.addEventListener("dfm:heatmap-wait", (event) => {
        const waiting = !!(event?.detail?.waiting);
        heatmapButtonState.waitingEvent = waiting;
        if (window.CAD?.heatmap) {
            window.CAD.heatmap.waiting = waiting;
        }
        if (waiting) {
            heatmapButtonState.fallbackOverride = false;
        }
        updateHeatmapButtonState();
    });

    heatmapBtn.addEventListener("click", () => {
        const shouldApplyFallback = !heatmapButtonState.ready && !heatmapButtonState.waitingEvent;
        if (shouldApplyFallback) {
            heatmapButtonState.fallbackWaiting = true;
            heatmapButtonState.fallbackOverride = false;
            updateHeatmapButtonState();
            ensureGeometryReady(window.CAD, { maxWaitMs: 12000 })
                .then(() => {
                    heatmapButtonState.fallbackWaiting = false;
                    heatmapButtonState.fallbackOverride = true;
                    updateHeatmapButtonState();
                })
                .catch((err) => {
                    console.warn("[heatmap] ensureGeometryReady failed", err);
                    heatmapButtonState.fallbackWaiting = false;
                    heatmapButtonState.fallbackOverride = false;
                    updateHeatmapButtonState();
                });
        }

        app.toggleHeatmap(!app.heatmapActive);
    });

    updateHeatmapButtonState();
}

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

