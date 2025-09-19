// /static/js/main.js
import {
  Viewer,
  XKTLoaderPlugin,
  FastNavPlugin,
  NavCubePlugin,
  SectionPlanesPlugin,
  AnnotationsPlugin
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

/* ---------- utilitaires DOM ---------- */
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- sélecteurs ---------- */
const fileInput     = $("#fileInput");
const btnChoose     = $("#btnChoose");
const btnVisualiser = $("#btnVisualiser");
const chkAdditive   = $("#chkAdditive");
const fileNameLbl   = $("#fileName");

const viewerShell   = $("#viewerShell");
const viewerContainer = $("#viewerContainer");
const overlayHost   = $("#overlayHost");

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
const clipButtons  = $$(".clipAxis");
const clipRange    = $("#clipRange");
const explodeRange = $("#explodeRange");
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

/* Overlays HTML (pastilles/étiquettes/plaques) */
const annotations = new AnnotationsPlugin(viewer, {
  container: overlayHost,
  markerHTML: `<div class="dot"></div>`,
  labelHTML:  `<div class="bubble"></div>`
});

/* Cube d’axes dans le coin */
(() => {
  const cube = document.createElement("canvas");
  cube.width = cube.height = 96;
  Object.assign(cube.style, {
    position:"absolute",left:"12px",top:"12px",zIndex:"5",
    borderRadius:"12px",boxShadow:"0 6px 18px rgba(0,0,0,.25)",
    background:"rgba(255,255,255,.06)",backdropFilter:"blur(2px)"
  });
  viewerContainer.appendChild(cube);
  new NavCubePlugin(viewer, { canvasElement:cube, cameraFlyToDuration:0.9 });
})();

/* ---------- état appli ---------- */
const models = new Map(); // id -> { model, name, src }
let lastModelId = null;
let selectedIds = new Set();
let appMode = "select";   // "select" | "measure" | "annotate"
let clipAxis = null;      // 'x' | 'y' | 'z' | null
let clipPlane = null;     // SectionPlane
let clipPlateAnnot = null;// plaque visuelle (overlay)

const setProgress = (p) => { if (progressBar) progressBar.style.inset = `0 ${100-Math.max(0,Math.min(100,p))}% 0 0`; };
const allIds =       () => viewer.scene?.objectIds ?? [];
const setSome = (ids, prop, val) => ids.forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; });
const setAll  = (prop, val)     => allIds().forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; });
const clearSelection = () => { setSome([...selectedIds], "highlighted", false); selectedIds.clear(); propsPanel.innerHTML=""; };

function showProps(meta) {
  propsPanel.innerHTML = "";
  if (!meta) return;
  const add = (k,v)=>{ const a=document.createElement("div"); a.textContent=k;
                       const b=document.createElement("div"); b.textContent=String(v);
                       propsPanel.append(a,b); };
  const base = { id:meta.id, type:meta.type||meta.ifcType||"", name:meta.name||meta.displayName||"" };
  Object.entries(base).forEach(([k,v])=> (v!==undefined && v!=="") && add(k,v));
  const p=meta.properties||meta.props;
  if (p && typeof p==="object")
    Object.entries(p).forEach(([k,v])=> add(k, typeof v==="object"? JSON.stringify(v): v));
}

function refreshModelsList(){
  modelsList.innerHTML="";
  for (const [id, info] of models) {
    const row = document.createElement("div");
    row.className="row mini";
    row.style.justifyContent="space-between";
    row.innerHTML = `
      <span title="${id}">${info.name||id}</span>
      <span>
        <button class="btn btn-outline mini" data-act="fly" data-id="${id}">Voir</button>
        <button class="btn btn-outline mini" data-act="toggle" data-id="${id}">${info.model.visible?"Cacher":"Montrer"}</button>
      </span>`;
    modelsList.appendChild(row);
  }
  modelsList.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click",()=>{
      const id=b.dataset.id; const info=models.get(id); if(!info) return;
      if (b.dataset.act==="fly") viewer.cameraFlight.flyTo(info.model);
      else { info.model.visible=!info.model.visible; refreshModelsList(); }
    });
  });
}

