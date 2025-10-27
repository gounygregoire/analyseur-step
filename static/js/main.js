// /static/js/main.js — UTF-8 (NO BOM)
console.log("main.js loaded ✅");
// force l’ID de la vraie modale matière (utilisé par DFMOrchestrator & app.html)
window.DFM_MATERIAL_MODAL_SELECTOR = window.DFM_MATERIAL_MODAL_SELECTOR || '#materialQuestionnaireModal';

const XEOKIT_VERSION = "2.6.86";

import {
  Viewer,
  XKTLoaderPlugin,
  GLTFLoaderPlugin,
  FastNavPlugin,
  NavCubePlugin,
  SectionPlanesPlugin,
  AnnotationsPlugin,
  DistanceMeasurementsPlugin,
  DistanceMeasurementsMouseControl
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2.6.86/dist/xeokit-sdk.es.min.js";
console.log(`[xeokit] version = ${XEOKIT_VERSION}`);
import {
  register as registerModel,
  markModelReady,
  clearModelRegistry,
  onModelChange,
  currentViewer,
  setViewerSingleton
} from "./modules/ModelRegistry.js";
import {
  applyDraftHeatmap as applyDraftHeatmapModule,
  clearDraftHeatmap as clearDraftHeatmapModule,
  ensureHeatmapLayer,
  ensureModelGeometryReady
} from "./modules/DraftHeatmap.js";
import { waitForGeometryReady } from "./modules/geomWait.js";
import { ensureGeometryReady } from "./DFMOrchestrator.js";
import { installProbeSafe } from "./modules/probeSafe.js";
import { sceneTypeHistogram, hasMeshes } from "./modules/sceneAudit.js";

/* ---------- utils DOM ---------- */
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function showHeatmapToast(message, type = "info") {
  if (typeof toast === "function") {
    toast(message);
    return;
  }
  if (typeof window !== "undefined") {
    if (typeof window.toast === "function") {
      window.toast(message);
      return;
    }
    if (window.showToast) {
      window.showToast(message, { type });
      return;
    }
  }
  const logger = type === "error" ? console.error : (type === "warn" ? console.warn : console.info);
  try {
    logger.call(console, message);
  } catch {
    console.log(message);
  }
}

function setUiProgress(msg) {
  const el = document.querySelector("#progressLabel");
  if (el) {
    el.textContent = msg || "";
  }
}

function showErrorToast(msg) {
  alert(msg);
}

let reconvertInFlight = false;

function resolveCurrentFileId() {
  if (typeof window === "undefined") return null;
  const meta = typeof fileMeta !== "undefined" && fileMeta ? fileMeta : null;
  const candidates = [
    window.currentFileId,
    window.currentConversionId,
    meta?.file_id,
    window.CAD?.fileIdStep,
    window.CAD?.modelId,
    window.CADLYTICS?.current?.fileId
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function ensureNoMeshWarningElement() {
  let host = document.getElementById("heatmapNoMeshWarning");
  if (host) return host;

  host = document.createElement("div");
  host.id = "heatmapNoMeshWarning";
  host.className = "alert alert-warning mt-2 d-flex align-items-center gap-3";
  host.style.display = "none";
  host.setAttribute("role", "alert");

  const messageSpan = document.createElement("span");
  messageSpan.dataset.role = "no-mesh-message";
  messageSpan.className = "flex-fill";
  host.appendChild(messageSpan);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "btn btn-sm btn-link p-0";
  retryBtn.dataset.role = "retry-convert";
  retryBtn.textContent = "Réessayer la conversion";
  retryBtn.addEventListener("click", (event) => {
    event.preventDefault();
    const fileId = host.dataset.fileId || resolveCurrentFileId();
    if (!fileId) {
      showHeatmapToast("Impossible d'identifier le fichier à reconvertir.", "error");
      return;
    }
    triggerReconvert(fileId, { source: "no-mesh" }).catch(() => {});
  });
  host.appendChild(retryBtn);

  const anchor = document.querySelector("#btnHeatmap") || document.querySelector("#dfmBtnHeatmapDraft");
  if (anchor && anchor.parentElement) {
    anchor.parentElement.insertAdjacentElement("afterend", host);
  } else {
    (document.getElementById("analysisPanel") || document.body).appendChild(host);
  }

  return host;
}

async function triggerReconvert(fileId, { source } = {}) {
  if (!fileId) {
    showHeatmapToast("Identifiant de conversion manquant.", "error");
    return null;
  }
  if (reconvertInFlight) {
    showHeatmapToast("Reconversion déjà en cours…", "info");
    return null;
  }

  reconvertInFlight = true;
  const host = ensureNoMeshWarningElement();
  const retryBtn = host.querySelector('[data-role="retry-convert"]');
  if (retryBtn) {
    retryBtn.disabled = true;
    retryBtn.classList.add("disabled");
  }

  const url = `/reconvert/${encodeURIComponent(fileId)}`;
  try {
    console.info("[reconvert] restart requested", { fileId, source });
    const res = await fetch(url, { method: "POST", headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    let payload = null;
    const contentType = res.headers?.get?.("content-type");
    if (contentType && /json/i.test(contentType)) {
      payload = await res.json();
    }
    showHeatmapToast("Conversion relancée. Patiente quelques instants avant de rafraîchir.", "info");
    return payload;
  } catch (err) {
    console.error("[reconvert] failed", err);
    showHeatmapToast("Échec de la relance de conversion.", "error");
    throw err;
  } finally {
    reconvertInFlight = false;
    if (retryBtn) {
      retryBtn.disabled = false;
      retryBtn.classList.remove("disabled");
    }
  }
}

function showNoMeshWarning({ fileId, meshCount }) {
  const host = ensureNoMeshWarningElement();
  const messageSpan = host.querySelector('[data-role="no-mesh-message"]');
  const retryBtn = host.querySelector('[data-role="retry-convert"]');
  const resolvedCount = Number.isFinite(meshCount) ? meshCount : Number(meshCount) || 0;
  if (messageSpan) {
    messageSpan.textContent = resolvedCount > 0
      ? `Le modèle chargé ne contient pas de maillage exploitable (Mesh: ${resolvedCount}).`
      : "Le modèle chargé ne contient aucune géométrie (Mesh: 0).";
  }
  host.dataset.fileId = fileId || "";
  if (retryBtn) {
    const hasFileId = typeof fileId === "string" && fileId.trim().length > 0;
    retryBtn.style.display = hasFileId ? "" : "none";
    retryBtn.disabled = !hasFileId || reconvertInFlight;
    if (!hasFileId) {
      retryBtn.classList.add("disabled");
    } else {
      retryBtn.classList.remove("disabled");
    }
  }
  host.style.display = "";
  host.dataset.toastShown = host.dataset.toastShown || "1";
}

function hideNoMeshWarning() {
  const host = document.getElementById("heatmapNoMeshWarning");
  if (!host) return;
  host.style.display = "none";
  host.dataset.fileId = "";
  delete host.dataset.toastShown;
}

function setHeatmapEnabled(enabled, reason = "ready") {
  if (typeof document === "undefined") return;
  const flag = !!enabled;
  const selectors = [
    "[data-role=heatmap-btn]",
    "#btn-heatmap",
    "#btnHeatmap",
    "#dfmBtnHeatmapDraft"
  ];
  const seen = new Set();
  for (const selector of selectors) {
    try {
      document.querySelectorAll(selector).forEach((el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        try {
          el.toggleAttribute("disabled", !flag);
        } catch (err) {
          console.warn("[heatmap] toggle failed", err);
        }
      });
    } catch (err) {
      console.warn("[heatmap] selector failed", { selector, err });
    }
  }
  if (typeof setHeatmapButtonsDisabled === "function") {
    try {
      setHeatmapButtonsDisabled(!flag, reason);
    } catch (err) {
      console.warn("[heatmap] lock update failed", err);
    }
  }
}

function handleSceneAuditAfterLoad(viewerInstance) {
  const hist = sceneTypeHistogram(viewerInstance);
  console.log("[scene][histogram]", hist);
  const heatmapBtn = document.querySelector("#btnHeatmap");
  const meshCount = Number.isFinite(Number(hist?.Mesh)) ? Number(hist.Mesh) : 0;
  const hasMesh = hasMeshes(viewerInstance);
  if (!hasMesh || meshCount <= 0) {
    console.warn("[scene] no Mesh detected -> disable heatmap");
    setHeatmapEnabled(false, "mesh");
    const warningHost = document.getElementById("heatmapNoMeshWarning");
    const alreadyWarned = warningHost?.dataset?.toastShown === "1";
    if (!alreadyWarned) {
      showHeatmapToast("Le viewer ne détecte aucun mesh. Relance la conversion pour corriger.", "warn");
    }
    showNoMeshWarning({ fileId: resolveCurrentFileId(), meshCount });
    if (heatmapBtn) {
      heatmapBtn.disabled = true;
      heatmapBtn.dataset.sceneAuditNoMesh = "1";
      heatmapBtn.dataset.sceneAuditNoMeshToast = "1";
    }
  } else {
    setHeatmapEnabled(true, "mesh");
    hideNoMeshWarning();
    if (heatmapBtn?.dataset?.sceneAuditNoMesh === "1") {
      heatmapBtn.disabled = false;
      delete heatmapBtn.dataset.sceneAuditNoMesh;
      delete heatmapBtn.dataset.sceneAuditNoMeshToast;
    }
  }
}

function onModelLoadedOnce(model, handler) {
  if (!model || typeof handler !== "function") {
    return;
  }
  if (typeof model.once === "function") {
    try {
      model.once("loaded", handler);
      return;
    } catch (err) {
      console.warn("[loader] once(loaded) failed, fallback to on/off", err);
    }
  }
  if (typeof model.on === "function") {
    const wrapped = (...args) => {
      if (typeof model.off === "function") {
        try { model.off("loaded", wrapped); } catch {}
      }
      handler(...args);
    };
    try {
      model.on("loaded", wrapped);
      return;
    } catch (err) {
      console.warn("[loader] on(loaded) failed", err);
    }
  }
  scheduleMicrotask(() => {
    try { handler(); } catch (err) { console.warn("[loader] loaded fallback errored", err); }
  });
}

function scheduleMicrotask(cb) {
  if (typeof cb !== "function") return;
  if (typeof queueMicrotask === "function") {
    queueMicrotask(() => {
      try { cb(); } catch (err) { console.warn("[heatmap] microtask error", err); }
    });
    return;
  }
  Promise.resolve()
    .then(() => cb())
    .catch((err) => console.warn("[heatmap] microtask error", err));
}

window.CAD = (typeof window !== 'undefined' && window.CAD && typeof window.CAD === 'object')
  ? window.CAD
  : {};
if (!window.CAD.heatmap || typeof window.CAD.heatmap !== 'object') {
  window.CAD.heatmap = { ready: false };
} else if (typeof window.CAD.heatmap.ready !== 'boolean') {
  window.CAD.heatmap.ready = !!window.CAD.heatmap.ready;
}
if (typeof window.CAD.viewer === 'undefined') window.CAD.viewer = null;
if (typeof window.CAD.model === 'undefined') window.CAD.model = null;
if (typeof window.CAD.modelId === 'undefined') window.CAD.modelId = null;
if (typeof window.CAD.heatmap.waiting !== 'boolean') window.CAD.heatmap.waiting = false;
if (!window.CAD.ui || typeof window.CAD.ui !== 'object') window.CAD.ui = {};

let geometryReadyFlag = false;
let geometryReadyPromiseRef = null;

function getHeatmapState() {
  const cad = window.CAD || (window.CAD = {});
  if (!cad.heatmap || typeof cad.heatmap !== "object") {
    cad.heatmap = {};
  }
  return cad.heatmap;
}

function setGeometryReadyFlag(flag) {
  geometryReadyFlag = !!flag;
  const heatmapState = getHeatmapState();
  heatmapState.geometryReady = geometryReadyFlag;
  heatmapState.ready = geometryReadyFlag;
}

function setGeometryReadyPromise(promise) {
  geometryReadyPromiseRef = promise || null;
  const heatmapState = getHeatmapState();
  if (promise) {
    heatmapState.geometryReadyPromise = promise;
  } else {
    delete heatmapState.geometryReadyPromise;
  }
}

function getGeometryReadyPromise() {
  return geometryReadyPromiseRef;
}

function resetGeometryReadyState() {
  setGeometryReadyFlag(false);
  setGeometryReadyPromise(null);
}

function isGeometryReady() {
  return geometryReadyFlag === true;
}

function beginGeometryReadySequence({ modelId, viewerCandidate, fallbackScene }) {
  const heatmapState = getHeatmapState();
  setGeometryReadyFlag(false);
  const alreadyWaiting = heatmapState.waiting === true;
  const releaseInitialWait = alreadyWaiting ? () => {} : acquireHeatmapWaitLock();
  if (!alreadyWaiting) {
    heatmapState.waiting = true;
    try {
      document.dispatchEvent(new CustomEvent("dfm:heatmap-wait", { detail: { waiting: true, modelId } }));
    } catch {}
  }
  enableHeatmapButtons(false);

  const viewerForWait = viewerCandidate || { scene: fallbackScene };
  const waitOptions = { maxWaitMs: 60000, checkEvery: 100 };
  const readinessPromise = Promise.resolve(
    waitForGeometryReady(viewerForWait, waitOptions)
  );
  getHeatmapState().initialReadyPromise = readinessPromise;
  setGeometryReadyPromise(readinessPromise);

  readinessPromise
    .then(() => {
      if (getHeatmapState().initialReadyPromise !== readinessPromise) {
        return;
      }
      setGeometryReadyFlag(true);
      console.log("[heatmap] geometry ready");
      const state = getHeatmapState();
      if (state.layer && typeof state.layer.setReadyState === "function") {
        try { state.layer.setReadyState(true); } catch (err) { console.warn("[heatmap] ready broadcast failed", err); }
      } else if (state.layer) {
        state.layer.isReady = true;
      }
      enableHeatmapButtons(true);
      try {
        document.dispatchEvent(new CustomEvent("dfm:heatmap-ready", { detail: { ready: true, modelId } }));
      } catch {}
    })
    .catch((err) => {
      if (getHeatmapState().initialReadyPromise === readinessPromise) {
        setGeometryReadyFlag(false);
      }
      console.warn("[heatmap] geometry not ready", err);
      showHeatmapToast("Heatmap indisponible : géométrie en préparation.", "info");
      enableHeatmapButtons(false);
    })
    .finally(() => {
      const state = getHeatmapState();
      if (state.initialReadyPromise === readinessPromise) {
        delete state.initialReadyPromise;
      }
      if (getGeometryReadyPromise() === readinessPromise) {
        setGeometryReadyPromise(null);
      }
      releaseInitialWait();
      if (!alreadyWaiting) {
        state.waiting = false;
        try {
          document.dispatchEvent(new CustomEvent("dfm:heatmap-wait", { detail: { waiting: false, modelId } }));
        } catch {}
      }
    });

  return readinessPromise;
}

const DEFAULT_HEATMAP_BUTTON_SELECTORS = [
  "#btnHeatmapDraft",
  "#btnHeatmapDepouille",
  "#btnHeatmapOK",
  "#btnHeatmapZero",
  "#btnHeatmapUndercut",
  "#heatmapBtn"
];
const heatmapButtonMeta = new WeakMap();

function normalizeHeatmapButtonSelectors() {
  const heatmapState = window.CAD.heatmap || (window.CAD.heatmap = {});
  const normalized = [];
  const src = heatmapState.buttonSelectors;
  if (Array.isArray(src)) {
    for (const entry of src) {
      if (typeof entry === "string" && entry.trim()) {
        const trimmed = entry.trim();
        if (!normalized.includes(trimmed)) {
          normalized.push(trimmed);
        }
      }
    }
  } else if (typeof src === "string" && src.trim()) {
    normalized.push(src.trim());
  }
  for (const sel of DEFAULT_HEATMAP_BUTTON_SELECTORS) {
    if (!normalized.includes(sel)) {
      normalized.push(sel);
    }
  }
  heatmapState.buttonSelectors = normalized;
  return normalized;
}

function forEachButtonCandidate(candidate, cb) {
  if (!candidate && candidate !== 0) return;
  if (typeof candidate === "function") {
    try { forEachButtonCandidate(candidate(), cb); } catch {}
    return;
  }
  if (typeof candidate === "string") {
    return;
  }
  if (candidate && typeof candidate.nodeType === "number" && candidate.nodeType === 1) {
    cb(candidate);
    return;
  }
  if (candidate && typeof candidate.length === "number") {
    try {
      for (const item of Array.from(candidate)) {
        forEachButtonCandidate(item, cb);
      }
    } catch {}
    return;
  }
  if (candidate && typeof candidate.forEach === "function") {
    try { candidate.forEach((item) => forEachButtonCandidate(item, cb)); } catch {}
  }
}

function getHeatmapButtons() {
  const heatmapState = window.CAD.heatmap || {};
  const selectors = normalizeHeatmapButtonSelectors();
  const out = [];
  const seen = new Set();
  const push = (el) => {
    if (!el || typeof el !== "object") return;
    if (typeof el.nodeType === "number" && el.nodeType === 1 && !seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  };

  forEachButtonCandidate(heatmapState.buttonElement, push);
  forEachButtonCandidate(heatmapState.buttonElements, push);

  for (const sel of selectors) {
    try {
      const list = document.querySelectorAll(sel);
      for (const el of list) {
        push(el);
      }
    } catch {}
  }

  return out;
}

function setHeatmapButtonsDisabled(disabled, reason = "ready") {
  const lock = reason === "wait" ? "wait" : (reason === "mesh" ? "mesh" : "ready");
  const buttons = getHeatmapButtons();
  for (const btn of buttons) {
    if (!btn || typeof btn.disabled === "undefined") continue;
    let meta = heatmapButtonMeta.get(btn);
    if (!meta) {
      meta = { prevDisabled: btn.disabled, locks: { ready: false, wait: false, mesh: false } };
      heatmapButtonMeta.set(btn, meta);
    } else if (!meta.locks) {
      meta.locks = { ready: false, wait: false, mesh: false };
    } else {
      if (typeof meta.locks.ready !== "boolean") meta.locks.ready = false;
      if (typeof meta.locks.wait !== "boolean") meta.locks.wait = false;
      if (typeof meta.locks.mesh !== "boolean") meta.locks.mesh = false;
    }
    meta.locks[lock] = !!disabled;
    const shouldDisable = meta.locks.ready || meta.locks.wait || meta.locks.mesh;
    if (shouldDisable) {
      btn.disabled = true;
      if (meta.locks.wait) {
        btn.setAttribute("aria-busy", "true");
      } else {
        btn.removeAttribute("aria-busy");
      }
      if (btn.id === "btnHeatmapDepouille" || btn.id === "btnHeatmapDraft") {
        btn.classList.add("is-loading");
      }
    } else {
      if (meta.prevDisabled === false) {
        btn.disabled = false;
      }
      btn.removeAttribute("aria-busy");
      if (btn.id === "btnHeatmapDepouille" || btn.id === "btnHeatmapDraft") {
        btn.classList.remove("is-loading");
      }
      heatmapButtonMeta.delete(btn);
    }
  }
}

function getHeatmapLayer() {
  try {
    return ensureHeatmapLayer(window.CAD);
  } catch (err) {
    return window.CAD?.heatmap?.layer || null;
  }
}

function enableHeatmapButtons(enable = true) {
  setHeatmapButtonsDisabled(!enable, "ready");
}

window.CAD.ui.enableHeatmapButton = (flag) => enableHeatmapButtons(flag !== false);

function applyInitialHeatmapButtonState() {
  const ready = !!(window.CAD?.heatmap?.ready);
  const waiting = !!(window.CAD?.heatmap?.waiting);
  setHeatmapButtonsDisabled(!ready, "ready");
  setHeatmapButtonsDisabled(waiting, "wait");
}

document.addEventListener("dfm:heatmap-ready", (ev) => {
  const ready = !!(ev?.detail?.ready);
  setHeatmapButtonsDisabled(!ready, "ready");
});

document.addEventListener("dfm:heatmap-wait", (ev) => {
  const waiting = !!(ev?.detail?.waiting);
  setHeatmapButtonsDisabled(waiting, "wait");
});

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => applyInitialHeatmapButtonState(), { once: true });
  } else {
    applyInitialHeatmapButtonState();
  }
}

/* ---------- sélecteurs ---------- */
const fileInput     = $("#fileInput");
const btnChoose     = $("#btnChoose");
const btnVisualiser = $("#btnVisualiser") || document.getElementById("btn-visualiser");
const chkAdditive   = $("#chkAdditive");
const fileNameLbl   = $("#fileName");

const viewerShell     = $("#viewerShell");
const viewerContainer = $("#viewerContainer");
const overlayHost     = $("#overlayHost");

const btnFit   = $("#btnFit");
const btnProj  = $("#btnProj");
const chkEdges = $("#chkEdges");
const chkXray  = $("#chkXray");
const chkGhost = $("#chkGhost");
const chkTheme = $("#chkTheme");

const btnIsolate   = $("#btnIsolate");
const btnHide      = $("#btnHide");
const btnShowOnly  = $("#btnShowOnly");
const btnClearSel  = $("#btnClearSel");
const opacityRange = $("#opacityRange");

const searchInput  = $("#searchInput");
const btnSearch    = $("#btnSearch");
const resultsBox   = $("#results");
const propsPanel   = $("#propsPanel");

const progressBar  = $("#progressBar");
const btnMeasure   = $("#btnMeasure");
const btnAnnot     = $("#btnAnnot"); // caché
const clipButtons  = $$(".clipAxis");
const clipRange    = $("#clipRange");
const btnShot      = $("#btnShot");

/* ===== FIX modal matière (fallback non bloquant) ===== */
(function ensureMaterialModalAPI(){
  function getMaterialModalEl() {
    const sel =
      (window.DFM_MATERIAL_MODAL_SELECTOR && document.querySelector(window.DFM_MATERIAL_MODAL_SELECTOR))
        ? window.DFM_MATERIAL_MODAL_SELECTOR
        : '#materialQuestionnaireModal, #materialModal, [data-material-modal], .modal[data-role="material"]';
    const list = Array.from(document.querySelectorAll(sel));
    if (!list.length) return null;
    return (
      list.find(el => el.querySelector('#materialQuestionnaireForm, [data-material-form]')) ||
      list[0]
    );
  }
  function openMaterialModalHard() {
    const el = getMaterialModalEl();
    if (!el) { console.warn('[main] Modale matière introuvable'); return; }
    if (el.classList.contains('show') || el.style.display === 'block') return;
    if (window.bootstrap?.Modal) {
      window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' }).show();
      return;
    }
    let bd = document.getElementById('__mm_backdrop__');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = '__mm_backdrop__';
      Object.assign(bd.style, { position:'fixed', inset:'0', background:'rgba(0,0,0,.45)', zIndex:'1040' });
      document.body.appendChild(bd);
      bd.addEventListener('click', () => closeMaterialModalHard());
    }
    el.classList.add('show');
    Object.assign(el.style, {
      display:'block', visibility:'visible', opacity:'1', zIndex:'1050',
      position:(getComputedStyle(el).position === 'static' ? 'fixed' : getComputedStyle(el).position),
      left:'50%', top:'50%', transform:'translate(-50%, -50%)', maxHeight:'90vh', overflow:'auto'
    });
    el.addEventListener('click', (ev)=>{
      if (ev.target.matches('.btn-close,[data-bs-dismiss="modal"],[data-dismiss="modal"]')) closeMaterialModalHard();
    });
  }
  function closeMaterialModalHard() {
    const el = getMaterialModalEl();
    const bd = document.getElementById('__mm_backdrop__');
    if (el) {
      el.classList.remove('show');
      el.style.display = 'none';
      el.style.visibility = 'hidden';
      el.style.opacity = '0';
    }
    if (bd) bd.remove();
  }
  if (!window.openMaterialModal) window.openMaterialModal = openMaterialModalHard;
  if (!window.showMaterialModal) window.showMaterialModal = openMaterialModalHard;

  const ANALYZE_SEL =
    '#btnAnalyser, #analyzeBtn, #btn-analyser, #btnAnalyse, #analyser, .btn-analyser, [data-action="analyze"], [data-act="analyze"]';
  function wireAnalyzeButtons() {
    document.querySelectorAll(ANALYZE_SEL).forEach((btn) => {
      if (btn.__wiredAnalyzeMain) return;
      btn.__wiredAnalyzeMain = true;
      btn.addEventListener('click', (ev) => {
        if (ev.defaultPrevented) return;
        setTimeout(() => {
          const open =
            document.querySelector('.modal.show') ||
            document.querySelector('#materialQuestionnaireModal.show') ||
            document.querySelector('[data-material-modal].show, [data-material-modal].open');
          if (!open) window.openMaterialModal?.();
        }, 220);
      });
    });
  }
  wireAnalyzeButtons();
  new MutationObserver(wireAnalyzeButtons).observe(document.body, { childList:true, subtree:true });
})();
/* ===== FIN FIX ===== */

/* ====== Analyse: sélecteurs panneau (DYNAMIQUES) ====== */
const getEl = (sel) => document.querySelector(sel);
const getStatEl = (primarySel, dataMetric) =>
  getEl(primarySel) || getEl(`[data-metric="${dataMetric}"]`);
const projAxisRadios = () => $$('input[name="projAxis"]');

/* ---------- viewer + plugins ---------- */
export const viewerSingleton = new Viewer({
  canvasId: "xeokit-canvas",
  dtxEnabled: false,
  transparent: true
});
const viewer = viewerSingleton;
setViewerSingleton(viewer, { source: "main" });
// PATCH: exposer le viewer pour la sonde & signaler "prêt"
window.viewerAdapter = window.viewerAdapter || {};
window.viewerAdapter.viewer = viewer;
document.dispatchEvent(new Event('dfm:viewer-ready'));
window.viewer = viewer;
window.CAD.viewer = viewer;

const canvas = document.getElementById("myCanvas") || viewer?.canvas;
if (canvas) {
  try {
    const rect = canvas.getBoundingClientRect();
    console.log("[viewer][canvas] size =", rect.width, "x", rect.height);
    if (rect.width === 0 || rect.height === 0) {
      console.warn("[viewer][canvas] WARNING: canvas has zero size at load time");
    }
  } catch (err) {
    console.warn("[viewer][canvas] size check failed", err);
  }
}

new FastNavPlugin(viewer, { flyToDuration: 0.9, hideEdges:false, autoHideEdges:false });

/* -----------------------------------------------------------------------
   XKT LOADER — flags
------------------------------------------------------------------------ */
const xktLoader = new XKTLoaderPlugin(viewerSingleton, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/",
  storeGeometry: true,
  keepGeometry: true,
  parseGeometryStreams: true,
  readGeometry: true,
  decodeGeometry: true,
  decompressGeometry: true,
  edges: true // utile si la heatmap peut fallback sur edgeIndices
});

const sections = new SectionPlanesPlugin(viewer);
new AnnotationsPlugin(viewer, { container: overlayHost });

export function getViewer() { return viewerSingleton; }
export function getScene() { return viewerSingleton.scene; }

function getGlobalModelRegistry() {
  if (typeof ModelRegistry !== "undefined") return ModelRegistry;
  if (typeof globalThis !== "undefined" && globalThis.ModelRegistry) {
    return globalThis.ModelRegistry;
  }
  return null;
}

function registerGlobalModel({ viewer, model, meta }) {
  const registry = getGlobalModelRegistry();
  if (!registry) return;
  if (viewer) {
    try { setViewerSingleton(viewer, meta); } catch (err) { console.warn("[loader] viewer singleton sync failed", err); }
  }
  try { registry.register?.({ viewer, model, meta }); } catch (err) { console.warn("[loader] global register failed", err); }
  try { registry.setCurrentModel?.(model); } catch (err) { console.warn("[loader] setCurrentModel failed", err); }
}

/* ========= Canvas & overlay sizing ========= */
const canvasEl = document.getElementById("xeokit-canvas");
function resizeCanvasAndOverlay() {
  const w = Math.max(1, viewerContainer.clientWidth);
  const h = Math.max(1, viewerContainer.clientHeight);
  const dpr = 1;

  viewerContainer.style.position = "relative";
  overlayHost.style.position = "absolute";
  overlayHost.style.left = "0";
  overlayHost.style.top  = "0";

  canvasEl.style.width  = w + "px";
  canvasEl.style.height = h + "px";
  overlayHost.style.width  = w + "px";
  overlayHost.style.height = h + "px";

  canvasEl.width  = Math.floor(w * dpr);
  canvasEl.height = Math.floor(h * dpr);

  viewer.resize?.();
  viewer.scene?.setDirty?.(true);
}
new ResizeObserver(resizeCanvasAndOverlay).observe(viewerContainer);
addEventListener("resize", resizeCanvasAndOverlay, { passive: true });
resizeCanvasAndOverlay();

/* ---------- petit trièdre 2D ---------- */
function drawAxes(selected='Z'){
  const canvas = document.getElementById('axisCanvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const W=canvas.width, H=canvas.height, cx=W/2, cy=H/2, L=26;
  ctx.clearRect(0,0,W,H);
  function arrow(x1,y1,x2,y2,label,color){
    ctx.strokeStyle=color; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    const ang = Math.atan2(y2-y1, x2-x1);
    ctx.beginPath();
    ctx.moveTo(x2,y2);
    ctx.lineTo(x2-6*Math.cos(ang-0.5), y2-6*Math.sin(ang-0.5));
    ctx.lineTo(x2-6*Math.cos(ang+0.5), y2-6*Math.sin(ang+0.5));
    ctx.closePath(); ctx.fillStyle=color; ctx.fill();
    ctx.font='12px Inter, system-ui, sans-serif'; ctx.fillStyle=color;
    ctx.fillText(label, x2+4, y2+4);
  }
  const dim = '#9aa3af', sel = '#111827';
  const cX = (selected==='X') ? sel : dim;
  const cY = (selected==='Y') ? sel : dim;
  const cZ = (selected==='Z') ? sel : dim;
  arrow(cx,cy, cx+L,cy,      'X', cX);
  arrow(cx,cy, cx,cy-L,      'Y', cY);
  arrow(cx,cy, cx-0.7*L,cy+0.7*L, 'Z', cZ);
}
drawAxes('Z');
document.addEventListener('change', (ev)=>{
  const tgt = ev.target;
  if (tgt && tgt.name === 'projAxis') drawAxes(tgt.value);
});

/* ---------- NavCube ---------- */
(()=>{
  const cube=document.createElement("canvas"); cube.width=cube.height=96;
  Object.assign(cube.style,{position:"absolute",left:"12px",top:"12px",zIndex:"5",
    borderRadius:"12px",boxShadow:"0 6px 18px rgba(0,0,0,.25)",background:"rgba(255,255,255,.06)",backdropFilter:"blur(2px)"});
  viewerContainer.appendChild(cube);
  new NavCubePlugin(viewer,{canvasElement:cube,cameraFlyToDuration:0.9});
})();

/* ---------- état ---------- */
const models = new Map();
let lastModelId = null;
let selectedIds = new Set();
let appMode = "select";
let clipAxis = null;
let clipPlane = null;

// partagées avec la plaque (SVG)
let clipPlateWorld = null;
let clipPlaneDir   = [1,0,0];

/* ====== Analyse: état courant ====== */
let currentFileId = null;
let currentAxis   = "Z";
let lastStats     = null; // cache dernier JSON

// Lecture d’axe robuste
function getSelectedAxis(){
  const r = document.querySelector('input[name="projAxis"]:checked');
  if (r && r.value) return r.value.toUpperCase();
  const ax = $("#axisX")?.checked ? "X" : $("#axisY")?.checked ? "Y" : $("#axisZ")?.checked ? "Z" : "Z";
  return ax;
}

const setProgress=(p)=>{ if (progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; };
const allIds=()=> viewer.scene?.objectIds ?? [];
const setSome=(ids,prop,val)=> ids.forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const setAll=(prop,val)=> allIds().forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const clearSelection=()=>{ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); if (propsPanel) propsPanel.innerHTML=""; };

/* ---------- Mesures & unités ---------- */
let MM_PER_WU = 0.001;

const frFormat = (val) => {
  const a = Math.abs(val);
  const decimals = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3;
  return new Intl.NumberFormat('fr-FR', {
    useGrouping: true,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(val);
};
const mmFromWU = (wu) => wu * MM_PER_WU;

function pushLabelFormatterToPlugin() {
  const fmt = (wu) => `${frFormat(mmFromWU(wu))} mm`;
  try { distancePlugin.cfg = { ...(distancePlugin.cfg||{}), labelFormat: fmt }; } catch {}
  try { distancePlugin.labelFormat = fmt; } catch {}
  try {
    const shown = !!distancePlugin.labelsShown;
    distancePlugin.labelsShown = !shown;
    distancePlugin.labelsShown = shown;
  } catch {}
}
function onUnitsChanged(){ pushLabelFormatterToPlugin(); patchAllMeasureTexts(); }

function updateUnitsFromAABB(aabbLike) {
  try {
    const a = aabbLike || viewer.scene?.aabb;
    const sx = a[3]-a[0], sy = a[4]-a[1], sz = a[5]-a[2];
    const maxWU = Math.max(sx, sy, sz);
    let next = MM_PER_WU;
    if (maxWU > 1500)      next = 0.001;
    else if (maxWU < 0.5)  next = 1000;
    else                   next = 1;
    if (Math.abs(next - MM_PER_WU) > 1e-9) {
      MM_PER_WU = next;
      console.log("[units] mm per WU =", MM_PER_WU);
      onUnitsChanged();
    }
  } catch {}
}

function updateUnitsFromBBox(bboxMM) {
  try {
    const a = viewer.scene?.aabb;
    if (!a || !Array.isArray(bboxMM) || bboxMM.length !== 3) return;
    const extWU = [a[3]-a[0], a[4]-a[1], a[5]-a[2]];
    const extMM = bboxMM.map((v)=> +v || 0);
    const ratios = [0,1,2]
      .map(i => (extWU[i] > 1e-9 ? extMM[i] / extWU[i] : NaN))
      .filter(x => isFinite(x) && x > 0)
      .sort((x,y)=>x-y);
    if (!ratios.length) return;
    const next = ratios[Math.floor(ratios.length/2)];
    if (next > 1e-9 && Math.abs(next - MM_PER_WU) > 1e-9) {
      MM_PER_WU = next;
      console.log("[units] mm per WU (bbox) =", MM_PER_WU);
      onUnitsChanged();
    }
  } catch {}
}

/* =====================  HEATMAP DÉPOUILLE — START  ===================== */
// --- Neutralise tout colorize global avant d'afficher les overlays ---
const __savedColorize = new Map();
const __loggedModelEntries = new WeakSet();
function __clearAnyGlobalColorize() {
  try {
    const objs = viewer.scene?.objects || {};
    for (const id in objs) {
      const o = objs[id];
      if (!o || o.destroyed) continue;
      const cz = o.colorize;
      // si alpha > 0, on mémorise et on éteint
      if (cz && (cz[3] ?? 0) > 0) {
        __savedColorize.set(id, cz.slice ? cz.slice() : [cz[0],cz[1],cz[2],cz[3]]);
        o.colorize = [0,0,0,0];
      }
    }
  } catch {}
}
function __restoreGlobalColorize() {
  try {
    const objs = viewer.scene?.objects || {};
    for (const [id, cz] of __savedColorize) {
      const o = objs[id];
      if (o && !o.destroyed) o.colorize = cz;
    }
    __savedColorize.clear();
  } catch {}
}

onModelChange((entry) => {
  const sceneModel = entry?.model?.sceneModel || entry?.model || null;
  const metaId = entry?.meta?.id || sceneModel?.id || null;

  window.CAD.viewer = viewer;
  window.CAD.model = sceneModel;
  window.CAD.modelId = metaId;
  const heatmapState = window.CAD.heatmap || (window.CAD.heatmap = {});
  heatmapState.ready = false;
  if (heatmapState.waiting !== true) {
    heatmapState.waiting = false;
  }
  enableHeatmapButtons(false);

  if (!sceneModel || !entry?.ready) {
    return;
  }

  if (!__loggedModelEntries.has(entry)) {
    __loggedModelEntries.add(entry);
    const logId = metaId ?? sceneModel?.id ?? "unknown";
    console.info("[diag] model set", { id: logId });
  }

  const loaderModel = entry?.meta?.loaderModel || entry?.meta?.model || entry?.model || sceneModel;
  window.CAD.loaderModel = loaderModel;

  let readinessPromise = heatmapState.initialReadyPromise;
  let releaseWait = () => {};
  let startedWait = false;
  if (!readinessPromise) {
    releaseWait = acquireHeatmapWaitLock();
    heatmapState.waiting = true;
    startedWait = true;
    try {
      document.dispatchEvent(new CustomEvent("dfm:heatmap-wait", { detail: { waiting: true, modelId: metaId } }));
    } catch {}
    readinessPromise = Promise.resolve(ensureGeometryReady(window.CAD, { maxWaitMs: 15000 }));
    heatmapState.initialReadyPromise = readinessPromise;
  }

  Promise.resolve(readinessPromise)
    .then((ready) => {
      if (ready !== false && isGeometryReady()) {
        heatmapState.ready = true;
        window.CAD.ui?.enableHeatmapButton?.(true);
      } else if (!isGeometryReady()) {
        heatmapState.ready = false;
      }
    })
    .catch(() => {})
    .finally(() => {
      if (heatmapState.initialReadyPromise === readinessPromise) {
        delete heatmapState.initialReadyPromise;
      }
      releaseWait();
      if (startedWait) {
        heatmapState.waiting = false;
        try {
          document.dispatchEvent(new CustomEvent("dfm:heatmap-wait", { detail: { waiting: false, modelId: metaId } }));
        } catch {}
      }
    });
});

/** Axe sélectionné (X/Y/Z) — robuste à plusieurs implémentations possibles */
function getSelectedAxisVector() {
  // 1) radios type <input name="axis" value="x|y|z">
  const r = document.querySelector('input[name="axis"]:checked');
  const val = r?.value?.toLowerCase();
  if (val === "x") return { x:1, y:0, z:0 };
  if (val === "y") return { x:0, y:1, z:0 };
  if (val === "z") return { x:0, y:0, z:1 };

  // 2) ids classiques #axisX|#axisY|#axisZ
  if ($("#axisX")?.checked) return { x:1, y:0, z:0 };
  if ($("#axisY")?.checked) return { x:0, y:1, z:0 };
  if ($("#axisZ")?.checked) return { x:0, y:0, z:1 };

  // 3) fallback : Z
  return { x:0, y:0, z:1 };
}

function getDraftThresholdDeg() {
  const selectors = [
    '[data-draft-threshold]',
    '[data-role="draft-threshold"]',
    'input[name="draftThreshold"]',
    '#draftThreshold',
    'input[name="draft-threshold"]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const candidates = [
      el.dataset?.threshold,
      el.dataset?.value,
      el.value,
      el.textContent
    ];
    for (const cand of candidates) {
      const num = Number(cand);
      if (Number.isFinite(num) && num > 0) {
        return num;
      }
    }
  }
  if (Number.isFinite(Number(__draftState?.thresholdDeg)) && Number(__draftState.thresholdDeg) > 0) {
    return Number(__draftState.thresholdDeg);
  }
  return DEFAULT_DRAFT_THRESHOLD_DEG;
}

const DEFAULT_DRAFT_THRESHOLD_DEG = 2;
const DEFAULT_DRAFT_MODE = 'ok';
const DRAFT_COLORS = Object.freeze({
  ok: [0.20, 0.80, 0.20],
  zero: [0.98, 0.80, 0.15],
  undercut: [0.90, 0.25, 0.25]
});
const DRAFT_MODE_LABELS = Object.freeze({
  ok: 'Dépouille suffisante',
  zero: 'Sous le seuil',
  undercut: 'Contre-dépouille'
});
const VALID_DRAFT_MODES = new Set(['ok', 'zero', 'undercut']);

let __lastDraftMode = null;
let __draftState = null;
let __draftHeatmapActive = false;
let __draftLegendEl = null;
let __heatmapCooldownUntil = 0;

let __heatmapWaitToken = 0;
function acquireHeatmapWaitLock() {
  const token = ++__heatmapWaitToken;
  setHeatmapButtonsDisabled(true, "wait");
  if (window?.CAD?.heatmap && typeof window.CAD.heatmap === "object") {
    window.CAD.heatmap.waiting = true;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (__heatmapWaitToken === token) {
      if (window?.CAD?.heatmap && typeof window.CAD.heatmap === "object") {
        window.CAD.heatmap.waiting = false;
      }
      setHeatmapButtonsDisabled(false, "wait");
    }
  };
}

function setHeatmapCooldown(delayMs = 1200) {
  const clamped = Math.max(0, Number(delayMs) || 0);
  __heatmapCooldownUntil = Date.now() + clamped;
}

function destroyDraftLegend({ soft = false } = {}) {
  if (!__draftLegendEl) {
    return;
  }
  if (soft) {
    __draftLegendEl.style.display = "none";
    __draftLegendEl.setAttribute("aria-hidden", "true");
    __draftLegendEl.__softHidden = true;
    return;
  }
  if (__draftLegendEl.parentElement) {
    __draftLegendEl.parentElement.removeChild(__draftLegendEl);
  }
  __draftLegendEl = null;
}

function formatCount(val) {
  return Number(val || 0).toLocaleString('fr-FR');
}

function axisVectorLabel(axis) {
  const comps = [
    { label: 'X', value: axis.x || 0 },
    { label: 'Y', value: axis.y || 0 },
    { label: 'Z', value: axis.z || 0 }
  ];
  const dominant = comps.reduce((best, cur) => (Math.abs(cur.value) > Math.abs(best.value) ? cur : best), comps[0]);
  const sign = dominant.value >= 0 ? '+' : '-';
  return `${dominant.label}${sign}`;
}

function ensureLegendElement() {
  if (!viewerContainer) return null;
  if (__draftLegendEl) return __draftLegendEl;
  const el = document.createElement('div');
  el.id = 'draftHeatmapLegend';
  Object.assign(el.style, {
    position: 'absolute',
    right: '16px',
    top: '16px',
    zIndex: '30',
    background: 'rgba(15,23,42,0.88)',
    color: '#fff',
    padding: '12px 14px',
    borderRadius: '10px',
    boxShadow: '0 12px 28px rgba(0,0,0,0.45)',
    fontSize: '12px',
    lineHeight: '1.45',
    maxWidth: '260px',
    backdropFilter: 'blur(2px)'
  });
  el.addEventListener('click', (ev) => {
    const resetBtn = ev.target.closest('[data-act="reset"]');
    if (resetBtn) {
      ev.preventDefault();
      resetDraftHeatmap();
      return;
    }
    const modeBtn = ev.target.closest('[data-mode]');
    if (modeBtn) {
      ev.preventDefault();
      const targetMode = modeBtn.dataset.mode;
      const state = el.__state;
      if (targetMode && state?.applyMode) {
        const applied = state.applyMode(targetMode);
        __lastDraftMode = applied;
        __draftHeatmapActive = true;
        renderDraftLegend(state, applied);
      }
    }
  });
  viewerContainer.appendChild(el);
  __draftLegendEl = el;
  return el;
}

function renderDraftLegend(state, activeMode) {
  if (!viewerContainer) return;
  const el = ensureLegendElement();
  if (!el) return;
  el.__state = state;
  el.style.display = "block";
  el.removeAttribute("aria-hidden");
  delete el.__softHidden;
  const toCss = (rgb) => `rgb(${rgb.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})`;
  const axis = state?.axis?.vector || state?.axis || { x: 0, y: 0, z: 1 };
  const threshold = Number(state?.thresholdDeg || DEFAULT_DRAFT_THRESHOLD_DEG);
  const counts = state?.totals || {};
  const total = state?.totalFaces || 0;
  const axisLabel = axisVectorLabel(axis);
  const axisVectorStr = `(${(axis.x || 0).toFixed(2)}, ${(axis.y || 0).toFixed(2)}, ${(axis.z || 0).toFixed(2)})`;

  const item = (mode) => {
    const label = DRAFT_MODE_LABELS[mode] || mode;
    const color = toCss(DRAFT_COLORS[mode] || [0.6, 0.6, 0.6]);
    const active = mode === activeMode;
    const opacity = active ? '1' : '0.72';
    const weight = active ? '600' : '400';
    const count = counts[mode] || 0;
    return `<div class="draft-legend-item" data-mode="${mode}" style="display:flex;align-items:center;gap:8px;cursor:pointer;opacity:${opacity};margin-top:6px;">
      <span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${color};box-shadow:0 0 0 1px rgba(255,255,255,0.25);"></span>
      <span style="flex:1;font-weight:${weight};">${label}</span>
      <span style="font-weight:${weight};">${formatCount(count)}</span>
    </div>`;
  };

  const otherBlock = (counts.other || 0) > 0
    ? `<div style="display:flex;align-items:center;gap:8px;opacity:0.6;margin-top:6px;">
         <span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:rgba(148,163,184,0.6);"></span>
         <span style="flex:1;">Autres faces</span>
         <span>${formatCount(counts.other)}</span>
       </div>`
    : '';

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <strong style="font-size:13px;">Heatmap dépouille</strong>
      <button type="button" class="btn btn-sm btn-link p-0" data-act="reset" style="color:#93c5fd;">Réinitialiser</button>
    </div>
    <div style="margin-top:4px;font-weight:500;">Axe ${axisLabel} ${axisVectorStr}</div>
    <div style="margin-top:2px;opacity:0.8;">
      OK ≥ ${threshold.toFixed(1)}° — Sous seuil 0° à &lt; ${threshold.toFixed(1)}° — Contre < 0°
    </div>
    <div style="margin-top:6px;">
      ${item('ok')}
      ${item('zero')}
      ${item('undercut')}
      ${otherBlock}
    </div>
    <div style="margin-top:8px;opacity:0.75;">Faces analysées : ${formatCount(total)}</div>
  `;
}

function axisSignature(axisLike) {
  if (!axisLike) {
    return "Z+";
  }
  const vector = axisLike.vector || axisLike;
  let x = Number(vector?.x) || 0;
  let y = Number(vector?.y) || 0;
  let z = Number(vector?.z) || 0;
  const len = Math.hypot(x, y, z);
  if (len > 0) {
    x /= len;
    y /= len;
    z /= len;
  } else {
    x = 0; y = 0; z = 1;
  }
  const comps = [
    { letter: "X", value: x },
    { letter: "Y", value: y },
    { letter: "Z", value: z }
  ];
  const dominant = comps.reduce((best, cur) => (
    Math.abs(cur.value) > Math.abs(best.value) ? cur : best
  ), comps[0]);
  const sign = dominant.value >= 0 ? "+" : "-";
  return `${dominant.letter}${sign}`;
}

function hideDraftHeatmapOverlay({ keepState = true, softLegend } = {}) {
  const registry = window.CAD || {};
  const heatmapState = registry.heatmap || (registry.heatmap = {});
  const layer = getHeatmapLayer();
  if (layer) {
    if (keepState && typeof layer.setVisible === "function") {
      try { layer.setVisible(false); } catch (err) { console.warn("[heatmap] hide overlay failed", err); }
    } else if (typeof layer.clear === "function") {
      try { layer.clear(); } catch (err) { console.warn("[heatmap] clear overlay failed", err); }
    }
  }
  const legendSoft = typeof softLegend === "boolean" ? softLegend : keepState;
  if (legendSoft) {
    destroyDraftLegend({ soft: true });
  } else {
    destroyDraftLegend();
  }
  __draftHeatmapActive = false;
  if (heatmapState && typeof heatmapState === "object") {
    heatmapState.active = false;
    if (!keepState) {
      heatmapState.state = null;
      heatmapState.mode = null;
    }
  }
  if (!keepState) {
    __draftState = null;
    __lastDraftMode = null;
  }
}

function resetDraftHeatmap({ clearCache = false } = {}) {
  hideDraftHeatmapOverlay({ keepState: false, softLegend: false });
  try { clearDraftHeatmapModule(window.CAD); } catch (err) { console.warn('[heatmap] clear error', err); }
  __restoreGlobalColorize();
  if (clearCache && window.CAD?.heatmap?.cache instanceof Map) {
    window.CAD.heatmap.cache.clear();
  }
}

function setHeatmapVisibility(show) {
  const layer = getHeatmapLayer();
  if (!layer) {
    return;
  }
  const shouldShow = show !== false;
  try {
    layer.setVisible(shouldShow);
  } catch (err) {
    console.warn('[heatmap] toggle visibility failed', err);
  }
  if (shouldShow) {
    __draftHeatmapActive = true;
    const legendHidden = __draftLegendEl?.__softHidden || !__draftLegendEl;
    if (legendHidden && __draftState) {
      const mode = __lastDraftMode || __draftState.mode || DEFAULT_DRAFT_MODE;
      renderDraftLegend(__draftState, mode);
    }
    const heatmapState = window.CAD?.heatmap;
    if (heatmapState && typeof heatmapState === 'object') {
      heatmapState.active = true;
    }
  } else {
    hideDraftHeatmapOverlay({ keepState: true, softLegend: true });
  }
}

async function renderDraftHeatmap({ axis, show = true } = {}) {
  if (!show) {
    setHeatmapVisibility(false);
    return;
  }

  const registry = window.CAD || {};
  if (!registry?.model) {
    throw new Error('MODEL_NOT_READY');
  }

  const axisVector = axis || getSelectedAxisVector();
  const thresholdDeg = getDraftThresholdDeg();
  const existingState = __draftState;
  const sameAxis = existingState && axisSignature(existingState.axis) === axisSignature(axisVector);
  const sameThreshold = existingState && Math.abs(Number(existingState.thresholdDeg || 0) - Number(thresholdDeg || 0)) < 1e-3;
  const hasEntries = Array.isArray(existingState?.entries) && existingState.entries.length > 0;

  let stateToUse = existingState;
  if (!stateToUse || !sameAxis || !sameThreshold || !hasEntries) {
    stateToUse = await applyDraftHeatmapModule({ registry, axis: axisVector, thresholdDeg });
  }

  const targetMode = __lastDraftMode || stateToUse?.mode || DEFAULT_DRAFT_MODE;
  await applyDraftHeatmapUI(targetMode, {
    axisVector,
    thresholdDeg,
    stateOverride: stateToUse,
    readyTimeoutMs: 1500,
    readyCheckEveryMs: 75
  });

  const heatmapState = registry.heatmap || (registry.heatmap = {});
  heatmapState.active = true;
  setHeatmapVisibility(true);
}

async function applyDraftHeatmapUI(mode = DEFAULT_DRAFT_MODE, opts = {}) {
  const stateOverride = opts?.stateOverride || null;
  if (mode === 'reset' || opts.reset) {
    resetDraftHeatmap({ clearCache: !!opts.clearCache });
    return;
  }

  const registry = window.CAD || {};
  if (!registry?.heatmap) {
    console.warn('[heatmap] registry not ready');
    throw new Error('MODEL_NOT_READY');
  }

  if (!registry.heatmap.ready) {
    const ready = await ensureGeometryReady(registry, {
      maxWaitMs: opts?.readyTimeoutMs ?? 12000,
      checkEveryMs: opts?.readyCheckEveryMs ?? 100
    });
    if (!ready) {
      console.warn('[heatmap] geometry not ready (timeout)');
      throw new Error('MODEL_NOT_READY');
    }
  }

  if (!registry?.model) {
    console.warn('[heatmap] model not ready');
    throw new Error('MODEL_NOT_READY');
  }

  const axis = opts.axisVector || opts.axis || getSelectedAxisVector();
  const thresholdInput = opts.thresholdDeg ?? opts.threshold ?? opts.okMinDeg;
  const thresholdDeg = Number.isFinite(Number(thresholdInput)) && Number(thresholdInput) > 0
    ? Number(thresholdInput)
    : DEFAULT_DRAFT_THRESHOLD_DEG;

  try {
    registry.axis = axis;
    const state = stateOverride || await applyDraftHeatmapModule({ registry, axis, thresholdDeg });
    __draftState = state;
    const requestedMode = VALID_DRAFT_MODES.has(mode) ? mode : (state.mode || DEFAULT_DRAFT_MODE);
    const appliedMode = state.applyMode ? state.applyMode(requestedMode) : requestedMode;
    __lastDraftMode = appliedMode;
    __draftHeatmapActive = true;
    renderDraftLegend(state, appliedMode);
    return state;
  } catch (err) {
    const raw = err?.message || err;
    console.error('[heatmap] apply failed', raw);
    throw err;
  }
}

/* ---------- Binding boutons ---------- */
function bindClick(sel, cb) {
  const el = document.querySelector(sel);
  if (!el) return false;
  el.addEventListener("click", (e) => {
    e.preventDefault();
    try {
      const res = cb(e);
      if (res && typeof res.then === 'function') {
        res.catch(err => console.error('[heatmap] bouton error', err));
      }
    } catch (err) {
      console.error('[heatmap] bouton error', err);
    }
  });
  console.log("[draft] bouton lié:", sel);
  return true;
}

bindClick("#btnHeatmapOK",       () => applyDraftHeatmapUI('ok'));
bindClick("#btnHeatmapZero",     () => applyDraftHeatmapUI('zero'));
bindClick("#btnHeatmapUndercut", () => applyDraftHeatmapUI('undercut'));
bindClick("#btnHeatmapDepouille", async (event) => {
  const btn = event?.currentTarget || document.querySelector("#btnHeatmapDepouille");
  if (Date.now() < __heatmapCooldownUntil) {
    showHeatmapToast("Préparation de la géométrie…", "info");
    return;
  }

  const registry = window.CAD || null;
  if (!registry?.model) {
    showHeatmapToast("Préparation de la géométrie…", "info");
    setHeatmapCooldown();
    return;
  }

  const layer = getHeatmapLayer();
  if (!layer) {
    showHeatmapToast("Heatmap indisponible pour le moment.", "error");
    setHeatmapCooldown();
    return;
  }

  const model = registry.loaderModel || registry.model;
  const axis = getSelectedAxisVector();
  if (!axis) {
    showHeatmapToast("Choisis un axe de dépouille (X, Y ou Z).", "warn");
    return;
  }

  if (!isGeometryReady()) {
    showHeatmapToast("Heatmap indisponible : géométrie en préparation.", "info");
    setHeatmapCooldown();
    return;
  }

  if (!layer.isReady || !registry?.heatmap?.ready) {
    showHeatmapToast("Préparation de la géométrie…", "info");
    if (typeof layer.awaitReadyAndMaybeWarmup === "function") {
      try {
        const viewerRef = currentViewer() || viewer;
        layer.awaitReadyAndMaybeWarmup({ model, viewer: viewerRef });
      } catch (err) {
        console.warn("[heatmap] warmup restart failed", err);
      }
    }
    setHeatmapCooldown();
    return;
  }

  const releaseWait = acquireHeatmapWaitLock();
  let geometryReady = false;
  try {
    const viewerRef = currentViewer() || viewer;
    await ensureModelGeometryReady({ model, viewer: viewerRef, maxWaitMs: 4000 });
    geometryReady = true;
  } catch (err) {
    console.warn("[heatmap] geometry wait failed", err);
    showHeatmapToast("Préparation de la géométrie…", "info");
  } finally {
    releaseWait();
  }

  if (!geometryReady) {
    setHeatmapCooldown(1500);
    return;
  }

  let pending = null;
  const toggleResult = layer.toggle({
    model,
    axis,
    renderFn: ({ recompute, visibleOnly, show, axis: renderAxis } = {}) => {
      if (visibleOnly) {
        setHeatmapVisibility(show);
        return;
      }
      if (!recompute) {
        return;
      }

      const finalAxis = renderAxis || axis;
      const promise = Promise.resolve(renderDraftHeatmap({ axis: finalAxis, show }));
      if (btn) {
        btn.disabled = true;
        btn.classList.add("is-loading");
        btn.setAttribute("aria-busy", "true");
      }
      pending = promise
        .catch((err) => {
          const code = err?.message || err;
          if (code === "GEOMETRY_NOT_READY") {
            showHeatmapToast("Préparation de la géométrie…", "info");
          } else if (code === "MODEL_NOT_READY") {
            showHeatmapToast("Heatmap indisponible pour le moment.", "error");
          } else {
            showHeatmapToast("Heatmap indisponible pour le moment.", "error");
          }
          console.warn("[heatmap] toggle render failed", err);
          throw err;
        })
        .finally(() => {
          if (btn) {
            btn.disabled = false;
            btn.classList.remove("is-loading");
            btn.removeAttribute("aria-busy");
          }
        });
    }
  });

  return pending || Promise.resolve(toggleResult);
});

/* Recalcul auto quand l’axe change */
document.querySelectorAll('input[name="axis"], #axisX, #axisY, #axisZ')
  .forEach(inp => {
    inp.addEventListener("change", () => {
      if (__lastDraftMode && __draftState) {
        const res = applyDraftHeatmapUI(__lastDraftMode, { thresholdDeg: __draftState.thresholdDeg });
        if (res && typeof res.then === 'function') {
          res.catch(err => console.warn('[heatmap] axis change apply failed', err));
        }
      }
    });
  });
// Pont public pour DFMOrchestrator
window.applyDraftHeatmap = (mode='ok', opts) => applyDraftHeatmapUI(mode, opts);
window.resetDraftHeatmap = (opts) => resetDraftHeatmap(opts || {});

onModelChange(() => {
  resetDraftHeatmap({ clearCache: true });
});

// Écoute éventuelle d’un événement
document.addEventListener('dfm:heatmap-draft', (ev) => {
  const res = applyDraftHeatmapUI(ev?.detail?.mode || DEFAULT_DRAFT_MODE, ev?.detail?.opts || {});
  if (res && typeof res.then === 'function') {
    res.catch(err => console.error('[heatmap] event apply failed', err));
  }
});
/* =====================  HEATMAP DÉPOUILLE — END  ===================== */



/* ---- Distance plugin ---- */
const distancePlugin = new DistanceMeasurementsPlugin(viewer, {
  container: overlayHost,
  labelsShown: true,
  units: "mm"
});
const distanceCtrl = new DistanceMeasurementsMouseControl(distancePlugin, { snapping: true });
if ("snapDistance" in distanceCtrl) distanceCtrl.snapDistance = 0.001;
if ("snapRadius"   in distanceCtrl) distanceCtrl.snapRadius   = 3;
if ("snapToEdges"  in distanceCtrl) distanceCtrl.snapToEdges  = false;
if ("snapToVertices" in distanceCtrl) distanceCtrl.snapToVertices = true;
if ("snapping" in distanceCtrl) {
  window.addEventListener("keydown", (e)=>{ if (e.altKey) distanceCtrl.snapping = false; }, {passive:true});
  window.addEventListener("keyup",   (e)=>{ if (!e.altKey) distanceCtrl.snapping = true;  }, {passive:true});
}

/* --- conversion overlay → mm --- */
function toFR(n){
  const a = Math.abs(n);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3;
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
}
function textMetersToMMWithScale(s) {
  if (!s) return s;
  return s
    .replace(/(-?\d{1,3}(?:[ \u00A0.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s*)m\b/gi, (full, num) => {
      const valWU = parseFloat(String(num).replace(/\s|\u00A0/g, '').replace(',', '.'));
      if (!isFinite(valWU)) return full;
      const mm = valWU * MM_PER_WU;
      return `${toFR(mm)} mm`;
    })
    .replace(/[≈~]\s*/g, '≈ ');
}
function patchNodeTextDeep(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const edits = [];
  while (walker.nextNode()) edits.push(walker.currentNode);
  for (const t of edits) {
    const before = t.nodeValue;
    const after  = textMetersToMMWithScale(before);
    if (after !== before) t.nodeValue = after;
  }
}
function patchAllMeasureTexts(){ try { patchNodeTextDeep(overlayHost); } catch {} }
if (overlayHost) {
  const mo = new MutationObserver(() => patchAllMeasureTexts());
  mo.observe(overlayHost, { childList: true, subtree: true, characterData: true });
}
pushLabelFormatterToPlugin();

/* ====== Panneau "Mesures" ====== */
const leftCard = document.querySelector(".grid > .card:first-child")
               || document.querySelector(".sidebar")
               || document.querySelector("#leftPane")
               || document.body;

const measPane = document.createElement("div");
measPane.className = "pane";
measPane.innerHTML = `
  <h4 style="margin:6px 0 10px">Mesures</h4>
  <div id="measureList" style="display:flex;flex-direction:column;gap:6px"></div>
  <div class="row mini" style="margin-top:6px; gap:8px">
    <button id="btnHideAll" class="btn btn-outline mini">Tout cacher/montrer</button>
    <button id="btnClearMeas" class="btn btn-danger mini">Tout supprimer</button>
  </div>`;
leftCard.appendChild(measPane);

const measureListEl = measPane.querySelector("#measureList");
const btnHideAll    = measPane.querySelector("#btnHideAll");
const btnClearMeas  = measPane.querySelector("#btnClearMeas");

const measMap  = new Map();
let measCounter = 0;
const getMeasId = (m)=> m.id || m._id || (m.__uiId ?? (m.__uiId = "m"+Date.now().toString(36)+Math.random().toString(36).slice(2,6)));

function addMeasurementRow(m){
  const id = getMeasId(m);
  if (!measMap.has(id)) { measCounter += 1; measMap.set(id, { m, name: `Mesure ${measCounter}` }); }
  const { name } = measMap.get(id);
  if (measureListEl.querySelector(`[data-mid="${id}"]`)) return;

  const row = document.createElement("div");
  row.className = "row mini";
  row.dataset.mid = id;
  row.style.justifyContent = "space-between";
  row.innerHTML = `
    <span class="measure-name" style="font-size:12px">${name}</span>
    <span>
      <button class="btn btn-outline mini" data-act="toggle">Cacher</button>
      <button class="btn btn-outline mini btn-danger" data-act="del">Suppr.</button>
    </span>`;
  measureListEl.appendChild(row);

  const btnT = row.querySelector('[data-act="toggle"]');
  const btnD = row.querySelector('[data-act="del"]');
  btnT.addEventListener("click", ()=>{ m.visible = !m.visible; btnT.textContent = m.visible ? "Cacher" : "Montrer"; });
  btnD.addEventListener("click", ()=>{ try { m.destroy ? m.destroy() : distancePlugin.destroyMeasurement?.(m.id); } catch {} measMap.delete(id); row.remove(); });
}
["measurementCreated","newMeasurement","measurementAdded"].forEach(evt=>{
  distancePlugin.on?.(evt, (ev)=> addMeasurementRow(ev.measurement || ev));
});
distancePlugin.on?.("measurementDestroyed", (ev)=>{
  const m = ev.measurement || ev;
  const id = getMeasId(m);
  measureListEl.querySelector(`[data-mid="${id}"]`)?.remove();
  measMap.delete(id);
});
let allHidden = false;
btnHideAll.addEventListener("click", ()=>{
  allHidden = !allHidden;
  for (const {m} of measMap.values()) m.visible = !allHidden;
});
btnClearMeas.addEventListener("click", ()=>{
  if (typeof distancePlugin.clear === "function") distancePlugin.clear();
  else if (typeof distancePlugin.destroyAll === "function") distancePlugin.destroyAll();
  measureListEl.innerHTML = ""; measMap.clear(); measCounter = 0; allHidden = false;
});
function deactivateMeasure() { if (distanceCtrl.active) distanceCtrl.deactivate(); btnMeasure?.classList.remove("btn-primary"); }
function activateMeasure()   { distanceCtrl.activate();  btnMeasure?.classList.add("btn-primary"); }
function toggleMeasure()     { if (distanceCtrl.active) deactivateMeasure(); else activateMeasure(); }
btnMeasure?.addEventListener("click", toggleMeasure);
window.addEventListener("keydown", (e)=>{ if (e.key==="Escape" && distanceCtrl.active) deactivateMeasure(); }, {passive:true});
if (btnAnnot) { btnAnnot.style.display = "none"; btnAnnot.disabled = true; }

/* ---- Hook géométrie (capture positions/indices pour fallback) ---- */
(function hookGeometryCapture(){
  const sc = viewer.scene;
  const orig = sc.createGeometry?.bind(sc);
  if (!orig) { console.warn('[geom-capture] createGeometry indisponible'); return; }
  sc.createGeometry = function(params){
    const g = orig(params);
    try {
      const P = params?.positions?.data || params?.positions?.array || params?.positions || null;
      const I = params?.indices?.data   || params?.indices?.array   || params?.indices   || null;
      if (P && I) { g.__dfmPositions = P; g.__dfmIndices = I; }
    } catch {}
    return g;
  };
  console.log('[geom-capture] actif');
})();

/* ---------- chargement XKT ---------- */
function buildXKTLoadConfig({ id, src }) {
  return {
    id,
    src,
    edges: true, // utile si la heatmap peut fallback sur edgeIndices
    storeGeometry: true,
    keepGeometry: true,
    parseGeometryStreams: true,
    readGeometry: true,
    decodeGeometry: true,
    decompressGeometry: true
  };
}

let gltfLoaderSingleton = null;

function getGLTFLoader(viewerInstance) {
  if (!gltfLoaderSingleton) {
    gltfLoaderSingleton = new GLTFLoaderPlugin(viewerInstance);
  }
  return gltfLoaderSingleton;
}

function attachModelEvent(model, eventName, handler) {
  if (!model || typeof handler !== "function") {
    return { detach: () => {}, attached: false };
  }
  if (typeof model.once === "function") {
    try {
      model.once(eventName, handler);
      return { detach: () => {}, attached: true };
    } catch (err) {
      console.warn(`[viewer] once(${eventName}) indisponible`, err);
    }
  }
  if (typeof model.on === "function") {
    try {
      model.on(eventName, handler);
      return {
        detach: () => {
          if (typeof model.off === "function") {
            try { model.off(eventName, handler); } catch {}
          }
        },
        attached: true
      };
    } catch (err) {
      console.warn(`[viewer] on(${eventName}) indisponible`, err);
    }
  }
  return { detach: () => {}, attached: false };
}

function waitForModelLoad(model) {
  return new Promise((resolve, reject) => {
    const cleanups = [];
    let settled = false;
    const settle = (fn, payload) => {
      if (settled) return;
      settled = true;
      for (const { detach } of cleanups) {
        try { detach(); } catch {}
      }
      fn(payload);
    };
    const onLoaded = () => settle(resolve, { model });
    const onError  = (error) => settle(reject, { model, error });
    cleanups.push(attachModelEvent(model, "loaded", onLoaded));
    cleanups.push(attachModelEvent(model, "error", onError));
    if (cleanups.every(({ attached }) => !attached)) {
      settle(resolve, { model });
    }
  });
}

async function urlExists(url) {
  const res = await fetch(url, { method: "HEAD", cache: "no-store" });
  return res.ok;
}

async function tryLoadXKTThenGLB({
  viewerInstance,
  stableId,
  xktUrl,
  glbUrl,
  onBeforeLoad
}) {
  const attempt = async ({ type, loader, src }) => {
    let model;
    try {
      model = loader();
    } catch (error) {
      throw { error, type, model: null, src };
    }

    let cleanupHook = null;
    if (typeof onBeforeLoad === "function") {
      try {
        cleanupHook = onBeforeLoad({ model, type, src });
      } catch (err) {
        console.warn("[viewer] onBeforeLoad a échoué", err);
      }
    }

    try {
      await waitForModelLoad(model);
      if (cleanupHook) {
        try { cleanupHook(); } catch {}
      }
      return { model, type, src };
    } catch (info) {
      if (cleanupHook) {
        try { cleanupHook(); } catch {}
      }
      info = info || {};
      info.type = type;
      info.model = info.model || model;
      info.src = src;
      throw info;
    }
  };

  try {
    return await attempt({
      type: "xkt",
      src: xktUrl,
      loader: () => xktLoader.load(buildXKTLoadConfig({ id: stableId, src: xktUrl }))
    });
  } catch (firstErr) {
    const cause = firstErr?.error || firstErr;
    console.warn("[viewer] XKT load failed, tentative GLB", cause);
    if (!glbUrl) {
      throw firstErr;
    }
    let glbExists = false;
    try {
      glbExists = await urlExists(glbUrl);
    } catch (probeErr) {
      console.warn("[viewer] GLB HEAD check failed", probeErr);
    }
    if (!glbExists) {
      console.warn("[viewer] GLB fallback skipped (404).", { glbUrl });
      throw firstErr;
    }
    try {
      firstErr?.model?.destroy?.();
    } catch (destroyErr) {
      console.warn("[viewer] destruction modèle XKT échouée", destroyErr);
    }
    const gltfLoader = getGLTFLoader(viewerInstance);
    const result = await attempt({
      type: "glb",
      src: glbUrl,
      loader: () => gltfLoader.load({ id: stableId, src: glbUrl })
    });
    console.log("[viewer] GLB loaded fallback");
    return result;
  }
}

const loggedXKTContentSources = new Set();

function normalizeXKTSrc(src) {
  if (!src) return null;
  try {
    const url = new URL(src, typeof location !== "undefined" ? location.href : undefined);
    return url.toString();
  } catch {
    return src;
  }
}

function isHttpLikeURL(src) {
  if (!src) return false;
  if (src.startsWith("blob:")) return false;
  try {
    const url = new URL(src, typeof location !== "undefined" ? location.href : undefined);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function logXKTContentDiagnostics({ src, file, label }) {
  try {
    if (file && typeof file.size === "number") {
      console.log("[viewer][xkt] content =", { label: label || file.name || null, sizeBytes: file.size });
      return;
    }
    if (!src) return;
    const normalized = normalizeXKTSrc(src);
    if (!normalized) return;
    if (loggedXKTContentSources.has(normalized)) return;
    loggedXKTContentSources.add(normalized);
    if (!isHttpLikeURL(normalized)) {
      console.log("[viewer][xkt] content =", { src: normalized, sizeBytes: null, note: "non-http source" });
      return;
    }
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => {
      try { controller.abort(); } catch {}
    }, 7000) : null;
    let res;
    try {
      res = await fetch(normalized, { method: "HEAD", cache: "no-store", signal: controller?.signal });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (!res || !res.ok) {
      console.warn("[viewer][xkt] HEAD failed", { src: normalized, status: res?.status });
      return;
    }
    const len = res.headers.get("content-length");
    const size = len ? Number(len) : null;
    console.log("[viewer][xkt] content =", {
      src: normalized,
      sizeBytes: Number.isFinite(size) ? size : null,
      rawContentLength: len || null
    });
  } catch (err) {
    console.warn("[viewer][xkt] content size unavailable", err);
  }
}

function logModelSceneBinding(model, viewer, meta = {}) {
  const modelScene = model?.scene || model?.sceneModel?.scene || model?.sceneModel || null;
  const viewerScene = viewer?.scene || null;
  const payload = {
    modelId: meta.id || model?.id || null,
    src: meta.src || null,
    modelSceneId: modelScene?.id || null,
    viewerSceneId: viewerScene?.id || null,
    same: modelScene && viewerScene ? modelScene === viewerScene : null
  };
  if (!modelScene) {
    console.warn("[diag] scene binding missing model scene", payload);
    return false;
  }
  if (!viewerScene) {
    console.warn("[diag] scene binding missing viewer scene", payload);
    return false;
  }
  if (payload.same) {
    console.info("[diag] scene binding OK", payload);
    return true;
  }
  console.warn("[diag] scene binding mismatch", payload);
  return false;
}

function resolveFallbackGlbUrl({ explicitUrl, fileId }) {
  if (explicitUrl) return explicitUrl;
  const candidate = fileId && typeof fileId === "string" ? fileId.trim() : "";
  if (!candidate) return null;
  try {
    if (typeof location !== "undefined" && location.origin) {
      return new URL(`/glb/${candidate}.glb`, location.origin).toString();
    }
  } catch {}
  return `/glb/${candidate}.glb`;
}

async function finalizeModelLoad({ model, stableId, src, nameHint, loaderType }) {
  setProgress(100);
  setTimeout(() => setProgress(0), 350);
  try {
    viewer.cameraFlight.flyTo(model);
  } catch (err) {
    console.warn("[viewer] camera flyTo failed", err);
  }
  models.set(stableId, { model, name: nameHint || stableId, src, loader: loaderType });
  lastModelId = stableId;
  if (chkEdges?.checked) {
    viewer.scene.edgeMaterial.edgesEnabled = true;
  }

  const readinessModel = model?.sceneModel || model;
  const viewerRef = (typeof currentViewer === "function" && currentViewer()) || viewer;
  beginGeometryReadySequence({
    modelId: stableId,
    viewerCandidate: viewerRef || viewer,
    fallbackScene: readinessModel?.scene || viewer?.scene
  });

  markModelReady(model, { id: stableId, src, name: nameHint || stableId, loader: loaderType });

  window.CAD.viewer = viewer;
  window.CAD.model = readinessModel;
  window.CAD.modelId = stableId;
  window.CAD.lastLoadedFormat = loaderType;

  try {
    const meshCount = await waitForMeshes(viewer);
    console.log(`[viewer] meshes ready: ${meshCount}`);
    setHeatmapEnabled(true, "mesh");
  } catch (err) {
    console.warn("[viewer] meshes not ready in time", err);
    setHeatmapEnabled(false, "mesh");
  }

  handleSceneAuditAfterLoad(viewer);

  MM_PER_WU = 0.001;
  console.log("[units] init forced to µm→mm");
  onUnitsChanged();
  let tries = 0;
  const iv = setInterval(() => {
    updateUnitsFromAABB(model?.aabb || viewer.scene?.aabb);
    if (++tries > 10) clearInterval(iv);
  }, 80);

  setTimeout(() => {
    window.dispatchEvent(new CustomEvent("dfm:fileReady", {
      detail: { fileId: window.currentFileId || null }
    }));
  }, 50);

  try {
    currentAxis = getSelectedAxis();
    if (currentFileId) {
      fetchStats(currentFileId, currentAxis);
    }
  } catch (e) {
    console.warn("[analyse] fetch initial ignoré:", e);
  }
}

async function loadXKT(url, nameHint, options = {}) {
  const uploadMetaId = (typeof fileMeta !== "undefined" && fileMeta && fileMeta.file_id) ? fileMeta.file_id : null;
  const stableId = uploadMetaId
    || currentFileId
    || (typeof window !== "undefined" && window.currentFileId ? window.currentFileId : null)
    || (typeof window !== "undefined" && window.CAD && window.CAD.fileIdStep ? window.CAD.fileIdStep : null)
    || `mdl_${Date.now()}`;

  window.CAD.heatmap.ready = false;
  window.CAD.model = null;
  window.CAD.modelId = null;
  window.CAD.xktUrl = url;
  const fallbackGlbUrl = resolveFallbackGlbUrl({
    explicitUrl: options?.glbUrl,
    fileId: options?.fileId || stableId
  });
  if (fallbackGlbUrl) {
    window.CAD.glbUrl = fallbackGlbUrl;
  }

  setHeatmapEnabled(false, "ready");
  resetGeometryReadyState();
  clearModelRegistry();
  logXKTContentDiagnostics({ src: url, label: nameHint || stableId }).catch(() => {});

  setProgress(8);

  const progressHandler = (value) => {
    const ratio = (typeof value === "number" && Number.isFinite(value))
      ? value
      : Number(value?.progress ?? value?.value ?? 0) || 0;
    setProgress(8 + Math.round(Math.max(0, Math.min(1, ratio)) * 84));
  };

  try {
    const { model, type, src } = await tryLoadXKTThenGLB({
      viewerInstance: viewer,
      stableId,
      xktUrl: url,
      glbUrl: fallbackGlbUrl,
      onBeforeLoad: ({ model: loadingModel, type: loaderType, src: loaderSrc }) => {
        logModelSceneBinding(loadingModel, viewer, { id: stableId, src: loaderSrc, loader: loaderType });
        const attached = attachModelEvent(loadingModel, "progress", progressHandler);
        return () => {
          try { attached.detach(); } catch {}
        };
      }
    });

    const meta = { id: stableId, src, name: nameHint || stableId, loader: type };
    registerGlobalModel({ viewer, model, meta });
    registerModel({ viewer, model, meta });
    await finalizeModelLoad({ model, stableId, src, nameHint, loaderType: type });
    return stableId;
  } catch (err) {
    const error = err?.error || err;
    console.error("[viewer] chargement modèle échoué", error);
    setProgress(0);
    alert("Erreur chargement modèle (XKT/GLB).");
    throw error;
  }
}

async function waitForMeshes(viewerInstance, maxWaitMs = 30000) {
  const startedAt = performance.now();
  while (true) {
    const meshes = viewerInstance?.scene?.meshes || {};
    const count = Object.keys(meshes).length;
    if (count > 0) {
      return count;
    }
    if (performance.now() - startedAt > maxWaitMs) {
      throw new Error("MESH_WAIT_TIMEOUT");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

// --- FIX XKT local via blob: garder l'URL jusqu'à la fin, éviter double-load ---
let currentBlobURL = null;
let currentModel   = null;

async function loadLocalXKT(file) {
  if (!file || !file.name.toLowerCase().endsWith(".xkt")) {
    console.warn("[viewer] Fichier ignoré (pas .xkt) :", file?.name);
    return;
  }

  window.CAD.heatmap.ready = false;
  window.CAD.model = null;
  window.CAD.modelId = null;
  setHeatmapEnabled(false, "ready");
  resetGeometryReadyState();
  clearModelRegistry();

  // 1) Nettoyage éventuel du précédent blob
  if (currentModel && !currentModel.destroyed) {
    try { currentModel.destroy(); } catch(e) {}
  }
  if (currentBlobURL) {
    try { URL.revokeObjectURL(currentBlobURL); } catch(e) {}
    currentBlobURL = null;
  }

  // 2) Créer un blob URL et NE PAS le révoquer tout de suite
  const blobURL = URL.createObjectURL(file);
  currentBlobURL = blobURL;

  const stableIdLocal = window.currentFileId || currentFileId || `local_xkt_${Date.now()}`;
  console.log("[viewer] loading XKT (local) :", blobURL);
  logXKTContentDiagnostics({ src: blobURL, file, label: file?.name || stableIdLocal }).catch(() => {});

  // 3) Charger UNE SEULE FOIS via XKTLoader
  //    Assure-toi d'avoir ton instance déjà créée :
  //    const xktLoader = new XKTLoaderPlugin(viewer);
  const model = xktLoader.load(buildXKTLoadConfig({ id: stableIdLocal, src: blobURL }));
  logModelSceneBinding(model, viewer, { id: stableIdLocal, src: blobURL });
  currentModel = model;

  registerGlobalModel({ viewer, model, meta: { id: stableIdLocal, src: blobURL, name: file?.name || stableIdLocal } });

  registerModel({ viewer, model, meta: { id: stableIdLocal, src: blobURL, fileName: file.name } });

  onModelLoadedOnce(model, async () => {
    const readinessModel = model?.sceneModel || model;
    const viewerRef = (typeof currentViewer === "function" && currentViewer()) || viewer;
    beginGeometryReadySequence({
      modelId: stableIdLocal,
      viewerCandidate: viewerRef || viewer,
      fallbackScene: readinessModel?.scene || viewer?.scene
    });

    viewer.cameraFlight.flyTo(model);
    models.set(stableIdLocal, { model, name: file?.name || stableIdLocal, src: blobURL });
    lastModelId = stableIdLocal;

    markModelReady(model, { id: stableIdLocal, src: blobURL, name: file?.name || stableIdLocal });

    window.CAD.viewer = viewer;
    window.CAD.model = readinessModel;
    window.CAD.modelId = stableIdLocal;

    try {
      const meshCount = await waitForMeshes(viewer);
      console.log(`[viewer] meshes ready: ${meshCount}`);
      setHeatmapEnabled(true, "mesh");
    } catch (err) {
      console.warn("[viewer] meshes not ready in time", err);
      setHeatmapEnabled(false, "mesh");
    }

    handleSceneAuditAfterLoad(viewer);
  });

  model.on("error", (err) => {
    console.error("[viewer] XKT load error :", err);
    // NE PAS révoquer ici : laisse la possibilité de réessayer
  });

  model.on("destroyed", () => {
    // Ici on peut enfin libérer l'URL blob en toute sécurité
    if (currentBlobURL) {
      try { URL.revokeObjectURL(currentBlobURL); } catch(e) {}
      currentBlobURL = null;
    }
  });
}

// Exemple d’intégration :
// input[type=file].onchange = (e) => loadLocalXKT(e.target.files[0]);
// zoneDrop.onDrop = (file) => loadLocalXKT(file);

// IMPORTANT : si tu utilises aussi un chargement par URL HTTP (.xkt sur ton serveur),
// entoure ce code d’un guard pour ne PAS appeler en plus le chargement HTTP
// lorsqu’un File est présent.

/* ====================== PROBE SAFE (faces) ====================== */
installProbeSafe(viewer);

/* ---------- FICHIERS / upload ---------- */
async function uploadAndShow(file) {
  const f = file || fileInput?.files?.[0];
  if (!f) { alert("Choisis un fichier .step/.stp/.stl (ou .xkt)"); return; }
  if (fileNameLbl) fileNameLbl.textContent = f.name;

  if (btnVisualiser) { btnVisualiser.disabled = true; btnVisualiser.textContent = "Conversion…"; }
  setProgress(12);

  try {
    if (/\.(xkt)$/i.test(f.name)) {
      currentFileId = null;
      window.currentFileId = null;
      const fileURL = URL.createObjectURL(f);
      if (!chkAdditive?.checked) {
        for (const [, i] of models) { try { i.model.destroy(); } catch {} }
        models.clear(); selectedIds.clear();
        clearModelRegistry();
      }
      console.log("[viewer] loading XKT (local):", fileURL);
      logXKTContentDiagnostics({ src: fileURL, file: f, label: f.name }).catch(() => {});
      StatsPoller.cancel();
      await loadXKT(fileURL, f.name);
      return;
    }

    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/upload", { method: "POST", body: fd });
    let j = null; try { j = await res.json(); } catch {}

    if (!res.ok || !j || !j.xkt_url) {
      console.error("[upload] bad response", res.status, j);
      throw new Error(`upload failed (${res.status})`);
    }

    if (j.s3_uploaded === false) console.warn("[upload] S3 non disponible.");

    currentFileId = j.file_id || null;
    window.currentFileId = currentFileId;
    const xktUrl = new URL(j.xkt_url, location.origin).toString();
    console.log("[upload] ok:", { file_id: currentFileId, xktUrl });

    let resolvedXktUrl = xktUrl;
    if (currentFileId) {
      try {
        if (typeof setUiProgress === "function") {
          setUiProgress("Conversion en cours…");
        }
        resolvedXktUrl = await waitForXKTReady(currentFileId, { expectedUrl: xktUrl });
        console.log("[viewer] XKT prêt", { fileId: currentFileId, resolvedXktUrl });
      } catch (waitErr) {
        console.error("[viewer] waitForXKTReady failed", waitErr);
        throw waitErr;
      } finally {
        if (typeof setUiProgress === "function") {
          setUiProgress("");
        }
      }
    }

    if (!chkAdditive?.checked) {
      for (const [, i] of models) { try { i.model.destroy(); } catch {} }
      models.clear(); selectedIds.clear();
      clearModelRegistry();
    }

    console.log("[viewer] loading XKT:", resolvedXktUrl);
    logXKTContentDiagnostics({ src: resolvedXktUrl, label: f.name || currentFileId }).catch(() => {});
    StatsPoller.cancel();
    let glbUrl = null;
    try {
      if (j.glb_url) {
        glbUrl = new URL(j.glb_url, location.origin).toString();
      } else if (currentFileId) {
        glbUrl = new URL(`/glb/${currentFileId}.glb`, location.origin).toString();
      }
    } catch {
      glbUrl = j.glb_url || (currentFileId ? `/glb/${currentFileId}.glb` : null);
    }
    if (typeof setUiProgress === "function") {
      setUiProgress("Chargement du modèle…");
    }
    await loadXKT(resolvedXktUrl, f.name, { fileId: currentFileId, glbUrl });
  } catch (e) {
    console.error(e);
    alert("Erreur conversion/chargement (voir Console).");
  } finally {
    if (typeof setUiProgress === "function") {
      setUiProgress("");
    }
    if (btnVisualiser) { btnVisualiser.disabled = false; btnVisualiser.textContent = "VISUALISER"; }
    setProgress(0);
  }
}

function getUploadFormData() {
  const input = fileInput || document.querySelector('input[type="file"]');
  const file = input?.files?.[0] || null;
  if (!file) {
    throw new Error("Aucun fichier sélectionné");
  }
  const fd = new FormData();
  fd.append("file", file);
  return { fd, file };
}

async function waitForXKTReady(fileId, opts = {}) {
  const minSize  = opts.minSize  ?? 120 * 1024;   // >100KB pour éviter les fichiers vides
  const maxWait  = opts.maxWait  ?? 10 * 60 * 1000; // 10 minutes max
  const pollMs   = opts.pollMs   ?? 1500;         // 1.5s entre requêtes
  const badSize  = 46204;                         // taille connue "mauvaise"
  const expectedUrl = typeof opts.expectedUrl === "string" && opts.expectedUrl.trim().length
    ? opts.expectedUrl.trim()
    : null;
  const t0 = performance.now();

  while (true) {
    const r = await fetch(`/debug/xkt/${fileId}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`debug_xkt_failed ${r.status}`);
    const j = await r.json();

    // prêt quand: le fichier existe, taille suffisante et ≠ taille “mauvaise”
    if (j.xkt_exists && j.xkt_size >= minSize && j.xkt_size !== badSize) {
      if (typeof j.public_url === "string" && j.public_url) {
        return j.public_url;
      }
      if (expectedUrl) {
        return expectedUrl;
      }
      try {
        if (typeof location !== "undefined" && location.origin) {
          return new URL(`/xkt/${fileId}.xkt`, location.origin).toString();
        }
      } catch {}
      return `/xkt/${fileId}.xkt`;
    }

    if (performance.now() - t0 > maxWait) {
      throw new Error("GEOMETRY_WAIT_TIMEOUT");
    }
    await new Promise(res => setTimeout(res, pollMs));
  }
}

async function showDebugXKT(fileId) {
  if (!fileId) {
    console.warn("[debug] showDebugXKT appelé sans fileId");
    return;
  }
  try {
    const r = await fetch(`/debug/xkt/${fileId}`, { cache: "no-store" });
    if (!r.ok) {
      console.warn("[debug] /debug/xkt renvoie", r.status);
      return;
    }
    const j = await r.json();
    console.table(j);
  } catch (err) {
    console.warn("[debug] showDebugXKT a échoué", err);
  }
}

async function handleUpload(formData) {
  const res = await fetch("/upload", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) {
    console.error("[upload] failed", data);
    const msg = data?.detail || data?.error || `Upload/convert failed (${res.status})`;
    showErrorToast(msg);
    throw new Error(msg);
  }

  const fileId = data.file_id;
  if (!fileId) {
    const msg = "Réponse upload sans file_id.";
    console.error("[upload] missing file_id", data);
    showErrorToast(msg);
    throw new Error(msg);
  }

  let xktUrl = null;
  let glbUrl = null;
  try {
    if (data.xkt_url) {
      xktUrl = new URL(data.xkt_url, location.origin).toString();
    }
  } catch {
    xktUrl = data.xkt_url || null;
  }
  try {
    if (data.glb_url) {
      glbUrl = new URL(data.glb_url, location.origin).toString();
    }
  } catch {
    glbUrl = data.glb_url || null;
  }

  return { fileId, xktUrl, glbUrl };
}

btnVisualiser?.addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    setUiProgress?.("Upload…");
    const { fd, file } = getUploadFormData();
    const { fileId, xktUrl: initialXktUrl, glbUrl } = await handleUpload(fd);
    setUiProgress?.("Conversion en cours…");
    const xktUrl = await waitForXKTReady(fileId, { expectedUrl: initialXktUrl });
    if (fileId) {
      currentFileId = fileId;
      window.currentFileId = fileId;
      console.log("[debug] fileId", fileId);
      showDebugXKT(fileId).catch(() => {});
    }
    setUiProgress?.("Chargement du modèle…");
    await loadXKT(xktUrl, file?.name, { fileId, glbUrl });
    setUiProgress?.("");
  } catch (err) {
    console.error(err);
    setUiProgress?.("");
    showErrorToast(err?.message || "Erreur d'upload");
  }
});

