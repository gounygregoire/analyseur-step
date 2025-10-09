// /static/js/main.js — UTF-8 (NO BOM)
console.log("main.js loaded ✅");

import {
  Viewer,
  XKTLoaderPlugin,
  FastNavPlugin,
  NavCubePlugin,
  SectionPlanesPlugin,
  AnnotationsPlugin,
  DistanceMeasurementsPlugin,
  DistanceMeasurementsMouseControl
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

/* ---------- utils DOM ---------- */
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- sélecteurs ---------- */
const fileInput     = $("#fileInput");
const btnChoose     = $("#btnChoose");
const btnVisualiser = $("#btnVisualiser");
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

/* ====== Analyse: sélecteurs panneau (DYNAMIQUES) ====== */
const getEl = (sel) => document.querySelector(sel);
const getStatEl = (primarySel, dataMetric) =>
  getEl(primarySel) || getEl(`[data-metric="${dataMetric}"]`);
const projAxisRadios = () => $$('input[name="projAxis"]');

/* ====== Bouton "Analyser" (3 ids possibles) ====== */
const btnAnalyser = document.querySelector("#btnAnalyser, #analyzeBtn, #btn-analyser");

/* ------------------------------------------------------------------
   Fallback modale matière (aucun conflit avec DFMOrchestrator)
   ------------------------------------------------------------------ */
const materialModalSelectors  = ['#materialModal', '[data-material-modal]'];
const materialFormSelectors   = ['#materialQuestionnaireForm', '#materialForm', '[data-material-form]'];
const materialResultsSelectors= ['#materialResults', '[data-material-results]'];

function q1(list){ for (const s of list){ const el=document.querySelector(s); if (el) return el; } return null; }
function findMaterialModal()   { return q1(materialModalSelectors); }
function findMaterialForm()    { return q1(materialFormSelectors); }
function findMaterialResults() { return q1(materialResultsSelectors); }

function ensureMaterialModalFallback(){
  let el = findMaterialModal();
  if (el) return el;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
  <div class="modal fade" data-material-modal tabindex="-1" aria-hidden="true">
    <div class="modal-dialog"><div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">Critères matière</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fermer"></button>
      </div>
      <div class="modal-body">
        <form id="materialQuestionnaireForm" class="vstack" style="gap:.5rem">
          <strong>Contraintes mécaniques</strong>
          <label><input type="checkbox" name="mechanical" value="stiffness"> Rigidité</label>
          <label><input type="checkbox" name="mechanical" value="impact"> Choc / Impact</label>
          <label><input type="checkbox" name="mechanical" value="temperature"> Température</label>

          <strong class="mt-2">Esthétique</strong>
          <label><input type="checkbox" name="aesthetic" value="cosmetic"> Aspect soigné</label>
          <label><input type="checkbox" name="aesthetic" value="transparent"> Transparent</label>

          <strong class="mt-2">Réglementaire</strong>
          <label id="food" data-strong="true"><input type="checkbox" name="regulatory" value="food"> Contact alimentaire</label>
          <label id="flame_retardant" data-strong="true"><input type="checkbox" name="regulatory" value="flame_retardant"> Auto-extinguible</label>
        </form>

        <div class="mt-2">
          <button id="btnMaterialRecompute" type="button" class="btn btn-primary btn-sm">Recommander</button>
        </div>
        <div data-material-results style="display:none; margin-top:12px"></div>
      </div>
    </div></div>
  </div>`;
  el = wrap.firstElementChild;
  document.body.appendChild(el);
  return el;
}

function openMaterialModalSafe(){
  if (typeof window.openMaterialModal === "function") { try { window.openMaterialModal(); return findMaterialModal(); } catch(e){ console.warn(e); } }
  if (typeof window.showMaterialModal === "function") { try { window.showMaterialModal(); return findMaterialModal(); } catch(e){ console.warn(e); } }
  const el = findMaterialModal() || ensureMaterialModalFallback();
  if (!el) { alert("Modale critères indisponible."); return null; }
  if (window.bootstrap?.Modal) window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: "static" }).show();
  else { el.classList.add("open"); el.style.display="block"; }
  return el;
}

/* ---------- viewer + plugins ---------- */
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  dtxEnabled: true,
  transparent: true
});
window.viewer = viewer;

new FastNavPlugin(viewer, { flyToDuration: 0.9, hideEdges:false, autoHideEdges:false });

const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});
const sections = new SectionPlanesPlugin(viewer);
new AnnotationsPlugin(viewer, { container: overlayHost });

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
  if (tgt && tgt.name === 'axis') drawAxes(tgt.value);
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
    theAfter = textMetersToMMWithScale(before);
    if (theAfter !== before) t.nodeValue = theAfter;
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

/* ---------- chargement XKT ---------- */
async function loadXKT(url, nameHint){
  const id="m"+Date.now();
  const model=xktLoader.load({id, src:url, edges:!!chkEdges?.checked});
  setProgress(8);
  model.on("progress", p=> setProgress(8+Math.round(p*84)));
  model.on("loaded", ()=>{
    setProgress(100); setTimeout(()=>setProgress(0), 350);
    viewer.cameraFlight.flyTo(model);
    models.set(id,{model,name:nameHint||id,src:url}); lastModelId=id;
    if (chkEdges?.checked) viewer.scene.edgeMaterial.edgesEnabled=true;

    // init unités + heuristique AABB
    MM_PER_WU = 0.001;
    console.log("[units] init forced to µm→mm");
    onUnitsChanged();
    let tries = 0;
    const iv = setInterval(()=>{
      updateUnitsFromAABB(model?.aabb || viewer.scene?.aabb);
      if (++tries > 10) clearInterval(iv);
    }, 80);

    // notifier l’UI: fichier prêt
    setTimeout(()=>{
      window.dispatchEvent(new CustomEvent('dfm:fileReady', {
        detail: { fileId: window.currentFileId || null }
      }));
    }, 50);

    try {
      currentAxis = getSelectedAxis();
      if (currentFileId) { fetchStats(currentFileId, currentAxis); }
    } catch (e) { console.warn("[analyse] fetch initial ignoré:", e); }
  });
  model.on("error", e=>{ console.error(e); setProgress(0); alert("Erreur chargement XKT."); });
  return id;
}

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
      }
      console.log("[viewer] loading XKT (local):", fileURL);
      StatsPoller.cancel(); // stoppe l'ancien poll
      await loadXKT(fileURL, f.name);
      return;
    }

    const fd = new FormData();
    fd.append("file", f);

    const res = await fetch("/upload", { method: "POST", body: fd });
    let j = null;
    try { j = await res.json(); } catch {}

    if (!res.ok || !j || !j.xkt_url) {
      console.error("[upload] bad response", res.status, j);
      throw new Error(`upload failed (${res.status})`);
    }

    if (j.s3_uploaded === false) {
      console.warn("[upload] S3 non disponible.");
    }

    currentFileId = j.file_id || null;
    window.currentFileId = currentFileId; // <<< important pour fetchStats/DFM
    const xktUrl = new URL(j.xkt_url, location.origin).toString();
    console.log("[upload] ok:", { file_id: currentFileId, xktUrl });

    if (!chkAdditive?.checked) {
      for (const [, i] of models) { try { i.model.destroy(); } catch {} }
      models.clear(); selectedIds.clear();
    }

    console.log("[viewer] loading XKT]:", xktUrl);
    StatsPoller.cancel(); // stoppe l'ancien poll
    await loadXKT(xktUrl, f.name);
  } catch (e) {
    console.error(e);
    alert("Erreur conversion/chargement (voir Console).");
  } finally {
    if (btnVisualiser) { btnVisualiser.disabled = false; btnVisualiser.textContent = "VISUALISER"; }
    setProgress(0);
  }
}

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
btnVisualiser?.addEventListener("click",(e)=>{ e.preventDefault(); uploadAndShow(); });

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
    div.className="row mini"; div.style.justifyContent="space-between";
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
const norm  = (v)=>{ const L=len(v); return [v[0]/L,v[1]/L,v[2]/L]; };
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
  const cy = mP[1]*vx + mP[5]*vy + mP[9]*vz  + mP[13]*vw;
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

  const n = norm(clipPlaneDir);
  let up = [0,1,0];
  if (Math.abs(dot(up,n)) > 0.95) up = [1,0,0];
  const u = norm(cross(up, n));
  const v = norm(cross(n, u));

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

function renderStats(json){
  if (!json || typeof json !== "object") return;
  lastStats = json;

  if (Array.isArray(json.bbox_mm)) {
    window.__bbox_mm = json.bbox_mm;
    updateUnitsFromBBox(window.__bbox_mm);
  }

  const elVol  = getStatEl("#volVal",  "volume");
  const elProj = getStatEl("#projVal", "projected_area");
  const elTmin = getStatEl("#tminVal","tmin");
  const elTmax = getStatEl("#tmaxVal","tmax");

  setText(elVol,  f3(json.volume_cm3));
  setText(elProj, f3(json.projected_area_cm2));
  setText(elTmin, f3(json.thickness_min_mm));
  setText(elTmax, f3(json.thickness_max_mm));
}

function clearStatsUI(force=false){
  if (!force && StatsPoller.state?.lastOk) return; // conserve l’affichage existant
  renderStats({
    volume_cm3: null,
    projected_area_cm2: null,
    thickness_min_mm: null,
    thickness_max_mm: null,
    bbox_mm: window.__bbox_mm
  });
}

/* --- Stats polling controller (singleton) --- */
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
        cancel(); // stop dès OK
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
btnAnalyser?.addEventListener("click", (e) => {
  e.preventDefault();
  if (window.DFMOrchestrator?.handleAnalyzeClick) {
    window.DFMOrchestrator.handleAnalyzeClick();
    return;
  }
  openMaterialModalSafe();
});

/* ✅ Un seul listener dfm:fileReady : déclenche le polling (pas de re-render direct) */
window.addEventListener('dfm:fileReady', (ev)=>{
  const fid = ev?.detail?.fileId || currentFileId;
  if (fid) fetchStats(fid, getSelectedAxis());
});

// Export vide
export {};
