/*
 * Orchestrateur DFM – version robuste (résout fileId depuis DOM/URL/Viewer)
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 */

import AxisPicker from "./modules/AxisPicker.js";
import HeatmapLayer from "./modules/HeatmapLayer.js";

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
  let attempts = 0;
  let queuedSince = Date.now();

  async function step() {
    try {
      const res = await fetch(`/api/dfm/status?job_id=${encodeURIComponent(jobId)}`);
      const data = await res.json(); // {status:'queued'|'running'|'done'|'error', step?, progress?}

      onUpdate?.(data);

      if (data.status === "done") { await onDone?.(data); return; }
      if (data.status === "error") { onError?.(data); return; }

      attempts++;
      const delay = Math.min(1000 * Math.pow(1.5, attempts), 10000);

      if (data.status === "queued" && Date.now() - queuedSince > 90_000) {
        StatusUI.set("Toujours en file d’attente… un worker va démarrer dès que possible.");
        queuedSince = Date.now();
      }
      setTimeout(step, delay);
    } catch (e) {
      console.error("poll error", e);
      setTimeout(step, 5000);
    }
  }
  step();
}

export function showMaterialModal(prefill) {
  if (!window.bootstrap) { console.error("Bootstrap non chargé"); return; }
  const el = document.getElementById('materialModal');
  if (!el) { console.error("#materialModal introuvable"); return; }

  const profile = prefill || this?.materialProfile || null;
  // Injection / pré-remplissage
  try {
    // renderMaterialSelector('#materialSelector', profile);
    // renderFinishSelector('#materialFinish', profile);
  } catch (e) { console.warn("Material selector injection skipped:", e); }

  const modal = new bootstrap.Modal(el, { backdrop: 'static' });
  modal.show();
}

// ---------------------- États ----------------------
export const DFM_STATES = {
  IDLE:"IDLE", MATERIAL_CONFIRMED:"MATERIAL_CONFIRMED", AXIS_PICK:"AXIS_PICK",
  RUNNING:"RUNNING", RESULTS:"RESULTS", ERROR:"ERROR"
};

class DFMOrchestrator {
  constructor(){
    this.state = DFM_STATES.IDLE;
    this.fileId = null;
    this.materialProfile = null;
    this.demouldAxis = null;
    this.axisPicker = null;
    this._autoSuggestion = null;
  }

  setState(next){
    this.state = next; dbg("state →", next);
    if (next === DFM_STATES.AXIS_PICK) this.renderAxisPanel();
  }

