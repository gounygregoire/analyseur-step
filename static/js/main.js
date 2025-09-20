// /static/js/main.js
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
const btnAnnot     = $("#btnAnnot");
const clipButtons  = $$(".clipAxis");
const clipRange    = $("#clipRange");
const btnShot      = $("#btnShot");

/* ---------- viewer + plugins ---------- */
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  dtxEnabled: true,
  transparent: true
});
new FastNavPlugin(viewer, { flyToDuration: 0.9, hideEdges:false, autoHideEdges:false });

const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});
const sections = new SectionPlanesPlugin(viewer);

// Overlays HTML (utilisé par mesures + annotations)
const annotations = new AnnotationsPlugin(viewer, { container: overlayHost });

/* ========= Canvas & overlay sizing — DPR sûr ========= */
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
let appMode = "select";            // "select" | "annotate"
let clipAxis = null;
let clipPlane = null;

const setProgress=(p)=>{ if (progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; };
const allIds=()=> viewer.scene?.objectIds ?? [];
const setSome=(ids,prop,val)=> ids.forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const setAll=(prop,val)=> allIds().forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const clearSelection=()=>{ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); if (propsPanel) propsPanel.innerHTML=""; };

/* ---------- Mesures (libellé "mm" demandé) ---------- */
const distancePlugin = new DistanceMeasurementsPlugin(viewer, {
  container: overlayHost,
  labelsShown: true,
  labelFormat: (meters) => `${meters.toFixed(2)} mm`
});
const distanceCtrl = new DistanceMeasurementsMouseControl(distancePlugin, { snapping: true });

/* ====== Panneau "Mesures" ====== */
const leftCard = document.querySelector(".grid > .card:first-child") || document.querySelector(".sidebar") || document.querySelector("#leftPane") || document.body;
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

const measMap  = new Map();  // id -> { m, name }
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

/* ============ Modes exclusifs ============ */
function deactivateMeasure() {
  if (distanceCtrl.active) distanceCtrl.deactivate();
  btnMeasure?.classList.remove("btn-primary");
}
function deactivateAnnot() {
  appMode = "select";
  btnAnnot?.classList.remove("btn-primary");
}
function activateMeasure() {
  deactivateAnnot();
  distanceCtrl.activate();
  btnMeasure?.classList.add("btn-primary");
}
function toggleMeasure() {
  if (distanceCtrl.active) { deactivateMeasure(); }
  else { activateMeasure(); }
}
function toggleAnnot() {
  const turnOn = appMode !== "annotate";
  deactivateMeasure();
  if (turnOn) {
    appMode = "annotate";
    btnAnnot?.classList.add("btn-primary");
  } else {
    deactivateAnnot();
  }
}
btnMeasure?.addEventListener("click", toggleMeasure);
btnAnnot  ?.addEventListener("click", toggleAnnot);
window.addEventListener("keydown", (e)=>{ if (e.key==="Escape" && distanceCtrl.active) deactivateMeasure(); });

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
  });
  model.on("error", e=>{ console.error(e); setProgress(0); alert("Erreur chargement XKT."); });
  return id;
}
async function uploadAndShow(){
  const f=fileInput?.files?.[0];
  if (!f){ alert("Choisis un fichier .step/.stp/.stl (ou .xkt)"); return; }
  if (btnVisualiser){ btnVisualiser.disabled=true; btnVisualiser.textContent="Conversion…"; }
  setProgress(12);
  try{
    if (/\.(xkt)$/i.test(f.name)) {
      const fileURL = URL.createObjectURL(f);
      if (!chkAdditive?.checked){ for (const [,i] of models){ try{i.model.destroy();}catch{} } models.clear(); selectedIds.clear(); }
      await loadXKT(fileURL, f.name);
      return;
    }
    const fd=new FormData(); fd.append("file",f);
    const res=await fetch("/upload",{method:"POST",body:fd});
    const j=await res.json();
    if (!res.ok || !j.xkt_url) throw new Error(JSON.stringify(j));
    const xktUrl=new URL(j.xkt_url, location.origin).toString();
    if (!chkAdditive?.checked){ for (const [,i] of models){ try{i.model.destroy();}catch{} } models.clear(); selectedIds.clear(); }
    await loadXKT(xktUrl, f.name);
  }catch(e){ console.error(e); alert("Erreur conversion/chargement (voir Console)."); }
  finally{ if (btnVisualiser){ btnVisualiser.disabled=false; btnVisualiser.textContent="VISUALISER"; } }
}

