// src/main.js
// Viewer Xeokit + outils, aligné avec ton HTML actuel

import {
  Viewer,
  XKTLoaderPlugin,
  DistanceMeasurementsPlugin,
  SectionPlanesPlugin,
  AxisGizmoPlugin
} from "@xeokit/xeokit-sdk";
import DFMViewerAdapter from "../static/js/modules/DFMViewerAdapter.js";

let viewer, cameraControl, xktLoader, dist, sections, canvas;

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
}

// État global partagé (accessible via window.state)
const state = (typeof window !== 'undefined' ? (window.state = window.state || {}) : {});
state.measurements = [];
state.sectionPlane = null;
state.fileLoaded = false;

// ---------- Initialisation ---------------------------------------------------
export async function initViewer(modelUrl) {
  const canvasEl = document.querySelector('#xktCanvas') || document.querySelector('#viewer3d');
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

    xktLoader = new XKTLoaderPlugin(viewer);
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
      const urls = [
        `/api/simple/models/${fileId}.xkt`,
        `/static/converted/${fileId}.xkt`,
        `/models/${fileId}.xkt`
      ];
      let lastErr;
      for (const url of urls) {
        try {
          console.log("[viewer] try xkt", url);
          const model = await xktLoader.load({ id: fileId, src: url });
          viewer.model = model;
          const aabb = viewer.scene.getAABB();
          try {
            cameraControl.fit?.({ aabb });
          } catch {
            try { viewer.cameraFlight.fit?.({ aabb }); } catch {}
          }
          return true;
        } catch (e) {
          lastErr = e;
        }
      }
      console.error("[viewer] all xkt URLs failed", urls, lastErr);
      if (typeof window !== "undefined" && typeof window.showError === "function") {
        window.showError("Impossible de charger le modèle 3D");
      }
      return false;
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
  const uploadArea = document.getElementById('uploadArea') || document.querySelector('.upload-area');
  if (!uploadArea || uploadArea.dataset.previewBound === '1') return;
  uploadArea.dataset.previewBound = '1';

  const fileInput = document.getElementById('fileInput') || uploadArea.querySelector('input[type="file"]');
  const dropzone  = document.getElementById('dropzone')  || uploadArea.querySelector('.dropzone');
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
      const msg = data.error || `upload failed (${res.status})`;
      window.showToast ? showToast(msg,{type:'error'}) : alert(msg);
      setHasFileUI(false);
      return;
    }
    exposeFileId.call(state, data.file_id);
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
      const msg = data.error || `convert failed (${res.status})`;
      window.showToast ? showToast(msg,{type:'error'}) : alert(msg);
      return;
    }
    console.info('[convert] xkt=', data.xkt_path);
    await loadXKTFromConvertResponse.call(state, { file_id: fileId, xkt_url: data.xkt_path });
    window.refreshHistory?.();
  }catch(e){
    console.error('[convert] error', e);
    window.showToast ? showToast('Conversion échouée',{type:'error'}) : alert('Conversion échouée');
  }finally{
    showLoading(false);
    enableVisualizeBtn(true);
  }
}

// >>> CADLYTICS PATCH: VIEW LOAD SAFE (BEGIN)
async function loadXKTFromConvertResponse(response) {
  try {
    const fileId = String(response.file_id || '').trim();
    if (!this.fileId) this.fileId = fileId;
    else if (this.fileId !== fileId) console.warn('[ID] ignore new id', fileId, 'keep', this.fileId);

    const xktUrl = response.xkt_url || `/uploads/${fileId}.xkt`;
    console.debug('[VIEW] will load XKT', { fileId, xktUrl });
    if (typeof lastXktUrl !== 'undefined') lastXktUrl = xktUrl;

    const head = await fetch(xktUrl, { method: 'HEAD' });
    if (!head.ok) throw new Error(`XKT not available: ${head.status}`);
    const model = await xktLoader.load({ id: fileId, src: xktUrl });
    viewer.model = model;
    console.info('[VIEW] XKT loaded', xktUrl);
  } catch (e) {
    console.error('[VIEW] Visualization error', e);
    (window.UI?.error ? UI.error : alert)('Échec de la visualisation. Merci de réessayer.\n' + (e.message || String(e)));
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