  setFileId(id){
    this.fileId = id || null;
    const hidden = document.getElementById('fileId');
    if (hidden && hidden.type === 'hidden') hidden.value = this.fileId || '';
  }
  setMaterialProfile(p){
    this.materialProfile = p || null;
  }
  setDemouldAxis(a){
    const vec = axisToVector(a);
    this.demouldAxis = vec || null;
    window.CAD.axis = vec;
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

  // ---------------------- Axis panel ----------------------
  renderAxisPanel(){
    if (!this.materialProfile){
      UI.info("Compléter le questionnaire.");
      return;
    }
    const wrap = document.getElementById('axisPickerInline');
    if (!wrap) return;
    wrap.classList.remove('d-none');
    if (this.axisPicker) return;
    this.axisPicker = new AxisPicker(wrap);
    this.axisPicker.addEventListener('preview', e=>this.previewAxis(e.detail));
    this.axisPicker.addEventListener('clear', ()=>window.viewerAdapter?.clearAxisPreview?.());
    this.axisPicker.addEventListener('confirm', e=>this.confirmAxis(e.detail));
  }

  async previewAxis(sel){
    dbg("previewAxis", sel);
    if (sel.axis === "AUTO"){
      try{
        const res = await fetch(`/api/dfm/axes/suggest?fileId=${encodeURIComponent(this.fileId)}`);
        if (res.ok){
          const data = await res.json();
          this._autoSuggestion = data;
          window.viewerAdapter?.previewDemouldAxis?.(data);
          if (data.axis && data.axis !== "VECTOR"){
            this.axisPicker?.setValue({ axis:data.axis, direction:data.direction });
          }
        }
      }catch(e){ console.error(e); }
    }else{
      this._autoSuggestion = sel;
      window.viewerAdapter?.previewDemouldAxis?.(sel);
    }
  }

  confirmAxis(sel){
    const chosen = sel.axis === "AUTO" && this._autoSuggestion ? this._autoSuggestion : sel;
    this.setDemouldAxis(chosen);
    dbg("confirmAxis", chosen);
    if (!this.fileId) this.setFileIdFromPage();
    if (!this.fileId){ UI.err("Aucun fichier à analyser"); return; }
    if (!this.materialProfile){ UI.err("Profil matière manquant"); return; }
    this.startAnalysis();
  }

  // ---------------------- Analyse ----------------------
  async startAnalysis({
    fileId = this.fileId,
    materialProfile = this.materialProfile,
    demouldAxis = this.demouldAxis
  } = {}) {
    if (!this.materialProfile) {
      console.warn("Aucun profil matière sélectionné, ouverture de la modale.");
      showMaterialModal();
      return;
    }
    // ➊ Résolution robuste du fileId au tout début
    if (!fileId) {
      // a) champ caché
      const hid = document.getElementById('fileId');
      if (hid && hid.value) fileId = hid.value;

      // b) data-fileid sur <body>
      if (!fileId && document?.body?.dataset?.fileid) {
        fileId = document.body.dataset.fileid;
      }

      // c) global exposé par l’uploader
      if (!fileId && window?.CADLYTICS?.current?.fileId) {
        fileId = window.CADLYTICS.current.fileId;
      }

      // d) viewer éventuel
      if (!fileId && window?.viewerAdapter?.current?.fileId) {
        fileId = window.viewerAdapter.current.fileId;
      }

      // e) fallback orchestrateur
      if (!fileId) fileId = this.setFileIdFromPage();

      // On mémorise si trouvé
      if (fileId) this.setFileId(fileId);
    }

    // ➋ Garde-fous côté UI
    if (!fileId) {
      UI.info("Aucun fichier à analyser. Merci d’importer une pièce.");
      this.handleError?.("file_missing");
      return;
    }
    if (!demouldAxis) {
      UI.info("Veuillez valider l’axe de démoulage.");
      this.handleError?.("axe_manquant");
      return;
    }

    dbg("startAnalysis", { fileId, materialProfile, demouldAxis });
    this.setState(DFM_STATES.RUNNING);
    this._renderLoading();
    UI.setLoading(true);

    const payload = {
      file_id: fileId,
      axis: demouldAxis,
      material_profile: materialProfile?.resin || "GENERIC",
    };
    console.debug("[DFM] start payload", payload);


    try {
      const res = await fetch("/api/dfm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      let startResp = {};
      try { startResp = await res.json(); } catch {}

      console.log("POST /api/dfm/start", res.status, startResp);

      if (res.status === 200 || res.status === 202) {
        const { job_id: jobId } = startResp;
        if (jobId) {
          window.CAD.currentJobId = jobId;
          StatusUI.set("Analyse en cours…");
          pollJobStatus(
            jobId,
            (s) => {
              if (s.status === "running") {
                const label = s.step ? `Analyse en cours… (${s.step})` : "Analyse en cours…";
                StatusUI.set(label);
                if (typeof s.progress === "number" && UI.progress) UI.progress(s.progress);
              }
            },
            async () => {
              StatusUI.set("Analyse terminée");
              const r = await fetch(`/api/dfm/result?job_id=${encodeURIComponent(jobId)}`);
              if (r.ok){
                const data = await r.json();
                await this.renderResults(data);
              }else{
                this.handleError("result_failed");
              }
            },
            () => { StatusUI.set("Échec de l’analyse"); UI.err("Échec de l’analyse"); }
          );
        } else {
          this.handleError("missing_jobId");
        }
        return;
      }

      // Messages dédiés selon code HTTP
      switch (res.status) {
        case 400: UI.err("Aucun fichier: importez/convertez une pièce puis recommencez."); break;
        case 404: UI.err("Endpoint introuvable"); break;
        case 409: UI.err("Analyse déjà en cours pour ce fichier."); break;
        case 503: UI.err("Service indisponible (worker/broker). Réessayez."); break;
        default:  UI.err("Démarrage analyse impossible");
      }
      this.handleError("start_failed");

    } catch (e) {
      console.error(e);
      UI.err("Démarrage analyse impossible");
      this.handleError("start_failed");

    } finally {
      UI.setLoading(false);
    }
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
    try{
      const camRes = await fetch(`/static/dfm/${fileId}/camera_states.json`);
      if (camRes.ok){
        const cams = await camRes.json();
        const iso = cams.iso;
        const cam = window.viewerAdapter?.viewer?.camera;
        if (iso && cam){
          cam.eye = iso.eye;
          cam.look = iso.look;
          cam.up = iso.up;
        }
      }
    }catch(e){ console.error("camera_states", e); }
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

export const dfmOrchestrator = (typeof window !== 'undefined' && window.DFMOrchestrator) ? window.DFMOrchestrator : new DFMOrchestrator();
if (typeof window !== 'undefined') {
  window.DFMOrchestrator = dfmOrchestrator;
}

// Expose startAnalysis globally for non-module callers
if (typeof window !== 'undefined') {
  if (typeof window.DFMOrchestrator.startAnalysis === 'function') {
    window.startAnalysis = window.startAnalysis || window.DFMOrchestrator.startAnalysis.bind(window.DFMOrchestrator);
  }
  console.debug("[DFM] startAnalysis exposé ?", typeof window.startAnalysis);
}

// ---------------------- Formulaire matière ----------------------
const EXCLUSIVE_GROUPS = [
  ["stiffness","flexibility"],           // exemple : exclusifs
  ["transparent","flame_retardant"]
];
const SECTION_LIMITS = { mechanical:3, aesthetic:2, regulatoryStrong:1 };

// util
const arr = v => Array.isArray(v) ? v : (v ? [v] : []);

export function collectMaterialForm(){
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
export function initDFMUI() {
  if (typeof window !== 'undefined') {
    window.showMaterialModal = showMaterialModal;
  }

  (function bindMaterialConfirm(){
    const btn = document.getElementById('materialConfirmBtn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener('click', ()=> {
      const el = document.getElementById('materialModal');
      if (el && window.bootstrap) {
        const m = bootstrap.Modal.getInstance(el) || new bootstrap.Modal(el);
        m.hide();
      }
      if (typeof DFMOrchestrator?.launchAxisPicking === 'function') {
        DFMOrchestrator.launchAxisPicking();
      } else if (typeof launchAxisPicking === 'function') {
        launchAxisPicking();
      }
    });
  })();

  document.addEventListener("DOMContentLoaded", () => {
    dfmOrchestrator.setFileId(window.CAD.fileIdStep);
    dfmOrchestrator.setMaterialProfile(window.CAD.materialProfile);

    window.addEventListener('dfm:fileReady', e => {
      window.CAD.fileIdStep = e.detail.fileId;
      dfmOrchestrator.setFileId(e.detail.fileId);
    });

    document.addEventListener('material:confirmed', e => {
      window.CAD.materialProfile = e.detail;
      dfmOrchestrator.setMaterialProfile(e.detail);
      if (!dfmOrchestrator.demouldAxis) {
        dfmOrchestrator.renderAxisPanel();
      } else {
        dfmOrchestrator.startAnalysis();
      }
    });
  });

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('analyzeBtn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = "1";

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const hasProfile =
        (window.DFMOrchestrator && DFMOrchestrator.materialProfile) ||
        window.materialProfile;
      if (!hasProfile) {
        if (typeof showMaterialModal === 'function') showMaterialModal();
        else console.error("showMaterialModal manquant");
        return;
      }
      if (typeof DFMOrchestrator?.startAnalysis === 'function') {
        DFMOrchestrator.startAnalysis();
      } else if (typeof window.startAnalysis === 'function') {
        window.startAnalysis();
      } else {
        console.error("startAnalysis introuvable");
      }
    });
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initDFMUI();
}
function dfmSelfCheck() {
  const errors = [];
  if (!window.bootstrap || !bootstrap.Modal) errors.push("bootstrap.Modal absent");
  if (!document.getElementById('materialModal')) errors.push("#materialModal absent");
  if (!document.getElementById('analyzeBtn')) errors.push("#analyzeBtn absent");

  if (errors.length) {
    console.warn("[DFM selfcheck] Issues:", errors);
  } else {
    console.debug("[DFM selfcheck] OK");
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.requestAnimationFrame(dfmSelfCheck);
}
