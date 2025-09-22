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
const btnAnnot     = $("#btnAnnot"); // caché
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
new AnnotationsPlugin(viewer, { container: overlayHost }); // intact

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

// coupe (SVG)
let clipPlateWorld = null;
let clipPlaneDir   = [1,0,0];

const setProgress=(p)=>{ if (progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; };
const allIds=()=> viewer.scene?.objectIds ?? [];
const setSome=(ids,prop,val)=> ids.forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const setAll=(prop,val)=> allIds().forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const clearSelection=()=>{ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); if (propsPanel) propsPanel.innerHTML=""; };

/* ===================== MESURES — mm + anti-aimantation par défaut ===================== */
const MM_PER_M = 1000;
const mmNumber = (mm) => {
  const abs = Math.abs(mm);
  if (abs < 10)   return mm.toFixed(2);
  if (abs < 100)  return mm.toFixed(1);
  return Math.round(mm).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
};

// (A) on coupe les labels natifs du plugin
const distancePlugin = new DistanceMeasurementsPlugin(viewer, {
  container: overlayHost,
  labelsShown: false
});

// (B) contrôle de mesure : SNAP OFF, opt-in avec ALT
const distanceCtrl = new DistanceMeasurementsMouseControl(distancePlugin, { snapping: false });

// désactive *vraiment* le snap (toutes variantes connues)
try {
  distanceCtrl.snapping = false;
  if ("snapRadius" in distanceCtrl)   distanceCtrl.snapRadius   = 0;
  if ("snapDistance" in distanceCtrl) distanceCtrl.snapDistance = 0;
  if ("snapToEdges" in distanceCtrl)  distanceCtrl.snapToEdges  = false;
  if ("snapToVertices" in distanceCtrl) distanceCtrl.snapToVertices = false;
  // fallback pour builds différentes
  distanceCtrl._snapRadius   = 0;
  distanceCtrl._snapDistance = 0;
} catch {}

let ALT_HELD = false;
window.addEventListener("keydown", e => { if (e.altKey) { ALT_HELD = true;  distanceCtrl.snapping = true; }},  {passive:true});
window.addEventListener("keyup",   e => { if (!e.altKey){ ALT_HELD = false; distanceCtrl.snapping = false;}}, {passive:true});

// (C) masquage CSS de secours des bulles bleues en mètres si une build ignore labelsShown:false
const styleKillMeters = document.createElement("style");
styleKillMeters.textContent = `
  /* masquer toute bulle du plugin, on ne garde que nos étiquettes .xk-badge et le SVG */
  #overlayHost > :not(.xk-badge):not(svg) .xeokit-distance-label,
  #overlayHost .xeokit-distance-label,
  #overlayHost .xeokit-measurement-label,
  #overlayHost .distanceMeasurements-label,
  #overlayHost > .xeokit-distance-label,
  #overlayHost > .xeokit-measurement-label {
    display: none !important;
  }
`;
document.head.appendChild(styleKillMeters);

// (D) pour toute nouvelle mesure : si la build expose des flags, on coupe encore les labels
["measurementCreated","newMeasurement","measurementAdded"].forEach(evt=>{
  distancePlugin.on?.(evt, (ev)=>{
    const m = ev.measurement || ev;
    if ("labelShown"  in m) m.labelShown  = false;
    if ("labelsShown" in m) m.labelsShown = false;
  });
});

/* ---------- Nos étiquettes mm (overlay) ---------- */
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