const flyAll = ()=> viewer.cameraFlight.flyTo(viewer.scene);

/* ---------- chargement XKT ---------- */
async function loadXKT(url, nameHint){
  const id = "m"+Date.now();
  const model = xktLoader.load({ id, src:url, edges:!!chkEdges.checked });
  setProgress(6);
  model.on("progress", p=> setProgress(6 + Math.round(p*88)));
  model.on("loaded", ()=>{
    setProgress(100); setTimeout(()=>setProgress(0), 350);
    viewer.cameraFlight.flyTo(model);
    models.set(id, { model, name:nameHint||id, src:url });
    lastModelId=id; refreshModelsList();
    if (chkEdges.checked) viewer.scene.edgeMaterial.edgesEnabled = true;
  });
  model.on("error", e=>{ console.error(e); setProgress(0); alert("Erreur chargement XKT."); });
  return id;
}

/* ---------- upload ---------- */
async function uploadAndShow(){
  const f = fileInput?.files?.[0];
  if (!f) { alert("Choisis un fichier .step/.stp/.stl"); return; }
  btnVisualiser.disabled = true; btnVisualiser.textContent = "Conversion…";
  setProgress(10);
  try{
    const fd = new FormData(); fd.append("file", f);
    const res = await fetch("/upload", { method:"POST", body:fd });
    const j   = await res.json();
    if (!res.ok || !j.xkt_url) throw new Error(JSON.stringify(j));
    const xktUrl = new URL(j.xkt_url, location.origin).toString();

    if (!chkAdditive.checked) { for (const [,i] of models){ try{i.model.destroy();}catch{} } models.clear(); selectedIds.clear(); }
    await loadXKT(xktUrl, f.name);
  }catch(e){
    console.error(e); alert("Erreur conversion/chargement (voir Console).");
  }finally{
    btnVisualiser.disabled = false; btnVisualiser.textContent = "VISUALISER";
  }
}

/* ---------- UI fichiers ---------- */
btnChoose.addEventListener("click", (e)=>{ e.preventDefault(); fileInput.click(); });
fileInput.addEventListener("change", ()=>{
  const f=fileInput.files?.[0]; if (f) fileNameLbl.textContent = f.name;
  if (f) uploadAndShow(); // visualisation immédiate
});
btnVisualiser.addEventListener("click", (e)=>{ e.preventDefault(); uploadAndShow(); });

/* ---------- navigation & rendu ---------- */
btnFit.addEventListener("click", flyAll);
let proj="perspective";
btnProj.addEventListener("click", ()=>{
  proj = proj==="perspective" ? "ortho" : "perspective";
  viewer.camera.projection = proj;
  btnProj.textContent = proj==="perspective" ? "PERSPECTIVE" : "ORTHOGRAPHIQUE";
});
const setNav = (m)=> viewer.cameraControl.navMode = (m==="pan" ? "planView" : m);
navMode.addEventListener("change", ()=> setNav(navMode.value)); setNav(navMode.value);

chkEdges.addEventListener("change", ()=> viewer.scene.edgeMaterial.edgesEnabled = !!chkEdges.checked);
viewer.scene.on("tick", ()=>{ if (chkEdges.checked && !viewer.scene.edgeMaterial.edgesEnabled) viewer.scene.edgeMaterial.edgesEnabled = true; });

chkXray .addEventListener("change", ()=>{ setAll("xrayed",  !!chkXray.checked);  setSome([...selectedIds],"xrayed",false);  });
chkGhost.addEventListener("change", ()=>{ setAll("ghosted", !!chkGhost.checked); setSome([...selectedIds],"ghosted",false); });

chkTheme.addEventListener("change", ()=> viewerShell.classList.toggle("dark", !!chkTheme.checked));
opacityRange.addEventListener("input", ()=> setAll("opacity", parseFloat(opacityRange.value)||1));

