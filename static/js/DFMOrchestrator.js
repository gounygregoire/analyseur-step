/*
 * Orchestrateur DFM – ouverture modale matière infaillible + flux analyse
 * (ne modifie que le chemin “ouvrir la bonne modale”)
 */

import HeatmapLayer from "./modules/HeatmapLayer.js";

// util optionnel (inchangé)
async function loadCameraPresetOptional(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/* ---------- État global minimal ---------- */
if (typeof window !== "undefined") {
  window.CAD = {
    fileIdStep: window.CAD?.fileIdStep ?? null,
    materialProfile: window.CAD?.materialProfile ?? null,
    axis: window.CAD?.axis ?? { x: 0, y: 0, z: 1 },
    currentJobId: window.CAD?.currentJobId ?? null,
  };
}

const DEBUG_DFM = (typeof window !== 'undefined' && window.DEBUG_DFM === true);
const dbg = (...a) => { if (DEBUG_DFM) console.debug("[DFM]", ...a); };

/* ---------- Sélecteurs & helpers ---------- */
const BTN_SEL = '#btnAnalyser, #analyzeBtn, #btn-analyser, #btnAnalyse, #analyser, .btn-analyser, [data-action="analyze"], [data-act="analyze"]';
const MATERIAL_MODAL_SEL =
  '#materialQuestionnaireModal, #materialModal, [data-material-modal], .modal[data-role="material"]';

function findRealMaterialModal() {
  const list = Array.from(document.querySelectorAll(MATERIAL_MODAL_SEL));
  if (!list.length) return null;
  return (
    list.find(el => el.querySelector('#materialQuestionnaireForm, [data-material-form]')) ||
    list[0]
  );
}

function openMaterialModalVanilla(el){
  if (!el) return;
  let bd = document.getElementById('__dfm_bd__');
  if (!bd) {
    bd = document.createElement('div');
    bd.id = '__dfm_bd__';
    Object.assign(bd.style,{position:'fixed',inset:'0',background:'rgba(0,0,0,.45)',zIndex:'1040'});
    document.body.appendChild(bd);
    bd.addEventListener('click', () => closeMaterialModalVanilla(el));
  }
  el.classList.add('show');
  Object.assign(el.style,{
    display:'block', visibility:'visible', opacity:'1', zIndex:'1050',
    position:(getComputedStyle(el).position === 'static' ? 'fixed' : getComputedStyle(el).position),
    left:'50%', top:'50%', transform:'translate(-50%, -50%)', maxHeight:'90vh', overflow:'auto'
  });
  el.addEventListener('click', (ev)=>{
    if (ev.target.matches('.btn-close,[data-bs-dismiss="modal"],[data-dismiss="modal"]')) closeMaterialModalVanilla(el);
  });
}
function closeMaterialModalVanilla(el){
  el.classList.remove('show');
  el.style.display='none';
  el.style.visibility='hidden';
  el.style.opacity='0';
  document.getElementById('__dfm_bd__')?.remove();
}

function showMaterialModal() {
  const el = findRealMaterialModal();
  if (!el) { console.warn('[dfm] Modale matière introuvable'); return; }
  if (window.bootstrap?.Modal) {
    window.bootstrap.Modal.getOrCreateInstance(el, { backdrop:'static' }).show();
  } else {
    openMaterialModalVanilla(el);
  }
}
function openMaterialModal(){ showMaterialModal(); }

// expose global pour main.js / autres
if (typeof window !== 'undefined') {
  window.showMaterialModal = window.showMaterialModal || showMaterialModal;
  window.openMaterialModal = window.openMaterialModal || openMaterialModal;
}

/* ---------- Interception du clic Analyser (phase capture) ---------- */
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.(BTN_SEL);
  if (!btn) return;

  // on est volontairement en capture (ce listener est global)
  e.preventDefault();
  e.stopImmediatePropagation();

  const fileId  = window.currentFileId || window.CAD?.fileIdStep || null;
  const hasMat  = !!window.selectedMaterial;
  const hasAxis = !!window.selectedAxis;

  if (!fileId || !hasMat) { showMaterialModal(); return; }
  if (!hasAxis) {
    // affiche le panneau axe si présent
    const p = document.querySelector('#dfmAxisPanel, #axis-panel');
    if (p) p.style.display = '';
    return;
  }

  // démarrage analyse si tout est prêt (inchangé)
  try { orchestrator.setFileId?.(fileId); orchestrator.startDFM?.(); }
  catch (err) { console.warn(err); }
}, true);

