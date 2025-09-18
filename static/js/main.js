import {
  Viewer,
  XKTLoaderPlugin,
  NavCubePlugin,
  FastNavPlugin,
  SectionPlanesPlugin,
  AnnotationsPlugin
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

const $ = (s) => document.querySelector(s);

/* ====== UI refs (inchangé) ====== */
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

/* ====== Viewer/Plugins ====== */
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  transparent: true,
  dtxEnabled: true
});
const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});
const fast = new FastNavPlugin(viewer, {
  flyToDuration: 0.9,
  autoHideEdges: false,
  hideEdges: false
});
const sections = new SectionPlanesPlugin(viewer, {});
const ann = new AnnotationsPlugin(viewer, {
  container: viewerContainer // ancre les overlays au conteneur du canvas
});

/* ====== Style (injection) ====== */
{
  const css = `
  .anno-dot{width:10px;height:10px;border-radius:999px;border:2px solid #fff;
            box-shadow:0 0 0 2px rgba(0,0,0,.2)}
  .anno-dot.red{background:#ef4444}.anno-dot.blue{background:#3b82f6}
  .anno-bubble{padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.6);
               color:#fff;font:12px/1.2 Inter,system-ui,Segoe UI,Roboto,Arial;
               box-shadow:0 6px 20px rgba(0,0,0,.25)}
  .plane-hint{width:140px;height:140px;border-radius:8px;
              background:rgba(0,153,255,.16);border:1px dashed rgba(0,153,255,.6)}
  .plane-x{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.7)}
  .plane-y{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.7)}
  .plane-z{background:rgba(96,165,250,.16);border-color:rgba(96,165,250,.7)}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/* ====== HUD (Mesures + Coupe) ====== */
const hud = document.createElement("div");
Object.assign(hud.style, {
  position: "absolute",
  right: "12px",
  top: "12px",
  zIndex: 6,
  display: "grid",
  gap: "8px",
  maxWidth: "260px"
});
viewerContainer.appendChild(hud);

const measurePanel = document.createElement("div");
measurePanel.innerHTML = "<strong style='color:#fff'>Mesures</strong>";
Object.assign(measurePanel.style, {
  background: "rgba(0,0,0,.45)",
  color: "#fff",
  borderRadius: "10px",
  padding: "8px 10px",
  font: "12px/1.35 Inter,system-ui,Segoe UI,Roboto,Arial"
});
const measureList = document.createElement("div");
measurePanel.appendChild(measureList);
hud.appendChild(measurePanel);

const clipPanel = document.createElement("div");
clipPanel.innerHTML = `
  <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
    <strong style="color:#fff">Coupe</strong>
    <button data-axis="x" class="clipBtn">X</button>
    <button data-axis="y" class="clipBtn">Y</button>
    <button data-axis="z" class="clipBtn">Z</button>
  </div>
  <input type="range" min="-100" max="100" value="0" id="clipRange" disabled />
`;
Object.assign(clipPanel.style, {
  background: "rgba(15,15,20,.55)",
  color: "#fff",
  borderRadius: "10px",
  padding: "8px 10px",
  font: "12px/1.35 Inter,system-ui,Segoe UI,Roboto,Arial",
  display: "none"
});
hud.appendChild(clipPanel);

clipPanel.querySelectorAll(".clipBtn").forEach(b=>{
  Object.assign(b.style,{
    border:"1px solid rgba(255,255,255,.5)",
    background:"transparent",
    color:"#fff",
    borderRadius:"8px",
    padding:"4px 8px",
    cursor:"pointer"
  });
});
const clipRange = clipPanel.querySelector("#clipRange");

/* ====== Axes (cube + légende) ====== */
(() => {
  const cube = document.createElement("canvas");
  cube.width = cube.height = 96;
  Object.assign(cube.style, {
    position: "absolute", left: "12px", top: "12px", zIndex: 5,
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
    position: "absolute", left: "12px", top: "114px", zIndex: 6,
    font: "12px/1 Inter,system-ui,Segoe UI,Roboto,Arial",
    padding: "4px 8px", background: "rgba(0,0,0,.35)", color: "#fff",
    borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,.2)"
  });
  viewerContainer.appendChild(legend);
})();

/* ====== Etat/Helpers ====== */
const models = new Map();
let lastModelId = null;
let selectedIds = new Set();

const allIds = ()=> viewer.scene?.objectIds ?? [];
const setAll  = (prop,val)=> allIds().forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; });
const setSome = (ids,prop,val)=> ids.forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; });

function setProgress(p){ if(progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; }
function clearSelection(){ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); propsPanel&&(propsPanel.innerHTML=""); }

const aabb = ()=> viewer.scene.aabb && viewer.scene.aabb.length===6
  ? viewer.scene.aabb : [-1,-1,-1,1,1,1];

/* ====== Modes ====== */
let mode = "none";
function setMode(m){
  mode = (mode===m) ? "none" : m;
  btnMeasure?.classList.toggle("btn-primary", mode==="measure");
  btnAnnot?.classList.toggle("btn-primary",   mode==="annot");
  btnClip?.classList.toggle("btn-primary",    mode==="clip");
  viewerContainer.style.cursor = (mode==="measure"||mode==="annot"||mode==="clip")? "crosshair":"";
  clipPanel.style.display = mode==="clip" ? "block" : "none";
  if (mode!=="clip"){ disableClipping(); }
}
window.addEventListener("keydown",(e)=>{ if (e.key==="Escape") setMode("none"); });

/* ====== Annotations util ====== */
const annoRefs = new Set(); // pour pouvoir nettoyer facilement

function createDot(worldPos, color="red"){
  const a = ann.createAnnotation({
    worldPos,
    occludable: true,
    markerHTML: `<div class="anno-dot ${color}"></div>`
  });
  annoRefs.add(a);
  return a;
}
function createBubble(worldPos, text){
  const a = ann.createAnnotation({
    worldPos,
    occludable: true,
    markerHTML: `<div class="anno-bubble">${text}</div>`
  });
  annoRefs.add(a);
  return a;
}
function createPlaneHint(worldPos, axis){ // axis: x|y|z
  const a = ann.createAnnotation({
    worldPos,
    occludable: false,
    markerHTML: `<div class="plane-hint plane-${axis}"></div>`
  });
  annoRefs.add(a);
  return a;
}
function clearMeasureAnnotations(){
  [...annoRefs].forEach(a=>{
    // on ne supprime que dots et bulles (pas les éventuelles autres annots de l’utilisateur)
    const m = a.markerElement?.querySelector?.(".anno-dot, .anno-bubble");
    if (m){ ann.destroyAnnotation(a); annoRefs.delete(a); }
  });
}
function clearPlaneHints(){
  [...annoRefs].forEach(a=>{
    const m = a.markerElement?.querySelector?.(".plane-hint");
    if (m){ ann.destroyAnnotation(a); annoRefs.delete(a); }
  });
}

/* ====== MESURE ====== */
let firstPoint = null;
function pushMeasure(p1,p2){
  const d = Math.hypot(p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]);
  const label = d>=1 ? `${d.toFixed(3)} m` : `${(d*1000).toFixed(1)} mm`;
  // Overlays
  createDot(p1,"red"); createDot(p2,"blue");
  const mid=[(p1[0]+p2[0])/2,(p1[1]+p2[1])/2,(p1[2]+p2[2])/2];
  createBubble(mid,label);
  // HUD list
  const row = document.createElement("div");
  row.textContent = label;
  Object.assign(row.style,{padding:"4px 6px",background:"rgba(255,255,255,.06)",borderRadius:"6px",marginTop:"4px",color:"#fff"});
  const del = document.createElement("button");
  del.textContent="×";
  Object.assign(del.style,{float:"right",background:"transparent",border:"0",color:"#fff",cursor:"pointer"});
  del.onclick=()=> row.remove();
  row.appendChild(del);
  measureList.appendChild(row);
}
btnMeasure?.addEventListener("click", ()=> { clearMeasureAnnotations(); firstPoint=null; setMode("measure"); });

/* ====== ANNOTATION ====== */
btnAnnot?.addEventListener("click", ()=> setMode("annot"));

/* ====== COUPE ====== */
let planeX=null, planeY=null, planeZ=null, activeAxis=null;

function ensurePlanes(){
  if (planeX && planeY && planeZ) return;
  const c = viewer.scene?.aabbCenter || [0,0,0];
  planeX = sections.createSectionPlane({ id:"cutX", pos:c.slice(), dir:[1,0,0] });
  planeY = sections.createSectionPlane({ id:"cutY", pos:c.slice(), dir:[0,1,0] });
  planeZ = sections.createSectionPlane({ id:"cutZ", pos:c.slice(), dir:[0,0,1] });
}
function disableClipping(){
  viewer.scene.sectionPlanesEnabled = false;
  activeAxis=null; clipRange.disabled=true; updateClipButtonsState();
  clearPlaneHints();
}
function updateClipButtonsState(){
  clipPanel.querySelectorAll(".clipBtn").forEach(b=>{
    const on = b.dataset.axis === activeAxis;
    b.style.background = on ? "rgba(255,255,255,.2)" : "transparent";
  });
}
function setPlaneFromSlider(){
  if (!activeAxis) return;
  const bb=aabb();
  const center=[(bb[0]+bb[3])/2,(bb[1]+bb[4])/2,(bb[2]+bb[5])/2];
  const half=[(bb[3]-bb[0])/2,(bb[4]-bb[1])/2,(bb[5]-bb[2])/2];
  const t = (parseFloat(clipRange.value)||0)/100; // -1..1
  ensurePlanes();
  clearPlaneHints();
  if (activeAxis==="x"){
    planeX.pos=[center[0]+t*half[0], center[1], center[2]];
    createPlaneHint(planeX.pos,"x");
  }
  if (activeAxis==="y"){
    planeY.pos=[center[0], center[1]+t*half[1], center[2]];
    createPlaneHint(planeY.pos,"y");
  }
  if (activeAxis==="z"){
    planeZ.pos=[center[0], center[1], center[2]+t*half[2]];
    createPlaneHint(planeZ.pos,"z");
  }
  viewer.scene.sectionPlanesEnabled = true;
}
btnClip?.addEventListener("click", ()=>{ setMode("clip"); /* aucun axe sélectionné par défaut */ });
clipPanel.querySelectorAll(".clipBtn").forEach(b=>{
  b.addEventListener("click", ()=>{
    const axis = b.dataset.axis;
    if (activeAxis === axis){
      // toggle off
      disableClipping();
    } else {
      activeAxis = axis;
      ensurePlanes();
      clipRange.disabled = false;
      setPlaneFromSlider();
      updateClipButtonsState();
    }
  });
});
clipRange.addEventListener("input", setPlaneFromSlider);
window.addEventListener("keydown",(e)=>{
  if (mode!=="clip" || !activeAxis) return;
  if (e.key==="ArrowLeft"){ clipRange.value = (+clipRange.value-1).toString(); setPlaneFromSlider(); }
  if (e.key==="ArrowRight"){ clipRange.value = (+clipRange.value+1).toString(); setPlaneFromSlider(); }
});

/* ====== Picking (route par mode) ====== */
viewer.scene.input.on("mouseclicked", (coords)=>{
  const hit = viewer.scene.pick({ canvasPos:[coords[0],coords[1]], pickSurface:true });

  if (mode==="measure"){
    if (hit && hit.worldPos){
      if (!firstPoint){ firstPoint = hit.worldPos.slice(); createDot(firstPoint,"red"); }
      else { pushMeasure(firstPoint, hit.worldPos.slice()); firstPoint=null; setMode("none"); }
    }
    return;
  }

  if (mode==="annot"){
    if (hit && hit.worldPos){
      createDot(hit.worldPos.slice(),"blue");
      createBubble(hit.worldPos.slice(),"Annotation");
      // on log la position dans le panneau propriétés pour info
      if (propsPanel){
        const row=document.createElement("div");
        row.textContent=`Annotation @ ${hit.worldPos.map(n=>n.toFixed(2)).join(", ")}`;
        propsPanel.appendChild(row);
      }
      setMode("none");
    }
    return;
  }

  if (mode==="clip"){
    if (activeAxis && hit && hit.worldPos){
      ensurePlanes();
      if (activeAxis==="x") planeX.pos=hit.worldPos.slice();
      if (activeAxis==="y") planeY.pos=hit.worldPos.slice();
      if (activeAxis==="z") planeZ.pos=hit.worldPos.slice();
      clearPlaneHints(); createPlaneHint(hit.worldPos.slice(), activeAxis);
      viewer.scene.sectionPlanesEnabled = true;
    }
    return;
  }

  // SELECT par défaut
  if (!hit || !hit.entity){ clearSelection(); return; }
  const id = hit.entity.id;
  setSome(allIds(),"highlighted",false);
  selectedIds = new Set([id]);
  setSome([id],"highlighted",true);
  const meta = hit.entity.metaObject || hit.entity.meta;
  if (propsPanel){
    propsPanel.innerHTML = "";
    const add=(k,v)=>{const a=document.createElement("div");a.textContent=k;const b=document.createElement("div");b.textContent=String(v);propsPanel.append(a,b);};
    if (meta){
      const base={ id:meta.id, type:meta.type||meta.ifcType||"", name:meta.name||meta.displayName||"" };
      Object.entries(base).forEach(([k,v])=> (v!==undefined && v!=="") && add(k,v));
    } else add("id", id);
  }
});

/* ====== Rendu/Nav (identique) ====== */
btnFit?.addEventListener("click", ()=> viewer.cameraFlight.flyTo(viewer.scene));

let proj="perspective";
btnProj?.addEventListener("click", ()=>{
  proj = (proj==="perspective") ? "ortho" : "perspective";
  viewer.camera.projection = proj;
  btnProj.textContent = proj==="perspective" ? "Perspective" : "Orthographique";
});
(() => {
  if (!navMode) return;
  const opt = [...navMode.options].find(o=>o.value==="pan");
  if (opt){ opt.value="planView"; opt.textContent="Plan"; }
})();
navMode?.addEventListener("change", ()=> viewer.cameraControl.navMode = navMode.value);

/* Arêtes */
function applyEdges(on){
  viewer.scene.edgeMaterial.edgesEnabled = !!on;
  (viewer.scene.objectIds||[]).forEach(id=>{
    const o = viewer.scene.objects[id];
    if (o){ if ("edges" in o) o.edges=!!on; if (o.mesh && ("edges" in o.mesh)) o.mesh.edges=!!on; }
  });
}
chkEdges?.addEventListener("change", ()=> applyEdges(!!chkEdges.checked));
viewer.scene.on("tick", ()=>{ if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) viewer.scene.edgeMaterial.edgesEnabled = true; });

chkXray?.addEventListener("change", ()=>{ setAll("xrayed", !!chkXray.checked); if (selectedIds.size) setSome([...selectedIds],"xrayed",false); });
chkGhost?.addEventListener("change", ()=>{ setAll("ghosted", !!chkGhost.checked); if (selectedIds.size) setSome([...selectedIds],"ghosted",false); });

chkTheme?.addEventListener("change", ()=>{
  viewerContainer?.classList.toggle("dark", !!chkTheme.checked);
  viewer.scene.clearColor = chkTheme.checked ? [0.06,0.07,0.08] : [0.965,0.957,0.937];
});
opacityRange?.addEventListener("input", ()=> setAll("opacity", parseFloat(opacityRange.value)||1));

/* ====== Upload/Load (identique) ====== */
async function loadXKT(xktUrl, nameHint){
  const id = "m"+Date.now();
  const model = xktLoader.load({ id, src:xktUrl, edges:!!chkEdges?.checked });
  setProgress(10);
  model.on("progress", p=> setProgress(10+Math.round(p*80)));
  model.on("loaded", ()=>{
    setProgress(100); setTimeout(()=>setProgress(0),350);
    viewer.cameraFlight.flyTo(model);
    models.set(id,{model,name:nameHint||id,src:xktUrl}); lastModelId=id; refreshModelsList();
    if (chkEdges?.checked) applyEdges(true);
  });
  model.on("error", e=>{ setProgress(0); console.error(e); alert("Erreur chargement XKT."); });
}
function refreshModelsList(){
  if (!modelsList) return;
  modelsList.innerHTML="";
  for (const [id,info] of models){
    const row=document.createElement("div");
    row.className="row mini";
    row.style.justifyContent="space-between";
    row.innerHTML=`<span title="${id}">${info.name||id}</span>
      <span>
        <button class="btn btn-outline mini" data-act="fly" data-id="${id}">Voir</button>
        <button class="btn btn-outline mini" data-act="toggle" data-id="${id}">${info.model.visible?"Cacher":"Montrer"}</button>
      </span>`;
    modelsList.appendChild(row);
  }
  modelsList.querySelectorAll("button").forEach(b=>{
    b.onclick=()=>{
      const id=b.dataset.id, info=models.get(id); if(!info)return;
      if (b.dataset.act==="fly") viewer.cameraFlight.flyTo(info.model);
      else { info.model.visible=!info.model.visible; refreshModelsList(); }
    };
  });
}
async function uploadAndShow(){
  const f = fileInput?.files?.[0]; if(!f){ alert("Choisis un fichier .step/.stp/.stl"); return; }
  btnVisualiser && (btnVisualiser.disabled=true, btnVisualiser.textContent="Conversion…");
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
    alert("Erreur de conversion/chargement.");
  }finally{
    btnVisualiser && (btnVisualiser.disabled=false, btnVisualiser.textContent="VISUALISER");
  }
}
btnChoose?.addEventListener("click", (e)=>{ e.preventDefault(); fileInput?.click(); });
fileInput?.addEventListener("change", ()=>{ const f=fileInput.files?.[0]; if (f && fileNameLbl) fileNameLbl.textContent=f.name; if (f) uploadAndShow(); });
btnVisualiser?.addEventListener("click", (e)=>{ e.preventDefault(); uploadAndShow(); });

/* ====== Divers ====== */
btnIsolate?.addEventListener("click", ()=>{ if (!selectedIds.size) return; setAll("visible", false); setSome([...selectedIds],"visible", true); });
btnHide?.addEventListener("click",    ()=>{ if (!selectedIds.size) return; setSome([...selectedIds],"visible", false); });
btnShowOnly?.addEventListener("click",()=>{ if (!selectedIds.size) return; setAll("visible", false); setSome([...selectedIds],"visible", true); });
btnClearSel?.addEventListener("click",()=>{ setAll("visible", true); setSome(allIds(),"highlighted", false); clearSelection(); });

explodeRange?.addEventListener("input", ()=>{
  const ids = allIds(); if (!ids.length) return;
  const k = parseFloat(explodeRange.value)||0;
  const bb=viewer.scene.aabb, c=[(bb[0]+bb[3])/2,(bb[1]+bb[4])/2,(bb[2]+bb[5])/2];
  ids.forEach(id=>{
    const o=viewer.scene.objects[id]; if(!o) return;
    const p=o.aabbCenter||[0,0,0]; const v=[p[0]-c[0],p[1]-c[1],p[2]-c[2]];
    const len=Math.hypot(v[0],v[1],v[2])||1; const off=[v[0]/len*k*10,v[1]/len*k*10,v[2]/len*k*10];
    if ("offset" in o) o.offset=off;
  });
});
btnShot?.addEventListener("click", ()=>{
  try{
    const dataURL = document.getElementById("xeokit-canvas").toDataURL("image/png");
    const a=document.createElement("a"); a.href=dataURL; a.download="cadlytics_view.png"; a.click();
  }catch(e){ console.error(e); alert("Capture impossible."); }
});
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
