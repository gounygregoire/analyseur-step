/*
 * Orchestrateur DFM – version robuste (résout fileId depuis DOM/URL/Viewer)
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 */

import HeatmapLayer from "./modules/HeatmapLayer.js";
import { loadCameraPresetOptional } from "./viewer.js";

// État global minimal pour la DFM
if (typeof window !== "undefined") {
  window.CAD = {
    fileIdStep: window.CAD?.fileIdStep ?? null,
    materialProfile: window.CAD?.materialProfile ?? null,
    axis: window.CAD?.axis ?? { x: 0, y: 0, z: 1 },
    currentJobId: window.CAD?.currentJobId ?? null,
  };
}

// Sélecteurs
const btnAnalyser = document.querySelector('#btnAnalyser, #analyzeBtn, #btn-analyser');
const axisPanel   = document.querySelector('#dfmAxisPanel, #axis-panel');

// État initial : cacher l'axe mais laisser Analyser cliquable
if (axisPanel) axisPanel.style.display = "none";

const DEBUG_DFM = (typeof window !== 'undefined' && window.DEBUG_DFM === true);
const dbg = (...a) => { if (DEBUG_DFM) console.debug("[DFM]", ...a); };

// ---------------------- UI helpers ----------------------
const UI = {
  info(m){ if (window.showToast) showToast(m,{type:"info"}); },
  warn(m){ if (window.showToast) showToast(m,{type:"warn"}); },
  err(m){  if (window.showToast) showToast(m,{type:"error"}); },
  setLoading(on){ if (btnAnalyser) btnAnalyser.disabled = !!on; },
  progress(pct){ const bar = document.getElementById("dfmProgressBar"); if (bar) bar.style.width = `${pct}%`; }
};

const StatusUI = { set(text){ const el = document.querySelector('#dfmStatusText'); if (el) el.textContent = text || ''; } };

function axisToVector(ax){
  if (!ax) return null;
  if (ax.axis === "X") return {x: ax.direction, y:0, z:0};
  if (ax.axis === "Y") return {x:0, y: ax.direction, z:0};
  if (ax.axis === "Z") return {x:0, y:0, z: ax.direction};
  if (ax.axis === "VECTOR" && Array.isArray(ax.vector)){ const [x=0,y=0,z=1] = ax.vector; return {x,y,z}; }
  return null;
}

async function pollJobStatus(jobId, onUpdate, onDone, onError) {
  let queuedSince = Date.now();
  async function step() {
    try {
      const res = await fetch(`/api/dfm/status?job_id=${encodeURIComponent(jobId)}`);
      const data = await res.json();
      onUpdate?.(data);
      if (data.status === "done") { await onDone?.(data); return; }
      if (data.status === "failed" || data.status === "error") { onError?.(data); return; }
      if (data.status === "queued" && Date.now() - queuedSince > 90_000) {
        StatusUI.set("Toujours en file d’attente… un worker va démarrer dès que possible.");
        queuedSince = Date.now();
      }
    } catch (e) { console.error("poll error", e); }
    setTimeout(step, 1500);
  }
  step();
}

function renderDFMResults(report = {}) {
  const { score = 0, recommendations = [], metrics = {} } = report;
  const panel = document.getElementById('dfmAnalysisPanel'); if (!panel) return;
  panel.innerHTML = '';
  const scoreEl = document.createElement('div'); scoreEl.textContent = `Score: ${score}`; panel.appendChild(scoreEl);
  if (Array.isArray(recommendations) && recommendations.length) {
    const ul = document.createElement('ul');
    recommendations.forEach(r => { const li = document.createElement('li'); li.textContent = r.message || r.id || JSON.stringify(r); ul.appendChild(li); });
    panel.appendChild(ul);
  }
  if (metrics && Object.keys(metrics).length) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(metrics, null, 2); panel.appendChild(pre); }
}
if (typeof window !== 'undefined') window.renderDFMResults = renderDFMResults;

