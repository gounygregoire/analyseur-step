// src/main.js
// Viewer Xeokit + outils, aligné avec ton HTML actuel

import {
  Viewer,
  XKTLoaderPlugin,
  GLTFLoaderPlugin,
  DistanceMeasurementsPlugin,
  SectionPlanesPlugin,
  AxisGizmoPlugin
} from "@xeokit/xeokit-sdk";
import DFMViewerAdapter from "../static/js/modules/DFMViewerAdapter.js";
import { waitFor } from "./js/utils/waits.js";
import { ensureHealthyXKT, postReconvert, pollConversionStatus, fetchConversionError } from "./js/xkt/healthCheck.js";
import { showReconvertBanner, updateReconvertBanner, hideReconvertBanner } from "./js/ui/reconvertBanner.js";

const MIN_HEALTHY_XKT = 200000; // 200 KB

let viewer, cameraControl, xktLoader, gltfLoader, dist, sections, canvas;
let activeConversionTask = null;

function getBaseUrl() {
  if (typeof location !== "undefined" && location.origin) {
    return location.origin;
  }
  return "";
}

// CODENAME: HEAD-FIRST-XKT
async function waitForXKTReady({ fileId, xktUrl, maxTries = 60, onReady }) {
  const maxAttempts = Number.isFinite(maxTries) && maxTries > 0 ? Math.floor(maxTries) : 60;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headURL = `/xkt/${fileId}.xkt?nocache=${Date.now()}`;
    let headOk = false;
    let len = 0;

    try {
      const res = await fetch(headURL, { method: "HEAD", cache: "no-store" });
      const clen = res.headers.get("content-length") || res.headers.get("Content-Length");
      len = clen ? Number(clen) : 0;
      console.log("[wait][xkt][head]", { attempt, status: res.status, len });
      if (res.ok && len > 0) headOk = true;
    } catch (e) {
      console.warn("[wait][xkt][head-error]", { attempt, e });
    }

    if (headOk) {
      console.log("[wait][xkt][head-ok] load now", { attempt, len });
      if (typeof onReady === "function") {
        const result = await onReady({ attempt, headUrl: headURL, xktUrl, contentLength: len });
        return typeof result === "undefined" ? true : result;
      }
      return true;
    }

    try {
      const exRes = await fetch(`/exists/xkt/${fileId}?nocache=${Date.now()}`, { cache: "no-store" });
      const exJson = await exRes.json();
      console.log("[wait][xkt][exists]", { attempt, ...exJson });
      if (exJson && exJson.exists === false) {
        console.log("[wait][xkt] exists=false (telemetry only)", { attempt });
        // Continuer la boucle jusqu’à HEAD=200
      }
    } catch (e) {
      console.warn("[wait][xkt][exists-check-failed]", { attempt, e });
    }

    const delay = Math.min(1000 + attempt * 200, 3000);
    await new Promise((r) => setTimeout(r, delay));
  }

  console.warn("[wait] timeout — XKT non prêt");
  return null;
}

