// /static/js/main.js
import {
  Viewer,
  XKTLoaderPlugin,
  FastNavPlugin,
  NavCubePlugin,
  SectionPlanesPlugin,
  AnnotationsPlugin,               // gardé si tu veux encore t'en servir ailleurs
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

// (on garde une instance, mais on ne s'appuie plus dessus pour placer les annotations)
const annotations = new AnnotationsPlugin(viewer, { container: overlayHost });

/* ========= Canvas & overlay sizing — DPR sûr ========= */
const canvasEl = document.getElementById("xeokit-canvas");
function resizeCanvasAndOverlay() {
  const w = Math.max(1, viewerContainer.clientWidth);
  const h = Math.max(1, viewerContainer.clientHeight);
  const dpr = 1;

  // Calque HTML bien superposé au canvas
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
let clipPlateAnn = null;

const setProgress=(p)=>{ if (progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; };
const allIds=()=> viewer.scene?.objectIds ?? [];
const setSome=(ids,prop,val)=> ids.forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const setAll=(prop,val)=> allIds().forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const clearSelection=()=>{ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); if (propsPanel) propsPanel.innerHTML=""; };

/* ---------- Mesures xeokit (affiche “mm” sans conversion) ---------- */
const distancePlugin = new DistanceMeasurementsPlugin(viewer, {
  container: overlayHost,
  labelsShown: true,
  labelFormat: (meters) => `${meters.toFixed(2)} mm`
});
const distanceCtrl = new DistanceMeasurementsMouseControl(distancePlugin, { snapping: true });

/* ====== Panneau "Mesures" ====== */
const leftCard = document.querySelector(".grid > .card:first-child");
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
  // (les annotations manuelles seront mises à jour plus bas)
});

chkXray ?.addEventListener("change",()=>{ setAll("xrayed", !!chkXray.checked);  setSome([...selectedIds],"xrayed",false); });
chkGhost?.addEventListener("change",()=>{ setAll("ghosted",!!chkGhost.checked); setSome([...selectedIds],"ghosted",false); });
chkTheme?.addEventListener("change",()=> viewerShell?.classList.toggle("dark",!!chkTheme.checked));
opacityRange?.addEventListener("input",()=> setAll("opacity", parseFloat(opacityRange.value)||1));

/* ===================== ANNOTATIONS MANUELLES (lock + occlusion, UI robuste) ===================== */

/* Helpers 4x4 */
function invertMat4(m) {
  const a = m, out = new Float32Array(16);
  const b00 = a[0]*a[5]-a[1]*a[4],  b01 = a[0]*a[6]-a[2]*a[4],  b02 = a[0]*a[7]-a[3]*a[4];
  const b03 = a[1]*a[6]-a[2]*a[5],  b04 = a[1]*a[7]-a[3]*a[5],  b05 = a[2]*a[7]-a[3]*a[6];
  const b06 = a[8]*a[13]-a[9]*a[12], b07 = a[8]*a[14]-a[10]*a[12], b08 = a[8]*a[15]-a[11]*a[12];
  const b09 = a[9]*a[14]-a[10]*a[13], b10 = a[9]*a[15]-a[11]*a[13], b11 = a[10]*a[15]-a[11]*a[14];
  let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
  if (!det) return null;
  det = 1 / det;
  out[0]  = ( a[5]*b11 - a[6]*b10 + a[7]*b09) * det;
  out[1]  = (-a[1]*b11 + a[2]*b10 - a[3]*b09) * det;
  out[2]  = ( a[13]*b05 - a[14]*b04 + a[15]*b03) * det;
  out[3]  = (-a[9]*b05 + a[10]*b04 - a[11]*b03) * det;
  out[4]  = (-a[4]*b11 + a[6]*b08 - a[7]*b07) * det;
  out[5]  = ( a[0]*b11 - a[2]*b08 + a[3]*b07) * det;
  out[6]  = (-a[12]*b05 + a[14]*b02 - a[15]*b01) * det;
  out[7]  = ( a[8]*b05 - a[10]*b02 + a[11]*b01) * det;
  out[8]  = ( a[4]*b10 - a[5]*b08 + a[7]*b06) * det;
  out[9]  = (-a[0]*b10 + a[1]*b08 - a[3]*b06) * det;
  out[10] = ( a[12]*b04 - a[13]*b02 + a[15]*b00) * det;
  out[11] = (-a[8]*b04 + a[9]*b02 - a[11]*b00) * det;
  out[12] = (-a[4]*b09 + a[5]*b07 - a[6]*b06) * det;
  out[13] = ( a[0]*b09 - a[1]*b07 + a[2]*b06) * det;
  out[14] = (-a[12]*b03 + a[13]*b01 - a[14]*b00) * det;
  out[15] = ( a[8]*b03 - a[9]*b01 + a[10]*b00) * det;
  return out;
}
function transformPoint(m, v) {
  const x=v[0], y=v[1], z=v[2];
  const w = m[3]*x + m[7]*y + m[11]*z + m[15];
  return [
    (m[0]*x + m[4]*y + m[8]*z  + m[12]) / w,
    (m[1]*x + m[5]*y + m[9]*z  + m[13]) / w,
    (m[2]*x + m[6]*y + m[10]*z + m[14]) / w
  ];
}
const dist3 = (a,b)=> Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