/* ---------- FICHIERS UI ---------- */
function openFileChooser(){
  try{
    if (fileInput && !fileInput.disabled){
      if (typeof fileInput.showPicker === "function") fileInput.showPicker();
      else fileInput.click();
      return;
    }
    const tmp = document.createElement("input");
    tmp.type = "file";
    tmp.accept = ".step,.stp,.stl,.xkt,model/step,model/stl,application/octet-stream";
    tmp.style.position = "fixed";
    tmp.style.left = "-9999px";
    document.body.appendChild(tmp);
    tmp.addEventListener("change", ()=>{ if (tmp.files?.[0]) uploadAndShow(tmp.files[0]); tmp.remove(); });
    tmp.click();
  }catch(err){
    console.error(err);
    alert("Impossible d’ouvrir le sélecteur de fichiers (popup bloquée ?).");
  }
}
btnChoose?.setAttribute("type","button");
btnChoose?.setAttribute("tabindex","0");
btnChoose?.addEventListener("click",  (e)=>{ e.preventDefault(); openFileChooser(); });
btnChoose?.addEventListener("keydown",(e)=>{ if (e.key==="Enter"||e.key===" ") { e.preventDefault(); openFileChooser(); } });

fileInput?.addEventListener("change",()=>{
  const f=fileInput.files?.[0];
  if (f && fileNameLbl) fileNameLbl.textContent=f.name;
  if (f) uploadAndShow(f);
});

