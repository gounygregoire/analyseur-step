// /static/js/main.js
import {
  Viewer,
  XKTLoaderPlugin,
  NavCubePlugin,
  FastNavPlugin,
  SectionPlanesPlugin,
  DistanceMeasurementsPlugin,
  AnnotationsPlugin
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

const $ = (s) => document.querySelector(s);

// --- Réfs UI (toutes optionnelles : le code s'adapte)
const fileInput     = $("#fileInput");
const btnVisualiser = $("#btnVisualiser");
const chkAdditive   = $("#chkAdditive");
const fileNameLbl   = $("#fileName");

const btnFit  = $("#btnFit");
const btnProj = $("#btnProj");
const navMode = $("#navMode");
const chkEdges= $("#chkEdges");
const chkXray = $("#chkXray");
const chkGhost= $("#chkGhost");
const chkTheme= $("#chkTheme");
const viewerContainer = $("#viewerContainer");

const modelsList   = $("#modelsList");
const btnReload    = $("#btnReload");
const btnUnload    = $("#btnUnload");

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
const btnClip      = $("#btnClip");
const explodeRange = $("#explodeRange");
const btnShot      = $("#btnShot");

// ---------- Viewer & Plugins ----------
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  transparent: true,
  dtxEnabled: true
});
new FastNavPlugin(viewer, { flyToDuration: 0.9 });

const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});
const sections     = new SectionPlanesPlugin(viewer, {});
const measurements = new DistanceMeasurementsPlugin(viewer, { defaultDistancePrecision: 2 });
const annotations  = new AnnotationsPlugin(viewer, {
  markerHTML: "<div style='width:10px;height:10px;border-radius:999px;background:#ef4444;border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.2)'></div>"
});

// ---------- Axes jolis (cube + pastille XYZ) ----------
(() => {
  if (!viewerContainer) return;
  const cube = document.createElement("canvas");
  cube.width = cube.height = 96;
  Object.assign(cube.style, {
    position: "absolute", left: "12px", top: "12px", zIndex: "5",
    borderRadius: "12px", boxShadow: "0 6px 18px rgba(0,0,0,.25)",
    background: "rgba(255,255,255,.06)", backdropFilter: "blur(2px)"
  });
  viewerContainer.appendChild(cube);
  new NavCubePlugin(viewer, { canvasElement: cube, cameraFlyToDuration: 0.9 });

  const legend = document.createElement("div");
  legend.innerHTML =
    `<span style="color:#ef4444;font-weight:600">X</span>
     <span style="color:#22c55e;font-weight:600;margin:0 6px">Y</span>
     <span style="color:#60a5fa;font-weight:600">Z</span>`;
  Object.assign(legend.style, {
    position: "absolute", left: "12px", top: "114px", zIndex: "6",
    font: "12px/1 Inter,system-ui,Segoe UI,Roboto,Arial",
    padding: "4px 8px", background: "rgba(0,0,0,.35)", color: "#fff",
    borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,.2)"
  });
  viewerContainer.appendChild(legend);
})();

// ---------- État ----------
const models = new Map(); // id -> { model, name, src }
let lastModelId = null;
let selectedIds = new Set();
let onePlane = null;
let appMode = "select"; // "select" | "measure" | "annotate"

function setMode(m) {
  appMode = (appMode === m) ? "select" : m;
  btnMeasure?.classList.toggle("btn-primary", appMode === "measure");
  btnAnnot?.classList.toggle("btn-primary",   appMode === "annotate");
}