/* ---------- outils (modes) ---------- */
function setMode(m){
  appMode = (appMode===m) ? "select" : m;
  btnMeasure.classList.toggle("btn-primary", appMode==="measure");
  btnAnnot.classList.toggle("btn-primary",   appMode==="annotate");
}
btnMeasure.addEventListener("click", ()=> setMode("measure"));
btnAnnot  .addEventListener("click", ()=> setMode("annotate"));

/* Mesures et annotations (via overlays HTML) */
let measurePts = [];     // [[x,y,z], [x,y,z]]
let measureAnnots = [];  // ids d'annotations créées pour la dernière mesure
const fmt = (v)=> new Intl.NumberFormat("fr-FR",{maximumFractionDigits:2}).format(v);

viewer.scene.input.on("mouseclicked", (coords)=>{
  const hit = viewer.scene.pick({ canvasPos:[coords[0],coords[1]], pickSurface:true });

  if (!hit || !hit.worldPos) { if (appMode==="select") clearSelection(); return; }

  if (appMode === "measure") {
    // 2 points -> distance + pastilles + étiquette (au milieu)
    measurePts.push(hit.worldPos);
    const aId = "mpt"+Date.now()+Math.random();
    annotations.createAnnotation({ id:aId, worldPos:hit.worldPos, markerShown:true, labelShown:false });
    measureAnnots.push(aId);
    if (measurePts.length===2){
      const [a,b] = measurePts;
      const d = Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
      const mid = [(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
      const lid = "mlbl"+Date.now();
      annotations.createAnnotation({
        id: lid, worldPos: mid, markerShown:false, labelShown:true, label: `${fmt(d)} mm`
      });
      measureAnnots.push(lid);
      measurePts = [];
    }
    return;
  }

  if (appMode === "annotate") {
    const id = "note"+Date.now();
    annotations.createAnnotation({
      id, worldPos: hit.worldPos, markerShown:true, labelShown:true, label: "Annotation"
    });
    return;
  }

  // SELECT
  const id = hit.entity?.id;
  if (id){
    setSome(allIds(), "highlighted", false);
    selectedIds = new Set([id]);
    setSome([id], "highlighted", true);
    showProps(hit.entity.metaObject || hit.entity.meta || { id });
  }
});

/* Iso / cacher / montrer */
btnIsolate .addEventListener("click", ()=>{ if (!selectedIds.size) return; setAll("visible", false); setSome([...selectedIds],"visible",true); });
btnHide    .addEventListener("click", ()=>{ if (!selectedIds.size) return; setSome([...selectedIds],"visible",false); });
btnShowOnly.addEventListener("click", ()=>{ if (!selectedIds.size) return; setAll("visible", false); setSome([...selectedIds],"visible",true); });
btnClearSel.addEventListener("click", ()=>{ setAll("visible", true); setSome(allIds(),"highlighted",false); clearSelection(); });

/* Recherche */
btnSearch.addEventListener("click", ()=>{
  const q=(searchInput.value||"").toLowerCase().trim();
  resultsBox.innerHTML=""; if(!q) return;
  const found=[];
  allIds().forEach(id=>{
    const o=viewer.scene.objects[id]; const m=o?.metaObject||{};
    const hay=[id,m.type,m.name,m.ifcType,m.displayName].join(" ").toLowerCase();
    if (hay.includes(q)) found.push({id,meta:m});
  });
  if (!found.length){ resultsBox.textContent="Aucun résultat"; return; }
  found.slice(0,200).forEach(({id,meta})=>{
    const div=document.createElement("div");
    div.className="row"; div.style.justifyContent="space-between";
    div.innerHTML = `<span>${meta?.name||meta?.displayName||meta?.type||id}</span>
      <button class="btn btn-outline mini" data-id="${id}">Voir</button>`;
    resultsBox.appendChild(div);
  });
  resultsBox.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", ()=>{
      const id=b.dataset.id; const obj=viewer.scene.objects[id];
      if (obj){ viewer.cameraFlight.flyTo(obj); setSome([id],"highlighted",true); }
    });
  });
});

