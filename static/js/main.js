import {
  Viewer,
  XKTLoaderPlugin,
  NavCubePlugin,
  FastNavPlugin,
  SectionPlanesPlugin,
  SectionPlanesMouseControl,
  DistanceMeasurementsPlugin,
  DistanceMeasurementsMouseControl,
  AnnotationsPlugin,
  AnnotationsMouseControl
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

const $ = (s) => document.querySelector(s);

// ---------- UI refs ----------
const fileInput     = $("#fileInput");
const btnVisualiser = $("#btnVisualiser");
const btnChoose     = $("#btnChoose");
const chkAdditive   = $("#chkAdditive");
const fileNameLbl   = $("#fileName");

const viewerContainer = $("#viewerContainer");
const btnFit   = $("#btnFit");
const btnProj  = $("#btnProj");
const navMode  = $("#navMode");
const chkEdges = $("#chkEdges");
const chkXray  = $("#chkXray");
const chkGhost = $("#chkGhost");
const chkTheme = $("#chkTheme");

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

// ---------- Viewer & plugins ----------
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  transparent: true,
  dtxEnabled: true
});

const fast = new FastNavPlugin(viewer, {
  flyToDuration: 0.9,
  autoHideEdges: false,
  hideEdges: false
});

const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});

// Coupe
const sections   = new SectionPlanesPlugin(viewer, {});
const secCtl     = new SectionPlanesMouseControl(sections);
secCtl.active    = false;

// Mesure
const measurements = new DistanceMeasurementsPlugin(viewer, { defaultDistancePrecision: 2 });
const measureCtl   = new DistanceMeasurementsMouseControl(measurements, {
  // quelques options utiles si disponibles dans ta build :
  // snapToEdge: true,
  // snapToVertex: true
});
measureCtl.active  = false;

// Annotations
const annotations = new AnnotationsPlugin(viewer, {
  markerHTML:
    "<div style='width:10px;height:10px;border-radius:999px;background:#ef4444;border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.2)'></div>"
});
const annotCtl   = new AnnotationsMouseControl(annotations);
annotCtl.active  = false;

// ---------- Axe/cube ----------
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

