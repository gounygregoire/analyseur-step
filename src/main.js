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

let viewer, cameraControl, xktLoader, gltfLoader, dist, sections, canvas;
let activeConversionTask = null;
let uploadStatusParent = null;
let uploadStatusEl = null;

function ensureUploadStatusElement(parent) {
  if (typeof document === "undefined") return null;
  uploadStatusParent = parent || uploadStatusParent || document.getElementById("uploadArea") || document.body;
  if (uploadStatusEl && uploadStatusEl.isConnected) {
    return uploadStatusEl;
  }
  let el = document.getElementById("uploadStatus");
  if (!el) {
    el = document.createElement("div");
    el.id = "uploadStatus";
    el.className = "upload-status small text-muted mt-2";
    uploadStatusParent?.appendChild(el);
  }
  uploadStatusEl = el;
  return uploadStatusEl;
}

function setUploadStatus(text, { type = "info" } = {}) {
  const el = ensureUploadStatusElement();
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("text-danger", type === "error");
  el.classList.toggle("text-success", type === "success");
  if (type !== "success") {
    el.classList.remove("text-success");
  }
  if (type !== "error") {
    el.classList.remove("text-danger");
  }
}

async function pollFileStatus({ fileId, timeoutMs = 120000, maxDelayMs = 5000, initialDelayMs = 1000, onUpdate, shouldAbort }) {
  if (!fileId) throw new Error("fileId requis pour pollFileStatus");
  const startedAt = Date.now();
  let delay = Math.max(250, initialDelayMs);

  while (Date.now() - startedAt < timeoutMs) {
    if (typeof shouldAbort === "function" && shouldAbort()) {
      const abortErr = new Error("POLL_ABORTED");
      abortErr.code = "POLL_ABORTED";
      throw abortErr;
    }

    try {
      const res = await fetch(`/api/files/${fileId}/status`, { method: "GET", cache: "no-store" });
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      const data = await res.json();
      console.log("[status] poll", { fileId, status: data.status, updated_at: data.updated_at });
      if (typeof onUpdate === "function") {
        onUpdate(data);
      }
      if (data.status === "ready" && data.xkt_url) {
        return data;
      }
      if (data.status === "failed") {
        const err = new Error(data.message || "Conversion échouée.");
        err.code = "STATUS_FAILED";
        err.data = data;
        throw err;
      }
    } catch (err) {
      if (err?.code === "POLL_ABORTED") {
        throw err;
      }
      console.warn("[status] poll error", { fileId, err });
    }

    if (typeof shouldAbort === "function" && shouldAbort()) {
      const abortErr = new Error("POLL_ABORTED");
      abortErr.code = "POLL_ABORTED";
      throw abortErr;
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, maxDelayMs);
  }

  const timeoutErr = new Error("Conversion trop longue (timeout).");
  timeoutErr.code = "STATUS_TIMEOUT";
  throw timeoutErr;
}

async function loadXKT(url, { fileId } = {}) {
  if (!viewer || !xktLoader) {
    throw new Error("Viewer non initialisé");
  }
  if (!url) {
    throw new Error("URL XKT manquante");
  }

  console.log("[viewer] loadXKT", { fileId, url });
  setUploadStatus("Modèle prêt, chargement…");
  window.setUiProgress?.("Chargement du modèle…");
  setHeatmapEnabled(false);

  try {
    viewer.scene?.reset?.();
  } catch (resetErr) {
    console.warn("[viewer] reset failed", resetErr);
  }

  if (viewer.model) {
    try {
      viewer.model.destroy?.();
    } catch (destroyErr) {
      console.warn("[viewer] destroy previous model failed", destroyErr);
    }
    viewer.model = null;
  }

  try {
    const modelId = fileId || `model-${Date.now()}`;
    const model = await xktLoader.load({ id: modelId, src: url });
    viewer.model = model;

    let aabb = null;
    try {
      aabb = viewer.scene?.getAABB?.();
    } catch (aabbErr) {
      console.warn("[viewer] getAABB failed", aabbErr);
    }

    try {
      if (aabb && cameraControl?.fit) {
        cameraControl.fit({ aabb });
      } else if (aabb && viewer.cameraFlight?.fit) {
        viewer.cameraFlight.fit({ aabb });
      } else {
        viewer.cameraFlight?.fit?.();
      }
    } catch (fitErr) {
      console.warn("[viewer] camera fit failed", fitErr);
    }

    try {
      const scene = viewer.scene;
      await waitFor(() => {
        const n = scene.stats?.numMeshes ?? scene.numMeshes ?? 0;
        return Number.isFinite(n) && n > 0;
      }, 10000, 50);

      const cam = scene?.camera;
      if (cam?.projection === "perspective" && cam.perspective) {
        const persp = cam.perspective;
        if (!Number.isFinite(persp.near) || !Number.isFinite(persp.far)) {
          const box = scene.getAABB?.() || scene.aabb;
          if (box) {
            const dx = box[3] - box[0];
            const dy = box[4] - box[1];
            const dz = box[5] - box[2];
            const diag = Math.max(1e-3, Math.hypot(dx, dy, dz));
            persp.near = diag / 50;
            persp.far = diag * 12;
          }
        }
      }
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 16);
        }
      });
      if (typeof runVolumeSurfacePass === "function") {
        try {
          await runVolumeSurfacePass(scene);
        } catch (metricErr) {
          console.warn("[viewer] metrics skipped", metricErr);
        }
      }
    } catch (sceneErr) {
      console.warn("[viewer] scene readiness failed", sceneErr);
    }

    await handleHeatmapAvailability(viewer);
    state.fileLoaded = true;
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("viewer:modelLoaded", {
          detail: { fileId: fileId || state.fileId || null, src: url, type: "xkt" }
        })
      );
    }
    console.info("[viewer] XKT chargé", { url });
    setUploadStatus("Upload OK", { type: "success" });
    return model;
  } catch (err) {
    console.error("[viewer] loadXKT failed", err);
    setHeatmapEnabled(false);
    setUploadStatus(`Erreur: ${err.message || "chargement du modèle"}`, { type: "error" });
    const message = err?.message ? `Échec du chargement du modèle 3D: ${err.message}` : "Échec du chargement du modèle 3D.";
    if (window.showToast) {
      window.showToast(message, { type: "error" });
    } else if (typeof alert === "function") {
      alert(message);
    }
    throw err;
  } finally {
    window.setUiProgress?.("");
  }
}