["dragenter","dragover"].forEach(ev=>{
  viewerContainer?.addEventListener(ev,(e)=>{ e.preventDefault(); e.dataTransfer.dropEffect="copy"; }, false);
});
viewerContainer?.addEventListener("drop",(e)=>{
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) uploadAndShow(f);
});

/* ---------- nav & rendu ---------- */
btnFit?.addEventListener("click", ()=> viewer.cameraFlight.flyTo(viewer.scene));
let proj="perspective";
btnProj?.addEventListener("click",()=>{ proj = proj==="perspective" ? "ortho" : "perspective"; viewer.camera.projection=proj; btnProj.textContent = proj==="perspective" ? "PERSPECTIVE" : "ORTHOGRAPHIQUE"; });
chkEdges?.addEventListener("change",()=> viewer.scene.edgeMaterial.edgesEnabled=!!chkEdges.checked);

/* ---------- Sélection simple ---------- */
viewer.scene.input.on("mouseclicked", (coords)=>{
  if (distanceCtrl.active) return;
  const hit = viewer.scene.pick({ canvasPos: coords, pickSurface: true });
  if (!hit || !hit.entity) { clearSelection(); return; }
  const id = hit.entity.id;
  setSome(allIds(),"highlighted",false);
  selectedIds = new Set([id]);
  setSome([id],"highlighted",true);
  showProps(hit.entity.metaObject || { id });
});