function startConversionMonitor(fileId) {
  if (!fileId) return;

  if (activeConversionTask && typeof activeConversionTask.cancel === "function") {
    activeConversionTask.cancel();
  }

  const token = { cancelled: false, cancel() { this.cancelled = true; } };
  activeConversionTask = token;

  const baseUrl = getBaseUrl();

  showReconvertBanner("Conversion en cours…");
  window.setUiProgress?.("Conversion en cours…");

  (async () => {
    let jobId = null;
    const handleStatus = (signal) => {
      if (token.cancelled) return;
      if (signal === "reconvert:queued") {
        updateReconvertBanner("File d'attente…");
        window.setUiProgress?.("Conversion en cours…");
      } else if (signal === "reconvert:started") {
        updateReconvertBanner("Conversion en cours…");
        window.setUiProgress?.("Conversion en cours…");
      } else if (signal === "reconvert:finished") {
        updateReconvertBanner("Conversion terminée.");
        window.setUiProgress?.("");
      } else if (signal === "reconvert:failed") {
        updateReconvertBanner("Conversion échouée.");
        window.setUiProgress?.("");
      }
    };

    try {
      const queued = await postReconvert({ baseUrl, fileId });
      jobId = queued?.job_id || null;
      handleStatus("reconvert:queued");

      const result = await pollConversionStatus({ baseUrl, fileId, onStatus: handleStatus });
      jobId = result.jobId || jobId;

      if (token.cancelled) return;

      if (result.status === "done") {
        hideReconvertBanner();
        window.setUiProgress?.("");
        return;
      }

      const message = await fetchConversionError({ baseUrl, jobId, payload: result.payload });
      const fallback = result.status === "timeout"
        ? "Conversion trop longue. Merci de réessayer."
        : "Conversion échouée.";
      const finalMessage = message || fallback;
      updateReconvertBanner(finalMessage);
      window.setUiProgress?.("");
      if (window.showToast) {
        window.showToast(finalMessage, { type: "error" });
      } else {
        alert(finalMessage);
      }
    } catch (err) {
      if (token.cancelled) return;
      console.error("[conversion] monitor failed", err);
      const msg = err?.message || "Impossible de lancer la conversion.";
      updateReconvertBanner(msg);
      window.setUiProgress?.("");
      if (window.showToast) {
        window.showToast(msg, { type: "error" });
      } else {
        alert(msg);
      }
    } finally {
      if (activeConversionTask === token && !token.cancelled) {
        activeConversionTask = null;
      }
    }
  })();
}

function setHeatmapEnabled(enabled) {
  if (typeof document === "undefined") return;
  document
    .querySelectorAll("[data-role=heatmap-btn], #btn-heatmap, #btnHeatmap")
    .forEach((el) => el.toggleAttribute("disabled", !enabled));
}

async function waitForTrianglesReady(scene, timeoutMs = 12000, intervalMs = 50) {
  if (!scene) throw new Error("SCENE_MISSING");
  await waitFor(() => {
    const count = scene.stats?.numTriangles ?? scene.stats?.triangles ?? 0;
    return Number.isFinite(count) && count > 0;
  }, timeoutMs, intervalMs);
  const value = scene.stats?.numTriangles ?? scene.stats?.triangles ?? 0;
  return Number.isFinite(value) ? value : 0;
}

async function handleHeatmapAvailability(viewerInstance) {
  if (!viewerInstance?.scene) {
    setHeatmapEnabled(false);
    return false;
  }
  try {
    const meshCount = await waitForTrianglesReady(viewerInstance.scene);
    console.log("[viewer] triangles ready:", meshCount);
    setHeatmapEnabled(true);
    return true;
  } catch (err) {
    console.warn("[viewer] mesh wait failed", err);
    setHeatmapEnabled(false);
    return false;
  }
}

async function urlExists(url) {
  const res = await fetch(url, { method: "HEAD", cache: "no-store" });
  return res.ok;
}

async function tryLoadXKTThenGLB(fileId, xktUrl) {
  if (!fileId) throw new Error("file_id absent pour tryLoadXKTThenGLB");
  if (!xktUrl) throw new Error("xktUrl absent pour tryLoadXKTThenGLB");
  if (!xktLoader) throw new Error("xktLoader indisponible");

  let lastError;
  try {
    const model = await xktLoader.load({ id: fileId, src: xktUrl });
    return { model, type: "xkt", src: xktUrl };
  } catch (err) {
    lastError = err;
    console.warn("[viewer] XKT load failed, tentative GLB", err);
  }

  const origin = typeof location !== "undefined" ? location.origin : "";
  const glbUrl = origin ? `${origin}/glb/${fileId}.glb` : `/glb/${fileId}.glb`;

  let exists = false;
  try {
    exists = await urlExists(glbUrl);
  } catch (probeErr) {
    console.warn("[viewer] GLB HEAD check failed", probeErr);
  }

  if (!exists) {
    console.warn("[viewer] GLB fallback skipped (404).", { glbUrl });
    if (lastError) throw lastError;
    throw new Error("GLB fallback indisponible");
  }

  if (!gltfLoader) {
    const err = new Error("GLTF loader indisponible");
    if (lastError) err.cause = lastError;
    throw err;
  }

  try {
    const model = await gltfLoader.load({ id: fileId, src: glbUrl });
    console.log("[viewer] GLB fallback loaded", glbUrl);
    return { model, type: "glb", src: glbUrl };
  } catch (glbErr) {
    console.error("[viewer] GLB fallback failed", glbErr);
    throw glbErr;
  }
}

