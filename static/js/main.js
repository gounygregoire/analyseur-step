import {
  Viewer,
  XKTLoaderPlugin,
  NavCubePlugin,
  FastNavPlugin,
  SectionPlanesPlugin,
  AnnotationsPlugin
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
const canvasEl = document.getElementById("xeokit-canvas");

const fast = new FastNavPlugin(viewer, {
  flyToDuration: 0.9,
  autoHideEdges: false,
  hideEdges: false
});

const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});

const sections    = new SectionPlanesPlugin(viewer, {});
const annotations = new AnnotationsPlugin(viewer, {
  markerHTML:
    "<div style='width:10px;height:10px;border-radius:999px;background:#ef4444;border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.2)'></div>"
});

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

// ---------- Overlay de mesure (canvas 2D) ----------
const overlay = document.createElement("canvas");
const octx    = overlay.getContext("2d");
Object.assign(overlay.style, {
  position:"absolute", inset:"0", pointerEvents:"none", zIndex:"4"
});
viewerContainer.appendChild(overlay);

function resizeOverlay(){
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = viewerContainer.getBoundingClientRect();
  overlay.width  = Math.round(rect.width * dpr);
  overlay.height = Math.round(rect.height * dpr);
  overlay.style.width  = rect.width + "px";
  overlay.style.height = rect.height + "px";
}
resizeOverlay();
new ResizeObserver(resizeOverlay).observe(viewerContainer);

// util projete (world->pixels overlay)
function worldToOverlay(p){
  const ndc = viewer.camera.project(p, []);
  if (!ndc) return null;
  // NDC -> pixels overlay
  const x = (ndc[0] * 0.5 + 0.5) * overlay.width;
  const y = (1 - (ndc[1] * 0.5 + 0.5)) * overlay.height;
  return [x,y];
}

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

// ---------- OUTILS ----------
let toolMode = "none"; // "none" | "measure" | "annot" | "clip"
let measurePts = [];   // 0..2 world positions
let clipPlane  = null; // SectionPlane

function setToolMode(next){
  toolMode = (toolMode===next) ? "none" : next;
  btnMeasure?.classList.toggle("btn-primary", toolMode==="measure");
  btnAnnot?.classList.toggle("btn-primary",   toolMode==="annot");
  btnClip?.classList.toggle("btn-primary",    toolMode==="clip");
  if (canvasEl) canvasEl.style.cursor =
    (toolMode==="measure"||toolMode==="annot"||toolMode==="clip") ? "crosshair" : "";

  if (toolMode!=="measure") measurePts = [];

  if (toolMode!=="clip"){
    viewer.scene.sectionPlanesEnabled = false;
    if (clipPlane){ clipPlane.destroy(); clipPlane=null; }
  } else {
    if (!clipPlane){
      const c = viewer.scene?.aabbCenter || [0,0,0];
      clipPlane = sections.createSectionPlane({ id:"cut", pos:c, dir:[0,1,0] });
    }
    viewer.scene.sectionPlanesEnabled = true;
  }
}
btnMeasure?.addEventListener("click", ()=> setToolMode("measure"));
btnAnnot?.addEventListener("click",   ()=> setToolMode("annot"));
btnClip?.addEventListener("click",    ()=> setToolMode("clip"));

// Déplacement du plan à la molette / X Y Z pour l’axe
window.addEventListener("wheel", (e)=>{
  if (toolMode!=="clip" || !clipPlane) return;
  e.preventDefault();
  const step = (e.deltaY>0 ? 1 : -1) * 0.02;
  const d = clipPlane.dir, p = clipPlane.pos;
  clipPlane.pos = [p[0]+d[0]*step, p[1]+d[1]*step, p[2]+d[2]*step];
}, { passive:false });
window.addEventListener("keydown", (e)=>{
  if (toolMode!=="clip" || !clipPlane) return;
  if (e.key==="x"||e.key==="X") clipPlane.dir = [1,0,0];
  if (e.key==="y"||e.key==="Y") clipPlane.dir = [0,1,0];
  if (e.key==="z"||e.key==="Z") clipPlane.dir = [0,0,1];
});

// ---------- Mesures custom (sans plugin instable) ----------
const measures = []; // { p1,p2, labelId, endAId, endBId, color }
function formatDist(d){
  // heuristique: si >1 => m, sinon => mm
  if (d >= 1)  return d.toFixed(3) + " m";
  return (d*1000).toFixed(1) + " mm";
}
function addMeasurement(p1, p2){
  const mid = [(p1[0]+p2[0])/2,(p1[1]+p2[1])/2,(p1[2]+p2[2])/2];
  const d = Math.hypot(p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]);

  const endAId = "mEndA_"+Date.now();
  const endBId = "mEndB_"+(Date.now()+1);
  const labelId= "mLbl_"+(Date.now()+2);

  annotations.createAnnotation({ id:endAId, worldPos:p1, label:"" });
  annotations.createAnnotation({ id:endBId, worldPos:p2, label:"" });
  annotations.createAnnotation({ id:labelId, worldPos:mid, label:formatDist(d) });

  measures.push({ p1:[...p1], p2:[...p2], labelId, endAId, endBId, color:"#22d3ee" });
  redrawOverlay(); // dessine tout de suite
}

function redrawOverlay(){
  const dpr = Math.max(1, window.devicePixelRatio||1);
  octx.setTransform(1,0,0,1,0,0);
  octx.clearRect(0,0, overlay.width, overlay.height);
  octx.lineWidth = 2 * dpr;
  octx.strokeStyle = "#22d3ee";
  measures.forEach(m=>{
    const a = worldToOverlay(m.p1);
    const b = worldToOverlay(m.p2);
    if (!a || !b) return;
    octx.beginPath();
    octx.moveTo(a[0], a[1]);
    octx.lineTo(b[0], b[1]);
    octx.stroke();
  });
}
viewer.scene.on("tick", redrawOverlay);

// ---------- Clic unique : route selon l’outil actif ----------
viewer.scene.input.on("mouseclicked", (coords)=>{
  const hit = viewer.scene.pick({ canvasPos: [coords[0], coords[1]], pickSurface: true });

  // Mesure : 2 clics -> ajout
  if (toolMode==="measure"){
    if (hit && hit.worldPos){
      measurePts.push(hit.worldPos);
      if (measurePts.length===2){
        addMeasurement(measurePts[0], measurePts[1]);
        measurePts = [];
      }
    }
    return;
  }

  // Annotation : 1 clic = 1 note
  if (toolMode==="annot"){
    if (hit && hit.worldPos){
      annotations.createAnnotation({
        id: "a"+Date.now(),
        worldPos: hit.worldPos,
        label: "Note"
      });
    }
    return;
  }

  // Coupe : clic repositionne le plan
  if (toolMode==="clip"){
    if (hit && hit.worldPos && clipPlane){
      clipPlane.pos = hit.worldPos.slice();
    }
    return;
  }

  // SELECT (aucun outil)
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
    const dataURL = canvasEl.toDataURL("image/png");
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
