/*
 * Orchestrateur DFM – version robuste (résout fileId depuis DOM/URL/Viewer)
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 */

import AxisPicker from "./modules/AxisPicker.js";
import HeatmapLayer from "./modules/HeatmapLayer.js";

const DEBUG_DFM = window.DEBUG_DFM === true;
const dbg = (...a) => { if (DEBUG_DFM) console.debug("[DFM]", ...a); };

// ---------------------- UI helpers ----------------------
const UI = {
  info(m){ if (window.showToast) showToast(m,{type:"info"}); },
  warn(m){ if (window.showToast) showToast(m,{type:"warn"}); },
  err(m){  if (window.showToast) showToast(m,{type:"error"}); },
  setLoading(on){
    const b = document.getElementById("submitQuestionnaire");
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
    this.onAnalysisDone = null;
    window.addEventListener("axisPicker:validated", (e) => {
      const detail = e.detail || {};
      this.setMaterialProfile(detail.materialProfile);
      this.setDemouldAxis(detail.axis);
      this.startAnalysis({ demouldAxis: detail.axis, materialProfile: detail.materialProfile });
    });
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
    // 1) fileId déjà en mémoire ?
    if (this.fileId) return this.fileId;

    // 2) dataset du <body>
    let id = document.body?.dataset?.fileid;
    if (id) return id;

    // 3) global (fallback)
    id = window.CADLYTICS?.current?.fileId;
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
    this.axisPicker.addEventListener("clear", () => window.viewerAdapter?.clearAxisPreview?.());
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
    document.getElementById("dfmAxisPanel")?.remove();
    this.axisPicker = null;
    this.startAnalysis(); // ← lance l’analyse
  }

  // ---------------------- Analyse ----------------------
  async startAnalysis({
    fileId = this.fileId,
    materialProfile = this.materialProfile,
    demouldAxis = this.demouldAxis
  } = {}) {
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
    if (!materialProfile) {
      UI.info("Sélectionnez un matériau pour l’analyse.");
      this.handleError?.("profil_matiere_manquant");
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
      fileId,
      file_id: fileId,
      materialProfile,
      material_profile: materialProfile,
      demouldAxis,
      demould_axis: demouldAxis
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

        if (startResp.result) {
          await this.renderResults(startResp.result);
        } else if (jobId) {
          StatusUI.set("Analyse en cours…");
          this.onAnalysisDone = (s) => this.renderResults(s.result);
          pollJobStatus(
            jobId,
            (s) => {
              if (s.status === "running") {
                const label = s.step ? `Analyse en cours… (${s.step})` : "Analyse en cours…";
                StatusUI.set(label);
                if (typeof s.progress === "number" && UI.progress) UI.progress(s.progress);
              }
            },
            async (s) => { StatusUI.set("Analyse terminée"); await this.onAnalysisDone?.(s); },
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

    if (results.metrics){
      const table = document.createElement("table");
      table.className = "table table-sm";
      const tbody = document.createElement("tbody");
      Object.entries(results.metrics).forEach(([k,v])=>{
        const tr = document.createElement("tr");
        tr.innerHTML = `<th>${k}</th><td>${typeof v === 'object' ? JSON.stringify(v) : v}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      panel.appendChild(table);
    }

    const thumbs = results.views?.thumbnails || {};
    const thumbsDiv = document.createElement("div");
    Object.entries(thumbs).forEach(([name,url])=>{
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      const img = document.createElement("img");
      img.src = url;
      img.alt = name;
      img.style.maxWidth = "100px";
      img.className = "img-thumbnail me-2";
      a.appendChild(img);
      thumbsDiv.appendChild(a);
    });
    if (thumbsDiv.childNodes.length) panel.appendChild(thumbsDiv);

    if (results.report_paths?.pdf){
      const link = document.createElement("a");
      link.href = results.report_paths.pdf;
      link.textContent = "Télécharger le rapport";
      link.className = "btn btn-sm btn-outline-secondary mt-2";
      panel.appendChild(link);
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
    try{
      const heatRes = await fetch(`/static/dfm/${fileId}/heatmap_faces.json`);
      if (heatRes.ok){
        const mapping = await heatRes.json();
        if (mapping && Object.keys(mapping).length){
          const layer = new HeatmapLayer(window.viewerAdapter);
          layer.apply(mapping);
        }
      }
    }catch(e){ console.error("heatmap_faces", e); }
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
document.addEventListener("DOMContentLoaded", () => {
  // Récupération des éléments
  const modalEl = document.getElementById("materialQuestionnaireModal");
  const btn = document.getElementById("submitQuestionnaire");
  const analyzeBtn = document.getElementById("dfmAnalyzeBtn");

  // Sécurité : si le bouton n'existe pas, on sort proprement
  if (!btn) {
    console.warn("[DFM] #submitQuestionnaire introuvable");
    return;
  }

  // Modal Bootstrap si dispo, sinon fallback maison
  let modal = null;
  if (modalEl) {
    if (window.bootstrap?.Modal) {
      modal = new bootstrap.Modal(modalEl);
    } else {
      modal = {
        show(){ modalEl.classList.add("show"); modalEl.style.display="block"; modalEl.removeAttribute("aria-hidden"); },
        hide(){ modalEl.classList.remove("show"); modalEl.style.display="none"; modalEl.setAttribute("aria-hidden","true"); }
      };
    }
  }

  // Ouvre le questionnaire matière quand on clique "Analyser"
  analyzeBtn?.addEventListener("click", () => {
    if (!dfmOrchestrator.setFileIdFromPage()){
      UI.info("Aucun fichier à analyser. Merci d’importer une pièce.");
      return;
    }
    modal?.show?.();
  });

  // Normalise un profil matière minimal
  const arr = v => Array.isArray(v) ? v : (v ? [v] : []);
  function normalizeProfile(raw){
    const p = raw && typeof raw === "object" ? raw : {};
    return {
      mechanical: arr(p.mechanical),
      aesthetic:  arr(p.aesthetic),
      regulatory: arr(p.regulatory),
      resin:      p.resin || "generic",
      notes:      p.notes || ""
    };
  }

  btn.addEventListener("click", () => {
    UI.setLoading(true);
    try {
      const result  = typeof collectMaterialForm === "function" ? collectMaterialForm() : { data: {} };
      const profile = normalizeProfile(result?.data);

      dfmOrchestrator.setMaterialProfile(profile);
      dfmOrchestrator.setFileIdFromPage();
      console.debug("[DFM] materialProfile:", profile, "fileId:", dfmOrchestrator.fileId);

      if (!dfmOrchestrator.fileId){
        UI.info("Aucun fichier à analyser. Merci d’importer une pièce.");
        return;
      }

      modal?.hide?.();
      dfmOrchestrator.setState(DFM_STATES.MATERIAL_CONFIRMED);
      dfmOrchestrator.setState(DFM_STATES.AXIS_PICK);
    } catch (e) {
      console.error(e);
      UI.err(e?.message || "Formulaire invalide");
    } finally {
      UI.setLoading(false);
    }
  });
});