function hideViewerUI() {
  document.querySelectorAll("[data-viewer-required]").forEach((el) => {
    el.classList.add("d-none");
  });
}

function reportViewerError(err) {
  console.error("initViewer failed", err);
  const banner = document.getElementById("viewerError");
  if (banner) {
    banner.textContent = "Le visualiseur 3D n'a pas pu démarrer.";
    banner.classList.remove("d-none");
  }
  hideViewerUI();
  setHeatmapEnabled(false);
}

// État global partagé (accessible via window.state)
const state = (typeof window !== 'undefined' ? (window.state = window.state || {}) : {});
state.measurements = [];
state.sectionPlane = null;
state.fileLoaded = false;

// ---------- Initialisation ---------------------------------------------------
export async function initViewer(modelUrl) {
  const canvasEl =
    document.getElementById('xeokit-canvas') ||
    document.querySelector('#xeokitCanvas') ||
    document.querySelector('#xktCanvas') ||
    document.querySelector('#viewer3d');
  console.log('[viewer] query canvas', canvasEl);
  const containerEl = document.getElementById('viewerContainer');
  console.log('[viewer] container size', containerEl?.offsetWidth, containerEl?.offsetHeight);
  if (!canvasEl) {
    reportViewerError('canvas introuvable');
    return null;
  }
  try {
    viewer = new Viewer({ canvasElement: canvasEl });
    window.viewer = viewer;

    cameraControl = viewer.cameraControl;

    setHeatmapEnabled(false);

    xktLoader = new XKTLoaderPlugin(viewer);
    try {
      gltfLoader = new GLTFLoaderPlugin(viewer);
    } catch (err) {
      gltfLoader = null;
      console.warn("[viewer] GLTF loader indisponible", err);
    }
    dist = new DistanceMeasurementsPlugin(viewer);
    sections = new SectionPlanesPlugin(viewer);

    // Le fichier n'est considéré comme chargé qu'après l'évènement 'loaded'
    state.fileLoaded = false;
    xktLoader.on?.("loaded", () => {
      state.fileLoaded = true;
      try {
        const aabb = viewer.scene.getAABB();
        cameraControl.fit?.({ aabb });
      } catch {
        try {
          viewer.cameraFlight.fit?.();
        } catch {}
      }
    });

    // Adapte l'app Xeokit pour l'Orchestrateur DFM
    viewer.measure = dist;
    window.viewerAdapter = window.viewerAdapter || new DFMViewerAdapter(viewer);
    window.viewerAdapter.viewer = viewer;
    window.viewerAdapter.loadFromFileId = async function(fileId) {
      if (!fileId) return false;
      // Nettoie l'ancien modèle pour éviter les collisions d'ID dans Xeokit
      if (viewer.model) {
        try { viewer.model.destroy?.(); } catch (err) { console.warn('[viewer] destroy failed', err); }
        viewer.model = null;
      }
      setHeatmapEnabled(false);
      let xktUrl = `/xkt/${fileId}.xkt?t=${Date.now()}`;
      const attemptLoad = async () => {
        console.log('[viewer] XKT ready, loading…', { fileId, xktUrl });
        if (typeof lastXktUrl !== 'undefined') lastXktUrl = xktUrl;
        const urls = [
          xktUrl,
          `/api/simple/models/${fileId}.xkt`,
          `/static/converted/${fileId}.xkt`,
          `/models/${fileId}.xkt`
        ];
        let lastErr;
        for (const url of urls) {
          try {
            console.log("[viewer] try xkt", url);
            window.setUiProgress?.("Chargement du modèle…");
            const { model, type, src } = await tryLoadXKTThenGLB(fileId, url);
            viewer.model = model;
            const aabb = viewer.scene.getAABB();
            try {
              cameraControl.fit?.({ aabb });
            } catch {
              try { viewer.cameraFlight.fit?.({ aabb }); } catch {}
            }
            window.setUiProgress?.("");
            await handleHeatmapAvailability(viewer);
            console.info(`[viewer] modèle ${type} chargé`, src);
            return true;
          } catch (e) {
            lastErr = e;
            window.setUiProgress?.("");
          }
        }
        console.error("[viewer] all xkt URLs failed", urls, lastErr);
        if (typeof window !== "undefined" && typeof window.showError === "function") {
          window.showError("Impossible de charger le modèle 3D");
        }
        setHeatmapEnabled(false);
        return false;
      };

      const loaded = await waitForXKTReady({
        fileId,
        xktUrl,
        onReady: attemptLoad
      });

      if (loaded === null) {
        const waitErr = new Error("XKT_NOT_READY_TIMEOUT");
        console.error('[viewer] waitForXKTReady timeout', { fileId, xktUrl });
        if (typeof window !== "undefined" && typeof window.showError === "function") {
          window.showError("Conversion en cours. Merci de patienter quelques instants et réessayer.");
        }
        throw waitErr;
      }

      return loaded;
    };

    try {
      if (!window.__axes_gizmo__) {
        window.__axes_gizmo__ = new AxisGizmoPlugin(viewer, { canvasId: "axisGizmo" });
      }
    } catch (e) {
      console.warn("AxisGizmoPlugin indisponible", e);
    }

    // Référence directe vers l'élément canvas du viewer
    canvas = viewer.scene.canvas.canvas;

    // Empêcher le scroll de page quand la molette est sur le canvas
    canvas.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });

    // Mesures -> UI
    dist.on?.("measurementCreated", (m) => {
      state.measurements.push(m);
      renderMeasurements();
    });

    if (modelUrl) {
      const model = await xktLoader.load({ id: "current", src: modelUrl });
      viewer.model = model;
      await handleHeatmapAvailability(viewer);
    }

    bindUI();
    return viewer;
  } catch (e) {
    reportViewerError(e);
    return null;
  }
}
if (typeof window !== 'undefined') {
  window.initViewer = initViewer;
}

