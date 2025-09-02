/*
 * Orchestrateur DFM – version robuste (résout fileId depuis DOM/URL/Viewer)
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 */

import AxisPicker from "./modules/AxisPicker.js";

const DEBUG_DFM = window.DEBUG_DFM === true;
const dbg = (...a) => { if (DEBUG_DFM) console.debug("[DFM]", ...a); };

// ---------------------- UI helpers ----------------------
const UI = {
  info(m){ if (window.showToast) showToast(m,{type:"info"}); else alert(m); },
  warn(m){ if (window.showToast) showToast(m,{type:"warn"}); else alert(m); },
  err(m){  if (window.showToast) showToast(m,{type:"error"}); else alert(m); },
  setLoading(on){
    const b = document.getElementById("submitQuestionnaire");
    if (b) b.disabled = !!on;
  }
};

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
  setMaterialProfile(p){ this.materialProfile = p || null; }
  setDemouldAxis(a){ this.demouldAxis = a || null; }

  // ---------------------- Résolution de fileId ----------------------
  resolveFileId(){
    if (this.fileId) return this.fileId;

    let id = document.body?.dataset?.fileid;
    if (id) return id;

    try {
      id = window.CADLYTICS?.current?.fileId;
      if (id) return id;
    } catch {}

    try {
      id = window.viewerAdapter?.current?.fileId;
      if (id) return id;
    } catch {}

    const hidden = document.getElementById('fileId');
    if (hidden && hidden.type === 'hidden' && hidden.value) return hidden.value;

    return null;
  }

  setFileIdFromPage(){
    const id = this.resolveFileId();
    if (id) this.setFileId(id);
    dbg("resolveFileId →", id);
    return id;
  }

  // ---------------------- Axis panel ----------------------
  renderAxisPanel(){
    if (!this.fileId && !this.setFileIdFromPage()){
      UI.info("Aucun fichier à analyser. Merci d’importer une pièce.");
      return;
    }
    if (!this.materialProfile){
      UI.info("Sélectionnez un matériau (questionnaire) avant d’analyser.");
      return;
    }

    let panel = document.getElementById("dfmAxisPanel");
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "dfmAxisPanel";
    panel.className = "card mt-3";
    panel.innerHTML = `<div class="card-body" id="axisPickerContainer"></div>`;
    document.getElementById("viewer")?.insertAdjacentElement("afterend", panel);

    const container = panel.querySelector("#axisPickerContainer");
    this.axisPicker = new AxisPicker(container);
    this.axisPicker.addEventListener("preview", e => this.previewAxis(e.detail));
    this.axisPicker.addEventListener("clear", () => window.viewerAdapter?.clearAxisPreview());
    this.axisPicker.addEventListener("confirm", e => this.confirmAxis(e.detail));
  }

  async previewAxis(sel){
    dbg("previewAxis", sel);
    if (sel.axis === "AUTO"){
      try{
        const res = await fetch(`/api/dfm/axes/suggest?fileId=${encodeURIComponent(this.fileId)}`);
        if (res.ok){
          const data = await res.json();
          this._autoSuggestion = data;
          window.viewerAdapter?.previewDemouldAxis(data);
          if (data.axis && data.axis !== "VECTOR"){
            this.axisPicker?.setValue({ axis:data.axis, direction:data.direction });
          }
        }
      }catch(e){ console.error(e); }
    }else{
      this._autoSuggestion = sel;
      window.viewerAdapter?.previewDemouldAxis(sel);
    }
  }

  confirmAxis(sel){
    const chosen = sel.axis === "AUTO" && this._autoSuggestion ? this._autoSuggestion : sel;
    this.setDemouldAxis(chosen);
    dbg("confirmAxis", chosen);
    document.getElementById("dfmAxisPanel")?.remove();
    this.axisPicker = null;
    this.startAnalysis();
  }

  // ---------------------- Analyse ----------------------
  async startAnalysis({ fileId=this.fileId, materialProfile=this.materialProfile, demouldAxis=this.demouldAxis } = {}){
    if (!fileId) fileId = this.setFileIdFromPage();
    if (!materialProfile){
      UI.info("Sélectionnez un matériau pour l’analyse.");
      this.handleError("Profil matière manquant");
      return;
    }
    if (!demouldAxis){
      UI.info("Veuillez valider l’axe de démoulage.");
      this.handleError("Axe de démoulage manquant");
      return;
    }

    dbg("startAnalysis", { fileId, materialProfile, demouldAxis });
    this.setState(DFM_STATES.RUNNING);
    this._renderLoading();
    UI.setLoading(true);

    const payload = { material_profile: materialProfile, demould_axis: demouldAxis };
    if (fileId) payload.file_id = fileId;

    try{
      const res = await fetch("/api/dfm/start", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(payload)
      });
      let data = {};
      try{ data = await res.json(); }catch{}
      console.log("POST /api/dfm/start", res.status, data);

      if (res.status === 200 || res.status === 202){
        UI.info("Analyse en cours…");
        const jobId = data.jobId || data.job_id || data.task_id || data.taskId;
        if (data.result){
          this.renderResults(data.result);
        } else if (jobId){
          this.pollStatus(jobId);
        } else {
          this.handleError("missing_jobId");
        }
        return;
      }

      switch(res.status){
        case 400:
          UI.err("Aucun fichier: importez/convertez une pièce puis recommencez.");
          break;
        case 404:
          UI.err("Endpoint introuvable");
          break;
        case 409:
          UI.err("Analyse déjà en cours pour ce fichier.");
          break;
        case 503:
          UI.err("Service indisponible (worker/broker). Réessayez.");
          break;
        default:
          UI.err("Démarrage analyse impossible");
      }
      this.handleError("start_failed");
    }catch(e){
      console.error(e);
      UI.err("Démarrage analyse impossible");
      this.handleError("start_failed");
    }finally{
      UI.setLoading(false);
    }
  }

  async pollStatus(jobId){
    dbg("pollStatus", jobId);
    try{
      const res = await fetch(`/api/dfm/status?jobId=${encodeURIComponent(jobId)}`);
      if (!res.ok) throw new Error("status_failed");
      const data = await res.json();

      if (typeof data.progress === "number"){
        const bar = document.getElementById("dfmProgressBar");
        if (bar) bar.style.width = `${data.progress}%`;
      }
      if (data.status === "completed") this.fetchResults(jobId);
      else if (data.status === "failed") this.handleError("Analyse échouée");
      else setTimeout(() => this.pollStatus(jobId), 2500);
    }catch(e){
      console.error(e);
      this.handleError("Erreur de suivi d’analyse");
    }
  }

  async fetchResults(jobId){
    dbg("fetchResults", jobId);
    try{
      const res = await fetch(`/api/dfm/results?jobId=${encodeURIComponent(jobId)}`);
      if (!res.ok) throw new Error("results_failed");
      const data = await res.json();
      this.renderResults(data);
    }catch(e){
      console.error(e);
      this.handleError("Récupération résultats impossible");
    }
  }

  renderResults(results = {}){
    this.setState(DFM_STATES.RESULTS);
    const section = document.getElementById("dfmResultsSection");
    if (section) section.style.display = "block";
    const panel = document.getElementById("dfmAnalysisPanel");
    if (!panel) return;
    panel.innerHTML = "";

    // Issues
    if (Array.isArray(results.issues) && results.issues.length){
      const table = document.createElement("table");
      table.className = "table table-sm";
      table.innerHTML = `<thead><tr>
        <th data-sort="severity">Severité</th>
        <th data-sort="type">Type</th>
        <th>Description</th></tr></thead>`;
      const tbody = document.createElement("tbody");
      results.issues.forEach(issue => {
        const tr = document.createElement("tr");
        tr.dataset.severity = issue.severity || "";
        tr.dataset.type = issue.type || "";
        tr.innerHTML = `<td>${issue.severity||""}</td><td>${issue.type||""}</td><td>${issue.message||""}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      this._makeSortable(table);
      panel.appendChild(table);
    } else {
      panel.textContent = "Aucune anomalie détectée";
    }

    // Checklist
    const checklistWrap = document.getElementById("moldingChecklist");
    const checklistItems = document.getElementById("checklistItems");
    if (checklistItems) checklistItems.innerHTML = "";
    if (checklistWrap && Array.isArray(results.checklist) && results.checklist.length){
      checklistWrap.style.display = "block";
      results.checklist.forEach(it => {
        const cl = it.status === "pass" ? "success" : it.status === "warn" ? "warning" : "danger";
        const div = document.createElement("div");
        div.className = `list-group-item list-group-item-${cl}`;
        div.textContent = it.label || "";
        checklistItems.appendChild(div);
      });
    }

    // Reco matière
    const recWrap = document.getElementById("materialRecommendations");
    const recList = document.getElementById("recommendationItems");
    if (recList) recList.innerHTML = "";
    if (recWrap && Array.isArray(results.materialRecommendations) && results.materialRecommendations.length){
      recWrap.style.display = "block";
      results.materialRecommendations.forEach(r => {
        const li = document.createElement("li");
        li.className = "list-group-item";
        li.textContent = r;
        recList.appendChild(li);
      });
    }

    // Rapports
    if (results.reportUrls){
      const pdf = document.getElementById("generatePdfBtn");
      const csv = document.getElementById("downloadCsvBtn");
      if (pdf && csv){
        pdf.style.display = "inline-block";
        csv.style.display = "inline-block";
        pdf.href = results.reportUrls.pdf;
        csv.href = results.reportUrls.csv;
      }
    }

    // Heatmap / annotations
    window.viewerAdapter?.applyHeatmap(results.heatmap);
    window.viewerAdapter?.addAnnotations(results.annotations);
  }

  handleError(message){
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

export const dfmOrchestrator = new DFMOrchestrator();

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

// ---------------------- Wiring des boutons ----------------------
document.addEventListener("DOMContentLoaded", ()=>{
  const modalEl = document.getElementById("materialQuestionnaireModal");
  const modal = modalEl ? new bootstrap.Modal(modalEl) : null;

  // exclusivités en live
  EXCLUSIVE_GROUPS.forEach(group=>{
    const inputs = group.map(id=>document.getElementById(id)).filter(Boolean);
    inputs.forEach(input=>{
      input.addEventListener("change", ()=>{
        if (input.checked) inputs.forEach(o=>{ if (o!==input) o.checked=false; });
      });
    });
  });

  document.getElementById("dfmAnalyzeBtn")?.addEventListener("click", ()=>{
    if (!dfmOrchestrator.setFileIdFromPage()){
      UI.info("Aucun fichier à analyser. Merci d’importer une pièce.");
      return;
    }
    modal?.show();
  });

  const btn = document.getElementById("submitQuestionnaire");
  if (!btn) return;

  btn.addEventListener("click", ()=>{
    UI.setLoading(true);
    try{
      const result = collectMaterialForm();
      if (result.warnings?.length) UI.warn(result.warnings.join("\n"));

      // Détermine fileId maintenant
      dfmOrchestrator.setFileIdFromPage();
      dfmOrchestrator.setMaterialProfile(result.data);

      if (!dfmOrchestrator.fileId){
        UI.info("Aucun fichier à analyser. Merci d’importer une pièce.");
        return;
      }

      modal?.hide();
      dfmOrchestrator.setState(DFM_STATES.MATERIAL_CONFIRMED);
      dfmOrchestrator.setState(DFM_STATES.AXIS_PICK);
    } catch (e){
      console.error(e);
      UI.err(e?.message || "Formulaire invalide");
    } finally {
      UI.setLoading(false);
    }
  });
});