/* Reload / Unload */
btnReload.addEventListener("click", ()=>{
  if (!lastModelId) return;
  const info = models.get(lastModelId); if(!info) return;
  try{ info.model.destroy(); }catch{}
  models.delete(lastModelId);
  loadXKT(info.src, info.name);
});
btnUnload.addEventListener("click", ()=>{
  if (!lastModelId) return;
  const info=models.get(lastModelId); if(!info) return;
  try{ info.model.destroy(); }catch{}
  models.delete(lastModelId);
  lastModelId=[...models.keys()].pop()||null;
  refreshModelsList();
});

/* Explode simple (offset radiale) */
explodeRange.addEventListener("input", ()=>{
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

/* Screenshot */
btnShot.addEventListener("click", ()=>{
  try{
    const canvas = document.getElementById("xeokit-canvas");
    const dataURL = canvas.toDataURL("image/png");
    const a=document.createElement("a"); a.href=dataURL; a.download="cadlytics_view.png"; a.click();
  }catch(e){ console.error(e); alert("Capture impossible."); }
});

/* ---------- coupe : 1 axe à la fois, aucun par défaut ---------- */
function setClipAxis(axis){
  // toggle : si on reclique la même -> off
  const same = (clipAxis===axis);
  clipAxis = same ? null : axis;

  clipButtons.forEach(b=>{
    b.classList.toggle("btn-primary", !same && b.dataset.axis===clipAxis);
  });

  // Plan plugin
  if (clipPlane) { try{ clipPlane.destroy(); }catch{} clipPlane=null; }
  if (clipPlateAnnot) { annotations.destroyAnnotation(clipPlateAnnot.id); clipPlateAnnot=null; }

  if (!clipAxis) { viewer.scene.sectionPlanesEnabled = false; return; }

  const aabb = viewer.scene?.aabb || [0,0,0, 0,0,0];
  const center = [(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  const dir = clipAxis==="x" ? [1,0,0] : clipAxis==="y" ? [0,1,0] : [0,0,1];

  clipPlane = sections.createSectionPlane({ id:"cut", pos:center, dir });
  viewer.scene.sectionPlanesEnabled = true;

  // Plaque visuelle (overlay) posée au centre
  clipPlateAnnot = annotations.createAnnotation({
    id: "cutplate",
    worldPos: center,
    markerShown:false,
    labelShown:false
  });
  // on remplace son container par une plaque custom
  const el = overlayHost.querySelector('[data-annotation_id="cutplate"]');
  if (el){
    el.innerHTML = `<div class="cutplate" title="Plan ${clipAxis.toUpperCase()}"></div>`;
  }

  // reset slider
  clipRange.value = "0";
}
clipButtons.forEach(b=>{
  b.addEventListener("click", ()=> setClipAxis(b.dataset.axis));
});

clipRange.addEventListener("input", ()=>{
  if (!clipPlane || !clipAxis) return;
  // déplacement relatif +/-100 -> translation de +/- la demi-taille de la scène
  const k = parseFloat(clipRange.value)||0;
  const aabb = viewer.scene?.aabb || [0,0,0, 0,0,0];
  const center = [(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  const half   = [(aabb[3]-aabb[0])/2,(aabb[4]-aabb[1])/2,(aabb[5]-aabb[2])/2];
  const shift  = (clipAxis==="x"?half[0]:clipAxis==="y"?half[1]:half[2]) * (k/100);
  const pos = [...center];
  if (clipAxis==="x") pos[0]+=shift; else if (clipAxis==="y") pos[1]+=shift; else pos[2]+=shift;
  clipPlane.pos = pos;

  // déplacer la plaque indicative
  if (clipPlateAnnot) {
    annotations.setAnnotationWorldPos(clipPlateAnnot.id, pos);
  }
});