/* ---------- États & orchestrateur (inchangés, sauf ouvertures modales) ---------- */
const DFM_STATES = {
  IDLE:"IDLE", MATERIAL_CONFIRMED:"MATERIAL_CONFIRMED", AXIS_PICK:"AXIS_PICK",
  RUNNING:"RUNNING", RESULTS:"RESULTS", ERROR:"ERROR"
};

class DFMOrchestrator {
  constructor(){
    this.phase = DFM_STATES.IDLE;
    this.state = this.state || { fileLoaded:false, materialSelected:false, axisConfirmed:false, running:false };
    this.fileId = null;
    this.materialProfile = null;
    this.demouldAxis = null;
    this.currentAxis = 'AUTO';
    this.invert = false;
    this.axisValidated = false;
    this.axisSelection = null;
    this.selectedAxis = null;
    this.selectedInvert = false;
    this.axisPanel = null;
    this.axisPanelInitialized = false;
    this.axisPicker = null;
    this.confirmedAxis = null;
  }

  init(){
    window.addEventListener('material:selected', (e) => {
      this.setMaterialProfile(e.detail.materialProfile);
      window.CAD.materialProfile = this.materialProfile;
      window.dispatchEvent(new CustomEvent('material:confirmed'));
    });
    window.addEventListener('material:confirmed', () => this.renderAxisPanel());
    window.addEventListener('axis:confirmed', (e) => {
      this.selectedAxis = e.detail.axis;
      this.selectedInvert = !!e.detail.invert;
      this.state.axisConfirmed = true;
    });
  }

  setState(next){ this.phase = next; dbg("state →", next); }

  setFileId(id){
    if (!id) return false;
    if (this.fileId && this.fileId !== id) { console.warn('[DFM] file_id mismatch', this.fileId, id); return false; }
    this.fileId = id;
    this.state.fileLoaded = true;
    this.state.axisConfirmed = false;
    const hidden = document.getElementById('fileId');
    if (hidden && hidden.type === 'hidden') hidden.value = this.fileId || '';
    this.refreshAxisState?.();
    return true;
  }
  setMaterialProfile(p){
    this.materialProfile = p || null;
    this.state.materialSelected = !!this.materialProfile;
    this.state.axisConfirmed = false;
    this.resetAxisValidation();
    this.refreshAxisState?.();
  }

  setDemouldAxis(a){
    const vec = (a?.axis === "X") ? {x:a.direction,y:0,z:0}
              : (a?.axis === "Y") ? {x:0,y:a.direction,z:0}
              : (a?.axis === "Z") ? {x:0,y:0,z:a.direction}
              : Array.isArray(a?.vector) ? {x:a.vector[0]||0,y:a.vector[1]||0,z:a.vector[2]||1} : null;
    this.demouldAxis = vec || null;
    window.CAD.axis = vec;
  }

  resetAxisValidation(){
    this.axisValidated = false;
    this.axisSelection = null;
    if (this.axisConfirmBtn){
      this.axisConfirmBtn.disabled = false;
      this.axisConfirmBtn.classList.remove('btn-success');
      this.axisConfirmBtn.classList.add('btn-primary');
      this.axisConfirmBtn.innerHTML = "Valider l'axe de démoulage";
    }
  }

  resolveFileId(){
    if (this.fileId) return this.fileId;
    let id = document.body?.dataset?.fileid;             if (id) return id;
    id = window.CAD?.fileIdStep || window.CADLYTICS?.current?.fileId; if (id) return id;
    const hidden = document.getElementById('fileId');    if (hidden?.type==='hidden' && hidden.value) return hidden.value;
    id = window.viewerAdapter?.current?.fileId;          if (id) return id;
    return null;
  }

  setFileIdFromPage(){ const id = this.resolveFileId(); if (id) this.setFileId(id); return id; }