const len3 = (a,b)=> Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
const mid3 = (a,b)=> [(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];

const measUI = new Map(); // measurement -> {el, getEnds}

function makeEndsGetter(m){
  const fromPositions = (src) => () => {
    const p = (src && Array.isArray(src) && src.length >= 6) ? src : null;
    if (!p) return null;
    return [[p[0],p[1],p[2]],[p[3],p[4],p[5]]];
  };
  if (Array.isArray(m.positions))                return fromPositions(m.positions);
  if (m._state && Array.isArray(m._state.positions)) return fromPositions(m._state.positions);
  if (Array.isArray(m._positions))               return fromPositions(m._positions);
  if (Array.isArray(m.coords))                   return fromPositions(m.coords);
  if (Array.isArray(m._coords))                  return fromPositions(m._coords);

  const p1 = m.pos1||m.point1||m.p1||m.origin||m.start||m.a;
  const p2 = m.pos2||m.point2||m.p2||m.target||m.end||m.b;
  if (Array.isArray(p1) && Array.isArray(p2)) return ()=> [p1.slice(0,3), p2.slice(0,3)];

  if (typeof m.getPositions === "function") {
    return ()=> {
      const p = m.getPositions();
      return (Array.isArray(p) && p.length>=6) ? [[p[0],p[1],p[2]],[p[3],p[4],p[5]]] : null;
    };
  }
  return ()=> null;
}

function addMMLabelFor(meas){
  const el = document.createElement("div");
  el.className = "xk-badge";
  el.style.cssText = "position:absolute;pointer-events:none;transform:translate(-50%,-50%);z-index:12;"+
                     "background:#2563eb; color:#fff; border-radius:8px; padding:3px 6px; font:600 11px/1.2 system-ui,Segoe UI,Roboto,sans-serif; box-shadow:0 4px 12px rgba(0,0,0,.15)";
  overlayHost.appendChild(el);
  measUI.set(meas, { el, getEnds: makeEndsGetter(meas) });
}
function removeMMLabelFor(meas){
  const ui = measUI.get(meas); if (ui){ ui.el.remove(); measUI.delete(meas); }
}
function updateAllMMLabels(){
  for (const [meas, ui] of measUI.entries()){
    const ends = ui.getEnds?.();
    if (!ends) { ui.el.style.display="none"; continue; }
    const [a,b] = ends;
    const c = mid3(a,b);
    const pt = worldToOverlayXY(c);
    if (!pt){ ui.el.style.display="none"; continue; }
    const mm = len3(a,b) * MM_PER_M;
    ui.el.textContent = `${mmNumber(mm)} mm`;
    ui.el.style.left = `${pt.x}px`;
    ui.el.style.top  = `${pt.y}px`;
    ui.el.style.display = "block";
  }
}

["measurementCreated","newMeasurement","measurementAdded"].forEach(evt=>{
  distancePlugin.on?.(evt, (ev)=> addMMLabelFor(ev.measurement || ev));
});
distancePlugin.on?.("measurementDestroyed", (ev)=>{
  const m = ev.measurement || ev;
  removeMMLabelFor(m);
});

// toggle mesure
function deactivateMeasure(){ if (distanceCtrl.active) distanceCtrl.deactivate(); btnMeasure?.classList.remove("btn-primary"); }
function activateMeasure(){   distanceCtrl.activate();  btnMeasure?.classList.add("btn-primary"); }
function toggleMeasure(){     if (distanceCtrl.active) deactivateMeasure(); else activateMeasure(); }
btnMeasure?.addEventListener("click", toggleMeasure);
window.addEventListener("keydown", (e)=>{ if (e.key==="Escape" && distanceCtrl.active) deactivateMeasure(); }, {passive:true});

/* ====================== Panneau Mesures ====================== */
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
  btnT.addEventListener("click", ()=>{
    const ui = measUI.get(m);
    if (ui){ const vis = ui.el.style.display !== "none"; ui.el.style.display = vis ? "none" : "block"; }
    btnT.textContent = (ui && ui.el.style.display !== "none") ? "Cacher" : "Montrer";
  });
  btnD.addEventListener("click", ()=>{
    try { m.destroy ? m.destroy() : distancePlugin.destroyMeasurement?.(m.id); } catch {}
    measMap.delete(id); row.remove(); removeMMLabelFor(m);
  });
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
  for (const {m} of measMap.values()) {
    const ui = measUI.get(m);
    if (ui) ui.el.style.display = allHidden ? "none" : "block";
  }
});
btnClearMeas.addEventListener("click", ()=>{
  if (typeof distancePlugin.clear === "function") distancePlugin.clear();
  else if (typeof distancePlugin.destroyAll === "function") distancePlugin.destroyAll();
  for (const {m} of measMap.values()) removeMMLabelFor(m);
  measureListEl.innerHTML = ""; measMap.clear(); measCounter = 0; allHidden = false;
});