/* ---------- Recherche ---------- */
btnSearch?.addEventListener("click",()=>{
  const q=(searchInput?.value||"").toLowerCase().trim();
  if (!resultsBox) return; resultsBox.innerHTML="";
  if (!q) return;
  const found=[];
  allIds().forEach(id=>{
    const o=viewer.scene.objects[id]; const m=o?.metaObject||{};
    const hay=[id,m.type,m.name,m.ifcType,m.displayName].join(" ").toLowerCase();
    if (hay.includes(q)) found.push({id,meta:m});
  });
  if (!found.length){ resultsBox.textContent="Aucun résultat"; return; }
  found.slice(0,200).forEach(({id,meta})=>{
    const div=document.createElement("div");
    div.className = "row mini"; div.style.justifyContent="space-between";
    div.innerHTML=`<span style="font-size:12px">${meta?.name||meta?.displayName||meta?.type||id}</span>
      <button class="btn btn-outline mini" data-id="${id}">Voir</button>`;
    resultsBox.appendChild(div);
  });
  resultsBox.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click",()=>{ const id=b.dataset.id; const obj=viewer.scene.objects[id];
      if (obj){ viewer.cameraFlight.flyTo(obj); setSome([id],"highlighted",true); }
    });
  });
});

/* ---------- Iso/cacher/montrer ---------- */
btnIsolate ?.addEventListener("click",()=>{ if (!selectedIds.size) return; setAll("visible",false); setSome([...selectedIds],"visible",true); });
btnHide    ?.addEventListener("click",()=>{ if (!selectedIds.size) return; setSome([...selectedIds],"visible",false); });
btnShowOnly?.addEventListener("click",()=>{ if (!selectedIds.size) return; setAll("visible",false); setSome([...selectedIds],"visible",true); });
btnClearSel?.addEventListener("click",()=>{ setAll("visible",true); setSome(allIds(),"highlighted",false); clearSelection(); });

