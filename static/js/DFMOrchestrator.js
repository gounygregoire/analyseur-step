/*
 * Orchestrateur DFM – version robuste (résout fileId depuis DOM/URL/Viewer)
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 */

import HeatmapLayer from "./modules/HeatmapLayer.js";
import eventBus from "./modules/events-bus.js";
import { loadCameraPresetOptional } from "./modules/viewer.js";

// État global minimal pour la DFM
if (typeof window !== 'undefined') {
  window.CAD = {
    fileIdStep: window.CAD?.fileIdStep ?? null,
    materialProfile: window.CAD?.materialProfile ?? null,
    axis: window.CAD?.axis ?? { x: 0, y: 0, z: 1 },
    currentJobId: window.CAD?.currentJobId ?? null,
  };
}

const DEBUG_DFM = (typeof window !== 'undefined' && window.DEBUG_DFM === true);
const dbg = (...a) => { if (DEBUG_DFM) console.debug("[DFM]", ...a); };

// ---------------------- UI helpers ----------------------
const UI = {
  info(m){ if (window.showToast) showToast(m,{type:"info"}); },
  warn(m){ if (window.showToast) showToast(m,{type:"warn"}); },
  err(m){  if (window.showToast) showToast(m,{type:"error"}); },
  setLoading(on){
    const b = document.getElementById("analyzeBtn");
    if (b) b.disabled = !!on;
  },
  progress(pct){
    const bar = document.getElementById("dfmProgressBar");
    if (bar) bar.style.width = `${pct}%`;
  }
};

const StatusUI = {
  set(text){
    const el = document.querySelector('#dfmStatusText');
    if (el) el.textContent = text || '';
  }
};

function axisToVector(ax){
  if (!ax) return null;
  if (ax.axis === "X") return {x: ax.direction, y:0, z:0};
  if (ax.axis === "Y") return {x:0, y: ax.direction, z:0};
  if (ax.axis === "Z") return {x:0, y:0, z: ax.direction};
  if (ax.axis === "VECTOR" && Array.isArray(ax.vector)){
    const [x=0,y=0,z=1] = ax.vector;
    return {x,y,z};
  }
  return null;
}
async function pollJobStatus(jobId, onUpdate, onDone, onError) {
  let queuedSince = Date.now();

  async function step() {
    try {
      const res = await fetch(`/api/dfm/status?job_id=${encodeURIComponent(jobId)}`);
      const data = await res.json(); // {status:'queued'|'running'|'done'|'failed', step?, progress?}

      onUpdate?.(data);

      if (data.status === "done") { await onDone?.(data); return; }
      if (data.status === "failed" || data.status === "error") { onError?.(data); return; }

      if (data.status === "queued" && Date.now() - queuedSince > 90_000) {
        StatusUI.set("Toujours en file d’attente… un worker va démarrer dès que possible.");
        queuedSince = Date.now();
      }
    } catch (e) {
      console.error("poll error", e);
    }
    setTimeout(step, 1500);
  }
  step();
}

function renderDFMResults({ score, recommendations, metrics }) {
  const panel = document.getElementById('dfmAnalysisPanel');
  if (!panel) return;
  panel.innerHTML = '';

  const scoreEl = document.createElement('div');
  scoreEl.textContent = `Score: ${score}`;
  panel.appendChild(scoreEl);

  if (Array.isArray(recommendations) && recommendations.length) {
    const ul = document.createElement('ul');
    recommendations.forEach(r => {
      const li = document.createElement('li');
      li.textContent = r.message || r.id || JSON.stringify(r);
      ul.appendChild(li);
    });
    panel.appendChild(ul);
  }

  if (metrics && Object.keys(metrics).length) {
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(metrics, null, 2);
    panel.appendChild(pre);
  }
}
if (typeof window !== 'undefined') {
  window.renderDFMResults = renderDFMResults;
}

async function pollReport(fileId, maxMs = 120000){
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs){
    const r = await fetch(`/api/simple/report/${fileId}`, { cache: 'no-store' });
    if (r.status === 200){
      const d = await r.json();
      renderDFMResults(d);
      return;
    }
    await new Promise(res => setTimeout(res, 2500));
  }
  showError('Analyse trop longue, réessaie.');
}

