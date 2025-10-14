// /static/js/DFMOrchestrator.js — UTF-8 (NO BOM)
/*
 * Orchestrateur DFM – robuste (résout fileId depuis DOM/URL/Viewer)
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 * Compatible avec app.html (demouldHost) + main.js (viewerAdapter & probes)
 */

import HeatmapLayer from "./modules/HeatmapLayer.js";

/* ---------------------- helpers/fallbacks ---------------------- */
async function loadCameraPresetOptional(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  window.CAD = {
    fileIdStep: window.CAD?.fileIdStep ?? null,
    materialProfile: window.CAD?.materialProfile ?? null,
    axis: window.CAD?.axis ?? { x: 0, y: 0, z: 1 },
    currentJobId: window.CAD?.currentJobId ?? null,
    materialShortlist: window.CAD?.materialShortlist ?? null,
  };
}

const DEBUG_DFM = (typeof window !== 'undefined' && window.DEBUG_DFM === true);
const dbg = (...a) => { if (DEBUG_DFM) console.debug("[DFM]", ...a); };

const UI = {
  info(m){ if (window.showToast) showToast(m,{type:"info"}); },
  warn(m){ if (window.showToast) showToast(m,{type:"warn"}); },
  err(m){  if (window.showToast) showToast(m,{type:"error"}); },
  setLoading(on){
    const b = document.querySelector('#btnAnalyser, #analyzeBtn, #btn-analyser');
    if (b) b.disabled = !!on;
  },
  progress(pct){
    const bar = document.getElementById("dfmProgressBar");
    if (bar) bar.style.width = `${pct}%`;
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

/* ---------------------- Phase A rapide (locale) ---------------------- */
function normalizeShortlist(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 3).map((x) => ({
    id: String(x.id || x.name || 'MAT'),
    name: String(x.name || x.id || 'MAT'),
    match_pct: typeof x.match_pct === 'number'
      ? Math.round(x.match_pct)
      : (typeof x.score === 'number' ? Math.round(Math.max(0, Math.min(100, x.score))) : 100),
    score: (typeof x.score === 'number' ? x.score : 100)
  }));
}

const MAT_RULES_QUICK = {
  ABS:{draftExt:1.0,draftInt:0.5,P_inj_bar:600,tmin:1.2},
  PC:{draftExt:1.5,draftInt:1.0,P_inj_bar:800,tmin:1.8},
  PP:{draftExt:1.0,draftInt:0.5,P_inj_bar:500,tmin:1.2},
  'PA66 GF30':{draftExt:1.0,draftInt:0.5,P_inj_bar:800,tmin:1.5}
};
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const axisLetterToVec=(A)=>A==='X'?[1,0,0]:A==='Y'?[0,1,0]:[0,0,1];

async function __quickProjectedArea(axis){ try{return await window.__getProjectedArea?.(axis)??0;}catch{return 0;} }
async function __quickBasicStats(){ try{return await window.__getBasicStats?.()??{volume_cm3:0,tmin_mm:null,tmax_mm:null};}catch{return {volume_cm3:0,tmin_mm:null,tmax_mm:null};} }
async function __quickFaces(){ try{return await window.__getFaces?.()??[];}catch{return [];} }

async function quickCheckDraft(axis){
  const ax = axisLetterToVec(axis);
  const faces = await __quickFaces();
  let areaTot=0, areaKO=0, areaWarn=0;
  const thr = { external: 1.0, internal: 0.5 };
  const draftMap = {};

  for (const f of faces){
    const n = f.normal || [0,0,1];
    const cos = dot3(n, ax);
    const angDeg = Math.acos(Math.max(-1, Math.min(1, Math.abs(cos)))) * 180/Math.PI;
    const draft = 90 - angDeg;
    draftMap[f.id ?? `f${Object.keys(draftMap).length}`] = draft;

    areaTot += (f.area||0);
    const need = (f.isExternal ? thr.external : thr.internal);
    if (draft < need) areaKO += (f.area||0);
    else if (draft < need + 0.5) areaWarn += (f.area||0);
  }

  const pctKO = areaTot ? (100*areaKO/areaTot) : 0;
  const pctWarn = areaTot ? (100*areaWarn/areaTot) : 0;
  window.__quickDraftMap = draftMap;

  return [
    { key:'draft_area_KO',   label:'% surface sous dépouille', value:pctKO.toFixed(1), unit:'%', pass: pctKO<5, severity: pctKO>15?'fail':(pctKO>5?'warn':'ok'),
      tips:['Augmenter la dépouille','Réduire le grain / revoir axe'] },
    { key:'draft_area_warn', label:'% surface proche du seuil', value:pctWarn.toFixed(1), unit:'%', pass:true }
  ];
}
async function quickUndercuts(axis){
  const ax=axisLetterToVec(axis), faces=await __quickFaces();
  const bad=faces.filter(f=>dot3(f.normal||[0,0,1],ax)<-0.05);
  const areaBad=bad.reduce((s,f)=>s+(f.area||0),0), areaTot=faces.reduce((s,f)=>s+(f.area||0),0);
  const pct=areaTot?(100*areaBad/areaTot):0;
  return [{key:'undercut_pct',label:'% surfaces en contre-dépouille',value:pct.toFixed(1),unit:'%',pass:pct<3,severity:pct>8?'fail':(pct>3?'warn':'ok'),tips:['Prévoir tiroir / split','Modifier plan de joint']}];
}
async function quickTonnage(axis,material){
  const rules=MAT_RULES_QUICK[(material?.id||material?.name||'ABS')]||MAT_RULES_QUICK.ABS;
  const area_cm2=await __quickProjectedArea(axis);
  const F_kN=(rules.P_inj_bar*1e5)*(area_cm2*1e-4)/1000; const tonnage=Math.ceil(F_kN/9.81); const pass=tonnage<=150;
  return [
    {key:'proj_area',label:'Surface projetée',value:area_cm2.toFixed(1),unit:'cm²',pass:true},
    {key:'tonnage',label:'Tonnage presse estimé',value:tonnage,unit:'T',pass,severity:pass?'ok':'warn',tips:pass?[]:['Réduire aire projetée / matière P_inj plus faible']}
  ];
}
async function quickMaterialVsThickness(material){
  const rules=MAT_RULES_QUICK[(material?.id||material?.name||'ABS')]||MAT_RULES_QUICK.ABS;
  const s=await __quickBasicStats();
  const okT=(s.tmin_mm??0)>=rules.tmin;
  return [
    {key:'mat_tmin_req',label:'Épaisseur mini matière',value:rules.tmin,unit:'mm',pass:true},
    {key:'part_tmin',label:'Épaisseur mini pièce',value:s.tmin_mm,unit:'mm',pass:okT,severity:okT?'ok':'fail',tips:okT?[]:[`Augmenter t_min à ≥ ${rules.tmin} mm`] }
  ];
}
async function runLocalPhaseA(axisLetter){
  try{
    UI.progress(5);
    const material=window.selectedMaterial||{id:'ABS',name:'ABS'};
    const draft=await quickCheckDraft(axisLetter);    UI.progress(15);
    const under=await quickUndercuts(axisLetter);     UI.progress(25);
    const ton=await quickTonnage(axisLetter,material);UI.progress(35);
    const thk=await quickMaterialVsThickness(material); UI.progress(45);
    const payload={detail:{metrics:{draft,undercut:under,tonnage:ton,thickness:thk}}};
    window.dispatchEvent(new CustomEvent('cadlytics:dfm:report', payload));
  }catch(e){ console.warn('[dfm quick] error', e); }
}
if (typeof window !== 'undefined') {
  window.__runLocalPhaseA = runLocalPhaseA;
}

/* ---------------------- Status polling ---------------------- */
async function pollJobStatus(jobId, onUpdate, onDone, onError) {
  let queuedSince = Date.now();

  async function step() {
    try {
      const res = await fetch(`/api/dfm/status?job_id=${encodeURIComponent(jobId)}`);
      const data = await res.json();

      onUpdate?.(data);
      if (data.status === "done")  { await onDone?.(data); return; }
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

/* ---------------------- Rendering ---------------------- */
function renderDFMResults(report = {}) {
  const { score = 0, recommendations = [], metrics = {} } = report;

  const panel = document.getElementById('dfmAnalysisPanel');
  if (!panel) return;
  panel.innerHTML = '';

  // Ré-injecte la shortlist si déjà connue
  if (Array.isArray(window.CAD?.materialShortlist) && window.CAD.materialShortlist.length) {
    renderMaterialsShortlistUI(window.CAD.materialShortlist);
  }

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

  try {
    window.dispatchEvent(new CustomEvent('cadlytics:dfm:report', { detail: { score, recommendations, metrics } }));
  } catch {}
}
if (typeof window !== 'undefined') window.renderDFMResults = renderDFMResults;

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
  if (window.showToast) showToast("Analyse trop longue, réessaie.", { type: "error" });
}

/* ---------------------- Orchestrateur ---------------------- */
const DFM_STATES = {
  IDLE:"IDLE", MATERIAL_CONFIRMED:"MATERIAL_CONFIRMED", AXIS_PICK:"AXIS_PICK",
  RUNNING:"RUNNING", RESULTS:"RESULTS", ERROR:"ERROR"
};

function materialIsConfirmed(){ return !!window.selectedMaterial; }

function vectorToAxisLetter(v = {x:0,y:0,z:1}) {
  const ax = Math.abs(v.x) >= Math.abs(v.y) && Math.abs(v.x) >= Math.abs(v.z) ? 'X'
          : Math.abs(v.y) >= Math.abs(v.x) && Math.abs(v.y) >= Math.abs(v.z) ? 'Y' : 'Z';
  return ax;
}

/* ---------- UI: shortlist matières (Top 3) ---------- */
function ensureResultsSection() {
  const section = document.getElementById("dfmResultsSection");
  if (section) section.style.display = "block";
  return document.getElementById("dfmAnalysisPanel");
}

function renderMaterialsShortlistUI(shortlist = []) {
  const panel = ensureResultsSection();
  if (!panel) return;

  let box = document.getElementById("dfmMatShortlistUI");
  if (!box) {
    box = document.createElement("div");
    box.id = "dfmMatShortlistUI";
    panel.prepend(box);
  }
  if (!Array.isArray(shortlist) || !shortlist.length) {
    box.innerHTML = "";
    return;
  }

  const pills = shortlist.map((m,i) => `
    <button type="button"
            class="btn btn-sm ${i===0?'btn-primary':'btn-outline-primary'} me-2 mb-2 dfm-mat-pill"
            data-mid="${m.id}">
      <span class="fw-semibold">${m.name}</span>
      <span class="badge ${i===0?'bg-light text-primary':'bg-primary'} ms-2">${m.match_pct}%</span>
    </button>`).join("");

  box.innerHTML = `
    <div class="card border-0 shadow-sm mb-2">
      <div class="card-body py-2">
        <div class="small text-muted mb-1">Meilleurs candidats matière :</div>
        <div class="d-flex flex-wrap">${pills}</div>
        <div class="small text-muted mt-1">Clique sur un candidat pour le sélectionner, puis “Analyser”.</div>
      </div>
    </div>`;

  box.querySelectorAll(".dfm-mat-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.mid;
      const found = shortlist.find(x => x.id === id);
      if (found) {
        window.selectedMaterial = { id: found.id, name: found.name };
        box.querySelectorAll(".dfm-mat-pill").forEach(b=>{
          b.classList.remove("btn-primary");
          b.classList.add("btn-outline-primary");
        });
        btn.classList.remove("btn-outline-primary");
        btn.classList.add("btn-primary");

        window.dispatchEvent(new CustomEvent('material:selected', {
          detail: { materialProfile: window.selectedMaterial }
        }));
        window.dispatchEvent(new CustomEvent('material:confirmed'));
      }
    });
  });
}

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
    this.selectedAxis = null; // {x,y,z}
    this.selectedInvert = false;
  }

  init(){
    // ❶ Shortlist envoyée par la modale → sauvegarder + afficher (dédupliqué)
    window.addEventListener('cadlytics:materials-shortlist', (e) => {
      const list = normalizeShortlist(e?.detail?.shortlist || []);
      window.CAD.materialShortlist = list;
      this._persistShortlist(list);
      this._renderShortlistBar(list);
      renderMaterialsShortlistUI(list);
    });

    // ❷ Fallback : si seule la matière “best” est connue, afficher au moins 1 pill à 100%
    window.addEventListener('material:selected', (e) => {
      const mp = e?.detail?.materialProfile || window.selectedMaterial;
      if (!mp) return;
      const existing = this._loadPersistedShortlist();
      if (Array.isArray(existing) && existing.length) {
        this._renderShortlistBar(existing);
      } else {
        const one = [{ id: mp.id, name: mp.name, match_pct: 100, score: 100 }];
        this._persistShortlist(one);
        this._renderShortlistBar(one);
      }
    });

    window.addEventListener('material:confirmed', () => {
      this.setState(DFM_STATES.MATERIAL_CONFIRMED);
    });

    // Compat: si un autre UI publie axis:confirmed (ex: ancien panel)
    window.addEventListener('axis:confirmed', (e) => {
      const v = e?.detail?.axis;
      if (v && typeof v === 'object') {
        this.selectedAxis = v;
        this.selectedInvert = !!e.detail.invert;
        this.state.axisConfirmed = true;
      }
    });

    // Intégration demouldHost (app.html) -> lettre X/Y/Z
    window.addEventListener('cadlytics:demould-axis-selected', (e) => {
      const letter = (e?.detail?.axis || 'Z').toUpperCase();
      this.selectedAxis = (letter==='X'?{x:1,y:0,z:0}:letter==='Y'?{x:0,y:1,z:0}:{x:0,y:0,z:1});
      this.state.axisConfirmed = true;

      // Phase A locale + éventuel lancement serveur
      window.__runLocalPhaseA?.(letter)?.catch?.(()=>{});
      const fid = this.resolveFileId();
      if (fid && materialIsConfirmed()) {
        this.setFileId(fid);
        this._renderLoading();
        this.startDFM();
      }
    });

    // Bouton Analyser → workflow unique
    const btnAnalyser = document.querySelector('#btnAnalyser, #analyzeBtn, #btn-analyser');
    if (btnAnalyser) {
      btnAnalyser.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.handleAnalyzeClick();
      }, true);
    }

    // Si une shortlist existe déjà (ex: modale fermée avant load), l’afficher
    if (Array.isArray(window.CAD?.materialShortlist) && window.CAD.materialShortlist.length) {
      renderMaterialsShortlistUI(window.CAD.materialShortlist);
    }

    // ❸ Initialiser la barre au chargement avec la dernière shortlist connue
    requestAnimationFrame(() => {
      const last = this._loadPersistedShortlist();
      if (last && last.length) this._renderShortlistBar(last);
      else this._renderShortlistBar([]); // crée la barre (cachée) pour éviter tout “flash”
    });

    // La modale “analyse matière” legacy
    window.addEventListener('cadlytics:material-analysis-done', (e) => {
      try {
        const raw = e?.detail?.shortlist || [];
        const list = normalizeShortlist(raw);
        window.CAD.materialShortlist = list;
        this._persistShortlist(list);
        this._renderShortlistBar(list);
        renderMaterialsShortlistUI(list);
      } catch (err) {
        console.warn('[DFM] failed to handle material-analysis-done', err);
      }
    });
  }

  setState(next){ this.phase = next; dbg("state →", next); }

  setFileId(id){
    if (!id) return false;
    if (this.fileId && this.fileId !== id) {
      console.warn('[DFM] file_id mismatch', this.fileId, id);
      return false;
    }
    this.fileId = id;
    this.state.fileLoaded = true;
    this.state.axisConfirmed = !!this.selectedAxis;
    const hidden = document.getElementById('fileId');
    if (hidden && hidden.type === 'hidden') hidden.value = this.fileId || '';
    return true;
  }

  setMaterialProfile(p){
    this.materialProfile = p || null;
    this.state.materialSelected = !!this.materialProfile;
    this.state.axisConfirmed = !!this.selectedAxis;
    dbg('material selected', this.materialProfile);
  }

  async debugFileId(){
    if (!this.fileId) { console.warn('[DFM] debugFileId: aucun file_id'); return; }
    try {
      const res = await fetch(`/api/dfm/debug/file/${this.fileId}`);
      const data = await res.json().catch(()=>({}));
      console.debug('[DFM debug]', data);
    } catch (err) { console.warn('debugFileId failed', err); }
  }

  // ---------------------- Résolution fileId ----------------------
  resolveFileId(){
    if (this.fileId) return this.fileId;
    let id = document.body?.dataset?.fileid; if (id) return id;
    id = window.CAD?.fileIdStep || window.CADLYTICS?.current?.fileId; if (id) return id;
    const hidden = document.getElementById('fileId');
    if (hidden && hidden.type === 'hidden' && hidden.value) return hidden.value;
    id = window.viewerAdapter?.current?.fileId; if (id) return id;
    return window.currentFileId || null;
  }

  async handleAnalyzeClick(){
    const fileId = this.resolveFileId();
    if (!fileId || !materialIsConfirmed()) {
      if (typeof window.openMaterialModal === 'function') window.openMaterialModal();
      else this._openMaterialModalFallback();
      return;
    }
    if (!this.selectedAxis) {
      const dem = document.getElementById('demouldHost');
      if (dem) { dem.style.display = ''; dem.scrollIntoView({ behavior:'smooth', block:'center' }); }
      return;
    }
    this.setFileId(fileId);
    await this.startDFM();
  }

  // ---------------------- Analyse serveur ----------------------
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

      if (data?.job_id) this.pollStatus(data.job_id);

      if (!res.ok) {
        const msg = data.error || 'Analyse échouée';
        this.handleError?.(msg);
        return;
      }

      UI.progress?.(25);
      await pollDFMReport(this.fileId);
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
        UI.setLoading?.(false);
        this.state.running = false;
      },
      () => {
        StatusUI.set('Analyse échouée');
        UI.err('Analyse échouée');
        UI.setLoading?.(false);
        this.state.running = false;
      }
    );
  }

  // --- Barre shortlist matières (persistante) ---
  _ensureRecoBar() {
    if (this._recoEl && document.body.contains(this._recoEl)) return this._recoEl;

    const host = document.createElement('div');
    host.id = 'materialRecoBar';
    Object.assign(host.style, {
      position: 'fixed',
      right: '16px',
      top: '16px',
      zIndex: '1060',
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      maxWidth: '40vw'
    });
    document.body.appendChild(host);

    const styleId = '__matRecoStyle__';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        #materialRecoBar .mat-pill{
          display:inline-flex; align-items:center; gap:6px;
          background:rgba(255,255,255,.92);
          border:1px solid rgba(0,0,0,.08);
          border-radius:16px; padding:6px 10px;
          box-shadow:0 6px 18px rgba(0,0,0,.08);
          font:500 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
          backdrop-filter:saturate(1.1) blur(4px);
          cursor:default; user-select:none;
        }
        #materialRecoBar .mat-pill .pct{
          font-weight:700; padding:2px 6px; border-radius:10px;
          background:#eef2ff; color:#1e3a8a;
        }
        #materialRecoBar .mat-pill .id{
          color:#111827;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    this._recoEl = host;
    return host;
  }

  _renderShortlistBar(shortlist = []) {
    const host = this._ensureRecoBar();
    host.innerHTML = '';

    if (!Array.isArray(shortlist) || !shortlist.length) {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'flex';

    shortlist.slice(0, 3).forEach(item => {
      const pill = document.createElement('div');
      pill.className = 'mat-pill';
      pill.innerHTML = `
        <span class="id">${item.name || item.id}</span>
        <span class="pct">${(item.match_pct ?? Math.round(item.score || 0))}%</span>
      `;
      host.appendChild(pill);
    });
  }

  _persistShortlist(list) {
    try { localStorage.setItem('cad_material_shortlist', JSON.stringify(list || [])); } catch {}
  }
  _loadPersistedShortlist() {
    try {
      const raw = localStorage.getItem('cad_material_shortlist');
      if (!raw) return [];
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  /* ---------- Helpers couleurs & calcul local du draft ---------- */
  _draftToRGBA(d){
    // 0° rouge -> 5° vert (simple ramp)
    const clamp=(x,mn,mx)=>Math.max(mn,Math.min(mx,x));
    const t = clamp((d-0)/(5-0), 0, 1);
    const lerp=(a,b,u)=>a+(b-a)*u;
    const r = t < 0.5 ? 255 : Math.round(lerp(255,  20, (t-0.5)/0.5));
    const g = t < 0.5 ? Math.round(lerp(0, 255, t/0.5)) : Math.round(lerp(255, 180, (t-0.5)/0.5));
    const b = t < 0.5 ? 0 : Math.round(lerp(0, 60, (t-0.5)/0.5));
    return [r/255, g/255, b/255, 1];
  }

  async _collectLocalDraftSamples(axisLetter){
    const faces = await (window.__getFaces?.(1200) || []);
    if (!faces.length) return null;
    const ax = (axisLetter||'Z').toUpperCase();
    const axis = ax==='X'?[1,0,0]:ax==='Y'?[0,1,0]:[0,0,1];
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const clamp01=(x)=>Math.max(-1,Math.min(1,x));
    return faces.map(f=>{
      const cos = Math.abs(dot(f.normal||[0,0,1], axis));
      const ang = Math.acos(clamp01(cos)) * 180/Math.PI;
      const draft = 90 - ang; // degrés
      return { eid: f.eid || null, draft, area: f.area || 1 };
    });
  }

  // Fallback entités (moyenne par entityId)
  async _applyEntityHeatmap(axisLetter){
    const samples = await this._collectLocalDraftSamples(axisLetter);
    if (!samples || !samples.length) {
      alert("Aucun échantillon local pour la heatmap.");
      return 0;
    }
    const v = window.viewerAdapter?.viewer || window.viewer;
    if (!v?.scene?.objects) { alert("Viewer non initialisé."); return 0; }

    const byE = new Map();
    for (const s of samples){
      if (!s.eid) continue;
      const acc = byE.get(s.eid) || { sum:0, area:0 };
      acc.sum  += s.draft * s.area;
      acc.area += s.area;
      byE.set(s.eid, acc);
    }
    let applied = 0;
    byE.forEach((acc, eid)=>{
      const obj = v.scene.objects[eid];
      if (!obj) return;
      const mean = acc.sum / Math.max(1e-9, acc.area);
      obj.colorize = this._draftToRGBA(mean);
      obj.opacity  = 1;
      applied++;
    });
    if (applied) StatusUI.set(`Heatmap dépouille appliquée (fallback entités: ${applied})`);
    return applied;
  }

  // --- Heatmap dépouille locale/serveur ---
  async applyDraftHeatmap(draftMap = null, opts = {}){
    try {
      const tryBuild = opts.tryBuild !== false;

      // 1) Axis letter depuis l'état courant
      const vec = this.selectedAxis || { x:0, y:0, z:1 };
      const maxAbs = Math.max(Math.abs(vec.x||0), Math.abs(vec.y||0), Math.abs(vec.z||0));
      const letter = (maxAbs===Math.abs(vec.x)) ? 'X' : (maxAbs===Math.abs(vec.y) ? 'Y' : 'Z');

      // 2) Map par face (si dispo) sinon tente une construction locale
      let map = draftMap || window.__quickDraftMap || {};
      let mapSize = Object.keys(map).length;

      if (mapSize === 0 && tryBuild) {
        const faces = await this._computeFacesFromViewer();
        if (faces.length) {
          const ax = (letter==='X')?[1,0,0]:(letter==='Y')?[0,1,0]:[0,0,1];
          const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
          map = {};
          for (const f of faces) {
            const n = f.normal || [0,0,1];
            const cos = Math.abs(n[0]*ax[0] + n[1]*ax[1] + n[2]*ax[2]);
            const ang = Math.acos(clamp(cos,-1,1)) * 180/Math.PI;
            const draft = 90 - ang;
            map[f.id ?? `f${Object.keys(map).length}`] = draft;
          }
          window.__quickDraftMap = map;
          mapSize = Object.keys(map).length;
        }
      }

      // 3) S’assure que le viewer est prêt
      if (!window.viewerAdapter?.viewer) {
        const canvas =
          document.getElementById('xeokit-canvas') ||
          document.getElementById('xktCanvas') ||
          document.querySelector('canvas');
        if (typeof window.initViewer === 'function' && canvas) {
          await window.initViewer({ canvasElement: canvas });
        }
      }
      const fileId = this.resolveFileId?.() || window.currentFileId || window.CAD?.fileIdStep;
      if (fileId && window.viewerAdapter?.loadFromFileId) {
        await window.viewerAdapter?.convert?.(fileId);
        await window.viewerAdapter?.loadFromFileId?.(fileId);
      }
      if (!window.viewerAdapter?.viewer) {
        alert("Viewer non initialisé.");
        return;
      }

      // 4) Essai par-face via HeatmapLayer
      let appliedCount = 0;
      if (mapSize > 0 && typeof HeatmapLayer === 'function') {
        const layer = new HeatmapLayer(window.viewerAdapter);
        if (typeof layer.applyWithCount === 'function') {
          appliedCount = layer.applyWithCount(map, { min: 0, max: 5 });
        } else {
          layer.apply(map, { min: 0, max: 5 });
          appliedCount = layer.debugAppliedCount || 0;
        }
      }

      // 5) Si 0 face colorisée -> FALLBACK ENTITÉ automatique
      if (appliedCount === 0) {
        console.warn('[DFM] Heatmap par face: 0 correspondance. Fallback entités…');
        const n = await this._applyEntityHeatmap(letter);
        if (!n) {
          alert(
            "Aucune face/entité colorisée.\n" +
            "Schéma d’ID incompatible pour HeatmapLayer. Partage-moi modules/HeatmapLayer.js pour adapter le mapping."
          );
        }
      } else {
        StatusUI.set("Heatmap dépouille appliquée");
      }
    } catch (e) {
      console.warn("[DFM] applyDraftHeatmap error", e);
      alert("Impossible d'appliquer la heatmap (voir console).");
    }
  }

  // --- Fallback: extraction approx depuis le viewer ---
  async _computeFacesFromViewer() {
    try {
      const v = window.viewerAdapter?.viewer;
      const scene = v?.scene;
      if (!scene) return [];
      const faces = [];

      const meshes = [];
      if (scene.meshes) { for (const k in scene.meshes) { if (scene.meshes[k]) meshes.push(scene.meshes[k]); } }
      else if (scene.objects) { for (const k in scene.objects) { const o=scene.objects[k]; if (o && (o.geometry||o._geometry||o._state?.geometry)) meshes.push(o); } }
      else if (scene.iterate) { scene.iterate((n)=>{ if (n?.geometry) meshes.push(n); }); }

      const mul4x4 = (m,[x,y,z])=>[
        m[0]*x+m[4]*y+m[8]*z+m[12],
        m[1]*x+m[5]*y+m[9]*z+m[13],
        m[2]*x+m[6]*y+m[10]*z+m[14]
      ];
      const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
      const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
      const len=(v)=>Math.hypot(v[0],v[1],v[2])||1;
      const norm=(v)=>{const L=len(v); return [v[0]/L,v[1]/L,v[2]/L];};

      const MAX_FACES = 15000;
      let budget = MAX_FACES;

      for (const m of meshes) {
        if (budget<=0) break;
        const g = m.geometry || m._geometry || m._state?.geometry || {};
        const pos = g.positions || g._positions || g.verts || g.coordinates;
        const idx = g.indices   || g._indices   || g.triangles || g.faces;
        if (!pos || !idx) continue;

        const wm = m.worldMatrix || m.matrix || m.worldTransform?.matrix || m.transform?.matrix || [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
        const step = Math.max(1, Math.ceil(idx.length / (3* (budget/3))));
        for (let i=0; i<idx.length-2 && budget>0; i += 3*step) {
          const i0 = idx[i]*3, i1 = idx[i+1]*3, i2 = idx[i+2]*3;
          const p0 = mul4x4(wm, [pos[i0], pos[i0+1], pos[i0+2]]);
          const p1 = mul4x4(wm, [pos[i1], pos[i1+1], pos[i1+2]]);
          const p2 = mul4x4(wm, [pos[i2], pos[i2+1], pos[i2+2]]);
          const n  = norm(cross(sub(p1,p0), sub(p2,p0)));
          const area = 0.5 * len(cross(sub(p1,p0), sub(p2,p0)));
          faces.push({ id: `${m.id||m._id||'m'}:${i}`, normal:n, area });
          budget--;
        }
      }
      return faces;
    } catch (e) {
      console.warn("[DFM] _computeFacesFromViewer fallback failed", e);
      return [];
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

    // Réafficher la shortlist si connue
    if (Array.isArray(window.CAD?.materialShortlist) && window.CAD.materialShortlist.length) {
      renderMaterialsShortlistUI(window.CAD.materialShortlist);
    }

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
        const sev = issue.severity === 'error' ? 'danger' : issue.severity === 'warn' ? 'warning text-dark' : 'secondary';
        ul.innerHTML += `<li><span class="badge bg-${sev} me-1">${issue.type}</span>${issue.message}</li>`;
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

    if (Array.isArray(window.CAD?.materialShortlist) && window.CAD.materialShortlist.length) {
      renderMaterialsShortlistUI(window.CAD.materialShortlist);
    }
  }

  // fallback ouverture modale (si aucun openMaterialModal global)
  _openMaterialModalFallback(){
    const el = document.getElementById('materialModal') || document.querySelector('[data-material-modal]');
    if (!el) return alert('Modale matière introuvable');
    if (window.bootstrap?.Modal) window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' }).show();
    else {
      el.style.display='block'; el.style.visibility='visible'; el.style.opacity='1';
      el.style.position='fixed'; el.style.left='50%'; el.style.top='50%'; el.style.transform='translate(-50%, -50%)';
    }
  }
}

/* ---------------------- Exports & init ---------------------- */
const orchestrator = (typeof window !== 'undefined' && window.DFMOrchestrator)
  ? window.DFMOrchestrator
  : new DFMOrchestrator();

if (typeof window !== 'undefined') {
  window.DFMOrchestrator = orchestrator;
  window.orchestrator = orchestrator;

  if (typeof orchestrator.startDFM === 'function') {
    window.startDFM = orchestrator.startDFM.bind(orchestrator);
  }

  document.addEventListener('DOMContentLoaded', () => {
    orchestrator.setFileId(window.CAD.fileIdStep);
    orchestrator.setMaterialProfile(window.CAD.materialProfile);

    window.addEventListener('dfm:fileReady', e => {
      window.CAD.fileIdStep = e.detail.fileId;
      orchestrator.setFileId(e.detail.fileId);
    });

    document.getElementById('debugFileId')?.addEventListener('click', () => orchestrator.debugFileId());
    orchestrator.init();
  });

  function dfmSelfCheck() {
    const errors = [];
    if (!document.getElementById("materialModal") && !document.querySelector("[data-material-modal]")) {
      errors.push("modal matière absente");
    }
    if (!document.querySelector("#btnAnalyser, #analyzeBtn, #btn-analyser")) {
      errors.push("bouton Analyser absent");
    }
    if (errors.length) console.warn("[DFM selfcheck] Issues:", errors);
    else dbg('selfcheck OK');
  }
  window.requestAnimationFrame(dfmSelfCheck);
}

// Legacy onclick="onAnalyzeClick()"
if (typeof window !== 'undefined') {
  window.onAnalyzeClick = () => document.querySelector('#btnAnalyser, #analyzeBtn, #btn-analyser')?.click();
}