/* Projection 3D -> 2D */
function worldToCanvas(world){
  if (!overlayHost) return null;
  if (typeof viewer.camera.project === "function") {
    const out = viewer.camera.project(world, new Float32Array(4));
    const w = out[3] || 1, nx = out[0]/w, ny = out[1]/w;
    return {
      x: (nx*0.5+0.5)*overlayHost.clientWidth,
      y: (1-(ny*0.5+0.5))*overlayHost.clientHeight
    };
  }
  const mV = viewer.camera.viewMatrix;
  const mP = viewer.camera.projMatrix || viewer.camera.projectionMatrix;
  if (!mV || !mP) return null;
  const x=world[0], y=world[1], z=world[2];
  const vx=mV[0]*x+mV[4]*y+mV[8]*z +mV[12];
  const vy=mV[1]*x+mV[5]*y+mV[9]*z +mV[13];
  const vz=mV[2]*x+mV[6]*y+mV[10]*z+mV[14];
  const vw=mV[3]*x+mV[7]*y+mV[11]*z+mV[15];
  const cx=mP[0]*vx+mP[4]*vy+mP[8]*vz+mP[12]*vw;
  const cy=mP[1]*vx+mP[5]*vy+mP[9]*vz+mP[13]*vw;
  const cw=mP[3]*vx+mP[7]*vy+mP[11]*vz+mP[15]*vw;
  const nx=cx/cw, ny=cy/cw;
  return {
    x: (nx*0.5+0.5)*overlayHost.clientWidth,
    y: (1-(ny*0.5+0.5))*overlayHost.clientHeight
  };
}
function place(el, p, half=6){
  if (!p) { el.style.display="none"; return; }
  el.style.display="block";
  el.style.transform = `translate(${Math.round(p.x-half)}px, ${Math.round(p.y-half)}px)`;
}

/* UI : création sûre du panneau */
function ensureAnnotPane(){
  const left = document.querySelector(".grid > .card:first-child")
            || document.querySelector("#leftPane")
            || document.querySelector(".sidebar")
            || document.querySelector(".left-panel");
  if (!left) return null;
  let pane = left.querySelector('[data-pane="annotations"]');
  if (!pane){
    pane = document.createElement("div");
    pane.className="pane";
    pane.dataset.pane="annotations";
    pane.innerHTML = `
      <h4 style="margin:12px 0 10px">Annotations</h4>
      <div id="annotList" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="row mini" style="margin-top:6px; gap:8px">
        <button id="btnHideAllAnn" class="btn btn-outline mini">Tout cacher/montrer</button>
        <button id="btnClearAnn"   class="btn btn-danger mini">Tout supprimer</button>
      </div>`;
    left.appendChild(pane);
  }
  return {
    pane,
    list: pane.querySelector("#annotList"),
    hideAllBtn: pane.querySelector("#btnHideAllAnn"),
    clearBtn: pane.querySelector("#btnClearAnn"),
  };
}
const annotUI = ensureAnnotPane(); // peut être null si aucun conteneur latéral
const annotListEl   = annotUI?.list;
const btnHideAllAnn = annotUI?.hideAllBtn;
const btnClearAnn   = annotUI?.clearBtn;

/* Modèle de données */
let annCounter = 0;
const manualAnns = []; // {id, entity, local:[x,y,z], world:[x,y,z], el, visible, name, half}