async function pollDFMReport(fileId, maxMs=120000){
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await fetch(`/api/simple/report/${fileId}`, { cache: "no-store" });
    if (r.status === 200) {
      const d = await r.json();
      renderDFMResults?.({ score: d.score ?? 0, recommendations: Array.isArray(d.recommendations) ? d.recommendations : [], metrics: d.metrics ?? {} });
      return;
    }
    await new Promise(res => setTimeout(res, 2500));
  }
  UI.err?.("Analyse trop longue, réessaie.");
}

/* ---------- Matériau: trouve et ouvre la BONNE modale ---------- */
function findRealMaterialModal() {
  const SELS = [
    '#materialQuestionnaireModal',
    '#materialModal',
    '[data-material-modal]:not([data-fallback])',
    '.modal[data-role="material"]'
  ];
  const candidates = Array.from(document.querySelectorAll(SELS.join(',')));
  const withForm = candidates.find(el => el.querySelector('#materialQuestionnaireForm, [data-material-form]'));
  return withForm || candidates[0] || null;
}

function showMaterialModal() {
  const el = findRealMaterialModal();
  if (!el) { console.warn('[dfm] modale matière introuvable'); return; }
  if (!window.bootstrap || !bootstrap.Modal) {
    // Fallback vanilla si Bootstrap absent
    el.style.display = 'block';
    el.style.visibility = 'visible';
    el.style.opacity = '1';
    el.style.zIndex = '1050';
    el.classList.add('show');
    // backdrop minimal
    let bd = document.getElementById('__dfm_backdrop__');
    if (!bd) {
      bd = document.createElement('div');
      bd.id='__dfm_backdrop__';
      Object.assign(bd.style,{position:'fixed',inset:'0',background:'rgba(0,0,0,.45)',zIndex:'1040'});
      document.body.appendChild(bd);
      bd.addEventListener('click', ()=>{ el.style.display='none'; el.classList.remove('show'); bd.remove(); });
    }
    return;
  }
  bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' }).show();
}
function openMaterialModal(){ showMaterialModal(); }

/* ---------- Gate matière/axe ---------- */
function materialIsConfirmed(){ return !!window.selectedMaterial; }
function showAxisPanelIfReady(){
  if (!axisPanel) return;
  if (!window.currentFileId || !materialIsConfirmed()) return;
  axisPanel.style.display = '';
}
window.addEventListener('material:confirmed', showAxisPanelIfReady);
window.addEventListener('material:selected',  showAxisPanelIfReady);
window.addEventListener('axis:confirmed', (e) => { window.selectedAxis = e?.detail; });
function axisIsValidated(){ return !!window.selectedAxis; }

/* ---------- Classe orchestrateur ---------- */
const DFM_STATES = { IDLE:"IDLE", MATERIAL_CONFIRMED:"MATERIAL_CONFIRMED", AXIS_PICK:"AXIS_PICK", RUNNING:"RUNNING", RESULTS:"RESULTS", ERROR:"ERROR" };

class DFMOrchestrator {
  constructor(){
    this.phase = DFM_STATES.IDLE;
    this.state = this.state || { fileLoaded: false, materialSelected: false, axisConfirmed: false, running: false };
    this.fileId = null; this.materialProfile = null; this.demouldAxis = null;
    this.currentAxis = 'AUTO'; this.invert = false; this.axisValidated = false;
    this.axisSelection = null; this.selectedAxis = null; this.selectedInvert = false;
    this.axisPanel = null; this.axisPanelInitialized = false; this.axisPicker = null; this.confirmedAxis = null;
  }

  init(){
    window.addEventListener('material:selected', (e) => {
      this.setMaterialProfile(e.detail.materialProfile);
      window.CAD.materialProfile = this.materialProfile;
      window.dispatchEvent(new CustomEvent('material:confirmed'));
    });
    window.addEventListener('material:confirmed', () => this.renderAxisPanel());
    window.addEventListener('axis:confirmed', (e) => {
      this.selectedAxis = e.detail.axis; this.selectedInvert = !!e.detail.invert;
      this.state.axisConfirmed = true;
    });
  }

