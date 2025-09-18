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

// ---- UI refs
const fileInput     = $("#fileInput");
const btnPick       = $("#btnPick");
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

// ---- Viewer & plugins
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  transparent: true,
  dtxEnabled: true
});

new FastNavPlugin(viewer, { flyToDuration: 0.9 });

// ✅ NavCube: on crée un canvas dédié (sinon erreur “valid canvasId or canvasElement”)
(() => {
  try {
    const cont = document.getElementById("viewerContainer");
    const cube = document.createElement("canvas");
    cube.width = cube.height = 140;
    cube.style.position = "absolute";
    cube.style.left = "10px";
    cube.style.top = "10px";
    cube.style.zIndex = "5";
    cube.style.pointerEvents = "auto";
    cont.appendChild(cube);

    new NavCubePlugin(viewer, {
      canvasElement: cube,
      cameraFlyToDuration: 0.9
    });
  } catch (e) {
    console.warn("NavCube init skipped:", e);
  }
})();

const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});

const sections     = new SectionPlanesPlugin(viewer, {});
const measurements = new DistanceMeasurementsPlugin(viewer, { defaultDistancePrecision: 2 });
const annotations  = new AnnotationsPlugin(viewer, {
  markerHTML: "<div style='width:10px;height:10px;border-radius:999px;background:#ef4444;border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.2)'></div>"
});

// ---- State
const models = new Map();   // id -> {model, name}
let lastModelId = null;
let selectedIds = new Set();
let oneSectionPlane = null;

