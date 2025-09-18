// main.js — outils stables sans APIs internes variables

import {
  Viewer,
  XKTLoaderPlugin,
  NavCubePlugin,
  FastNavPlugin,
  SectionPlanesPlugin
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

const $ = (s) => document.querySelector(s);

/* ====== Références UI ====== */
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

/* ====== Viewer + Plugins de base ====== */
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

/* ====== HUD léger (mesures + clip UI) ====== */
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

// panneau Mesures
const measurePanel = document.createElement("div");
measurePanel.innerHTML = "<strong>Mesures</strong>";
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

// panneau Clip (boutons + slider)
const clipPanel = document.createElement("div");
clipPanel.innerHTML = `
  <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
    <strong style="color:#fff">Coupe</strong>
    <button data-axis="x" class="clipBtn">X</button>
    <button data-axis="y" class="clipBtn">Y</button>
    <button data-axis="z" class="clipBtn">Z</button>
  </div>
  <input type="range" min="-100" max="100" value="0" id="clipRange" />
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

// style boutons HUD
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

/* ====== Axes UI (cube + légende) ====== */
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

/* ====== Etat ====== */
const models = new Map(); // id -> {model, name, src}
let lastModelId = null;
let selectedIds = new Set();

const allIds = ()=> viewer.scene?.objectIds ?? [];
const setAll = (prop,val)=> allIds().forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; });
const setSome= (ids,prop,val)=> ids.forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; });

function setProgress(p){ if(progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; }
function clearSelection(){ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); propsPanel&&(propsPanel.innerHTML=""); }

/* ====== Géométries utilitaires (lignes/pastilles) ====== */
// On crée des “entities” simples: 2 sphères (pastilles) + une ligne (3 segments courts)
function makeSphere(id, center=[0,0,0], radius=0.0025, color=[1,0.2,0.2]){
  return viewer.scene.createEntity({
    id,
    geometry: viewer.scene.createSphereGeometry({center, radius}),
    material: viewer.scene.createPhongMaterial({ambient:color, diffuse:color, emissive:color}),
    pickable:false,
    collidable:false,
    edges:false
  });
}
function makeLine(id, p1, p2, color=[0.1,0.7,1]){
  // On simule la ligne par un cylindre très fin
  const v = [p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]];
  const len = Math.hypot(v[0],v[1],v[2]) || 1;
  const mid = [ (p1[0]+p2[0])/2, (p1[1]+p2[1])/2, (p1[2]+p2[2])/2 ];
  // axe unitaire
  const u = [v[0]/len, v[1]/len, v[2]/len];
  // matrice orientée : xeokit fournit cylinderGeometry aligné sur +Y ; on oriente via rotationFromDir
  const geo = viewer.scene.createCylinderGeometry({radiusTop:0.0008, radiusBottom:0.0008, height:len});
  const mat = viewer.scene.createPhongMaterial({ambient:color, diffuse:color});
  const e   = viewer.scene.createEntity({ id, geometry: geo, material: mat, pickable:false, collidable:false, edges:false });
  // Oriente / place
  const up=[0,1,0];
  // rotation quaternion pour aligner up -> u
  function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
  function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
  function norm(a){const l=Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l];}
  const axis = norm(cross(up,u));
  const cos  = dot(up,u);
  const ang  = Math.acos(Math.max(-1,Math.min(1,cos)));
  // quaternion
  const s=Math.sin(ang/2), c=Math.cos(ang/2);
  const q=[axis[0]*s, axis[1]*s, axis[2]*s, c];
  e.rotation = viewer.scene.math.quaternionToEuler(q);
  e.position = mid;
  return e;
}

/* ====== MESURE : 2 clics -> pastilles + trait + HUD ====== */
let mode = "none"; // none | measure | annot | clip
let tmpPt = null;  // premier point
function setMode(m){
  mode = (mode===m) ? "none" : m;
  btnMeasure?.classList.toggle("btn-primary", mode==="measure");
  btnAnnot?.classList.toggle("btn-primary",   mode==="annot");
  btnClip?.classList.toggle("btn-primary",    mode==="clip");
  viewerContainer.style.cursor = (mode==="measure"||mode==="annot"||mode==="clip")? "crosshair":"";
  // clip HUD
  clipPanel.style.display = mode==="clip" ? "block" : "none";
  if (mode!=="clip") viewer.scene.sectionPlanesEnabled = false;
}
window.addEventListener("keydown",(e)=>{ if (e.key==="Escape") setMode("none"); });

function addMeasure(p1,p2){
  // entités
  const id = "meas_"+Date.now();
  const s1 = makeSphere(id+"_a", p1);
  const s2 = makeSphere(id+"_b", p2);
  const ln = makeLine(id+"_l", p1, p2);
  // distance
  const d = Math.hypot(p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]);
  const label = d>=1 ? `${d.toFixed(3)} m` : `${(d*1000).toFixed(1)} mm`;
  // HUD list
  const row = document.createElement("div");
  row.textContent = label;
  Object.assign(row.style,{padding:"4px 6px",background:"rgba(255,255,255,.06)",borderRadius:"6px",marginTop:"4px"});
  const del = document.createElement("button");
  del.textContent="×";
  Object.assign(del.style,{float:"right",background:"transparent",border:"0",color:"#fff",cursor:"pointer"});
  del.onclick=()=>{
    try{s1.destroy();}catch{}
    try{s2.destroy();}catch{}
    try{ln.destroy();}catch{}
    row.remove();
  };
  row.appendChild(del);
  measureList.appendChild(row);
}

btnMeasure?.addEventListener("click", ()=> setMode("measure"));

/* ====== ANNOTATION : pin 3D (sphère) + liste dans props ====== */
const annotations = []; // {id, pos, text}
btnAnnot?.addEventListener("click", ()=> setMode("annot"));

function addPin(worldPos, text="Note"){
  const id = "pin_"+Date.now();
  const pin = makeSphere(id, worldPos, 0.0035, [1,0.4,0]);
  annotations.push({id, pos: worldPos.slice(), text});
  // affiche en bas du panneau propriétés
  if (propsPanel){
    const row=document.createElement("div");
    row.className="row";
    row.innerHTML = `<span>${text}</span><button class="btn btn-outline mini">Voir</button>`;
    row.querySelector("button").onclick=()=> viewer.cameraFlight.flyTo(pin);
    propsPanel.appendChild(row);
  }
}

/* ====== CLIP : 3 plans + slider ====== */
let planeX=null, planeY=null, planeZ=null, activeAxis="x";
function ensurePlanes(){
  if (planeX && planeY && planeZ) return;
  const c = viewer.scene?.aabbCenter || [0,0,0];
  planeX = sections.createSectionPlane({ id:"cutX", pos:c.slice(), dir:[1,0,0] });
  planeY = sections.createSectionPlane({ id:"cutY", pos:c.slice(), dir:[0,1,0] });
  planeZ = sections.createSectionPlane({ id:"cutZ", pos:c.slice(), dir:[0,0,1] });
}
function aabb(){
  const bb = viewer.scene.aabb; // [xmin,ymin,zmin, xmax,ymax,zmax]
  return bb && bb.length===6 ? bb : [-1,-1,-1, 1,1,1];
}
function setPlaneFromSlider(){
  const bb=aabb();
  const center=[(bb[0]+bb[3])/2,(bb[1]+bb[4])/2,(bb[2]+bb[5])/2];
  const half=[(bb[3]-bb[0])/2,(bb[4]-bb[1])/2,(bb[5]-bb[2])/2];
  const t = (parseFloat(clipRange.value)||0)/100; // -1..1
  ensurePlanes();
  if (activeAxis==="x") planeX.pos=[center[0]+t*half[0], center[1], center[2]];
  if (activeAxis==="y") planeY.pos=[center[0], center[1]+t*half[1], center[2]];
  if (activeAxis==="z") planeZ.pos=[center[0], center[1], center[2]+t*half[2]];
  viewer.scene.sectionPlanesEnabled = true;
}
btnClip?.addEventListener("click", ()=>{ setMode("clip"); ensurePlanes(); setPlaneFromSlider(); });
clipPanel.querySelectorAll(".clipBtn").forEach(b=>{
  b.addEventListener("click", ()=>{
    activeAxis = b.dataset.axis;
    setPlaneFromSlider();
  });
});
clipRange.addEventListener("input", setPlaneFromSlider);
window.addEventListener("keydown",(e)=>{
  if (mode!=="clip") return;
  if (e.key==="ArrowLeft"){ clipRange.value = (+clipRange.value-1).toString(); setPlaneFromSlider(); }
  if (e.key==="ArrowRight"){ clipRange.value = (+clipRange.value+1).toString(); setPlaneFromSlider(); }
});

/* ====== Picking global (route selon le mode) ====== */
viewer.scene.input.on("mouseclicked", (coords)=>{
  const hit = viewer.scene.pick({ canvasPos:[coords[0],coords[1]], pickSurface:true });
  if (mode==="measure"){
    if (hit && hit.worldPos){
      if (!tmpPt){ tmpPt = hit.worldPos.slice(); }
      else { addMeasure(tmpPt, hit.worldPos.slice()); tmpPt=null; setMode("none"); }
    }
    return;
  }
  if (mode==="annot"){
    if (hit && hit.worldPos){ addPin(hit.worldPos.slice()); setMode("none"); }
    return;
  }
  if (mode==="clip"){
    // clic repositionne le plan actif
    if (hit && hit.worldPos){ ensurePlanes(); if (activeAxis==="x") planeX.pos=hit.worldPos; if (activeAxis==="y") planeY.pos=hit.worldPos; if (activeAxis==="z") planeZ.pos=hit.worldPos; }
    return;
  }
  // SELECT
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
    } else {
      add("id", id);
    }
  }
});

/* ====== Reste des contrôles ====== */
btnFit?.addEventListener("click", ()=> viewer.cameraFlight.flyTo(viewer.scene));

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
navMode?.addEventListener("change", ()=> viewer.cameraControl.navMode = navMode.value);

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

/* ====== Upload & load ====== */
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

// Choisir => ouvre l’explorateur de fichiers + auto-visualise
btnChoose?.addEventListener("click", (e)=>{ e.preventDefault(); fileInput?.click(); });
fileInput?.addEventListener("change", ()=>{ const f=fileInput.files?.[0]; if (f && fileNameLbl) fileNameLbl.textContent=f.name; if (f) uploadAndShow(); });
btnVisualiser?.addEventListener("click", (e)=>{ e.preventDefault(); uploadAndShow(); });

/* ====== Recherche / Voir propriétés déjà en place ====== */
btnSearch?.addEventListener("click", ()=>{
  const q = (searchInput?.value||"").toLowerCase().trim();
  if (!resultsBox) return;
  resultsBox.innerHTML=""; if (!q) return;
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
    div.innerHTML=`<span>${meta?.name||meta?.displayName||meta?.type||id}</span>
                   <button class="btn btn-outline mini" data-id="${id}">Voir</button>`;
    resultsBox.appendChild(div);
  });
  resultsBox.querySelectorAll("button").forEach(b=>{
    b.onclick=()=>{ const id=b.dataset.id; const obj=viewer.scene.objects[id]; if(obj){ viewer.cameraFlight.flyTo(obj); setSome([id],"highlighted",true); } };
  });
});

/* ====== Iso / cacher / montrer ====== */
btnIsolate?.addEventListener("click", ()=>{ if (!selectedIds.size) return; setAll("visible", false); setSome([...selectedIds],"visible", true); });
btnHide?.addEventListener("click",    ()=>{ if (!selectedIds.size) return; setSome([...selectedIds],"visible", false); });
btnShowOnly?.addEventListener("click",()=>{ if (!selectedIds.size) return; setAll("visible", false); setSome([...selectedIds],"visible", true); });
btnClearSel?.addEventListener("click",()=>{ setAll("visible", true); setSome(allIds(),"highlighted", false); clearSelection(); });

/* ====== Explode / Screenshot ====== */
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

/* ====== Reload / Unload ====== */
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