/* ---------- fichiers UI ---------- */
btnChoose?.addEventListener("click",(e)=>{ e.preventDefault(); fileInput?.click(); });
fileInput?.addEventListener("change",()=>{ const f=fileInput.files?.[0]; if (f && fileNameLbl) fileNameLbl.textContent=f.name; if (f) uploadAndShow(); });
btnVisualiser?.addEventListener("click",(e)=>{ e.preventDefault(); uploadAndShow(); });

/* ---------- nav & rendu ---------- */
btnFit?.addEventListener("click", ()=> viewer.cameraFlight.flyTo(viewer.scene));
let proj="perspective";
btnProj?.addEventListener("click",()=>{ proj = proj==="perspective" ? "ortho" : "perspective"; viewer.camera.projection=proj; btnProj.textContent = proj==="perspective" ? "PERSPECTIVE" : "ORTHOGRAPHIQUE"; });

chkEdges?.addEventListener("change",()=> viewer.scene.edgeMaterial.edgesEnabled=!!chkEdges.checked);
viewer.scene.on("tick",()=>{ 
  if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) viewer.scene.edgeMaterial.edgesEnabled=true;
});

/* ---------- ANNOTATIONS (plugin, position verrouillée au point cliqué) ---------- */
const annotPane = (()=> {
  const left = leftCard;
  const pane = document.createElement("div");
  pane.className="pane"; pane.dataset.pane="annotations";
  pane.innerHTML = `
    <h4 style="margin:12px 0 10px">Annotations</h4>
    <div id="annotList" style="display:flex;flex-direction:column;gap:6px"></div>
    <div class="row mini" style="margin-top:6px; gap:8px">
      <button id="btnHideAllAnn" class="btn btn-outline mini">Tout cacher/montrer</button>
      <button id="btnClearAnn"   class="btn btn-danger mini">Tout supprimer</button>
    </div>`;
  left.appendChild(pane);
  return {
    list: pane.querySelector("#annotList"),
    hideAllBtn: pane.querySelector("#btnHideAllAnn"),
    clearBtn: pane.querySelector("#btnClearAnn"),
  };
})();
const annotListEl  = annotPane.list;
const btnHideAllAnn= annotPane.hideAllBtn;
const btnClearAnn  = annotPane.clearBtn;

let annCounter = 0;
const manualAnns = []; // { id, ann }

function createManualAnnotation(hit){
  const id = "ann"+(++annCounter);
  const ann = annotations.createAnnotation({
    id,
    worldPos: hit.worldPos,              // <-- on colle EXACTEMENT au point cliqué
    markerHTML:`<div class="dot"></div>`,
    markerShown:true,
    labelHTML:`<input class="annot-input" placeholder="Texte…" />`,
    labelShown:true,
    occludable:false
  });

  manualAnns.push({ id, ann });
  addAnnotationRow(id, ann);

  const input = overlayHost.querySelector(`[data-annotation_id="${id}"] .annot-input`);
  if (input){
    input.focus();
    const commit=()=>{
      const t = (input.value||"").trim() || `Annotation ${annCounter}`;
      ann.setLabelHTML?.(`<div class="xk-badge">${t}</div>`) || (ann.labelHTML=`<div class="xk-badge">${t}</div>`);
      const row = annotListEl.querySelector(`[data-aid="${id}"] .annot-name`); if (row) row.textContent = t;
    };
    input.addEventListener("keydown",(e)=>{ if (e.key==="Enter"){ e.preventDefault(); input.blur(); } });
    input.addEventListener("blur", commit, {once:true});
  }
}