// ---- Utils
const setProgress = (p) => progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`;
const toast = (m) => console.log(m);
const allIds = () => viewer.scene.objectIds ?? [];

function setIdsProp(ids, prop, val){
  ids.forEach(id => { const o = viewer.scene.objects[id]; if (o) o[prop] = val; });
}
function setAllProp(prop, val){
  allIds().forEach(id => { const o = viewer.scene.objects[id]; if (o) o[prop] = val; });
}
function refreshModelsList(){
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
function clearSelection(){
  if (!selectedIds.size) return;
  setIdsProp([...selectedIds], "highlighted", false);
  setIdsProp([...selectedIds], "xrayed", false);
  setIdsProp([...selectedIds], "ghosted", false);
  selectedIds.clear();
}
function showProps(meta){
  propsPanel.innerHTML = "";
  if (!meta) return;
  const add = (k,v)=>{ const a=document.createElement("div");a.textContent=k;
                       const b=document.createElement("div");b.textContent=String(v);
                       propsPanel.append(a,b); };
  const base = { id: meta.id, type: meta.type||meta.ifcType||"", name: meta.name||meta.displayName||"" };
  Object.entries(base).forEach(([k,v])=> v!==undefined && v!=="" && add(k,v));
  const psets = meta.properties||meta.props;
  if (psets && typeof psets==="object")
    Object.entries(psets).forEach(([k,v])=> add(k, typeof v==="object"? JSON.stringify(v): v));
}
const flyToAll = ()=> viewer.cameraFlight.flyTo(viewer.scene);

// ---- Upload / Load
btnPick.addEventListener("click", ()=> fileInput.click());
fileInput.addEventListener("change", e=>{
  const f = e.target.files?.[0];
  fileNameLbl.textContent = f ? f.name : "Aucun fichier sélectionné";
  const dz = document.querySelector("[data-dropzone]");
  if (f){ dz?.classList.remove("is-error","is-success"); dz?.classList.add("is-ready"); }
});

async function loadXKT(xktUrl, nameHint){
  const id = "m"+Date.now();
  const model = xktLoader.load({ id, src: xktUrl, edges: chkEdges.checked });
  setProgress(10);
  model.on("progress", p=> setProgress(10 + Math.round(p*80)));
  model.on("loaded", ()=>{
    setProgress(100); setTimeout(()=>setProgress(0),350);
    viewer.cameraFlight.flyTo(model);
    models.set(id, { model, name: nameHint||id }); lastModelId=id;
    refreshModelsList();
  });
  model.on("error", e=>{ setProgress(0); console.error(e); alert("Erreur chargement XKT."); });
  return id;
}

async function uploadAndShow(){
  const f = fileInput.files?.[0]; if(!f){ alert("Choisis un fichier .step/.stp/.stl"); return; }
  btnVisualiser.disabled = true; btnVisualiser.textContent = "Conversion…"; setProgress(8);
  try{
    const fd = new FormData(); fd.append("file", f);
    const res = await fetch("/upload", {method:"POST", body:fd});
    const json = await res.json();
    if (!res.ok || !json.xkt_url) throw new Error(JSON.stringify(json));
    const xktUrl = new URL(json.xkt_url, location.origin).toString();

    if (!chkAdditive.checked){
      for (const [id, info] of models){ try{ info.model.destroy(); }catch{} }
      models.clear(); selectedIds.clear();
    }
    await loadXKT(xktUrl, f.name);
    const dz = document.querySelector("[data-dropzone]");
    dz?.classList.remove("is-ready"); dz?.classList.add("is-success");
  }catch(e){
    console.error(e);
    const dz = document.querySelector("[data-dropzone]");
    dz?.classList.remove("is-ready"); dz?.classList.add("is-error");
    alert("Erreur de conversion/chargement (voir Console).");
  }finally{
    btnVisualiser.disabled = false; btnVisualiser.textContent = "Visualiser";
  }
}
btnVisualiser.addEventListener("click", e=>{ e.preventDefault(); uploadAndShow(); });

// ---- Navigation & caméra
btnFit.addEventListener("click", flyToAll);

let proj="perspective";
btnProj.addEventListener("click", ()=>{
  proj = (proj==="perspective") ? "ortho" : "perspective";
  viewer.camera.projection = proj;
  btnProj.textContent = proj==="perspective" ? "Perspective" : "Orthographique";
});

// Remap 'pan' -> 'planView' (sinon erreur SDK)
(() => {
  const opt = [...navMode.options].find(o=>o.value==="pan");
  if (opt){ opt.value="planView"; opt.textContent="Plan"; }
})();
const setNavMode = (m)=> viewer.cameraControl.navMode = (m==="pan" ? "planView" : m);
navMode.addEventListener("change", ()=> setNavMode(navMode.value));
setNavMode(navMode.value);

// ---- Rendu / apparence
chkEdges.addEventListener("change", ()=> viewer.scene.edgeMaterial.edgesEnabled = chkEdges.checked);

chkXray.addEventListener("change", ()=>{
  setAllProp("xrayed", chkXray.checked);
  if (selectedIds.size) setIdsProp([...selectedIds], "xrayed", false);
});
chkGhost.addEventListener("change", ()=>{
  setAllProp("ghosted", chkGhost.checked);
  if (selectedIds.size) setIdsProp([...selectedIds], "ghosted", false);
});
opacityRange.addEventListener("input", ()=>{
  const a = parseFloat(opacityRange.value);
  setAllProp("opacity", a);
});
chkTheme.addEventListener("change", ()=>{
  document.documentElement.classList.toggle("theme-dark", chkTheme.checked);
  viewer.scene.clearColor = chkTheme.checked ? [0.09,0.1,0.09] : [0.965,0.957,0.937];
});

// ---- Sélection au clic (PAS de hover highlight)
viewer.scene.input.on("mouseclicked", (coords)=>{
  const hit = viewer.scene.pick({ canvasPos: [coords[0], coords[1]] });
  if (!hit || !hit.entity) return;
  const id = hit.entity.id;

  // reset + highlight
  setIdsProp(allIds(), "highlighted", false);
  selectedIds = new Set([id]);
  setIdsProp([id], "highlighted", true);

  const meta = hit.entity.metaObject || hit.entity.meta;
  showProps(meta || { id });
});

// ---- Isoler / cacher / montrer
btnIsolate.addEventListener("click", ()=>{
  if (!selectedIds.size){ toast("Sélectionne un objet"); return; }
  setAllProp("visible", false);
  setIdsProp([...selectedIds], "visible", true);
});
btnHide.addEventListener("click", ()=>{
  if (!selectedIds.size){ toast("Sélectionne un objet"); return; }
  setIdsProp([...selectedIds], "visible", false);
});
btnShowOnly.addEventListener("click", ()=>{
  if (!selectedIds.size){ toast("Sélectionne un objet"); return; }
  setAllProp("visible", false);
  setIdsProp([...selectedIds], "visible", true);
});
btnClearSel.addEventListener("click", ()=>{
  setAllProp("visible", true);
  setIdsProp(allIds(), "highlighted", false);
  selectedIds.clear(); propsPanel.innerHTML="";
});

// ---- Recherche simple
btnSearch.addEventListener("click", ()=>{
  const q = (searchInput.value||"").toLowerCase().trim();
  resultsBox.innerHTML=""; if (!q) return;
  const found = [];
  allIds().forEach(id=>{
    const obj = viewer.scene.objects[id];
    const m = obj?.metaObject || {};
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
      const id=b.dataset.id;
      const obj = viewer.scene.objects[id];
      if (obj) { viewer.cameraFlight.flyTo(obj); setIdsProp([id],"highlighted", true); }
    });
  });
});

// ---- Recharger / Décharger
btnReload.addEventListener("click", ()=>{
  if (!lastModelId) return;
  const info=models.get(lastModelId); if(!info) return;
  const src=info.model.src;
  try{ info.model.destroy(); }catch{}
  models.delete(lastModelId);
  loadXKT(src, info.name);
});
btnUnload.addEventListener("click", ()=>{
  if (!lastModelId) return;
  const info=models.get(lastModelId); if(!info) return;
  try{ info.model.destroy(); }catch{}
  models.delete(lastModelId);
  lastModelId=[...models.keys()].pop()||null;
  refreshModelsList();
});

// ---- MESURE (2 clics)
let measureMode=false, measurePts=[];
btnMeasure.addEventListener("click", ()=>{
  measureMode=!measureMode;
  btnMeasure.classList.toggle("btn-primary", measureMode);
  measurePts.length=0;
});
viewer.scene.input.on("mouseclicked", (coords)=>{
  if (!measureMode) return;
  const hit = viewer.scene.pick({canvasPos:[coords[0],coords[1]]});
  if (!hit || !hit.worldPos) return;
  measurePts.push(hit.worldPos);
  if (measurePts.length===2){
    try{ measurements.createMeasurement({ positions:[measurePts[0], measurePts[1]] }); }
    catch(e){ console.error(e); alert("Mesure indisponible"); }
    measurePts.length=0;
  }
});

// ---- ANNOTATION (1 clic)
let annotMode=false;
btnAnnot.addEventListener("click", ()=>{
  annotMode=!annotMode;
  btnAnnot.classList.toggle("btn-primary", annotMode);
});
viewer.scene.input.on("mouseclicked", (coords)=>{
  if (!annotMode) return;
  const hit = viewer.scene.pick({canvasPos:[coords[0],coords[1]]});
  if (!hit || !hit.worldPos) return;
  annotations.createAnnotation({ id:"a"+Date.now(), worldPos:hit.worldPos, occludable:true, label:"Note" });
});

// ---- COUPE (toggle)
let clippingOn=false;
btnClip.addEventListener("click", ()=>{
  clippingOn=!clippingOn;
  btnClip.classList.toggle("btn-primary", clippingOn);
  if (!clippingOn){ if(oneSectionPlane){ oneSectionPlane.destroy(); oneSectionPlane=null; } return; }
  if (oneSectionPlane) oneSectionPlane.destroy();
  const center = viewer.scene.aabbCenter || [0,0,0];
  oneSectionPlane = sections.createSectionPlane({ id:"cut", pos:center, dir:[0,1,0] });
  viewer.cameraFlight.flyTo(oneSectionPlane);
});

// ---- EXPLODE (naïf)
explodeRange.addEventListener("input", ()=>{
  const k = parseFloat(explodeRange.value);
  const c = viewer.scene.aabbCenter;
  allIds().forEach(id=>{
    const o = viewer.scene.objects[id]; if (!o) return;
    const p = o.aabbCenter || [0,0,0];
    const v = [p[0]-c[0], p[1]-c[1], p[2]-c[2]];
    const len = Math.hypot(...v)||1;
    const off = [v[0]/len*k*10, v[1]/len*k*10, v[2]/len*k*10];
    if ("offset" in o) o.offset = off;
  });
});

// ---- SCREENSHOT (canvas direct)
btnShot.addEventListener("click", ()=>{
  try{
    const canvas = document.getElementById("xeokit-canvas");
    const dataURL = canvas.toDataURL("image/png");
    const a = document.createElement("a"); a.href=dataURL; a.download="cadlytics_view.png"; a.click();
  }catch(e){ console.error(e); alert("Capture impossible."); }
});

// ---- Drag & drop
const dz = document.querySelector("[data-dropzone]");
if (dz){
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev, e=>{ e.preventDefault(); dz.classList.add("is-ready"); }));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev, e=>{ e.preventDefault(); dz.classList.remove("is-ready"); }));
  dz.addEventListener("drop", e=>{
    const f = e.dataTransfer?.files?.[0];
    if (f){
      const dt=new DataTransfer(); dt.items.add(f); fileInput.files=dt.files;
      fileNameLbl.textContent=f.name; dz.classList.add("is-ready");
    }
  });
}