/* ---------- Propriétés ---------- */
function showProps(meta){
  if (!propsPanel) return;
  propsPanel.innerHTML = "";
  if (!meta) return;
  const add=(k,v)=>{ const a=document.createElement("div"); a.textContent=k;
                     const b=document.createElement("div"); b.textContent=String(v);
                     propsPanel.append(a,b); };
  const base={ id:meta.id, type:meta.type||meta.ifcType||"", name:meta.name||meta.displayName||"" };
  Object.entries(base).forEach(([k,v])=> (v!==undefined && v!=="") && add(k,v));
  const p=meta.properties||meta.props;
  if (p && typeof p==="object")
    Object.entries(p).forEach(([k,v])=> add(k, typeof v==="object"? JSON.stringify(v): v));
}

/* ====================== PLAQUE DE COUPE : quad SVG ====================== */
const cross = (a,b)=> [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot   = (a,b)=> a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const len   = (v)=> Math.hypot(v[0],v[1],v[2]) || 1;
const normV = (v)=>{ const L=len(v); return [v[0]/L,v[1]/L,v[2]/L]; };
const add3  = (a,b)=> [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const mul3  = (v,s)=> [v[0]*s, v[1]*s, v[2]*s];

function worldToOverlayXY(world){
  const cam = viewer.camera;
  const mV  = cam.viewMatrix;
  const mP  = cam.projMatrix || cam.projectionMatrix;
  if (!mV || !mP || !overlayHost) return null;

  const x=world[0], y=world[1], z=world[2];
  const vx = mV[0]*x + mV[4]*y + mV[8]*z  + mV[12];
  const vy = mV[1]*x + mV[5]*y + mV[9]*z  + mV[13];
  const vz = mV[2]*x + mV[6]*y + mV[10]*z + mV[14];
  const vw = mV[3]*x + mV[7]*y + mV[11]*z + mV[15];

  const cx = mP[0]*vx + mP[4]*vy + mP[8]*vz  + mP[12]*vw;
  const cy = mP[1]*vx + mP[5]*vy + mP[9]*vz  + mP[13]*vw; // ← FIX (vx pas vy)
  const cw = mP[3]*vx + mP[7]*vy + mP[11]*vz + mP[15]*vw;
  if (!cw) return null;

  const nx = cx / cw, ny = cy / cw;
  return {
    x: (nx * 0.5 + 0.5) * overlayHost.clientWidth,
    y: (1 - (ny * 0.5 + 0.5)) * overlayHost.clientHeight
  };
}

/* --- overlay SVG (quad + axe) --- */
let cutSvg = null, cutPoly = null, cutAxisLine = null;
function ensureCutSvg(){
  if (cutSvg) return;
  cutSvg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  cutSvg.setAttribute("width","100%");
  cutSvg.setAttribute("height","100%");
  Object.assign(cutSvg.style, { position:"absolute", inset:"0", pointerEvents:"none", zIndex:"10" });
  overlayHost.appendChild(cutSvg);

  cutPoly = document.createElementNS("http://www.w3.org/2000/svg","polygon");
  cutPoly.setAttribute("fill","rgba(80,140,255,.20)");
  cutPoly.setAttribute("stroke","rgba(80,140,255,.45)");
  cutPoly.setAttribute("stroke-width","1");
  cutPoly.style.filter = "drop-shadow(0 6px 14px rgba(20,60,140,.18))";
  cutSvg.appendChild(cutPoly);

  cutAxisLine = document.createElementNS("http://www.w3.org/2000/svg","line");
  cutAxisLine.setAttribute("stroke","rgba(80,140,255,.65)");
  cutAxisLine.setAttribute("stroke-width","2");
  cutAxisLine.setAttribute("stroke-linecap","round");
  cutSvg.appendChild(cutAxisLine);
}
function clearCutSvg(){
  try { cutSvg?.remove(); } catch {}
  cutSvg = null; cutPoly = null; cutAxisLine = null;
}

function updateCutPlaneVisual(){
  if (!clipPlateWorld) { if (cutPoly) cutPoly.setAttribute("points",""); return; }
  ensureCutSvg();

  const n = normV(clipPlaneDir);
  let up = [0,1,0];
  if (Math.abs(dot(up,n)) > 0.95) up = [1,0,0];
  const u = normV(cross(up, n));
  const v = normV(cross(n, u));

  const aabb = viewer.scene?.aabb || [0,0,0,0,0,0];
  const corners = [
    [aabb[0],aabb[1],aabb[2]],[aabb[3],aabb[1],aabb[2]],[aabb[0],aabb[4],aabb[2]],[aabb[3],aabb[4],aabb[2]],
    [aabb[0],aabb[1],aabb[5]],[aabb[3],aabb[1],aabb[5]],[aabb[0],aabb[4],aabb[5]],[aabb[3],aabb[4],aabb[5]]
  ];
  let minU=+Infinity,maxU=-Infinity,minV=+Infinity,maxV=-Infinity;
  for (const p of corners){
    const r = [p[0]-clipPlateWorld[0], p[1]-clipPlateWorld[1], p[2]-clipPlateWorld[2]];
    const su = dot(r,u), sv = dot(r,v);
    if (su<minU) minU=su; if (su>maxU) maxU=su;
    if (sv<minV) minV=sv; if (sv>maxV) maxV=sv;
  }
  const SCALE = 0.92;
  const halfU = Math.max((maxU-minU)*0.5*SCALE, 1e-3);
  const halfV = Math.max((maxV-minV)*0.5*SCALE, 1e-3);

  const P0 = add3( add3(clipPlateWorld, mul3(u,-halfU)), mul3(v,-halfV) );
  const P1 = add3( add3(clipPlateWorld, mul3(u, halfU)), mul3(v,-halfV) );
  const P2 = add3( add3(clipPlateWorld, mul3(u, halfU)), mul3(v, halfV) );
  const P3 = add3( add3(clipPlateWorld, mul3(u,-halfU)), mul3(v, halfV) );

  const q0 = worldToOverlayXY(P0),
        q1 = worldToOverlayXY(P1),
        q2 = worldToOverlayXY(P2),
        q3 = worldToOverlayXY(P3);
  if (!q0 || !q1 || !q2 || !q3){ cutPoly.setAttribute("points",""); return; }
  cutPoly.setAttribute("points", `${q0.x},${q0.y} ${q1.x},${q1.y} ${q2.x},${q2.y} ${q3.x},${q3.y}`);

  const Au = worldToOverlayXY(add3(clipPlateWorld, mul3(u, halfU*0.55)));
  const Bu = worldToOverlayXY(add3(clipPlateWorld, mul3(u,-halfU*0.55)));
  if (Au && Bu){
    cutAxisLine.setAttribute("x1", Au.x); cutAxisLine.setAttribute("y1", Au.y);
    cutAxisLine.setAttribute("x2", Bu.x); cutAxisLine.setAttribute("y2", Bu.y);
    cutAxisLine.style.display = "block";
  } else {
    cutAxisLine.style.display = "none";
  }
}

/* ---------- COUPE ---------- */
function setClipAxis(axis){
  const same = (clipAxis === axis);
  clipAxis = same ? null : axis;

  clipButtons.forEach(b => b.classList.toggle("btn-primary", !same && b.dataset.axis === clipAxis));

  if (clipPlane){ try{ clipPlane.destroy(); }catch{} clipPlane=null; }
  try { sections.clear?.(); } catch {}

  clipPlateWorld = null;

  if (!clipAxis){
    viewer.scene.sectionPlanesEnabled=false;
    clearCutSvg();
    return;
  }

  const aabb   = viewer.scene?.aabb || [0,0,0, 0,0,0];
  const center = [(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  clipPlaneDir  = (clipAxis==="x") ? [1,0,0] : (clipAxis==="y") ? [0,1,0] : [0,0,1];

  clipPlane = sections.createSectionPlane({ id:"cut", pos:center, dir: clipPlaneDir });
  viewer.scene.sectionPlanesEnabled = true;

  ensureCutSvg();
  clipPlateWorld = center.slice();
  clipRange.value = "0";
  updateCutPlaneVisual();
}
clipButtons.forEach(b => b.addEventListener("click", () => setClipAxis(b.dataset.axis)));

clipRange?.addEventListener("input", ()=>{
  if (!clipPlane || !clipAxis) return;
  const k=parseFloat(clipRange.value)||0;

  const aabb=viewer.scene?.aabb || [0,0,0, 0,0,0];
  const center=[(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  const half=[(aabb[3]-aabb[0])/2,(aabb[4]-aabb[1])/2,(aabb[5]-aabb[2])/2];
  const shift=(clipAxis==="x"?half[0]:clipAxis==="y"?half[1]:half[2])*(k/100);
  const pos=center.slice();
  if (clipAxis==="x") pos[0]+=shift; else if (clipAxis==="y") pos[1]+=shift; else pos[2]+=shift;

  clipPlane.pos = pos;
  clipPlateWorld = pos;
  updateCutPlaneVisual();
});

viewer.scene.on("tick", ()=>{
  if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) {
    viewer.scene.edgeMaterial.edgesEnabled = true;
  }
  updateCutPlaneVisual();
  if (window.__drawAxesFromView) {
    window.__lastViewMatrix = viewer.camera.viewMatrix;
    window.__drawAxesFromView(viewer.camera.viewMatrix);
  }
});

/* ---------- Switchs d’affichage ---------- */
chkXray ?.addEventListener("change",()=>{ setAll("xrayed", !!chkXray.checked);  setSome([...selectedIds],"xrayed",false); });
chkGhost?.addEventListener("change",()=>{ setAll("ghosted",!!chkGhost.checked); setSome([...selectedIds],"ghosted",false); });
chkTheme?.addEventListener("change",()=> viewerShell?.classList.toggle("dark",!!chkTheme.checked));
opacityRange?.addEventListener("input",()=> setAll("opacity", parseFloat(opacityRange.value)||1));

/* ---------- Screenshot ---------- */
btnShot?.addEventListener("click",()=>{
  try{
    const dataURL=canvasEl.toDataURL("image/png");
    const a=document.createElement("a"); a.href=dataURL; a.download="cadlytics_view.png"; a.click();
  }catch(e){ console.error(e); alert("Capture impossible."); }
});

/* ==================== ANALYSE : fetch & rendu ==================== */
function f3(v){ return (v==null || !isFinite(+v)) ? "—" : (+v).toFixed(3).replace(".", ","); }
function setText(el, txt){ if (el && el.textContent !== txt) el.textContent = txt; }

/* --- Anti-blink --- */
const StatsSafe = (() => {
  const idToMetric = (el) => {
    if (!el) return null;
    if (el.getAttribute?.('data-metric')) return el.getAttribute('data-metric');
    if (el.id === 'volVal')  return 'volume';
    if (el.id === 'projVal') return 'projected_area';
    if (el.id === 'tminVal') return 'tmin';
    if (el.id === 'tmaxVal') return 'tmax';
    return null;
  };
  const expected = {};
  let applying = false;
  const mo = new MutationObserver((mutList) => {
    if (applying) return;
    for (const m of mutList) {
      let node = m.type === 'characterData' ? m.target?.parentElement : m.target;
      if (!node) continue;
      const metric = idToMetric(node);
      if (!metric) continue;
      const want = expected[metric];
      if (want == null) continue;
      const have = node.textContent;
      if (have !== want) {
        applying = true;
        node.textContent = want;
        applying = false;
      }
    }
  });
  mo.observe(document.body, { subtree:true, childList:true, characterData:true });

  function setMetric(metric, text) {
    expected[metric] = text;
    const el =
      metric === 'volume'         ? getStatEl("#volVal","volume") :
      metric === 'projected_area' ? getStatEl("#projVal","projected_area") :
      metric === 'tmin'           ? getStatEl("#tminVal","tmin") :
      metric === 'tmax'           ? getStatEl("#tmaxVal","tmax") : null;

    if (el) {
      applying = true;
      if (el.textContent !== text) el.textContent = text;
      applying = false;
    }
  }

  return { setMetric };
})();

function renderStats(json){
  if (!json || typeof json !== "object") return;
  lastStats = json;

  if (Array.isArray(json.bbox_mm)) {
    window.__bbox_mm = json.bbox_mm;
    updateUnitsFromBBox(window.__bbox_mm);
  }

  // Volume / épaisseurs : source serveur
  StatsSafe.setMetric('volume',         f3(json.volume_cm3));
  StatsSafe.setMetric('tmin',           f3(json.thickness_min_mm));
  StatsSafe.setMetric('tmax',           f3(json.thickness_max_mm));

  // Surface projetée : serveur si dispo, sinon fallback local
  const projServer = json.projected_area_cm2;
  if (projServer != null && isFinite(+projServer)) {
    StatsSafe.setMetric('projected_area', f3(+projServer));
  } else {
    try {
      const ax = getSelectedAxis();
      const local = (typeof window.__getProjectedArea === 'function') ? window.__getProjectedArea(ax) : 0;
      StatsSafe.setMetric('projected_area', f3(local));
    } catch {
      StatsSafe.setMetric('projected_area', f3(null));
    }
  }
}

function clearStatsUI(force=false){
  if (!force && StatsPoller.state?.lastOk) return;
  renderStats({
    volume_cm3: null,
    projected_area_cm2: null,
    thickness_min_mm: null,
    thickness_max_mm: null,
    bbox_mm: window.__bbox_mm
  });
}

/* --- Stats polling controller --- */
const StatsPoller = (() => {
  let state = { token: 0, timer: null, lastOk: null, fileId: null, axis: "Z" };

  function cancel() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  }

  async function _pollOnce(myToken) {
    if (myToken !== state.token) return;
    const { fileId, axis } = state;
    if (!fileId) return;

    try {
      const res  = await fetch(`/api/shape/stats?file_id=${encodeURIComponent(fileId)}&axis=${axis}`, { cache: 'no-store' });
      let data = null; try { data = await res.json(); } catch {}

      if (myToken !== state.token) return;

      if (res.status === 200 && data) {
        if (data.volume_mm3 != null && data.volume_cm3 == null) data.volume_cm3 = (+data.volume_mm3)/1000;
        if (data.projected_area_mm2 != null && data.projected_area_cm2 == null) data.projected_area_cm2 = (+data.projected_area_mm2)/100;
        state.lastOk = data;
        renderStats(data);
        cancel();
        return;
      }

      if (res.status === 202 && data && (data.status === "queued" || data.status === "processing")) {
        state.timer = setTimeout(() => _pollOnce(myToken), Math.max(800, ((data.retry_in_sec ?? 2) * 1000)));
        return;
      }

      if (!state.lastOk) clearStatsUI(true);
      cancel();
      console.warn("[analyse] API error", res.status, data);

    } catch (e) {
      if (!state.lastOk) clearStatsUI(true);
      cancel();
      console.error("[analyse] stats failed", e);
    }
  }

  function start(fileId, axis='Z') {
    cancel();
    state.token = Math.random() + Date.now();
    state.fileId = fileId;
    state.axis = (axis || 'Z').toUpperCase();
    _pollOnce(state.token);
  }

  return { start, cancel, get state(){ return state; } };
})();

// proxy fetchStats
function fetchStats(fileId, axis='Z') { StatsPoller.start(fileId, axis); }

/* Radios X/Y/Z → recalcul surface projetée */
projAxisRadios().forEach(r => r?.addEventListener("change", ()=>{
  currentAxis = getSelectedAxis();
  if (currentFileId) fetchStats(currentFileId, currentAxis);
}));

/* ==================== Lien avec le DFM ==================== */
window.addEventListener('dfm:fileReady', (ev)=>{
  const fid = ev?.detail?.fileId || currentFileId;
  if (fid) fetchStats(fid, getSelectedAxis());
});

// Export vide (ESM)
export {};