function showMaterialModal() {
  if (!window.bootstrap) {
    console.error("Bootstrap non chargé");
    return;
  }
  const el =
    document.getElementById("materialModal") ||
    document.querySelector("[data-material-modal]");
  if (!el) {
    console.error("Modal matière introuvable");
    return;
  }
  dbg('ouverture modale matière');
  const modal = bootstrap.Modal.getOrCreateInstance(el, { backdrop: "static" });
  modal.show();
}

// ---------------------- États ----------------------
const DFM_STATES = {
  IDLE:"IDLE", MATERIAL_CONFIRMED:"MATERIAL_CONFIRMED", AXIS_PICK:"AXIS_PICK",
  RUNNING:"RUNNING", RESULTS:"RESULTS", ERROR:"ERROR"
};

class DFMOrchestrator {
  constructor(){
    this.phase = DFM_STATES.IDLE;
    this.state = this.state || {
      fileLoaded: false,
      materialSelected: false,
      axisConfirmed: false,
      running: false,
    };
    this.fileId = null;
    this.materialProfile = null;
    this.demouldAxis = null;
    this.currentAxis = 'AUTO';
    this.invert = false;
    this.axisValidated = false;
    this.axisSelection = null;
    this.selectedAxis = null;
    this.selectedInvert = false;
    // panneau d'axe injecté à la volée
    this.axisPanel = null;
    this.axisPanelInitialized = false;
    this.axisPicker = null;
    this.confirmedAxis = null;
  }

  init(){
    document.getElementById('dfmAxisPanel')?.remove();
    document.getElementById('analyzeBtn')?.addEventListener('click', () => this.handleAnalyzeClick());

    window.addEventListener('material:selected', (e) => {
      this.setMaterialProfile(e.detail.materialProfile);
      window.CAD.materialProfile = this.materialProfile;
      dbg('material:selected', this.materialProfile);
      this.renderAxisPanel();
    });

    window.addEventListener('axis:confirmed', (e) => {
      this.selectedAxis = e.detail.axis;
      this.selectedInvert = !!e.detail.invert;
      this.state.axisConfirmed = true;
      dbg('axis:confirmed', this.selectedAxis, this.selectedInvert);
      this.startAnalysis();
    });
  }

  setState(next){
    this.phase = next; dbg("state →", next);
  }