  initAxisPanel(){
    const panel = document.getElementById('dfmAxisPanel');
    if (!panel){
      const obs = new MutationObserver(()=>{ const p = document.getElementById('dfmAxisPanel'); if (p){ obs.disconnect(); this.axisPanelInitialized=false; this.initAxisPanel(); }});
      obs.observe(document.body, { childList:true, subtree:true });
      return;
    }
    if (this.axisPanelInitialized && this.axisPanel === panel) return;
    this.axisPanel = panel;
    this.axisPanelInitialized = true;
    this.axisPanel.style.display = 'none';

    this.axisButtons = {
      X: document.getElementById('axisXBtn'),
      Y: document.getElementById('axisYBtn'),
      Z: document.getElementById('axisZBtn'),
      AUTO: document.getElementById('axisAutoBtn')
    };
    this.invertToggle = document.getElementById('invertAxisToggle');
    this.axisConfirmBtn = document.getElementById('axisConfirmBtn');

    Object.entries(this.axisButtons).forEach(([axis, btn])=>{
      if (!btn) return;
      btn.addEventListener('click', ()=>{ this.currentAxis = axis; });
    });
    this.invertToggle?.addEventListener('change', e=>{ this.invert = !!e.target.checked; });

    if (this.axisConfirmBtn){
      this.resetAxisValidation();
      this.axisConfirmBtn.addEventListener('click', () => {
        if (this.axisConfirmBtn.disabled) return;
        this.axisConfirmBtn.disabled = true;
        if (!this.fileId || !this.materialProfile){
          setTimeout(()=>{ this.axisConfirmBtn.disabled = false; }, 300);
          return;
        }

        this.axisValidated = true;
        this.axisSelection = { axis: this.currentAxis, invert: this.invert, ts: Date.now() };
        this.setDemouldAxis({ axis: this.currentAxis, direction: this.invert ? -1 : 1 });
        const vec = this.demouldAxis;

        window.dispatchEvent(new CustomEvent('axis:confirmed', { detail: { axis: vec, invert: this.invert } }));

        this.axisConfirmBtn.innerHTML = 'Axe validé <span class="ms-1">✅</span>';
        this.axisConfirmBtn.classList.remove('btn-primary');
        this.axisConfirmBtn.classList.add('btn-success');

        const ensured = this.setFileIdFromPage();
        const fid = ensured || this.fileId;
        if (fid && this.materialProfile) {
          this._renderLoading();
          this.startDFM();
        } else {
          this.axisConfirmBtn.disabled = false;
        }
      });
    }

    this.refreshAxisState();
  }

  updateAxisPanelState(){
    const enabled = !!(this.fileId && this.materialProfile);
    if (this.axisButtons){
      Object.values(this.axisButtons).forEach(btn=>{ if (btn) btn.disabled = !enabled; });
    }
    if (this.invertToggle) this.invertToggle.disabled = !enabled;
  }

  refreshAxisState(){
    const canShow = !!(this.fileId && this.materialProfile);
    if (this.axisPanel) this.axisPanel.style.display = canShow ? 'block' : 'none';
    this.updateAxisPanelState();
  }