/* Création d’une annotation verrouillée à l’entité */
function createManualAnnotation(hit){
  const ent = hit.entity;
  const wm  = ent.worldMatrix || ent.matrix;
  const inv = wm && invertMat4(wm);
  const local = inv ? transformPoint(inv, hit.worldPos) : hit.worldPos.slice(); // fallback

  const id = "ann" + (++annCounter);
  const el = document.createElement("div");
  Object.assign(el.style, { position:"absolute", zIndex:"5", pointerEvents:"auto" });

  const dot = document.createElement("div");
  dot.className = "dot";           // doit faire ~12x12px
  el.appendChild(dot);

  const lab = document.createElement("div");
  lab.className = "ann-label";
  const input = document.createElement("input");
  input.className = "annot-input";
  input.placeholder = "Texte…";
  lab.appendChild(input);
  el.appendChild(lab);

  overlayHost.appendChild(el);
  input.focus();

  const entry = { id, entity: ent, local, world: hit.worldPos.slice(), el, visible:true, name:`Annotation ${annCounter}`, half:6 };
  manualAnns.push(entry);
  if (annotListEl) addAnnotationRow(entry);

  const commit = ()=>{
    const t = (input.value||"").trim() || entry.name;
    lab.innerHTML = `<div class="xk-badge">${t}</div>`;
    const r = annotListEl?.querySelector(`[data-aid="${id}"] .annot-name`);
    if (r) r.textContent = t;
  };
  input.addEventListener("keydown", e=>{ if (e.key==="Enter"){ e.preventDefault(); input.blur(); } });
  input.addEventListener("blur", commit, {once:true});
}
function addAnnotationRow(entry){
  const row = document.createElement("div");
  row.className="row mini"; row.dataset.aid = entry.id;
  row.style.justifyContent="space-between";
  row.innerHTML = `
    <span class="annot-name" style="font-size:12px">${entry.name}</span>
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
      entry.el.querySelector(".ann-label").innerHTML = `<div class="xk-badge">${nv.trim()||entry.name}</div>`;
      row.querySelector(".annot-name").textContent = nv.trim()||entry.name;
    }
  });
  row.querySelector('[data-act="toggle"]').addEventListener("click", ()=>{
    entry.visible = !entry.visible;
    entry.el.style.display = entry.visible ? "block" : "none";
    row.querySelector('[data-act="toggle"]').textContent = entry.visible ? "Cacher" : "Montrer";
  });
  row.querySelector('[data-act="del"]').addEventListener("click", ()=>{
    entry.el.remove();
    const i = manualAnns.findIndex(a=>a.id===entry.id);
    if (i>=0) manualAnns.splice(i,1);
    row.remove();
  });
}

/* Boutons du panneau (protégés si absents) */
if (btnHideAllAnn) {
  btnHideAllAnn.addEventListener("click", ()=>{
    const hide = manualAnns.some(a=>a.visible);
    manualAnns.forEach(a=>{ a.visible=!hide; a.el.style.display = a.visible ? "block" : "none"; });
  });
}
if (btnClearAnn) {
  btnClearAnn.addEventListener("click", ()=>{
    manualAnns.splice(0).forEach(a=> a.el.remove());
    if (annotListEl) annotListEl.innerHTML="";
    annCounter=0;
  });
}

/* Mise à jour : recalcule worldPos depuis la coordonnée locale + occlusion */
viewer.scene.on("tick", ()=>{
  for (const a of manualAnns){
    if (!a.visible) continue;

    const wm = a.entity.worldMatrix || a.entity.matrix;
    if (!wm) { a.el.style.display="none"; continue; }

    a.world = transformPoint(wm, a.local);
    const p2 = worldToCanvas(a.world);
    if (!p2) { a.el.style.display="none"; continue; }

    // Occlusion: repick au pixel
    const pick = viewer.scene.pick({ canvasPos:[p2.x, p2.y], pickSurface:true });
    const visible = pick && pick.entity && pick.entity.id===a.entity.id && dist3(pick.worldPos, a.world) < 1e-3;

    a.el.style.opacity = visible ? "1" : "0";
    place(a.el, p2, a.half);
  }
});

/* Clic scène : création annotation verrouillée */
viewer.scene.input.on("mouseclicked", (coords)=>{
  if (distanceCtrl.active) return; // la mesure consomme le clic
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
  if (clipPlateAnn){ try{ clipPlateAnn.destroy?.(); }catch{} clipPlateAnn=null; }

  if (!clipAxis){ viewer.scene.sectionPlanesEnabled=false; return; }

  const aabb=viewer.scene?.aabb || [0,0,0, 0,0,0];
  const center=[(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  const dir = clipAxis==="x" ? [1,0,0] : clipAxis==="y" ? [0,1,0] : [0,0,1];

  clipPlane = sections.createSectionPlane({ id:"cut", pos:center, dir });
  viewer.scene.sectionPlanesEnabled=true;

  // petite plaque visuelle (on peut garder l'annotation plugin ici, ce n'est qu'un label flottant)
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