  setState(next){ this.phase = next; dbg("state →", next); }

  setFileId(id){
    if (!id) return false;
    if (this.fileId && this.fileId !== id) { console.warn('[DFM] file_id mismatch', this.fileId, id); return false; }
    this.fileId = id; this.state.fileLoaded = true; this.state.axisConfirmed = false;
    const hidden = document.getElementById('fileId'); if (hidden && hidden.type === 'hidden') hidden.value = this.fileId || '';
    this.refreshAxisState?.(); return true;
  }
  setMaterialProfile(p){
    this.materialProfile = p || null; this.state.materialSelected = !!this.materialProfile; this.state.axisConfirmed = false;
    this.resetAxisValidation(); this.refreshAxisState?.();
  }
  async debugFileId(){
    if (!this.fileId) return;
    try { const res = await fetch(`/api/dfm/debug/file/${this.fileId}`); const data = await res.json().catch(()=>({})); console.debug('[DFM debug]', data); }
    catch (err) { console.warn('debugFileId failed', err); }
  }
  setDemouldAxis(a){ const vec = axisToVector(a); this.demouldAxis = vec || null; window.CAD.axis = vec; }
  resetAxisValidation(){
    this.axisValidated = false; this.axisSelection = null;
    if (this.axisConfirmBtn){
      this.axisConfirmBtn.disabled = false;
      this.axisConfirmBtn.classList.remove('btn-success');
      this.axisConfirmBtn.classList.add('btn-primary');
      this.axisConfirmBtn.innerHTML = "Valider l'axe de démoulage";
    }
  }

  resolveFileId(){
    if (this.fileId) return this.fileId;
    let id = document.body?.dataset?.fileid; if (id) return id;
    id = window.CAD?.fileIdStep || window.CADLYTICS?.current?.fileId; if (id) return id;
    const hidden = document.getElementById('fileId'); if (hidden && hidden.type === 'hidden' && hidden.value) return hidden.value;
    id = window.viewerAdapter?.current?.fileId; if (id) return id;
    return null;
  }
  setFileIdFromPage(){ const id = this.resolveFileId(); if (id) this.setFileId(id); return id; }

  initAxisPanel(){
    const panel = document.getElementById('dfmAxisPanel');
    if (!panel){
      const obs = new MutationObserver(()=>{
        const p = document.getElementById('dfmAxisPanel');
        if (p){ obs.disconnect(); this.axisPanelInitialized = false; this.initAxisPanel(); }
      });
      obs.observe(document.body, { childList: true, subtree: true }); return;
    }
    if (this.axisPanelInitialized && this.axisPanel === panel) return;
    this.axisPanel = panel; this.axisPanelInitialized = true; this.axisPanel.style.display = 'none';

    this.axisButtons = { X: document.getElementById('axisXBtn'), Y: document.getElementById('axisYBtn'),
                         Z: document.getElementById('axisZBtn'), AUTO: document.getElementById('axisAutoBtn') };
    this.invertToggle = document.getElementById('invertAxisToggle');
    this.axisConfirmBtn = document.getElementById('axisConfirmBtn');

    Object.entries(this.axisButtons).forEach(([axis, btn])=>{ if (!btn) return; btn.addEventListener('click', ()=>{ this.currentAxis = axis; }); });
    if (this.invertToggle){ this.invertToggle.addEventListener('change', e=>{ this.invert = !!e.target.checked; }); }

    if (this.axisConfirmBtn){
      this.resetAxisValidation();
      this.axisConfirmBtn.addEventListener('click', () => {
        if (this.axisConfirmBtn.disabled) return;
        this.axisConfirmBtn.disabled = true;
        if (!this.fileId || !this.materialProfile){
          UI.info("Importez un fichier et validez la matière avant l’axe.");
          setTimeout(()=>{ this.axisConfirmBtn.disabled = false; }, 400);
          return;
        }
        this.axisValidated = true;
        this.axisSelection = { axis: this.currentAxis, invert: this.invert, ts: Date.now() };
        this.setDemouldAxis({ axis: this.currentAxis, direction: this.invert ? -1 : 1 });
        const vec = this.demouldAxis;
        window.dispatchEvent(new CustomEvent('axis:confirmed', { detail: { axis: vec } }));
        this.axisConfirmBtn.innerHTML = 'Axe validé <span class="ms-1">✅</span>';
        this.axisConfirmBtn.classList.remove('btn-primary');
        this.axisConfirmBtn.classList.add('btn-success');
      });
    }
    this.refreshAxisState();
  }
  updateAxisPanelState(){
    const enabled = !!(this.fileId && this.materialProfile);
    if (this.axisButtons){ Object.values(this.axisButtons).forEach(btn=>{ if (btn) btn.disabled = !enabled; }); }
    if (this.invertToggle) this.invertToggle.disabled = !enabled;
  }
  refreshAxisState(){
    const canShow = !!(this.fileId && this.materialProfile);
    if (this.axisPanel) this.axisPanel.style.display = canShow ? 'block' : 'none';
    this.updateAxisPanelState();
  }