// ---------- Utils ----------
const setProgress = (p)=> progressBar && (progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`);
const allIds = ()=> viewer.scene?.objectIds ?? [];

function setIdsProp(ids, prop, val){
  ids.forEach(id => { const o = viewer.scene.objects[id]; if (o) o[prop] = val; });
}
function setAllProp(prop, val){ allIds().forEach(id => { const o = viewer.scene.objects[id]; if (o) o[prop] = val; }); }

function clearSelection(){
  setIdsProp([...selectedIds], "highlighted", false);
  selectedIds.clear();
  propsPanel && (propsPanel.innerHTML = "");
}

function showProps(meta){
  if (!propsPanel) return;
  propsPanel.innerHTML = "";
  if (!meta) return;
  const add = (k,v)=>{ const a=document.createElement("div");a.textContent=k;
                       const b=document.createElement("div");b.textContent=String(v);
                       propsPanel.append(a,b); };
  const base = { id: meta.id, type: meta.type||meta.ifcType||"", name: meta.name||meta.displayName||"" };
  Object.entries(base).forEach(([k,v])=> (v!==undefined && v!=="") && add(k,v));
  const psets = meta.properties||meta.props;
  if (psets && typeof psets==="object")
    Object.entries(psets).forEach(([k,v])=> add(k, typeof v==="object"? JSON.stringify(v): v));
}

function refreshModelsList(){
  if (!modelsList) return;
  modelsList.innerHTML = "";
  for (const [id, info] of models) {
    const row = document.createElement("div");
    row.className = "row mini";
    row.style.justifyContent = "space-between";
    row.innerHTML = `<span title="${id}">${info.name||id}</span>
      <span>
        <button class="btn btn-outline mini" data-act="fly" data-id="${id}">Voir</button>
        <button class="btn btn-outline mini" data-act="toggle" data-id="${id}">${info.model.visible?"Cacher":"Montrer"}</button>
      </span>`;
    modelsList.appendChild(row);
  }
  modelsList.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click",()=>{
      const id = b.dataset.id; const info = models.get(id); if(!info) return;
      if (b.dataset.act==="fly") viewer.cameraFlight.flyTo(info.model);
      else { info.model.visible = !info.model.visible; refreshModelsList(); }
    });
  });
}

const flyToAll = ()=> viewer.cameraFlight.flyTo(viewer.scene);

// ---------- Upload / Load ----------
fileInput?.addEventListener("change", (e)=>{
  const f = e.target.files?.[0];
  if (fileNameLbl) fileNameLbl.textContent = f ? f.name : "Aucun fichier sélectionné";
  // Auto-visualisation dès la sélection
  if (f) uploadAndShow();
});

async function loadXKT(xktUrl, nameHint){
  const id = "m"+Date.now();
  const model = xktLoader.load({ id, src: xktUrl, edges: !!chkEdges?.checked });
  setProgress(10);
  model.on("progress", p=> setProgress(10 + Math.round(p*80)));
  model.on("loaded", ()=>{
    setProgress(100); setTimeout(()=>setProgress(0),350);
    viewer.cameraFlight.flyTo(model);
    models.set(id, { model, name: nameHint||id, src: xktUrl });
    lastModelId = id;
    refreshModelsList();
  });
  model.on("error", e=>{ setProgress(0); console.error(e); alert("Erreur chargement XKT."); });
  return id;
}

async function uploadAndShow(){
  const f = fileInput?.files?.[0]; if(!f){ alert("Choisis un fichier .step/.stp/.stl"); return; }
  btnVisualiser && (btnVisualiser.disabled = true, btnVisualiser.textContent = "Conversion…");
  setProgress(8);
  try{
    const fd = new FormData(); fd.append("file", f);
    const res = await fetch("/upload", {method:"POST", body:fd});
    const json = await res.json();
    if (!res.ok || !json.xkt_url) throw new Error(JSON.stringify(json));
    const xktUrl = new URL(json.xkt_url, location.origin).toString();

    if (!chkAdditive?.checked){
      for (const [, info] of models){ try{ info.model.destroy(); }catch{} }
      models.clear(); selectedIds.clear();
    }
    await loadXKT(xktUrl, f.name);

    const dz = document.querySelector("[data-dropzone]");
    dz?.classList.remove("is-error");
    dz?.classList.add("is-success");
  }catch(e){
    console.error(e);
    const dz = document.querySelector("[data-dropzone]");
    dz?.classList.remove("is-success"); dz?.classList.add("is-error");
    alert("Erreur de conversion/chargement (voir Console).");
  }finally{
    btnVisualiser && (btnVisualiser.disabled = false, btnVisualiser.textContent = "VISUALISER");
  }
}
btnVisualiser?.addEventListener("click", (e)=>{ e.preventDefault(); uploadAndShow(); });

// ---------- Navigation & rendu ----------
btnFit?.addEventListener("click", flyToAll);

let proj="perspective";
btnProj?.addEventListener("click", ()=>{
  proj = (proj==="perspective") ? "ortho" : "perspective";
  viewer.camera.projection = proj;
  btnProj.textContent = proj==="perspective" ? "Perspective" : "Orthographique";
});

// Remap pan -> planView
(() => {
  if (!navMode) return;
  const opt = [...navMode.options].find(o=>o.value==="pan");
  if (opt){ opt.value="planView"; opt.textContent="Plan"; }
})();
const setNavMode = (m)=> viewer.cameraControl.navMode = (m==="pan" ? "planView" : m);
navMode?.addEventListener("change", ()=> setNavMode(navMode.value));
if (navMode) setNavMode(navMode.value);

chkEdges?.addEventListener("change", ()=> viewer.scene.edgeMaterial.edgesEnabled = !!chkEdges.checked);
chkXray?.addEventListener("change", ()=>{ setAllProp("xrayed", !!chkXray.checked); if (selectedIds.size) setIdsProp([...selectedIds], "xrayed", false); });
chkGhost?.addEventListener("change", ()=>{ setAllProp("ghosted", !!chkGhost.checked); if (selectedIds.size) setIdsProp([...selectedIds], "ghosted", false); });

// Thème sombre => uniquement le viewer
chkTheme?.addEventListener("change", ()=>{
  viewerContainer?.classList.toggle("dark", !!chkTheme.checked);
  viewer.scene.clearColor = chkTheme.checked ? [0.06,0.07,0.08] : [0.965,0.957,0.937];
});
opacityRange?.addEventListener("input", ()=> setAllProp("opacity", parseFloat(opacityRange.value)||1));

// ---------- Modes outillage ----------
btnMeasure?.addEventListener("click", ()=> setMode("measure"));
btnAnnot?.addEventListener("click",   ()=> setMode("annotate"));

let clippingOn=false;
btnClip?.addEventListener("click", ()=>{
  clippingOn=!clippingOn;
  btnClip.classList.toggle("btn-primary", clippingOn);
  if (!clippingOn){ if(onePlane){ onePlane.destroy(); onePlane=null; } return; }
  if (onePlane) onePlane.destroy();
  const center = viewer.scene?.aabbCenter || [0,0,0];
  onePlane = sections.createSectionPlane({ id:"cut", pos:center, dir:[0,1,0] });
  viewer.cameraFlight.flyTo(onePlane);
});

// ---------- Clic unique : route par mode actif ----------
viewer.scene.input.on("mouseclicked", (coords)=>{
  const hit = viewer.scene.pick({ canvasPos: [coords[0], coords[1]] });

  // Pas de hit : en mode SELECT on désélectionne, sinon on ignore
  if (!hit || !hit.entity) {
    if (appMode === "select") clearSelection();
    return;
  }

  if (appMode === "measure") {
    if (hit.worldPos) {
      // 2 clics = 1 mesure
      if (!viewer.__mPts) viewer.__mPts = [];
      viewer.__mPts.push(hit.worldPos);
      if (viewer.__mPts.length === 2) {
        measurements.createMeasurement({ positions: [viewer.__mPts[0], viewer.__mPts[1]] });
        viewer.__mPts = [];
      }
    }
    return; // on ne sélectionne pas en mode mesure
  }

  if (appMode === "annotate") {
    if (hit.worldPos) {
      annotations.createAnnotation({
        id: "a"+Date.now(),
        worldPos: hit.worldPos,
        occludable: true,
        label: "Note"
      });
    }
    return; // pas de sélection en mode annotation
  }

  // Mode SELECT
  const id = hit.entity.id;
  setIdsProp(allIds(), "highlighted", false);
  selectedIds = new Set([id]);
  setIdsProp([id], "highlighted", true);
  const meta = hit.entity.metaObject || hit.entity.meta;
  showProps(meta || { id });
});

// ---------- Iso / cacher / montrer ----------
btnIsolate?.addEventListener("click", ()=>{ if (!selectedIds.size) return; setAllProp("visible", false); setIdsProp([...selectedIds], "visible", true); });
btnHide?.addEventListener("click",    ()=>{ if (!selectedIds.size) return; setIdsProp([...selectedIds], "visible", false); });
btnShowOnly?.addEventListener("click",()=>{ if (!selectedIds.size) return; setAllProp("visible", false); setIdsProp([...selectedIds], "visible", true); });
btnClearSel?.addEventListener("click",()=>{ setAllProp("visible", true); setIdsProp(allIds(), "highlighted", false); clearSelection(); });

// ---------- Recherche ----------
btnSearch?.addEventListener("click", ()=>{
  const q = (searchInput?.value||"").toLowerCase().trim();
  if (!resultsBox) return;
  resultsBox.innerHTML=""; if (!q) return;
  const found = [];
  allIds().forEach(id=>{
    const o = viewer.scene.objects[id]; const m=o?.metaObject||{};
    const hay=[id,m.type,m.name,m.ifcType,m.displayName].join(" ").toLowerCase();
    if (hay.includes(q)) found.push({id,meta:m});
  });
  if (!found.length){ resultsBox.textContent="Aucun résultat"; return; }
  found.slice(0,200).forEach(({id,meta})=>{
    const div=document.createElement("div");
    div.className="row"; div.style.justifyContent="space-between";
    div.innerHTML=`<span>${meta?.name||meta?.displayName||meta?.type||id}</span>
                   <button class="btn btn-outline mini" data-id="${id}">Voir</button>`;
    resultsBox.appendChild(div);
  });
  resultsBox.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", ()=>{
      const id=b.dataset.id; const obj=viewer.scene.objects[id];
      if (obj){ viewer.cameraFlight.flyTo(obj); setIdsProp([id],"highlighted",true); }
    });
  });
});

// ---------- Reload / Unload ----------
btnReload?.addEventListener("click", ()=>{
  if (!lastModelId) return;
  const info=models.get(lastModelId); if(!info) return;
  try{ info.model.destroy(); }catch{}
  models.delete(lastModelId);
  loadXKT(info.src, info.name);
});
btnUnload?.addEventListener("click", ()=>{
  if (!lastModelId) return;
  const info=models.get(lastModelId); if(!info) return;
  try{ info.model.destroy(); }catch{}
  models.delete(lastModelId);
  lastModelId=[...models.keys()].pop()||null;
  refreshModelsList();
});

// ---------- Explode (sécurisé) ----------
explodeRange?.addEventListener("input", ()=>{
  if (!allIds().length) return;
  const k = parseFloat(explodeRange.value)||0;
  const c = viewer.scene?.aabbCenter || [0,0,0];
  allIds().forEach(id=>{
    const o = viewer.scene.objects[id]; if (!o) return;
    const p = o.aabbCenter || [0,0,0];
    const v = [p[0]-c[0], p[1]-c[1], p[2]-c[2]];
    const len = Math.hypot(v[0],v[1],v[2]) || 1;
    const off = [v[0]/len*k*10, v[1]/len*k*10, v[2]/len*k*10];
    if ("offset" in o) o.offset = off;
  });
});

// ---------- Screenshot ----------
btnShot?.addEventListener("click", ()=>{
  try{
    const canvas = document.getElementById("xeokit-canvas");
    const dataURL = canvas.toDataURL("image/png");
    const a=document.createElement("a"); a.href=dataURL; a.download="cadlytics_view.png"; a.click();
  }catch(e){ console.error(e); alert("Capture impossible."); }
});

// ---------- Drag & drop ----------
const dz = document.querySelector("[data-dropzone]");
if (dz){
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev, e=>{ e.preventDefault(); dz.classList.add("is-ready"); }));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev, e=>{ e.preventDefault(); dz.classList.remove("is-ready"); }));
  dz.addEventListener("drop", e=>{
    const f = e.dataTransfer?.files?.[0];
    if (f){
      const dt=new DataTransfer(); dt.items.add(f);
      if (fileInput) fileInput.files=dt.files;
      if (fileNameLbl) fileNameLbl.textContent=f.name;
      dz.classList.add("is-ready");
      uploadAndShow(); // auto-visualisation aussi en DnD
    }
  });
}