function startConversionMonitor(fileId) {
  if (!fileId) return;

  if (activeConversionTask && typeof activeConversionTask.cancel === "function") {
    activeConversionTask.cancel();
  }

  const token = { cancelled: false, cancel() { this.cancelled = true; } };
  activeConversionTask = token;

  setUploadStatus("Conversion en cours…");
  window.setUiProgress?.("Conversion en cours…");
  console.log("[status] monitor start", { fileId });
  let conversionToastShown = false;
  if (window.showToast) {
    window.showToast("Conversion en cours…", { type: "info" });
    conversionToastShown = true;
  }

  const task = (async () => {
    try {
      const statusData = await pollFileStatus({
        fileId,
        shouldAbort: () => token.cancelled,
        onUpdate: (data) => {
          if (token.cancelled) return;
          if (data.status && data.status !== "ready") {
            setUploadStatus("Conversion en cours…");
            if (!conversionToastShown && window.showToast) {
              window.showToast("Conversion en cours…", { type: "info" });
              conversionToastShown = true;
            }
          }
        }
      });

      if (token.cancelled) return;

      if (!statusData?.xkt_url) {
        throw new Error("URL du modèle indisponible.");
      }
      if (window.showToast) {
        window.showToast("Chargement du modèle…", { type: "info" });
      }

      await loadXKT(statusData.xkt_url, { fileId });
      console.log("[status] monitor success", { fileId });
      return true;
    } catch (err) {
      if (token.cancelled || err?.code === "POLL_ABORTED") {
        return false;
      }
      console.error("[status] monitor failed", err);
      const msg = err?.message || "Conversion échouée.";
      setUploadStatus(`Erreur: ${msg}`, { type: "error" });
      window.setUiProgress?.("");
      if (window.showToast) {
        window.showToast(msg, { type: "error" });
      } else if (typeof alert === "function") {
        alert(msg);
      }
      return false;
    } finally {
      if (activeConversionTask === token) {
        activeConversionTask = null;
      }
    }
  })();

  token.promise = task;
  return task;
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
      try {
        setUploadStatus("Conversion en cours…");
        window.setUiProgress?.("Conversion en cours…");
        const status = await pollFileStatus({ fileId });
        await loadXKT(status.xkt_url, { fileId });
        return true;
      } catch (err) {
        if (err?.code !== "POLL_ABORTED") {
          console.error("[viewer] loadFromFileId failed", err);
          setUploadStatus(`Erreur: ${err.message || "chargement du modèle"}`, { type: "error" });
        }
        throw err;
      }
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

  uploadStatusParent = uploadArea;
  ensureUploadStatusElement(uploadArea);

 // ---- Helpers ----

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
    setUploadStatus('Upload OK', { type: 'success' });
    startConversionMonitor(data.file_id);
    window.refreshHistory?.();
  }catch(e){
    console.error('[upload] error', e);
    setUploadStatus(`Erreur: ${e.message || 'upload échoué'}`, { type: 'error' });
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
    const success = await startConversionMonitor(fileId);
    if (success) {
      window.refreshHistory?.();
    }
  }catch(e){
    console.error('[convert] error', e);
    setUploadStatus(`Erreur: ${e.message || 'conversion échouée'}`, { type: 'error' });
    window.showToast ? showToast('Conversion échouée',{type:'error'}) : alert('Conversion échouée');
  }finally{
    showLoading(false);
    enableVisualizeBtn(true);
    window.setUiProgress?.('');
  }
}


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