const setProgress = (p)=>
  progressBar && (progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`);

const allIds = ()=> viewer.scene?.objectIds ?? [];
function setIdsProp(ids, prop, val){ ids.forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; }); }
function setAllProp(prop,val){ allIds().forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; }); }
function clearSelection(){ setIdsProp([...selectedIds],"highlighted",false); selectedIds.clear(); propsPanel && (propsPanel.innerHTML=""); }

function showProps(meta){
  if (!propsPanel) return;
  propsPanel.innerHTML = "";
  if (!meta) return;
  const add=(k,v)=>{const a=document.createElement("div");a.textContent=k;
                    const b=document.createElement("div");b.textContent=String(v);
                    propsPanel.append(a,b);};
  const base={ id:meta.id, type:meta.type||meta.ifcType||"", name:meta.name||meta.displayName||"" };
  Object.entries(base).forEach(([k,v])=> (v!==undefined && v!=="") && add(k,v));
  const p=meta.properties||meta.props;
  if (p && typeof p==="object")
    Object.entries(p).forEach(([k,v])=> add(k, typeof v==="object"? JSON.stringify(v): v));
}

function refreshModelsList(){
  const list = modelsList;
  if (!list) return;
  list.innerHTML = "";
  for (const [id, info] of models) {
    const row = document.createElement("div");
    row.className = "row mini";
    row.style.justifyContent = "space-between";
    row.innerHTML = `<span title="${id}">${info.name||id}</span>
      <span>
        <button class="btn btn-outline mini" data-act="fly" data-id="${id}">Voir</button>
        <button class="btn btn-outline mini" data-act="toggle" data-id="${id}">${info.model.visible?"Cacher":"Montrer"}</button>
      </span>`;
    list.appendChild(row);
  }
  list.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click",()=>{
      const id = b.dataset.id; const info = models.get(id); if(!info) return;
      if (b.dataset.act==="fly") viewer.cameraFlight.flyTo(info.model);
      else { info.model.visible=!info.model.visible; refreshModelsList(); }
    });
  });
}
const flyToAll = ()=> viewer.cameraFlight.flyTo(viewer.scene);

// ---------- Chargements ----------
async function loadXKT(xktUrl, nameHint){
  const id = "m"+Date.now();
  const model = xktLoader.load({
    id,
    src: xktUrl,
    edges: !!chkEdges?.checked
  });
  setProgress(10);
  model.on("progress", p=> setProgress(10 + Math.round(p*80)));
  model.on("loaded", ()=>{
    setProgress(100); setTimeout(()=>setProgress(0),350);
    viewer.cameraFlight.flyTo(model);
    models.set(id, { model, name: nameHint||id, src: xktUrl });
    lastModelId=id; refreshModelsList();
    if (chkEdges?.checked) setEdges(true);
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

    if (!chkAdditive?.checked){ for (const [,i] of models){ try{i.model.destroy();}catch{} } models.clear(); selectedIds.clear(); }
    await loadXKT(xktUrl, f.name);

    document.querySelector("[data-dropzone]")?.classList.add("is-success");
  }catch(e){
    console.error(e);
    const dz=document.querySelector("[data-dropzone]"); dz?.classList.remove("is-success"); dz?.classList.add("is-error");
    alert("Erreur de conversion/chargement (voir Console).");
  }finally{
    btnVisualiser && (btnVisualiser.disabled = false, btnVisualiser.textContent = "VISUALISER");
  }
}

// Fichier → ouvrir / auto-visualiser
btnChoose?.addEventListener("click", (e)=>{ e.preventDefault(); fileInput?.click(); });
fileInput?.addEventListener("change", ()=>{
  const f=fileInput.files?.[0]; if (f && fileNameLbl) fileNameLbl.textContent=f.name;
  if (f) uploadAndShow();
});
btnVisualiser?.addEventListener("click", (e)=>{ e.preventDefault(); uploadAndShow(); });

// ---------- Navigation & rendu ----------
btnFit?.addEventListener("click", flyToAll);

let proj="perspective";
btnProj?.addEventListener("click", ()=>{
  proj = (proj==="perspective") ? "ortho" : "perspective";
  viewer.camera.projection = proj;
  btnProj.textContent = proj==="perspective" ? "Perspective" : "Orthographique";
});

// Pan => Plan
(() => {
  if (!navMode) return;
  const opt = [...navMode.options].find(o=>o.value==="pan");
  if (opt){ opt.value="planView"; opt.textContent="Plan"; }
})();
const setNavMode = (m)=> viewer.cameraControl.navMode = (m==="pan" ? "planView" : m);
navMode?.addEventListener("change", ()=> setNavMode(navMode.value));
if (navMode) setNavMode(navMode.value);

// Arêtes (global + par mesh + verrouillage)
function setEdges(on) {
  viewer.scene.edgeMaterial.edgesEnabled = !!on;
  const ids = viewer.scene.objectIds || [];
  ids.forEach(id => {
    const o = viewer.scene.objects[id];
    if (o) {
      if ("edges" in o) o.edges = !!on;
      if (o.mesh && ("edges" in o.mesh)) o.mesh.edges = !!on;
    }
  });
  for (const [, info] of models) {
    if ("edges" in info.model) info.model.edges = !!on;
  }
}
chkEdges?.addEventListener("change", ()=> setEdges(!!chkEdges.checked));
viewer.scene.on("tick", ()=>{
  if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) {
    viewer.scene.edgeMaterial.edgesEnabled = true;
  }
});

// X-ray / Ghost / Thème / Opacité
chkXray?.addEventListener("change", ()=>{
  setAllProp("xrayed", !!chkXray.checked);
  if (selectedIds.size) setIdsProp([...selectedIds], "xrayed", false);
});
chkGhost?.addEventListener("change", ()=>{
  setAllProp("ghosted", !!chkGhost.checked);
  if (selectedIds.size) setIdsProp([...selectedIds], "ghosted", false);
});
chkTheme?.addEventListener("change", ()=>{
  viewerContainer?.classList.toggle("dark", !!chkTheme.checked);
  viewer.scene.clearColor = chkTheme.checked ? [0.06,0.07,0.08] : [0.965,0.957,0.937];
});
opacityRange?.addEventListener("input", ()=> setAllProp("opacity", parseFloat(opacityRange.value)||1));

// ---------- Outils (modes) ----------
function setToolMode(mode){ // "none" | "measure" | "annot" | "clip"
  // reset boutons
  btnMeasure?.classList.toggle("btn-primary", mode==="measure");
  btnAnnot?.classList.toggle("btn-primary",   mode==="annot");
  btnClip?.classList.toggle("btn-primary",    mode==="clip");

  // activer/désactiver contrôleurs
  measureCtl.active = (mode==="measure");
  annotCtl.active   = (mode==="annot");
  secCtl.active     = (mode==="clip");

  // plans actifs seulement en mode coupe
  viewer.scene.sectionPlanesEnabled = (mode==="clip");

  // curseur
  viewer.canvas.style.cursor = (mode==="measure"||mode==="annot"||mode==="clip") ? "crosshair" : "";
}

btnMeasure?.addEventListener("click", ()=>{
  const next = measureCtl.active ? "none" : "measure";
  setToolMode(next);
});
btnAnnot?.addEventListener("click", ()=>{
  const next = annotCtl.active ? "none" : "annot";
  setToolMode(next);
});
btnClip?.addEventListener("click", ()=>{
  const next = secCtl.active ? "none" : "clip";
  if (next==="none"){ sections.clear(); } // retire toutes les coupes
  setToolMode(next);
});

// ---------- Sélection simple (uniquement hors outils actifs) ----------
viewer.scene.input.on("mouseclicked", (coords)=>{
  if (measureCtl.active || annotCtl.active || secCtl.active) return;
  const hit = viewer.scene.pick({ canvasPos: [coords[0], coords[1]], pickSurface: true });
  if (!hit || !hit.entity) { clearSelection(); return; }
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
    const o=viewer.scene.objects[id]; const m=o?.metaObject||{};
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

// ---------- Explode ----------
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
      uploadAndShow();
    }
  });
}