  setFileId(id){
    if (!id) return false;
    if (this.fileId && this.fileId !== id) {
      console.warn('[DFM] file_id mismatch', this.fileId, id);
      return false;
    }
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
    dbg('material selected', this.materialProfile, 'axis reset');
    this.refreshAxisState?.();
  }
  async debugFileId(){
    if (!this.fileId) {
      console.warn('[DFM] debugFileId: aucun file_id');
      return;
    }
    try {
      const res = await fetch(`/api/dfm/debug/file/${this.fileId}`);
      const data = await res.json().catch(()=>({}));
      console.debug('[DFM debug]', data);
    } catch (err) {
      console.warn('debugFileId failed', err);
    }
  }
  setDemouldAxis(a){
    const vec = axisToVector(a);
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

  // ---------------------- Résolution de fileId ----------------------
  resolveFileId(){
    // 1) fileId déjà en mémoire ?
    if (this.fileId) return this.fileId;

    // 2) dataset du <body>
    let id = document.body?.dataset?.fileid;
    if (id) return id;

    // 3) global (fallback)
    id = window.CAD?.fileIdStep || window.CADLYTICS?.current?.fileId;
    if (id) return id;

    // 4) input hidden
    const hidden = document.getElementById('fileId');
    if (hidden && hidden.type === 'hidden' && hidden.value) return hidden.value;

    // 5) viewerAdapter éventuel
    id = window.viewerAdapter?.current?.fileId;
    if (id) return id;

    return null;
  }

  setFileIdFromPage(){
    const id = this.resolveFileId();
    if (id) this.setFileId(id);
    return id;
  }

  initAxisPanel(){
    const panel = document.getElementById('dfmAxisPanel');
    if (!panel){
      const obs = new MutationObserver(()=>{
        const p = document.getElementById('dfmAxisPanel');
        if (p){
          obs.disconnect();
          this.axisPanelInitialized = false;
          this.initAxisPanel();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
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
      btn.addEventListener('click', ()=>{
        this.currentAxis = axis;
        dbg('axis', axis);
      });
    });

    if (this.invertToggle){
      this.invertToggle.addEventListener('change', e=>{
        this.invert = !!e.target.checked;
        dbg('invert', this.invert);
      });
    }

    if (this.axisConfirmBtn){
      this.resetAxisValidation();
      this.axisConfirmBtn.addEventListener('click', () => {
        if (this.axisConfirmBtn.disabled) return;
        this.axisConfirmBtn.disabled = true;
        dbg('axis confirm before', { fileId: this.fileId, material: this.materialProfile });
        if (!this.fileId || !this.materialProfile){
          UI.info("Importez un fichier et validez la matière avant l’axe.");
          setTimeout(()=>{ this.axisConfirmBtn.disabled = false; }, 400);
          return;
        }
        this.axisValidated = true;
        this.axisSelection = {
          axis: this.currentAxis,
          invert: this.invert,
          ts: Date.now()
        };
        this.setDemouldAxis({ axis: this.currentAxis, direction: this.invert ? -1 : 1 });
        const vec = this.demouldAxis;
        window.dispatchEvent(new CustomEvent('axis:confirmed', { detail: { axis: vec } }));
        this.axisConfirmBtn.innerHTML = 'Axe validé <span class="ms-1">✅</span>';
        this.axisConfirmBtn.classList.remove('btn-primary');
        this.axisConfirmBtn.classList.add('btn-success');
        dbg('axis confirm after', this.axisSelection);
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
    if (this.axisPanel) {
      this.axisPanel.style.display = canShow ? 'block' : 'none';
    }
    this.updateAxisPanelState();
  }

  // Affiche le sélecteur d'axe sous le viewer
  renderAxisPanel() {
    if (!this.state.materialSelected) return;
    if (!this.fileId && typeof this.setFileIdFromPage === 'function' && !this.setFileIdFromPage()) {
      UI?.info?.("Aucun fichier à analyser. Merci d’importer une pièce.");
      return;
    }

    // 2) Nettoyage d’un éventuel panneau déjà présent
    let panel = document.getElementById('dfmAxisPanel');
    if (panel) panel.remove();

    // 3) Point d’ancrage: juste après le viewer
    const viewerEl = document.getElementById('viewer')
      || document.querySelector('#viewer, #xeokit-viewer, canvas[data-role="viewer"]');
    if (!viewerEl) {
      console.warn('[DFM] viewer container introuvable, impossible d’injecter le panneau d’axe');
      return;
    }

    // 4) Création du panneau
    panel = document.createElement('div');
    panel.id = 'dfmAxisPanel';
    panel.className = 'card mt-3';
    panel.innerHTML = `
      <div class="card-body" id="axisPickerContainer">
        <div class="d-flex align-items-center justify-content-between">
          <h6 class="mb-0">Direction de démoulage</h6>
          <div>
            <button id="axisConfirmBtn" class="btn btn-primary btn-sm">Valider l’axe</button>
          </div>
        </div>
        <div id="axisWidget" class="mt-2"></div>
        <div class="form-check form-switch mt-2">
          <input class="form-check-input" type="checkbox" id="invertAxisToggle">
          <label class="form-check-label" for="invertAxisToggle">Inverser le sens</label>
        </div>
      </div>`;

    viewerEl.insertAdjacentElement('afterend', panel);

    // 5) Instanciation du picker (ou fallback)
    const container = panel.querySelector('#axisWidget');
    if (typeof AxisPicker === 'function') {
      // AxisPicker(container, { viewer: this.viewer }) si l’API l’accepte
      this.axisPicker = new AxisPicker(container, { viewer: this.viewer });
    } else {
      // Fallback simple si AxisPicker non chargé
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
          // Convention: vecteur +1 sur l’axe choisi
          return v === 'X' ? { x: 1, y: 0, z: 0 } : v === 'Y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
        }
      };
    }

    this.invertToggle = panel.querySelector('#invertAxisToggle');

    // 6) Bouton "Valider l’axe" → émettre axis:confirmed
    panel.querySelector('#axisConfirmBtn')?.addEventListener('click', () => {
      const axis = this.axisPicker?.getAxis?.();
      if (!axis) {
        UI?.info?.("Choisissez une direction d’axe avant de valider.");
        return;
      }
      const invert = !!this.invertToggle?.checked;
      dbg('axis:confirmed emit', axis, invert);
      window.dispatchEvent(new CustomEvent('axis:confirmed', { detail: { axis, invert } }));
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  handleAnalyzeClick(){
    if (!this.fileId){
      UI.info("Importe un STEP d\u2019abord.");
      const zone = document.getElementById('uploadArea') || document.getElementById('dropzone');
      if (zone){
        zone.scrollIntoView({ behavior: 'smooth', block: 'center' });
        zone.classList.add('pulse');
        setTimeout(()=>zone.classList.remove('pulse'), 1500);
      }
      return;
    }
    if (!this.state.materialSelected){
      showMaterialModal();
      return;
    }
    if (this.state.materialSelected && !this.state.axisConfirmed){
      this.renderAxisPanel();
      document.getElementById('dfmAxisPanel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (this.state.axisConfirmed){
      this.startDFM();
    }
  }

  startDFM(){
    const fileId = this.fileId;
    const profile = this.materialProfile;
    if (!fileId){
      UI.info("Importez un fichier avant d’analyser.");
      console.warn("startDFM: fileId manquant");
      return;
    }
    if (!profile){
      UI.info("Sélectionnez une matière.");
      console.warn("startDFM: matière manquante");
      return;
    }
    if (!this.axisValidated){
      UI.info("Validez l’axe de démoulage.");
      console.warn("startDFM: axe non validé");
      return;
    }

    const axis = this.axisSelection?.axis || 'Z';
    const payload = {
      file_id: fileId,
      material: profile.id || profile.material_profile_id || profile,
      axis,
      invert: this.axisSelection?.invert ?? false,
    };

    UI.setLoading(true);
    this.state.running = true;
    dbg('DFM start: ready to send payload', payload);
    eventBus.publish('dfm:start', payload);
  }

  // ---------------------- Analyse ----------------------
  async startAnalysis() {
    const payload = {
      file_id: this.fileId,
      axis: this.selectedAxis || { x: 0, y: 0, z: 1 },
      material: this.materialProfile?.id,
      options: {},
    };
    console.debug('[DFM] start payload', payload);

    if (!payload.file_id || !payload.material || !payload.axis) {
      UI.info?.('Paramètre manquant pour l’analyse.');
      return;
    }

    UI.setLoading?.(true);
    this.state.running = true;
    try {
      const res = await fetch('/api/simple/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || 'Analyse échouée';
        this.handleError?.(msg);
        return;
      }
      console.info('[dfm] report=', data.report_id);
      await this.renderResults(data);
      window.refreshHistory?.();
    } catch (err) {
      console.error('DFM start network error', err);
      this.handleError?.('Network error');
    } finally {
      UI.setLoading?.(false);
      this.state.running = false;
    }
  }

  pollStatus(jobId) {
    pollJobStatus(
      jobId,
      (s) => {
        if (s.status === 'queued') {
          StatusUI.set('En file d’attente…');
        } else if (s.status === 'running') {
          const label = s.step ? `Analyse en cours… (${s.step})` : 'Analyse en cours…';
          StatusUI.set(label);
          if (typeof s.progress === 'number') UI.progress(s.progress);
        }
      },
      () => {
        StatusUI.set('Analyse terminée');
        UI.setLoading(false);
        this.state.running = false;
      },
      () => {
        StatusUI.set('Analyse échouée');
        UI.err('Analyse échouée');
        UI.setLoading(false);
        this.state.running = false;
      }
    );
  }
  async renderResults(results = {}){
    StatusUI.set("Analyse terminée");
    this.setState(DFM_STATES.RESULTS);
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
        results.heatmap.per_face.forEach(({ face_id, value }) => {
          mapping[face_id] = value;
        });
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
    const cams = await loadCameraPresetOptional(`/static/dfm/${fileId}/camera_states.json`);
    if (cams?.iso) {
      const cam = window.viewerAdapter?.viewer?.camera;
      if (cam) {
        cam.eye = cams.iso.eye;
        cam.look = cams.iso.look;
        cam.up = cams.iso.up;
      }
    }
  }

  handleError(message){
    StatusUI.set("Échec de l’analyse");
    this.setState(DFM_STATES.ERROR);
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

  _makeSortable(table){
    const headers = table.querySelectorAll("th[data-sort]");
    headers.forEach(h=>{
      h.style.cursor = "pointer";
      h.addEventListener("click", ()=>{
        const key = h.dataset.sort;
        const tbody = table.tBodies[0];
        const rows = Array.from(tbody.querySelectorAll("tr"));
        const asc = h.classList.toggle("asc");
        rows.sort((a,b)=>{
          const av = a.dataset[key] || ""; const bv = b.dataset[key] || "";
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
        rows.forEach(r=>tbody.appendChild(r));
      });
    });
  }
}

const orchestrator = (typeof window !== 'undefined' && window.DFMOrchestrator) ? window.DFMOrchestrator : new DFMOrchestrator();
if (typeof window !== 'undefined') {
  window.DFMOrchestrator = orchestrator;
}

eventBus.subscribe('dfm:start', async (payload) => {
  try {
    const res = await fetch('/dfm/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.status === 404) {
      UI.err("Endpoint /dfm/start introuvable");
      console.error('dfm:start 404');
      UI.setLoading(false);
      return;
    }
    if (!res.ok) {
      const msg = `HTTP ${res.status} : ${res.statusText}`;
      UI.err(msg);
      console.error('dfm:start', msg);
      UI.setLoading(false);
      return;
    }

    await res.json().catch(() => ({}));
    StatusUI.set('Analyse en cours…');
    await pollReport(payload.file_id);
    UI.setLoading(false);
    orchestrator.state.running = false;
  } catch (err) {
    console.error('dfm:start network error', err);
    UI.err('Erreur réseau');
    UI.setLoading(false);
  }
});

// Expose startDFM globally for non-module callers
if (typeof window !== 'undefined') {
  if (typeof window.DFMOrchestrator.startDFM === 'function') {
    window.startDFM = window.DFMOrchestrator.startDFM.bind(window.DFMOrchestrator);
  }
  dbg('startDFM exposé ?', typeof window.startDFM);
}

// ---------------------- Formulaire matière ----------------------
const EXCLUSIVE_GROUPS = [
  ["stiffness","flexibility"],           // exemple : exclusifs
  ["transparent","flame_retardant"]
];
const SECTION_LIMITS = { mechanical:3, aesthetic:2, regulatoryStrong:1 };

// util
const arr = v => Array.isArray(v) ? v : (v ? [v] : []);

function collectMaterialForm(){
  const form = document.getElementById("materialQuestionnaireForm");
  const fd = new FormData(form);
  const data = {};
  for (const [k,v] of fd.entries()){
    const key = k.replace("[]","");
    if (data[key]) {
      if (Array.isArray(data[key])) data[key].push(v);
      else data[key] = [data[key], v];
    } else data[key] = v;
  }

  const mech = arr(data.mechanical);
  const aest = arr(data.aesthetic);
  const reg  = arr(data.regulatory);
  const warnings = [];

  // Cap au lieu de throw
  if (mech.length > SECTION_LIMITS.mechanical){
    warnings.push("Maximum 3 contraintes mécaniques. Les 3 premières ont été conservées.");
    mech.length = SECTION_LIMITS.mechanical;
  }
  if (aest.length > SECTION_LIMITS.aesthetic){
    warnings.push("Maximum 2 exigences esthétiques. Les 2 premières ont été conservées.");
    aest.length = SECTION_LIMITS.aesthetic;
  }
  const strongCount = reg.filter(id => document.getElementById(id)?.dataset.strong === "true").length;
  if (strongCount > SECTION_LIMITS.regulatoryStrong){
    let kept=false;
    const filtered = [];
    for (const id of reg){
      const strong = document.getElementById(id)?.dataset.strong === "true";
      if (strong && kept) continue;
      if (strong) kept = true;
      filtered.push(id);
    }
    data.regulatory = filtered;
    warnings.push("Maximum 1 contrainte réglementaire forte. Seule la première a été conservée.");
  }

  // Exclusivités (rigidité vs flexibilité…)
  const ids = [...mech, ...aest, ...(data.regulatory || reg)];
  for (const group of EXCLUSIVE_GROUPS){
    const selected = group.filter(id => ids.includes(id));
    if (selected.length > 1){
      const keep = selected[0], drop = selected.slice(1);
      warnings.push(`Critères exclusifs : ${selected.join(", ")}. Seul « ${keep} » a été conservé.`);
      drop.forEach(x=>{
        const iM = mech.indexOf(x); if (iM>=0) mech.splice(iM,1);
        const iA = aest.indexOf(x); if (iA>=0) aest.splice(iA,1);
        if (Array.isArray(data.regulatory)){
          const iR = data.regulatory.indexOf(x); if (iR>=0) data.regulatory.splice(iR,1);
        }
      });
    }
  }

  const profile = {
    ...data,
    mechanical: mech,
    aesthetic: aest,
    regulatory: Array.isArray(data.regulatory) ? data.regulatory : reg
  };

  return { ok:true, data:profile, warnings };
}

// ---------------------- Wiring du bouton Analyser ----------------------
function initDFMUI() {
  if (typeof window !== 'undefined') {
    window.showMaterialModal = showMaterialModal;
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
  window.showMaterialModal = showMaterialModal;
  window.DFM_STATES = DFM_STATES;
  window.dfmOrchestrator = orchestrator;
  window.collectMaterialForm = collectMaterialForm;
  window.initDFMUI = initDFMUI;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initDFMUI();
}
function dfmSelfCheck() {
  const errors = [];
  if (!window.bootstrap || !bootstrap.Modal) errors.push("bootstrap.Modal absent");
  if (!(
    document.getElementById("materialModal") ||
    document.querySelector("[data-material-modal]")
  ))
    errors.push("modal matière absent");
  if (!document.getElementById('analyzeBtn')) errors.push("#analyzeBtn absent");

  if (errors.length) {
    console.warn("[DFM selfcheck] Issues:", errors);
  } else {
    dbg('selfcheck OK');
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.requestAnimationFrame(dfmSelfCheck);
}

// Legacy global for older templates still calling onclick="onAnalyzeClick()"
if (typeof window !== 'undefined') {
  window.onAnalyzeClick = () => orchestrator.handleAnalyzeClick();
}

// --- Visualiser workflow -------------------------------------------------
let currentFileId = null;
window.addEventListener('dfm:fileReady', e => { currentFileId = e.detail.fileId; });

function getTolerance() {
  const v = parseFloat(document.getElementById('tolerance')?.value);
  return Number.isFinite(v) ? v : 0.1;
}

document.addEventListener('DOMContentLoaded', () => {
  const btnVisualiser = document.getElementById('btn-visualiser');
  const btnAnalyser = document.getElementById('btn-analyser');
  const viewer = window.viewerApp || window.viewer || window.viewerAdapter?.app;
  if (!btnVisualiser || !viewer) return;

  btnVisualiser.addEventListener('click', async () => {
    if (btnAnalyser) btnAnalyser.disabled = true;
    if (!currentFileId) {
      if (btnAnalyser) btnAnalyser.disabled = false;
      return toast('Aucun fichier');
    }
    console.log('[visualiser] start for', currentFileId);
    const r = await fetch('/api/simple/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: currentFileId, tolerance: getTolerance() })
    });
    if (!r.ok) {
      if (btnAnalyser) btnAnalyser.disabled = false;
      return showError('Conversion impossible');
    }
    const { file_id, xkt_url } = await r.json();
    console.log('[visualiser] xkt_url=', xkt_url);
    await viewer.loadFromFileId(file_id);
    console.log('[visualiser] done');
    if (btnAnalyser) btnAnalyser.disabled = false;
  });

  if (btnAnalyser) {
    btnAnalyser.addEventListener('click', async () => {
      if (!currentFileId) return toast('Aucun fichier');
      btnAnalyser.disabled = true;
      console.log('[analyser] start for', currentFileId);
      const r = await fetch('/api/simple/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: currentFileId, axis: [0,0,1], material: 'ABS', options: {} })
      });
      if (!r.ok) {
        btnAnalyser.disabled = false;
        return showError('Analyse impossible');
      }
      await pollReport(currentFileId);
      btnAnalyser.disabled = false;
    });
  }
});