  renderAxisPanel() {
    if (!this.fileId && typeof this.setFileIdFromPage === 'function') this.setFileIdFromPage();
    if (!this.fileId || !this.materialProfile) return;
    if (!this.state.materialSelected) return;

    let panel = document.getElementById('dfmAxisPanel');
    if (panel) panel.remove();

    const viewerEl = document.getElementById('viewer')
      || document.querySelector('#viewer, #xeokit-viewer, canvas[data-role="viewer"], #viewerContainer');
    if (!viewerEl) { console.warn('[DFM] viewer container introuvable'); return; }

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
      if (!axis) return;
      const invert = !!this.invertToggle?.checked;
      window.dispatchEvent(new CustomEvent('axis:confirmed', { detail: { axis, invert } }));
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });

      const ensured = this.setFileIdFromPage();
      const fid = ensured || this.fileId;
      if (fid && this.materialProfile) { this._renderLoading(); this.startDFM(); }
    });
  }

  async handleAnalyzeClick(){
    const fileId = this.resolveFileId();
    if (!fileId) { showMaterialModal(); return; }
    if (!window.selectedMaterial) { showMaterialModal(); return; }
    if (!window.selectedAxis) {
      const p = document.querySelector('#dfmAxisPanel, #axis-panel');
      if (p) p.style.display = '';
      return;
    }
    this.setFileId(fileId);
    await this.startDFM();
  }

  /* ---------- Analyse (inchangé) ---------- */
  async startDFM() {
    const payload = {
      file_id: this.fileId,
      axis: this.selectedAxis || { x: 0, y: 0, z: 1 },
      material: this.materialProfile?.id,
      options: {},
    };
    if (!payload.file_id || !payload.material || !payload.axis) return;

    try {
      const res = await fetch('/api/simple/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { this.handleError?.(data.error || 'Analyse échouée'); return; }

      await pollDFMReport(this.fileId);
      await this.renderResults(data);
      window.refreshHistory?.();
    } catch (err) {
      console.error('DFM start network error', err);
      this.handleError?.('Network error');
    }
  }

  async renderResults(results = {}) {
    const section = document.getElementById("dfmResultsSection");
    if (section) section.style.display = "block";
    const panel = document.getElementById("dfmAnalysisPanel");
    if (!panel) return;
    panel.innerHTML = "";

    if (results.summary){
      const table = document.createElement("table");
      table.className = "table table-sm";
      const tbody = document.createElement("tbody");
      Object.entries(results.summary).forEach(([k,v])=>{
        const tr = document.createElement("tr");
        tr.innerHTML = `<th>${k}</th><td>${Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : v}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      panel.appendChild(table);
    }
    if (Array.isArray(results.issues) && results.issues.length){
      const ul = document.createElement("ul");
      ul.className = "list-unstyled";
      results.issues.forEach(issue => {
        const li = document.createElement("li");
        const sev = issue.severity === 'error' ? 'danger' : issue.severity === 'warn' ? 'warning text-dark' : 'secondary';
        li.innerHTML = `<span class="badge bg-${sev} me-1">${issue.type}</span>${issue.message}`;
        ul.appendChild(li);
      });
      panel.appendChild(ul);
    }

    if (results.heatmap?.per_face?.length) {
      const hmBtn = document.createElement("button");
      hmBtn.id = "dfmHeatmapBtn";
      hmBtn.className = "btn btn-outline-primary btn-sm mt-2";
      hmBtn.textContent = "Afficher heatmap (beta)";
      if (!window.viewerAdapter?.viewer) hmBtn.disabled = true;
      hmBtn.addEventListener("click", () => {
        const mapping = {};
        results.heatmap.per_face.forEach(({ face_id, value }) => { mapping[face_id] = value; });
        const layer = new HeatmapLayer(window.viewerAdapter);
        layer.apply(mapping);
      });
      panel.appendChild(hmBtn);
    }

    await this._applyViewData();
  }

  async _applyViewData(){
    const fileId = this.fileId;
    if (!fileId) return;
    const preset = await loadCameraPresetOptional(`/static/dfm/${fileId}/camera_states.json`);
    if (preset?.iso) {
      const cam = window.viewerAdapter?.viewer?.camera;
      if (cam) { cam.eye = preset.iso.eye; cam.look = preset.iso.look; cam.up = preset.iso.up; }
    }
  }

  handleError(message){
    const section = document.getElementById("dfmResultsSection");
    if (section) section.style.display = "block";
    const panel = document.getElementById("dfmAnalysisPanel");
    if (!panel) return;
    panel.innerHTML = `<div class="alert alert-danger">${message}
      <a href="#" id="retryDFM" class="alert-link">Relancer</a></div>`;
    document.getElementById("retryDFM")?.addEventListener("click", e => {
      e.preventDefault();
      this.setState(DFM_STATES.AXIS_PICK);
    });
  }

  _renderLoading(){
    const section = document.getElementById("dfmResultsSection");
    if (section) section.style.display = "block";
    const panel = document.getElementById("dfmAnalysisPanel");
    if (!panel) return;
    panel.innerHTML = `<div id="dfmLoading" class="text-center my-3">
      <div class="spinner-border" role="status"></div>
      <div id="dfmProgressText" class="mt-2">Analyse DFM en cours...</div>
      <div class="progress mt-2">
        <div id="dfmProgressBar" class="progress-bar progress-bar-striped" style="width:0%"></div>
      </div>
    </div>`;
  }
}

/* ---------- Instanciation ---------- */
const orchestrator = (typeof window !== 'undefined' && window.DFMOrchestrator)
  ? window.DFMOrchestrator
  : new DFMOrchestrator();

if (typeof window !== 'undefined') {
  window.DFMOrchestrator = orchestrator;
  window.orchestrator = window.DFMOrchestrator; // alias
  window.DFM_STATES = DFM_STATES;
  window.dfmOrchestrator = orchestrator;
}

/* ---------- Boot ---------- */
function initDFMUI() {
  if (typeof window === 'undefined') return;
  document.addEventListener("DOMContentLoaded", () => {
    orchestrator.setFileId(window.CAD.fileIdStep);
    orchestrator.setMaterialProfile(window.CAD.materialProfile);

    window.addEventListener('dfm:fileReady', e => {
      window.CAD.fileIdStep = e.detail.fileId;
      orchestrator.setFileId(e.detail.fileId);
    });

    document.getElementById('debugFileId')?.addEventListener('click', () => orchestrator.debugFileId?.());
    orchestrator.init();
  });
}
if (typeof window !== 'undefined') initDFMUI();