// Chargement auto via data-model
export function initUI() {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[viewer] DOMContentLoaded');
    const fname = document.body.dataset.model;
    initViewer(fname ? `/uploads/${fname}` : undefined);
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initUI();
}

// ---------- UI ---------------------------------------------------------------
function bindUI() {
  const root = document;
  if (root.__viewer_ui_bound__) return;
  root.__viewer_ui_bound__ = true;

  const uiState = (window.__viewerState__ = window.__viewerState__ || {
    measuring: false,
    sectioning: false,
  });

  const btnFit = byId("fitBtn");
  if (btnFit && window.viewer) {
    btnFit.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      btnFit.classList.add("active");
      try {
        if (viewer.scene?.root) {
          viewer.cameraFlight.flyTo(viewer.scene.root);
        } else {
          viewer.cameraFlight.fit?.();
        }
      } catch {
        try {
          viewer.cameraFlight.fit?.();
        } catch {}
      } finally {
        setTimeout(() => btnFit.classList.remove("active"), 250);
      }
    });
  }

  const btnMeasure = byId("measureBtn");
  if (btnMeasure && dist) {
    btnMeasure.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      uiState.measuring = !uiState.measuring;
      btnMeasure.classList.toggle("active", uiState.measuring);
      if (dist.control?.activate) dist.control.activate(uiState.measuring);
      if (typeof dist.setActive === "function") dist.setActive(uiState.measuring);
      if (typeof dist.enable === "function") dist.enable(uiState.measuring);
    });
  }

  // Reset mesures
  byId("clearMeasures")?.addEventListener("click", () => {
    try {
      dist.clear?.();
    } catch {}
    state.measurements.forEach((m) => m.destroy?.());
    state.measurements.length = 0;
    renderMeasurements();
  });

  const btnSection = byId("sectionBtn");
  if (btnSection && sections) {
    btnSection.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      uiState.sectioning = !uiState.sectioning;
      btnSection.classList.toggle("active", uiState.sectioning);
      if (uiState.sectioning) {
        if (!state.sectionPlane) {
          state.sectionPlane =
            sections.createPlane?.({ dir: [0, 1, 0] }) ||
            sections.createSectionPlane?.({ dir: [0, 1, 0] });
        }
        sections.setVisible?.(true);
        if (state.sectionPlane) state.sectionPlane.active = true;
      } else {
        sections.setVisible?.(false);
        if (state.sectionPlane) state.sectionPlane.active = false;
      }
    });
  }

  // Sliders coupes (3 plans UI mappés sur Y)
  document.querySelectorAll(".section-control input")?.forEach((slider) => {
    slider.addEventListener("input", () => {
      if (!state.sectionPlane) {
        state.sectionPlane =
          sections.createPlane?.({ dir: [0, 1, 0] }) ||
          sections.createSectionPlane?.({ dir: [0, 1, 0] });
        state.sectionPlane.active = true;
        toggleActive("sectionBtn", true);
      }
      const aabb = viewer.scene.getAABB();
      const minY = aabb[1], maxY = aabb[4];
      const y = minY + ((Number(slider.value) + 1) / 2) * (maxY - minY);
      state.sectionPlane.pos = [0, y, 0];
      viewer.scene.glRedraw?.();
    });
  });

  // Arêtes (fallback filaire, fonctionnalité edges indisponible)
  const edgesBtnEl = byId("edgesBtn");
  if (edgesBtnEl) {
    edgesBtnEl.disabled = true;
    edgesBtnEl.addEventListener("click", () => {
      console.warn('[viewer] edges disabled (xeokit v2)');
    });
  }

  // Reset complet
  byId("resetBtn")?.addEventListener("click", resetAll);

  // Export PNG
  byId("pngBtn")?.addEventListener("click", () => {
    const data = viewer.getSnapshot();
    const a = document.createElement("a");
    a.download = "capture.png";
    a.href = data;
    a.click();
  });
  setupContextMenu();
  setupTooltip();
}