/* ====================== CHARGEMENT XKT ====================== */
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

/* ====================== PLAQUE DE COUPE : quad SVG en perspective ====================== */
const cross = (a,b)=> [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot   = (a,b)=> a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm  = (v)=>{ const L=Math.hypot(v[0],v[1],v[2])||1; return [v[0]/L,v[1]/L,v[2]/L]; };
const add3  = (a,b)=> [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const mul3  = (v,s)=> [v[0]*s, v[1]*s, v[2]*s];

/* --- overlay SVG (quad + axe) --- */
let cutSvg = null, cutPoly = null, cutAxis = null;
function ensureCutSvg(){
  if (cutSvg) return;
  cutSvg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  cutSvg.setAttribute("width","100%");
  cutSvg.setAttribute("height","100%");
  cutSvg.style.position = "absolute";
  cutSvg.style.inset = "0";
  cutSvg.style.pointerEvents = "none";
  cutSvg.style.zIndex = "10";
  overlayHost.appendChild(cutSvg);

  cutPoly = document.createElementNS("http://www.w3.org/2000/svg","polygon");
  cutPoly.setAttribute("fill","rgba(80,140,255,.20)");
  cutPoly.setAttribute("stroke","rgba(80,140,255,.45)");
  cutPoly.setAttribute("stroke-width","1");
  cutPoly.style.filter = "drop-shadow(0 6px 14px rgba(20,60,140,.18))";
  cutSvg.appendChild(cutPoly);

  cutAxis = document.createElementNS("http://www.w3.org/2000/svg","line");
  cutAxis.setAttribute("stroke","rgba(80,140,255,.65)");
  cutAxis.setAttribute("stroke-width","2");
  cutAxis.setAttribute("stroke-linecap","round");
  cutSvg.appendChild(cutAxis);
}

// Quad projeté qui couvre la bbox du modèle
function updateCutPlaneVisual(){
  if (!clipPlateWorld) { if (cutPoly) cutPoly.setAttribute("points",""); return; }

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
    const su = r[0]*u[0]+r[1]*u[1]+r[2]*u[2], sv = r[0]*v[0]+r[1]*v[1]+r[2]*v[2];
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
    cutAxis.setAttribute("x1", Au.x); cutAxis.setAttribute("y1", Au.y);
    cutAxis.setAttribute("x2", Bu.x); cutAxis.setAttribute("y2", Bu.y);
    cutAxis.style.display = "block";
  } else {
    cutAxis.style.display = "none";
  }
}

/* ---------- COUPE ---------- */
function setClipAxis(axis){
  const same = (clipAxis === axis);
  clipAxis = same ? null : axis;

  clipButtons.forEach(b => b.classList.toggle("btn-primary", !same && b.dataset.axis === clipAxis));

  if (clipPlane){ try{ clipPlane.destroy(); }catch{} clipPlane=null; }
  clipPlateWorld = null;

  if (!clipAxis){
    viewer.scene.sectionPlanesEnabled=false;
    if (cutPoly) cutPoly.setAttribute("points","");
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

/* ---------- TICK ---------- */
viewer.scene.on("tick", ()=>{
  if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) {
    viewer.scene.edgeMaterial.edgesEnabled = true;
  }
  updateCutPlaneVisual();
  updateAllMMLabels();
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