function addAnnotationRow(id, ann){
  const row = document.createElement("div");
  row.className="row mini"; row.dataset.aid = id;
  row.style.justifyContent="space-between";
  row.innerHTML = `
    <span class="annot-name" style="font-size:12px">Annotation ${annCounter}</span>
    <span>
      <button class="btn btn-outline mini" data-act="edit">Éditer</button>
      <button class="btn btn-outline mini" data-act="toggle">Cacher</button>
      <button class="btn btn-outline mini btn-danger" data-act="del">Suppr.</button>
    </span>`;
  annotListEl.appendChild(row);

  row.querySelector('[data-act="edit"]').addEventListener("click", ()=>{
    const cur = row.querySelector(".annot-name").textContent.trim();
    const nv  = prompt("Texte de l’annotation :", cur);
    if (nv!=null){
      ann.setLabelHTML?.(`<div class="xk-badge">${nv.trim()||cur}</div>`) || (ann.labelHTML=`<div class="xk-badge">${nv.trim()||cur}</div>`);
      row.querySelector(".annot-name").textContent = nv.trim()||cur;
    }
  });
  row.querySelector('[data-act="toggle"]').addEventListener("click", ()=>{
    ann.visible = !ann.visible;
  });
  row.querySelector('[data-act="del"]').addEventListener("click", ()=>{
    try { ann.destroy?.(); } catch {}
    const i = manualAnns.findIndex(a=>a.id===id);
    if (i>=0) manualAnns.splice(i,1);
    row.remove();
  });
}

btnHideAllAnn.addEventListener("click", ()=>{
  const hide = manualAnns.some(a=>a.ann.visible);
  manualAnns.forEach(a=> a.ann.visible = !hide);
});
btnClearAnn.addEventListener("click", ()=>{
  manualAnns.splice(0).forEach(a=>{ try{ a.ann.destroy?.(); }catch{} });
  annotListEl.innerHTML="";
  annCounter=0;
});

/* Clic scène : création annotation (mode ANNOTATE) */
viewer.scene.input.on("mouseclicked", (coords)=>{
  if (distanceCtrl.active) return;
  if (appMode!=="annotate") return;
  const hit = viewer.scene.pick({ canvasPos: coords, pickSurface: true });
  if (!hit || !hit.entity) return;
  createManualAnnotation(hit);
});

/* ---------- propriétés ---------- */
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

/* ---------- COUPE ---------- */
function setClipAxis(axis){
  const same=(clipAxis===axis); clipAxis = same ? null : axis;
  clipButtons.forEach(b=> b.classList.toggle("btn-primary", !same && b.dataset.axis===clipAxis));

  if (clipPlane){ try{ clipPlane.destroy(); }catch{} clipPlane=null; }

  if (!clipAxis){ viewer.scene.sectionPlanesEnabled=false; return; }

  const aabb=viewer.scene?.aabb || [0,0,0, 0,0,0];
  const center=[(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  const dir = clipAxis==="x" ? [1,0,0] : clipAxis==="y" ? [0,1,0] : [0,0,1];

  clipPlane = sections.createSectionPlane({ id:"cut", pos:center, dir });
  viewer.scene.sectionPlanesEnabled=true;

  annotations.createAnnotation({
    id:"cutplate", worldPos:center, markerShown:false, labelShown:true,
    labelHTML:`<div class="cutplate" title="Plan ${clipAxis.toUpperCase()}"></div>`, occludable:false
  });

  clipRange.value="0";
}
clipButtons.forEach(b=> b.addEventListener("click",()=> setClipAxis(b.dataset.axis)));
clipRange?.addEventListener("input",()=>{
  if (!clipPlane || !clipAxis) return;
  const k=parseFloat(clipRange.value)||0;
  const aabb=viewer.scene?.aabb || [0,0,0, 0,0,0];
  const center=[(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  const half=[(aabb[3]-aabb[0])/2,(aabb[4]-aabb[1])/2,(aabb[5]-aabb[2])/2];
  const shift=(clipAxis==="x"?half[0]:clipAxis==="y"?half[1]:half[2])*(k/100);
  const pos=[...center]; if (clipAxis==="x") pos[0]+=shift; else if (clipAxis==="y") pos[1]+=shift; else pos[2]+=shift;
  clipPlane.pos=pos;
});

/* ---------- Screenshot ---------- */
btnShot?.addEventListener("click",()=>{
  try{
    const dataURL=canvasEl.toDataURL("image/png");
    const a=document.createElement("a"); a.href=dataURL; a.download="cadlytics_view.png"; a.click();
  }catch(e){ console.error(e); alert("Capture impossible."); }
});