// ---------- Mesures ---------------------------------------------------------
function renderMeasurements() {
  const list = byId("measureList");
  if (!list) return;
  list.innerHTML = "";
  state.measurements.forEach((m, i) => {
    const len = typeof m.length === "number" ? m.length : (m.getLength?.() ?? 0);
    const li = document.createElement("li");
    li.textContent = `Mesure ${i + 1}: ${len.toFixed(2)} mm`;
    list.appendChild(li);
  });
}

// ---------- Menu contextuel / Tooltip ---------------------------------------
function setupContextMenu() {
  const menu = byId("contextMenu");
  if (!menu || !canvas) return;
  const canvasEl = canvas;

  canvasEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
    if (!hit || !hit.entity) return;
    menu.dataset.id = hit.entity.id;
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.classList.add("show");
  });

  document.addEventListener("click", () => menu.classList.remove("show"));

  menu.addEventListener("click", (e) => {
    const id = menu.dataset.id;
    const action = e.target?.dataset?.action;
    if (action === "hide")    hide(id);
    if (action === "showAll") showAll();
    menu.classList.remove("show");
  });
}

function setupTooltip() {
  if (!canvas) return;
  const canvasEl = canvas;
  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  document.body.appendChild(tooltip);

  canvasEl.addEventListener("mousemove", (e) => {
    const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
    if (hit && hit.entity) {
      tooltip.textContent = hit.entity.id;
      tooltip.style.left = `${e.clientX + 10}px`;
      tooltip.style.top  = `${e.clientY + 10}px`;
      tooltip.classList.add("show");
    } else {
      tooltip.classList.remove("show");
    }
  });

  canvasEl.addEventListener("dblclick", (e) => {
    const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
    if (hit && hit.entity) {
      cameraControl.fit?.({ aabb: hit.entity.aabb });
    }
  });
}

// ---------- Helpers ---------------------------------------------------------
function fitScene() {
  try {
    const aabb = viewer.scene.getAABB();
    cameraControl.fit?.({ aabb });
  } catch {}
}

function hide(id) {
  viewer.scene.setObjectVisible(id, false);
}

function showAll() {
  viewer.scene.setObjectsVisible(viewer.scene.objects, true);
}

function setWireframe(on) {
  const objs = viewer.scene.objects;
  for (const id in objs) {
    objs[id].wireframe = on;
  }
  viewer.scene.objectsWireframe = on;
}

