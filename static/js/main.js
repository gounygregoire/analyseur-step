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

/* ===================== ANNOTATIONS MANUELLES (fiables) ===================== */

const annotPane = document.createElement("div");
annotPane.className = "pane";
annotPane.innerHTML = `
  <h4 style="margin:12px 0 10px">Annotations</h4>
  <div id="annotList" style="display:flex;flex-direction:column;gap:6px"></div>
  <div class="row mini" style="margin-top:6px; gap:8px">
    <button id="btnHideAllAnn" class="btn btn-outline mini">Tout cacher/montrer</button>
    <button id="btnClearAnn"   class="btn btn-danger mini">Tout supprimer</button>
  </div>`;
leftCard.appendChild(annotPane);

const annotListEl  = annotPane.querySelector("#annotList");
const btnHideAllAnn= annotPane.querySelector("#btnHideAllAnn");
const btnClearAnn  = annotPane.querySelector("#btnClearAnn");

let annCounter = 0;
const manualAnns = []; // {id, world:[x,y,z], el, visible, name}

function worldToCanvas(world){
  // 1) chemin le plus fiable : project() si dispo
  if (typeof viewer.camera.project === "function") {
    const out = viewer.camera.project(world, new Float32Array(4)); // clip coords
    const w = out[3] || 1;
    const nx = out[0] / w;     // NDC -1..+1
    const ny = out[1] / w;
    const x = (nx * 0.5 + 0.5) * overlayHost.clientWidth;
    const y = (1 - (ny * 0.5 + 0.5)) * overlayHost.clientHeight;
    return { x, y };
  }
  // 2) fallback: projection 4x4 (si la méthode n'existe pas)
  const mV = viewer.camera.viewMatrix;
  const mP = viewer.camera.projMatrix || viewer.camera.projectionMatrix;
  if (!mV || !mP) return null;
  const x = world[0], y = world[1], z = world[2];
  // v = V * [x,y,z,1]
  const vx = mV[0]*x + mV[4]*y + mV[8]*z  + mV[12];
  const vy = mV[1]*x + mV[5]*y + mV[9]*z  + mV[13];
  const vz = mV[2]*x + mV[6]*y + mV[10]*z + mV[14];
  const vw = mV[3]*x + mV[7]*y + mV[11]*z + mV[15];
  // c = P * v
  const cx = mP[0]*vx + mP[4]*vy + mP[8]*vz + mP[12]*vw;
  const cy = mP[1]*vx + mP[5]*vy + mP[9]*vz + mP[13]*vw;
  const cw = mP[3]*vx + mP[7]*vy + mP[11]*vz + mP[15]*vw;
  const nx = cx / cw, ny = cy / cw;
  return {
    x: (nx * 0.5 + 0.5) * overlayHost.clientWidth,
    y: (1 - (ny * 0.5 + 0.5)) * overlayHost.clientHeight
  };
}

function place(el, p){
  if (!p) { el.style.display = "none"; return; }
  el.style.display = "block";
  // centrer le marqueur
  el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -50%)`;
}

function setAnnotationLabelEl(el, text){
  const badge = document.createElement("div");
  badge.className = "xk-badge";
  badge.textContent = (text && text.trim()) || "Annotation";
  const label = el.querySelector(".ann-label");
  label.innerHTML = "";
  label.appendChild(badge);
}

function addAnnotationRow(entry){
  const row = document.createElement("div");
  row.className = "row mini";
  row.style.justifyContent = "space-between";
  row.dataset.aid = entry.id;
  row.innerHTML = `
    <span class="annot-name" style="font-size:12px">${entry.name}</span>
    <span>
      <button class="btn btn-outline mini" data-act="edit">Éditer</button>
      <button class="btn btn-outline mini" data-act="toggle">Cacher</button>
      <button class="btn btn-outline mini btn-danger" data-act="del">Suppr.</button>
    </span>`;
  annotListEl.appendChild(row);

  row.querySelector('[data-act="edit"]').addEventListener("click", ()=>{
    const current = row.querySelector(".annot-name").textContent.trim();
    const nv = prompt("Texte de l’annotation :", current);
    if (nv != null){
      setAnnotationLabelEl(entry.el, nv);
      row.querySelector(".annot-name").textContent = nv.trim() || entry.name;
      entry.name = nv.trim() || entry.name;
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

let allAnnHidden = false;
btnHideAllAnn.addEventListener("click", ()=>{
  allAnnHidden = !allAnnHidden;
  manualAnns.forEach(a=>{
    a.visible = !allAnnHidden;
    a.el.style.display = a.visible ? "block" : "none";
  });
});
btnClearAnn.addEventListener("click", ()=>{
  manualAnns.splice(0).forEach(a=> a.el.remove());
  annotListEl.innerHTML = "";
  allAnnHidden = false;
  annCounter = 0;
});

function createManualAnnotation(world){
  const id = "ann" + (++annCounter);
  const wrapper = document.createElement("div");
  wrapper.className = "ann";
  Object.assign(wrapper.style, {
    position:"absolute",
    transform:"translate(-9999px, -9999px)",
    willChange:"transform",
    pointerEvents:"auto",
    zIndex: "5"
  });

  // dot
  const dot = document.createElement("div");
  dot.className = "dot";
  wrapper.appendChild(dot);

  // label (input d'abord)
  const label = document.createElement("div");
  label.className = "ann-label";
  const input = document.createElement("input");
  input.className = "annot-input";
  input.placeholder = "Texte…";
  label.appendChild(input);
  wrapper.appendChild(label);

  overlayHost.appendChild(wrapper);
  input.focus();

  const entry = { id, world: world.slice(), el: wrapper, visible: true, name: `Annotation ${annCounter}` };
  manualAnns.push(entry);
  addAnnotationRow(entry);

  const commit = ()=>{
    const val = (input.value||"").trim();
    setAnnotationLabelEl(wrapper, val);
    const row = annotListEl.querySelector(`[data-aid="${id}"] .annot-name`);
    if (row) row.textContent = val || entry.name;
  };
  input.addEventListener("keydown",(e)=>{ if (e.key==="Enter"){ e.preventDefault(); input.blur(); } });
  input.addEventListener("blur", commit, {once:true});

  // placer tout de suite
  place(wrapper, worldToCanvas(entry.world));
}

/* — mise à jour des annotations à chaque frame — */
viewer.scene.on("tick", ()=>{
  for (const a of manualAnns){
    if (!a.visible) continue;
    place(a.el, worldToCanvas(a.world));
  }
});

/* ---------- clic scène ---------- */
viewer.scene.input.on("mouseclicked", (coords)=>{
  if (distanceCtrl.active) return; // mesure consomme le clic
  const hit = viewer.scene.pick({ canvasPos: coords, pickSurface: true });
  if (!hit || !hit.entity) { if (appMode==="select") clearSelection(); return; }
  if (appMode==="annotate"){ createManualAnnotation(hit.worldPos); return; }

  const id = hit.entity.id;
  setSome(allIds(),"highlighted",false);
  selectedIds = new Set([id]);
  setSome([id],"highlighted",true);
  showProps(hit.entity.metaObject || { id });
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