  renderAxisPanel() {
    if (!this.fileId && typeof this.setFileIdFromPage === 'function') this.setFileIdFromPage();
    if (!this.fileId || !this.materialProfile) { if (!this.fileId) UI?.info?.("Aucun fichier à analyser. Merci d’importer une pièce."); return; }
    if (!this.state.materialSelected) return;

    let panel = document.getElementById('dfmAxisPanel'); if (panel) panel.remove();

    const viewerEl = document.getElementById('viewer') || document.querySelector('#viewer, #xeokit-viewer, canvas[data-role="viewer"]');
    if (!viewerEl) { console.warn('[DFM] viewer container introuvable, impossible d’injecter le panneau d’axe'); return; }

    panel = document.createElement('div');
    panel.id = 'dfmAxisPanel';
    panel.className = 'card mt-3';
    panel.innerHTML = `
      <div class="card-body" id="axisPickerContainer">
        <div class="d-flex align-items-center justify-content-between">
          <h6 class="mb-0">Direction de démoulage</h6>
          <div><button id="axisConfirmBtn" class="btn btn-primary btn-sm">Valider l’axe</button></div>
        </div>
        <div id="axisWidget" class="mt-2"></div>
        <div class="form-check form-switch mt-2">
          <input class="form-check-input" type="checkbox" id="invertAxisToggle">
          <label class="form-check-label" for="invertAxisToggle">Inverser le sens</label>
        </div>
      </div>`;
    viewerEl.insertAdjacentElement('afterend', panel);

    const container = panel.querySelector('#axisWidget');
    if (typeof AxisPicker === 'function') {
      this.axisPicker = new AxisPicker(container, { viewer: this.viewer });
    } else {
      container.innerHTML = `
        <div class="btn-group" role="group" aria-label="Axe">
          <input type="radio" class="btn-check" name="axis" id="axisX" autocomplete="off" value="X">
          <label class="btn btn-outline-secondary" for="axisX">X</label>
          <input type="radio" class="btn-check" name="axis" id="axisY" autocomplete="off" value="Y">
          <label class="btn btn-outline-secondary" for="axisY">Y</label>
          <input type="radio" class="btn-check" name="axis" id="axisZ" autocomplete="off" value="Z" checked>
          <label class="btn btn-outline-secondary" for="axisZ">Z</label>
        </div>`;
      this.axisPicker = {
        getAxis() {
          const v = (document.querySelector('input[name="axis"]:checked')?.value || 'Z').toUpperCase();
          return v === 'X' ? { x: 1, y: 0, z: 0 } : v === 'Y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
        }
      };
    }
    this.invertToggle = panel.querySelector('#invertAxisToggle');

    panel.querySelector('#axisConfirmBtn')?.addEventListener('click', () => {
      const axis = this.axisPicker?.getAxis?.();
      if (!axis) { UI?.info?.("Choisissez une direction d’axe avant de valider."); return; }
      const invert = !!this.invertToggle?.checked;
      window.dispatchEvent(new CustomEvent('axis:confirmed', { detail: { axis, invert } }));
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  async handleAnalyzeClick(){
    const fileId = this.resolveFileId();
    if (!fileId) { openMaterialModal(); return; }
    if (!materialIsConfirmed()) { openMaterialModal(); return; }
    if (!axisIsValidated()) { showAxisPanelIfReady(); return; }
    this.setFileId(fileId);
    await this.startDFM();
  }

  async startDFM() {
    const payload = { file_id: this.fileId, axis: this.selectedAxis || { x:0, y:0, z:1 }, material: this.materialProfile?.id, options: {} };
    if (!payload.file_id || !payload.material || !payload.axis) { UI.info?.('Paramètre manquant pour l’analyse.'); return; }
    UI.setLoading?.(true); this.state.running = true;
    try {
      const res = await fetch('/api/simple/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { this.handleError?.(data.error || 'Analyse échouée'); return; }
      await pollDFMReport(this.fileId);
      await this.renderResults(data);
      window.refreshHistory?.();
    } catch (err) { console.error('DFM start network error', err); this.handleError?.('Network error'); }
    finally { UI.setLoading?.(false); this.state.running = false; }
  }

  pollStatus(jobId) {
    pollJobStatus(jobId,
      (s) => {
        if (s.status === 'queued')      StatusUI.set('En file d’attente…');
        else if (s.status === 'running'){ StatusUI.set(s.step ? `Analyse en cours… (${s.step})` : 'Analyse en cours…'); if (typeof s.progress === 'number') UI.progress(s.progress); }
      },
      () => { StatusUI.set('Analyse terminée'); UI.setLoading(false); this.state.running = false; },
      () => { StatusUI.set('Analyse échouée'); UI.err('Analyse échouée'); UI.setLoading(false); this.state.running = false; }
    );
  }

  async renderResults(results = {}){
    StatusUI.set("Analyse terminée");
    this.setState(DFM_STATES.RESULTS);
    const section = document.getElementById("dfmResultsSection"); if (section) section.style.display = "block";
    const panel = document.getElementById("dfmAnalysisPanel"); if (!panel) return;
    panel.innerHTML = "";

    if (results.summary){
      const table = document.createElement("table"); table.className = "table table-sm";
      const tbody = document.createElement("tbody");
      Object.entries(results.summary).forEach(([k,v])=>{ const tr = document.createElement("tr"); tr.innerHTML = `<th>${k}</th><td>${Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : v}</td>`; tbody.appendChild(tr); });
      table.appendChild(tbody); panel.appendChild(table);
    }
    if (Array.isArray(results.issues) && results.issues.length){
      const ul = document.createElement("ul"); ul.className = "list-unstyled";
      results.issues.forEach(issue => { const sev = issue.severity === 'error' ? 'danger' : issue.severity === 'warn' ? 'warning text-dark' : 'secondary';
        const li = document.createElement("li"); li.innerHTML = `<span class="badge bg-${sev} me-1">${issue.type}</span>${issue.message}`; ul.appendChild(li); });
      panel.appendChild(ul);
    }
    if (results.heatmap?.per_face?.length) {
      const hmBtn = document.createElement("button"); hmBtn.id = "dfmHeatmapBtn";
      hmBtn.className = "btn btn-outline-primary btn-sm mt-2"; hmBtn.textContent = "Afficher heatmap (beta)";
      if (!window.viewerAdapter?.viewer) hmBtn.disabled = true;
      hmBtn.addEventListener("click", () => {
        const mapping = {}; results.heatmap.per_face.forEach(({ face_id, value }) => { mapping[face_id] = value; });
        const layer = new HeatmapLayer(window.viewerAdapter); layer.apply(mapping);
      });
      panel.appendChild(hmBtn);
    }
    await this._applyViewData();
  }

  async _applyViewData(){
    const fileId = this.fileId; if (!fileId) return;
    const preset = await loadCameraPresetOptional(`/static/dfm/${fileId}/camera_states.json`);
    if (preset?.iso) {
      const cam = window.viewerAdapter?.viewer?.camera;
      if (cam) { cam.eye = preset.iso.eye; cam.look = preset.iso.look; cam.up = preset.iso.up; }
    }
  }

  handleError(message){
    StatusUI.set("Échec de l’analyse"); this.setState(DFM_STATES.ERROR);
    const section = document.getElementById("dfmResultsSection"); if (section) section.style.display = "block";
    const panel = document.getElementById("dfmAnalysisPanel"); if (!panel) return;
    panel.innerHTML = `<div class="alert alert-danger">${message}
      <a href="#" id="retryDFM" class="alert-link">Relancer</a></div>`;
    document.getElementById("retryDFM")?.addEventListener("click", e => { e.preventDefault(); this.setState(DFM_STATES.AXIS_PICK); });
  }
}

/* ---------- Instance + exposition globale ---------- */
const orchestrator = (typeof window !== 'undefined' && window.DFMOrchestrator) ? window.DFMOrchestrator : new DFMOrchestrator();
if (typeof window !== 'undefined') {
  window.DFMOrchestrator = orchestrator;
  window.orchestrator    = window.DFMOrchestrator; // alias legacy pour vieux appels
}

/* ---------- Hook bouton Analyser en phase "capture" ---------- */
if (btnAnalyser) {
  btnAnalyser.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation(); // coupe d'éventuels fallbacks
    const fileId = orchestrator.resolveFileId?.() || window.currentFileId;
    if (!fileId || !materialIsConfirmed()) { openMaterialModal(); return; }
    if (!axisIsValidated()) { showAxisPanelIfReady(); return; }
    orchestrator.setFileId?.(fileId);
    orchestrator.startDFM?.();
  }, true); // capture
}

/* ---------- Wiring init ---------- */
function initDFMUI() {
  if (typeof window !== 'undefined') {
    window.showMaterialModal = showMaterialModal;
    window.openMaterialModal = openMaterialModal;
  }
  document.addEventListener("DOMContentLoaded", () => {
    orchestrator.setFileId(window.CAD.fileIdStep);
    orchestrator.setMaterialProfile(window.CAD.materialProfile);
    window.addEventListener('dfm:fileReady', e => {
      window.CAD.fileIdStep = e.detail.fileId;
      orchestrator.setFileId(e.detail.fileId);
    });
    document.getElementById('debugFileId')?.addEventListener('click', () => orchestrator.debugFileId());
    orchestrator.init();
  });
}
if (typeof window !== 'undefined') {
  window.DFM_STATES = DFM_STATES;
  window.dfmOrchestrator = orchestrator;
  window.initDFMUI = initDFMUI;
  window.collectMaterialForm = function collectMaterialForm(){ /* … si besoin, tu peux garder ta version complète */ };
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') initDFMUI();

/* ---------- Self-check ---------- */
function dfmSelfCheck() {
  const errors = [];
  if (!document.querySelector("#materialQuestionnaireModal, #materialModal, [data-material-modal], .modal[data-role='material']")) errors.push("modal matière absente");
  if (!btnAnalyser) errors.push("#btnAnalyser/#analyzeBtn/#btn-analyser absent");
  if (errors.length) console.warn("[DFM selfcheck] Issues:", errors); else dbg('selfcheck OK');
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') window.requestAnimationFrame(dfmSelfCheck);

/* Legacy onclick="onAnalyzeClick()" */
if (typeof window !== 'undefined') window.onAnalyzeClick = () => btnAnalyser?.click();
