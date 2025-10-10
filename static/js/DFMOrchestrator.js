/*
 * Orchestrateur DFM – version robuste (résout fileId depuis DOM/URL/Viewer)
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 */

import HeatmapLayer from "./modules/HeatmapLayer.js";
// Remove the broken named import and add a local helper:
async function loadCameraPresetOptional(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// État global minimal pour la DFM
if (typeof window !== "undefined") {
  window.CAD = {
    fileIdStep: window.CAD?.fileIdStep ?? null,
    materialProfile: window.CAD?.materialProfile ?? null,
    axis: window.CAD?.axis ?? { x: 0, y: 0, z: 1 },
    currentJobId: window.CAD?.currentJobId ?? null,
  };
}

// PATCH START: selectors
// const btnVisualiser = document.querySelector('#btnVisualiser');
const btnAnalyser = document.querySelector('#btnAnalyser, #analyzeBtn, #btn-analyser');
const axisPanel   = document.querySelector('#dfmAxisPanel, #axis-panel');
// PATCH END

// État initial : cacher l'axe mais laisser Analyser cliquable
if (axisPanel) axisPanel.style.display = "none";

const DEBUG_DFM = (typeof window !== 'undefined' && window.DEBUG_DFM === true);
const dbg = (...a) => { if (DEBUG_DFM) console.debug("[DFM]", ...a); };

// ---------------------- UI helpers ----------------------
const UI = {
  info(m){ if (window.showToast) showToast(m,{type:"info"}); },
  warn(m){ if (window.showToast) showToast(m,{type:"warn"}); },
  err(m){  if (window.showToast) showToast(m,{type:"error"}); },
  setLoading(on){
    const b = btnAnalyser;
    if (b) b.disabled = !!on;
  },
  progress(pct){
    const bar = document.getElementById("dfmProgressBar");
    if (bar) bar.style.width = `${pct}%`;
    // >>> NEW: propager aussi à d’autres UI si besoin
    window.dispatchEvent(new CustomEvent('cadlytics:dfm:progress', {
      detail: { pct: Math.max(0, Math.min(100, pct)), phase: 'server', label: 'Analyse DFM' }
    }));
  }
};

const StatusUI = {
  set(text){
    const el = document.querySelector('#dfmStatusText');
    if (el) el.textContent = text || '';
  }
};
// ====== ANALYSE LOCALE RAPIDE (Phase A instantanée) ======================

// Règles mini par matière (étends librement)
const MAT_RULES_QUICK = {
  ABS:        { draftExt: 1.0, draftInt: 0.5, P_inj_bar: 600, tmin: 1.2 },
  PC:         { draftExt: 1.5, draftInt: 1.0, P_inj_bar: 800, tmin: 1.8 },
  PP:         { draftExt: 1.0, draftInt: 0.5, P_inj_bar: 500, tmin: 1.2 },
  'PA66 GF30':{ draftExt: 1.0, draftInt: 0.5, P_inj_bar: 800, tmin: 1.5 }
};
const dot3 = (a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const axisLetterToVec = (A)=>A==='X'?[1,0,0]:A==='Y'?[0,1,0]:[0,0,1];

function getQuickMatRules(m){
  const id = (m?.id || m?.name || 'ABS');
  return MAT_RULES_QUICK[id] || MAT_RULES_QUICK.ABS;
}

// Wrappers vers le viewer (fallback sûrs)
async function __quickProjectedArea(axisLetter){
  try { return await window.__getProjectedArea?.(axisLetter) ?? 0; } catch{ return 0; }
}
async function __quickBasicStats(){
  try { return await window.__getBasicStats?.() ?? { volume_cm3:0, tmin_mm:null, tmax_mm:null }; }
  catch{ return { volume_cm3:0, tmin_mm:null, tmax_mm:null }; }
}
async function __quickFaces(){
  try { return await window.__getFaces?.() ?? []; } catch { return []; }
}

// ---- Checks rapides ----
async function quickCheckDraft(axisLetter){
  const ax = axisLetterToVec(axisLetter);
  const faces = await __quickFaces();
  let areaTot=0, areaKO=0, areaWarn=0;

  // seuils génériques (affinés ensuite avec la matière dans runLocalPhaseA)
  const thr = { external: 1.0, internal: 0.5 };

  for (const f of faces){
    const n = f.normal || [0,0,1];
    const cos = dot3(n, ax);
    // approx "dépouille" simplifiée : 90° - angle avec l’axe
    const angDeg = Math.acos(Math.max(-1, Math.min(1, Math.abs(cos)))) * 180/Math.PI;
    const draft = 90 - angDeg; // en degrés
    areaTot += (f.area||0);
    const need = (f.isExternal ? thr.external : thr.internal);
    if (draft < need) areaKO += (f.area||0);
    else if (draft < need + 0.5) areaWarn += (f.area||0);
  }
  const pctKO = areaTot ? (100*areaKO/areaTot) : 0;
  const pctWarn = areaTot ? (100*areaWarn/areaTot) : 0;

  return [
    { key:'draft_area_KO', label:'% surface sous dépouille', value:pctKO.toFixed(1), unit:'%', pass: pctKO<5, severity: pctKO>15?'fail':(pctKO>5?'warn':'ok'),
      tips:['Augmenter la dépouille','Réduire le grain / revoir axe'] },
    { key:'draft_area_warn', label:'% surface proche du seuil', value:pctWarn.toFixed(1), unit:'%', pass:true }
  ];
}

async function quickUndercuts(axisLetter){
  const ax = axisLetterToVec(axisLetter);
  const faces = await __quickFaces();
  const bad = faces.filter(f => dot3(f.normal||[0,0,1], ax) < -0.05);
  const areaBad = bad.reduce((s,f)=>s+(f.area||0),0);
  const areaTot = faces.reduce((s,f)=>s+(f.area||0),0);
  const pct = areaTot ? (100*areaBad/areaTot) : 0;

  return [
    { key:'undercut_pct', label:'% surfaces en contre-dépouille', value:pct.toFixed(1), unit:'%', pass: pct<3,
      severity: pct>8?'fail':(pct>3?'warn':'ok'),
      tips:['Prévoir tiroir / split','Modifier plan de joint'] }
  ];
}

async function quickTonnage(axisLetter, material){
  const rules = getQuickMatRules(material);
  const area_cm2 = await __quickProjectedArea(axisLetter);
  const F_kN = (rules.P_inj_bar * 1e5) * (area_cm2 * 1e-4) / 1000;
  const tonnage = Math.ceil(F_kN / 9.81);
  const pass = tonnage <= 150;
  return [
    { key:'proj_area', label:'Surface projetée', value:area_cm2.toFixed(1), unit:'cm²', pass:true },
    { key:'tonnage',   label:'Tonnage presse estimé', value:tonnage, unit:'T', pass, severity: pass?'ok':'warn',
      tips: pass?[]:['Réduire aire projetée / privilégier matière à P_inj plus faible'] }
  ];
}

async function quickMaterialVsThickness(material){
  const rules = getQuickMatRules(material);
  const s = await __quickBasicStats();
  const okT = (s.tmin_mm ?? 0) >= rules.tmin;
  return [
    { key:'mat_tmin_req', label:'Épaisseur mini matière', value:rules.tmin, unit:'mm', pass:true },
    { key:'part_tmin',    label:'Épaisseur mini pièce',  value:s.tmin_mm, unit:'mm', pass:okT, severity: okT?'ok':'fail',
      tips: okT?[]:[`Augmenter t_min à ≥ ${rules.tmin} mm`] }
  ];
}

// ---- Orchestrateur local ----
async function runLocalPhaseA(axisLetter){
  try{
    // annoncer la section quick
    window.dispatchEvent(new CustomEvent('cadlytics:demould-axis-selected', { detail:{ axis: axisLetter }}));
    UI.progress(5);

    const material = window.selectedMaterial || { id:'ABS', name:'ABS' };

    const draft    = await quickCheckDraft(axisLetter);      UI.progress(15);
    const undercut = await quickUndercuts(axisLetter);       UI.progress(25);
    const tonnage  = await quickTonnage(axisLetter, material); UI.progress(35);
    const thick    = await quickMaterialVsThickness(material); UI.progress(45);

    // pousser dans l’aperçu (même event que le backend pour réutiliser la même UI)
    window.dispatchEvent(new CustomEvent('cadlytics:dfm:report',{
      detail:{
        metrics: {
          draft: draft,
          undercut: undercut,
          tonnage: tonnage,
          thickness: thick
        }
      }
    }));
  }catch(e){
    console.warn('[DFM quick] erreur', e);
  }
}
// ========================================================================


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
// >>> NEW: pour publier l’event cadlytics avec X/Y/Z si utile
function vectorToAxisLetter(v = {x:0,y:0,z:1}) {
  const ax = Math.abs(v.x) >= Math.abs(v.y) && Math.abs(v.x) >= Math.abs(v.z) ? 'X'
          : Math.abs(v.y) >= Math.abs(v.x) && Math.abs(v.y) >= Math.abs(v.z) ? 'Y' : 'Z';
  return ax;
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

function renderDFMResults(report = {}) {
  const { score = 0, recommendations = [], metrics = {} } = report;

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
    // >>> NEW: notifier l’UI "aperçu" avec les métriques du rapport
  try {
    window.dispatchEvent(new CustomEvent('cadlytics:dfm:report', {
      detail: {
        score,
        recommendations,
        metrics
      }
    }));
  } catch {}
}
if (typeof window !== 'undefined') {
  window.renderDFMResults = renderDFMResults;
}

async function pollDFMReport(fileId, maxMs=120000){
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await fetch(`/api/simple/report/${fileId}`, { cache: "no-store" });
    if (r.status === 200) {
      const d = await r.json();
      renderDFMResults?.({
        score: d.score ?? 0,
        recommendations: Array.isArray(d.recommendations) ? d.recommendations : [],
        metrics: d.metrics ?? {}
      });
      return;
    }
    await new Promise(res => setTimeout(res, 2500));
  }
  showError?.("Analyse trop longue, réessaie.");
}

// --- Matériau: trouver la "vraie" modale de l'app, PAS un fallback ---
function findRealMaterialModal() {
  // 0) priorité absolue : sélecteur explicite si fourni
  const sel = window.DFM_MATERIAL_MODAL_SELECTOR;
  if (sel) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  // 1) candidats connus
  const SELS = [
    '#materialQuestionnaireModal',            // <-- priorité à ta modale
    '#materialModal',
    '[data-material-modal]:not([data-fallback])',
    '.modal[data-role="material"]'
  ];
  const candidates = Array.from(document.querySelectorAll(SELS.join(',')));
  if (!candidates.length) return null;

  // 2) privilégier celle qui contient le vrai formulaire
  const withForm = candidates.find(el =>
    el.querySelector('#materialQuestionnaireForm') ||
    el.querySelector('[data-material-form]')
  );
  return withForm || candidates[0] || null;
}

function showMaterialModal() {
  const el = findRealMaterialModal();
  if (!el) {
    console.warn('[dfm] modale matière introuvable (id/data-attr).');
    return;
  }
  if (!window.bootstrap || !bootstrap.Modal) {
    console.warn('[dfm] bootstrap.Modal absent; affichage basique');
    el.classList.add('open'); el.style.display = 'block';
    return;
  }
  console.info('[dfm] ouverture modale matière (vraie)');
  const modal = bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' });
  modal.show();
}

function openMaterialModal(){ showMaterialModal(); }

// PATCH START: show axis after material confirmed
function materialIsConfirmed(){ return !!window.selectedMaterial; }
function showAxisPanelIfReady(){
  if (!axisPanel) return;
  if (!window.currentFileId || !materialIsConfirmed()) return;
  axisPanel.style.display = '';
}
window.addEventListener('material:confirmed', showAxisPanelIfReady);
window.addEventListener('material:selected',  showAxisPanelIfReady); // compat
// PATCH END

window.addEventListener('axis:confirmed', (e) => { window.selectedAxis = e?.detail; });

function axisIsValidated(){
  return !!window.selectedAxis;
}

// Capter en phase "capture" et court-circuiter d'autres listeners (fallbacks)
if (btnAnalyser) {
  btnAnalyser.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();   // empêche le fallback du main.js de s'exécuter
    // workflow DFM: fichier ? matière ? axe ? sinon on ouvre la modale DFM
    const fileId = orchestrator.resolveFileId?.() || window.currentFileId;
    if (!fileId) { openMaterialModal(); return; }
    if (!materialIsConfirmed()) { openMaterialModal(); return; }
    if (!axisIsValidated()) { showAxisPanelIfReady(); return; }
    orchestrator.setFileId?.(fileId);
    orchestrator.startDFM?.();
  }, true); // <-- capture = true
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

    window.addEventListener('material:selected', (e) => {
      this.setMaterialProfile(e.detail.materialProfile);
      window.CAD.materialProfile = this.materialProfile;
      console.info('[dfm] matière sélectionnée', this.materialProfile);
      window.dispatchEvent(new CustomEvent('material:confirmed'));
    });

    window.addEventListener('material:confirmed', () => {
      console.info('[dfm] matière validée');
      this.renderAxisPanel();
    });

    window.addEventListener('axis:confirmed', (e) => {
      this.selectedAxis = e.detail.axis;
      this.selectedInvert = !!e.detail.invert;
      this.state.axisConfirmed = true;
      console.info('[dfm] axe confirmé', this.selectedAxis, 'invert', this.selectedInvert);
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

        // ===== Validation axe =====
        this.axisValidated = true;
        this.axisSelection = {
          axis: this.currentAxis,
          invert: this.invert,
          ts: Date.now()
        };
        this.setDemouldAxis({ axis: this.currentAxis, direction: this.invert ? -1 : 1 });
        const vec = this.demouldAxis;

        // Event natif déjà utilisé dans ton code
        window.dispatchEvent(new CustomEvent('axis:confirmed', { detail: { axis: vec, invert: this.invert } }));

        // >>> NEW: Event cadlytics pour les autres panneaux (avec lettre X/Y/Z)
        const axisLetter = vectorToAxisLetter(vec);
        window.dispatchEvent(new CustomEvent('cadlytics:demould-axis-selected', { detail: { axis: axisLetter } }));

        // Feedback UI
        this.axisConfirmBtn.innerHTML = 'Axe validé <span class="ms-1">✅</span>';
        this.axisConfirmBtn.classList.remove('btn-primary');
        this.axisConfirmBtn.classList.add('btn-success');
        dbg('axis confirm after', this.axisSelection);

        // >>> NEW: Lancer directement l’analyse DFM (intégralité) après validation
        // (on conserve tes endpoints / workflow existants)
        const ensured = this.setFileIdFromPage();
        const fid = ensured || this.fileId;
        if (fid && this.materialProfile) {
          // Affiche le loader local
          this._renderLoading();
          // Départ de l’analyse serveur
          this.startDFM();
        } else {
          // Relancer bouton au cas où
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
    if (this.axisPanel) {
      this.axisPanel.style.display = canShow ? 'block' : 'none';
    }
    this.updateAxisPanelState();
  }

  // Affiche le sélecteur d'axe sous le viewer
  renderAxisPanel() {
    if (!this.fileId && typeof this.setFileIdFromPage === 'function') this.setFileIdFromPage();
    if (!this.fileId || !this.materialProfile) {
      if (!this.fileId) UI?.info?.("Aucun fichier à analyser. Merci d’importer une pièce.");
      return; // ne pas afficher l'axe
    }
    if (!this.state.materialSelected) return;

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
    console.info('[dfm] panneau axe affiché');

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

    // 6) Bouton "Valider l’axe" → émettre axis:confirmed (et lancer analyse)
    panel.querySelector('#axisConfirmBtn')?.addEventListener('click', () => {
      const axis = this.axisPicker?.getAxis?.();
      if (!axis) {
        UI?.info?.("Choisissez une direction d’axe avant de valider.");
        return;
      }
      const invert = !!this.invertToggle?.checked;
      dbg('axis:confirmed emit', axis, invert);
window.dispatchEvent(new CustomEvent('axis:confirmed', { detail: { axis, invert } }));
const letter = vectorToAxisLetter(axis);
window.dispatchEvent(new CustomEvent('cadlytics:demould-axis-selected', { detail: { axis: letter } }));
// >>> NEW: lancer l’aperçu DFM local immédiat
runLocalPhaseA(letter);

// (la suite garde ton loader + appel serveur)
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Lancer aussitôt l’analyse
      const ensured = this.setFileIdFromPage();
      const fid = ensured || this.fileId;
      if (fid && this.materialProfile) {
        this._renderLoading();
        this.startDFM();
      }
    });
  }

  async handleAnalyzeClick(){
    console.info('[dfm] analyse demandée');
    const fileId = this.resolveFileId();
    if (!fileId) { console.info('[dfm] demande fichier'); openMaterialModal(); return; }
    if (!materialIsConfirmed()) { console.info('[dfm] demande matière'); openMaterialModal(); return; }
    if (!axisIsValidated()) { console.info('[dfm] demande axe'); showAxisPanelIfReady(); return; }
    this.setFileId(fileId);
    await this.startDFM();
  }

  // ---------------------- Analyse ----------------------
  async startDFM() {
  const payload = {
    file_id: this.fileId,
    axis: this.selectedAxis || { x: 0, y: 0, z: 1 },
    material: this.materialProfile?.id,
    options: {},
  };
  console.info('[dfm] lancement analyse', payload);

  if (!payload.file_id || !payload.material || !payload.axis) {
    UI.info?.('Paramètre manquant pour l’analyse.');
    return;
  }

  // >>> NEW: progression visible dès le départ
  UI.progress?.(5);

  UI.setLoading?.(true);
  this.state.running = true;
  try {
    const res = await fetch('/api/simple/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));

    // >>> NEW: si le backend renvoie un job_id, on suit la progression serveur
    if (data?.job_id) {
      this.pollStatus(data.job_id);   // <- alimentera UI.progress() → cadlytics:dfm:progress
    }

    if (!res.ok) {
      const msg = data.error || 'Analyse échouée';
      this.handleError?.(msg);
      return;
    }

    console.info('[dfm] report=', data.report_id);

    // petite progression intermédiaire pendant l’attente du rapport
    UI.progress?.(25);

    await pollDFMReport(this.fileId); // 404…404…200
    UI.progress?.(90);
    await this.renderResults(data);
    UI.progress?.(100);

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
    const preset = await loadCameraPresetOptional(`/static/dfm/${fileId}/camera_states.json`);
    if (preset?.iso) {
      const cam = window.viewerAdapter?.viewer?.camera;
      if (cam) {
        cam.eye = preset.iso.eye;
        cam.look = preset.iso.look;
        cam.up = preset.iso.up;
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
  // alias pour les vieux appels qui utilisent "orchestrator"
  window.orchestrator = window.DFMOrchestrator;
}

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
  window.showMaterialModal = showMaterialModal;
  window.openMaterialModal = openMaterialModal;
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
  if (!(document.getElementById("materialModal") || document.querySelector("[data-material-modal]"))) {
    errors.push("modal matière absent");
  }
  if (!btnAnalyser) errors.push("#btnAnalyser/#analyzeBtn/#btn-analyser absent");

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
  window.onAnalyzeClick = () => btnAnalyser?.click();
}

// --- Visualiser & analyse workflow ---------------------------------------
function getTolerance() {
  const v = parseFloat(document.getElementById("toleranceSelect")?.value);
  return Number.isFinite(v) ? v : 0.1;
}

if (typeof window !== "undefined") window.getTolerance = getTolerance;

// PATCH START: visualize flow via viewerAdapter
(function(){
  function $(s){ return document.querySelector(s); }
  const btnVisualiser = $('#btnVisualiser');

  // PATCH: après le load, annonce que le fichier est prêt + rafraîchit l’UI de base
async function doVisualize(fid){
  if (!fid) { console.warn('[visualiser] no fileId'); return; }
  if (!window.viewerAdapter?.viewer) {
    const canvas = document.getElementById('xktCanvas') || document.getElementById('xeokit-canvas');
    window.initViewer?.({ canvasElement: canvas });
  }
  await window.viewerAdapter?.convert?.(fid);
  await window.viewerAdapter?.loadFromFileId?.(fid);

  // >>> NEW: file prêt
  window.currentFileId = fid;
  // petit délai pour laisser la bbox/scene se stabiliser
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('dfm:fileReady', { detail: { fileId: fid } }));
  }, 50);
}


  if (btnVisualiser) {
    btnVisualiser.addEventListener('click', () => doVisualize(window.currentFileId));
  }

  window.addEventListener('dfm:fileReady', (e) => {
    const fid = (e?.detail && e.detail.fileId) || window.currentFileId;
    if (fid) doVisualize(fid);
  });
})();
/* ===========================================
   DFM — OUVERTURE MODALE SANS BOOTSTRAP
   - force l'ouverture de la "bonne" modale
   - capture le clic sur #btnAnalyser
   - bloque les fallbacks concurrents
   =========================================== */

// 1) Dis-moi (une bonne fois) quelle est la "vraie" modale à ouvrir.
//    Mets ici l'ID exact si tu le connais (sinon laisse vide, on devinera).
window.DFM_MATERIAL_MODAL_SELECTOR = window.DFM_MATERIAL_MODAL_SELECTOR || '#materialQuestionnaireModal';

// 2) Trouve la modale "réelle" (celle avec le formulaire)
function getMaterialModalEl() {
  const sel = window.DFM_MATERIAL_MODAL_SELECTOR && document.querySelector(window.DFM_MATERIAL_MODAL_SELECTOR)
    ? window.DFM_MATERIAL_MODAL_SELECTOR
    : '#materialQuestionnaireModal, #materialModal, [data-material-modal], .modal[data-role="material"]';

  const list = Array.from(document.querySelectorAll(sel));
  if (!list.length) return null;

  // priorité à celle qui contient un vrai formulaire matière
  const withForm = list.find(el => el.querySelector('#materialQuestionnaireForm, [data-material-form]'));
  return withForm || list[0];
}

// 3) Ouverture/fermeture "vanilla"
function openModalVanilla(el) {
  if (!el) return;

  // backdrop
  let backdrop = document.getElementById('__dfm_backdrop__');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = '__dfm_backdrop__';
    Object.assign(backdrop.style, {
      position:'fixed', inset:'0', background:'rgba(0,0,0,.45)', zIndex:'1040', display:'none'
    });
    document.body.appendChild(backdrop);
  }

  // styles de base pour la modale si besoin
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.style.display = 'block';
  el.style.visibility = 'visible';
  el.style.opacity = '1';
  el.style.zIndex = '1050';
  el.classList.add('show'); // au cas où tes CSS l’utilisent

  // centre si non positionnée
  const computed = getComputedStyle(el);
  if (computed.position === 'static') {
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.top = '50%';
    el.style.transform = 'translate(-50%, -50%)';
    el.style.maxHeight = '90vh';
    el.style.overflow = 'auto';
  }

  // afficher backdrop
  backdrop.style.display = 'block';

  // fermeture sur click [data-dismiss], .btn-close ou backdrop
  function tryClose(ev) {
    const t = ev.target;
    if (
      t.matches('.btn-close, [data-dismiss="modal"], [data-bs-dismiss="modal"]') ||
      t === backdrop
    ) {
      closeModalVanilla(el);
    }
  }
  backdrop.addEventListener('click', tryClose);
  el.addEventListener('click', tryClose);
  el.__dfm_closeHandlers = { tryClose, backdrop };
}

function closeModalVanilla(el) {
  if (!el) return;
  el.style.display = 'none';
  el.style.visibility = 'hidden';
  el.style.opacity = '0';
  el.classList.remove('show');
  const backdrop = document.getElementById('__dfm_backdrop__');
  if (backdrop) backdrop.style.display = 'none';
  if (el.__dfm_closeHandlers) {
    const { tryClose, backdrop } = el.__dfm_closeHandlers;
    backdrop?.removeEventListener('click', tryClose);
    el.removeEventListener('click', tryClose);
    delete el.__dfm_closeHandlers;
  }
}

// 4) API publique unique (écrase les autres implémentations)
window.showMaterialModal = window.openMaterialModal = function() {
  const el = getMaterialModalEl();
  if (!el) { console.warn('[DFM] Modale matière introuvable'); return; }

  // Si bootstrap est là, on l’utilise; sinon fallback vanilla
  if (window.bootstrap && window.bootstrap.Modal) {
    window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' }).show();
  } else {
    openModalVanilla(el);
  }
};

// 5) Capture le clic sur le bon bouton et coupe les fallbacks
(function hookAnalyzeButton(){
  // on écoute tous les alias possibles du bouton Analyser
  const BTN_SEL = '#btnAnalyser, #analyzeBtn, #btn-analyser, #btnAnalyse, #analyser, .btn-analyser, [data-action="analyze"], [data-act="analyze"]';

  function isMaterialModalOpen() {
    return !!(document.querySelector('.modal.show') ||
              document.querySelector('[data-material-modal].open'));
  }

  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.(BTN_SEL);
    if (!btn) return;

    // priorité (capture) mais on laisse une chance aux autres si on ouvre rien
    e.preventDefault();
    e.stopImmediatePropagation();

    try {
      // workflow minimal: file → matière → axe
      const fileId  = window.dfmOrchestrator?.resolveFileId?.() || window.currentFileId;
      const hasMat  = !!window.selectedMaterial;
      const hasAxis = !!window.selectedAxis;

      if (!fileId || !hasMat) {
        // on ouvre (vraie) modale matière
        return window.showMaterialModal?.() ?? window.openMaterialModal?.();
      }
      if (!hasAxis) {
        const p = document.querySelector('#dfmAxisPanel, #axis-panel');
        if (p) p.style.display = '';
        return;
      }

      // on a tout : lancer analyse
      window.dfmOrchestrator?.setFileId?.(fileId);
      return window.dfmOrchestrator?.startDFM?.();

    } finally {
      // filet de sécurité : si rien ne s’est ouvert, on force la modale matière
      setTimeout(() => {
        if (!isMaterialModalOpen()) {
          window.showMaterialModal?.() ?? window.openMaterialModal?.();
        }
      }, 150);
    }
  }, true); // capture = true (prioritaire)
})();

// PATCH END