function resetAll() {
  showAll();
  try { dist.clear?.(); } catch {}
  state.measurements.length = 0;
  if (state.sectionPlane) state.sectionPlane.active = false;
  // edges plugin absent → on s'assure de couper le filaire
  setWireframe(false);
  cameraControl.reset?.();
  renderMeasurements();
  ["measureBtn","sectionBtn"].forEach((id) => toggleActive(id, false));
}

function toggleActive(id, on) {
  const btn = document.getElementById(id);
  btn?.classList.toggle("active", on);
}

function byId(name) {
  return document.getElementById(name);
}

// ----------- Historique ----------------------------------------------------
function renderHistory(entries) {
  const tbody = document.getElementById('historyTableBody');
  const loading = document.getElementById('historyLoading');
  if (loading) loading.classList.add('d-none');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!entries || !entries.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Aucun historique de conversion disponible</td></tr>';
    return;
  }
  entries.forEach((e) => {
    const status = e.dfm_score !== undefined ? 'analyzed' : (e.xkt_ready ? 'converted' : 'uploaded');
    const score = e.dfm_score !== undefined ? e.dfm_score : '';
    const date = e.created_at ? new Date(e.created_at).toLocaleString() : '';
    const actions = e.report_id ? `<a href="/reports/${e.report_id}.html" class="btn btn-sm btn-outline-primary">Voir</a>` : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${e.filename || e.file_id}</td><td>${date}</td><td>${status}</td><td>${score}</td><td>${actions}</td>`;
    tbody.appendChild(tr);
  });
}

function refreshHistory(entries) {
  let data = Array.isArray(entries) ? entries : null;
  if (!data && typeof window !== 'undefined' && Array.isArray(window.__historyEntries)) {
    data = window.__historyEntries;
  }
  if (!data) data = [];
  renderHistory(data);
}

if (typeof window !== 'undefined') {
  window.refreshHistory = refreshHistory;
  document.addEventListener('DOMContentLoaded', () => refreshHistory());
}

(function wireUploadAndPreview(){
  const uploadArea =
    document.getElementById('uploadArea') ||
    document.querySelector('.upload-area') ||
    document.querySelector('[data-dropzone]');

  if (!uploadArea) {
    return;
  }

  if (uploadArea.dataset.previewBound === '1') return;
  uploadArea.dataset.previewBound = '1';

  const fileInput =
    document.getElementById('fileInput') ||
    uploadArea.querySelector('input[type="file"]');
  const dropzone =
    document.getElementById('dropzone') ||
    uploadArea.querySelector('.dropzone') ||
    uploadArea;
  const visualizeBtn = document.getElementById('visualizeBtn');

  // ---- Helpers ----
let lastXktUrl = null;

function setHasFileUI(has){
  if (!dropzone) return;
  dropzone.classList.toggle('has-file', !!has);
}
function enableVisualizeBtn(enable){
  if (!visualizeBtn) return;
  visualizeBtn.disabled = !enable;
  visualizeBtn.setAttribute('aria-disabled', String(!enable));
}
function showLoading(state){
  if (visualizeBtn) visualizeBtn.classList.toggle('is-loading', !!state);
}

/** Expose un fileId dans tous les points d’accès attendus par l’app */
function exposeFileId(incomingId) {
  if (!incomingId) return;
  if (!this.fileId) this.fileId = incomingId;
  else if (this.fileId !== incomingId) console.warn('[ID] ignore new id', incomingId, 'keep', this.fileId);

  const fileId = this.fileId;

  // 1) champ caché
  const h = document.getElementById('fileId');
  if (h && h.type === 'hidden') h.value = fileId;

  // 2) dataset du <body>
  document.body.dataset.fileid = fileId;

  // 3) globaux simples pour l’orchestrateur / viewer
  window.CADLYTICS = window.CADLYTICS || {};
  window.CADLYTICS.current = { fileId };

  window.viewerAdapter = window.viewerAdapter || {};
  window.viewerAdapter.current = { fileId };

  // 4) petit état UI
  window.state = window.state || {};
  window.state.fileLoaded = true;

  window.dispatchEvent(new CustomEvent('dfm:fileReady', { detail: { fileId } }));
  console.info('[upload] file_id=', fileId);
}

/** Appelle /upload pour stocker le STEP et mémoriser le file_id. */
async function uploadStepFile(file){
  if (!file) return;
  try{
    showLoading(true);
    fileInput.disabled = true;
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/simple/upload', { method:'POST', body: fd });
    const data = await res.json().catch(()=>({}));
    if (!res.ok){
      const msg = data.detail || data.error || `upload failed (${res.status})`;
      window.showToast ? showToast(msg,{type:'error'}) : alert(msg);
      setHasFileUI(false);
      return;
    }
    if (!data.file_id){
      throw new Error('file_id manquant');
    }
    exposeFileId.call(state, data.file_id);
    startConversionMonitor(data.file_id);
    lastXktUrl = null;
    window.refreshHistory?.();
  }catch(e){
    console.error('[upload] error', e);
    window.showToast ? showToast('Upload échoué',{type:'error'}) : alert('Upload échoué');
    setHasFileUI(false);
  }finally{
    fileInput.disabled = false;
    showLoading(false);
    enableVisualizeBtn(!!state.fileId);
  }
}

/** Lance la conversion en XKT pour le file_id courant. */
async function convertCurrent(){
  const fileId = state.fileId;
  if (!fileId){
    const msg = 'Importe un STEP d\u2019abord.';
    window.showToast ? showToast(msg,{type:'error'}) : alert(msg);
    return;
  }
  try{
    showLoading(true);
    enableVisualizeBtn(false);
    const res = await fetch('/api/simple/convert', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ file_id: fileId, tolerance: 0.1 })
    });
    const data = await res.json().catch(()=>({}));
    if (!res.ok){
      const msg = data.detail || data.error || `convert failed (${res.status})`;
      window.showToast ? showToast(msg,{type:'error'}) : alert(msg);
      return;
    }
    console.info('[convert] file_id=', fileId);
    window.setUiProgress?.('Conversion en cours…');
    await loadXKTFromConvertResponse.call(state, { file_id: fileId });
    window.refreshHistory?.();
  }catch(e){
    console.error('[convert] error', e);
    window.showToast ? showToast('Conversion échouée',{type:'error'}) : alert('Conversion échouée');
  }finally{
    showLoading(false);
    enableVisualizeBtn(true);
    window.setUiProgress?.('');
  }
}

// >>> CADLYTICS PATCH: VIEW LOAD SAFE (BEGIN)
async function loadXKTFromConvertResponse(response) {
  try {
    const fileId = String(response.file_id || '').trim();
    if (!this.fileId) this.fileId = fileId;
    else if (this.fileId !== fileId) console.warn('[ID] ignore new id', fileId, 'keep', this.fileId);

    window.setUiProgress?.('Chargement du modèle…');
    setHeatmapEnabled(false);
    const baseUrl = typeof location !== "undefined" && location.origin ? location.origin : "";
    const handleHealthStatus = (status) => {
      if (!status) return;
      console.log("[xkt][health]", status);
      if (status === "reconvert:start") {
        showReconvertBanner("Reconversion du modèle…");
        window.setUiProgress?.("Conversion en cours…");
      } else if (status.startsWith("reconvert:queued")) {
        updateReconvertBanner("File d'attente…");
        window.setUiProgress?.("Conversion en cours…");
      } else if (status.startsWith("reconvert:started")) {
        updateReconvertBanner("Conversion en cours…");
        window.setUiProgress?.("Conversion en cours…");
      } else if (status.startsWith("reconvert:finished")) {
        updateReconvertBanner("Terminé, rechargement…");
        window.setUiProgress?.("");
      } else if (status.startsWith("reconvert:failed")) {
        updateReconvertBanner("Reconversion échouée.");
        window.setUiProgress?.("");
      }
    };

    hideReconvertBanner();
    let xktUrl = baseUrl ? `${baseUrl}/xkt/${fileId}.xkt` : `/xkt/${fileId}.xkt`;
    try {
      xktUrl = await ensureHealthyXKT({
        baseUrl,
        fileId,
        minBytes: 200000,
        onStatus: handleHealthStatus
      });
    } catch (healthErr) {
      hideReconvertBanner();
      console.error("[xkt][health] contrôle impossible", healthErr);
      throw healthErr;
    }

    const performLoad = async () => {
      console.log('[viewer] XKT ready, loading…', { fileId, xktUrl });
      if (typeof lastXktUrl !== 'undefined') lastXktUrl = xktUrl;

      const { model, type, src } = await tryLoadXKTThenGLB(fileId, xktUrl);
      viewer.model = model;
      try {
        const aabb = viewer.scene.getAABB();
        if (cameraControl?.fit) {
          cameraControl.fit({ aabb });
        } else if (viewer.cameraFlight?.fit) {
          viewer.cameraFlight.fit({ aabb });
        }
      } catch (fitErr) {
        console.warn('[VIEW] camera fit failed', fitErr);
      }
      // --- readiness guard: meshes + camera ---
      const scene = viewer.scene;

      // 1) Attendre la présence de meshes réels
      await waitFor(() => {
        const n = (scene.stats?.numMeshes ?? scene.numMeshes ?? 0);
        return Number.isFinite(n) && n > 0;
      }, 10000, 50);

      // 2) Fixer near/far si indéfinis (évite projMatrix undefined)
      const cam = scene.camera;
      if (cam && cam.projection === "perspective" && cam.perspective) {
        const p = cam.perspective;
        const hasNear = Number.isFinite(p.near);
        const hasFar  = Number.isFinite(p.far);
        if (!hasNear || !hasFar) {
          const aabb = scene.aabb || {min:[-1,-1,-1], max:[1,1,1]};
          const dx = aabb.max[0] - aabb.min[0];
          const dy = aabb.max[1] - aabb.min[1];
          const dz = aabb.max[2] - aabb.min[2];
          const diag = Math.max(1e-3, Math.hypot(dx, dy, dz));
          p.near = diag / 50;
          p.far  = diag * 12;
        }
      }

      // 3) Laisser un frame de stabilisation (construction matrices/projection)
      await new Promise(r => requestAnimationFrame(() => r()));

      if (typeof runVolumeSurfacePass === "function") {
        try { await runVolumeSurfacePass(scene); } catch (e) { console.warn("[metrics] skipped:", e); }
      }
      console.info('[VIEW] modèle chargé', { type, src });
      await handleHeatmapAvailability(viewer);
      state.fileLoaded = true;
      window.dispatchEvent(
        new CustomEvent('viewer:modelLoaded', {
          detail: { fileId, src, type }
        })
      );
      return true;
    };

    const waitReady = await waitForXKTReady({
      fileId,
      xktUrl,
      onReady: performLoad
    });

    if (waitReady === null) {
      console.error('[viewer] XKT not ready after timeout', { fileId, xktUrl });
      const msg = "Modèle en cours de génération. Réessaie dans quelques instants.";
      window.showToast ? showToast(msg, { type: 'error' }) : alert(msg);
      hideReconvertBanner();
      return;
    }
  } catch (e) {
    console.error('[VIEW] Visualization error', e);
    (window.UI?.error ? UI.error : alert)('Échec de la visualisation. Merci de réessayer.\n' + (e.message || String(e)));
    setHeatmapEnabled(false);
  } finally {
    hideReconvertBanner();
    window.setUiProgress?.('');
  }
}
// >>> CADLYTICS PATCH: VIEW LOAD SAFE (END)

// ---- Écouteurs fichier ----
if (fileInput) {
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) {
      setHasFileUI(true);
      uploadStepFile(f);
    } else {
      setHasFileUI(false);
    }
  });
}

if (dropzone) {
  ['dragenter','dragover'].forEach(ev =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add('drag-over');
    }, { passive:false })
  );
  ['dragleave','drop'].forEach(ev =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove('drag-over');
    }, { passive:false })
  );
  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      setHasFileUI(true);
      uploadStepFile(files[0]);
    }
  }, { passive:false });
}

// ---- Bouton “Visualiser” sans reload ----
if (visualizeBtn) {
  visualizeBtn.setAttribute('type', 'button');
  visualizeBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await convertCurrent();
  });
}

setHasFileUI(!!(fileInput?.files?.length));
enableVisualizeBtn(false);
})();