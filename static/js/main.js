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

// Overlays HTML (annotations perso)
const annotations = new AnnotationsPlugin(viewer, { container: overlayHost });

/* ========= Canvas & overlay sizing — DPR sûr ========= */
const canvasEl = document.getElementById("xeokit-canvas");
function resizeCanvasAndOverlay() {
  const w = Math.max(1, viewerContainer.clientWidth);
  const h = Math.max(1, viewerContainer.clientHeight);
  const dpr = 1; // simple & infaillible

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

/* ---------- Mesures natives Xeokit (mm) + panneau de gestion ---------- */
const distancePlugin = new DistanceMeasurementsPlugin(viewer, {
  container: overlayHost,
  labelsShown: true,
  // mm souhaités
  labelFormat: (meters) => `${(meters * 1000).toFixed(2)} mm`
});
const distanceCtrl = new DistanceMeasurementsMouseControl(distancePlugin, { snapping: true });

/* Dédup & noms “Mesure 1/2/3” */
const seenMeas = new Set();        // ids déjà listés UI
const measMap  = new Map();        // id -> {m, name}
let measCounter = 0;

function getMeasId(m){
  return m.id || m._id || (m.__uiId ?? (m.__uiId = "m"+Date.now().toString(36)+Math.random().toString(36).slice(2,6)));
}

/* Panneau "Mesures" */
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

let allHidden = false;
btnHideAll.addEventListener("click", ()=>{
  allHidden = !allHidden;
  for (const {m} of measMap.values()) { m.visible = !allHidden; }
});

btnClearMeas.addEventListener("click", ()=>{
  if (typeof distancePlugin.clear === "function") distancePlugin.clear();
  else if (typeof distancePlugin.destroyAll === "function") distancePlugin.destroyAll();
  measureListEl.innerHTML = "";
  seenMeas.clear(); measMap.clear(); measCounter = 0;
});

/* UI par mesure */
function addMeasurementRow(m){
  const id = getMeasId(m);
  if (seenMeas.has(id)) return;      // évite les doublons
  seenMeas.add(id);

  if (!measMap.has(id)) {
    measCounter += 1;
    measMap.set(id, { m, name: `Mesure ${measCounter}` });
  }
  const { name } = measMap.get(id);

  const row = document.createElement("div");
  row.className = "row mini";
  row.dataset.mid = id;
  row.style.justifyContent = "space-between";
  row.innerHTML = `
    <span style="font-size:12px">${name}</span>
    <span>
      <button class="btn btn-outline mini" data-act="toggle">Cacher</button>
      <button class="btn btn-outline mini btn-danger" data-act="del">Suppr.</button>
    </span>`;
  measureListEl.appendChild(row);

  const btnT = row.querySelector('[data-act="toggle"]');
  const btnD = row.querySelector('[data-act="del"]');

  btnT.addEventListener("click", ()=>{
    m.visible = !m.visible;
    btnT.textContent = m.visible ? "Cacher" : "Montrer";
  });
  btnD.addEventListener("click", ()=>{
    try { m.destroy ? m.destroy() : distancePlugin.destroyMeasurement?.(m.id); } catch {}
    measMap.delete(id);
    seenMeas.delete(id);
    row.remove();
  });
}

/* Branchements (différentes versions émettent des noms d’événements différents) */
const addRowFromEvent = (ev)=> addMeasurementRow(ev.measurement || ev);
["measurementCreated","newMeasurement","measurementAdded"].forEach(evt=>{
  distancePlugin.on?.(evt, addRowFromEvent);
});
distancePlugin.on?.("measurementDestroyed", (ev)=>{
  const m = ev.measurement || ev;
  const id = getMeasId(m);
  const row = measureListEl.querySelector(`[data-mid="${id}"]`);
  if (row) row.remove();
  measMap.delete(id);
  seenMeas.delete(id);
});

/* Conversion robuste des labels “m” -> “mm” (fallback DOM) */
function convertLabelsIn(node){
  if (!node || node.nodeType !== 1) return;
  const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
  const re = /(-?\d+(?:\.\d+)?)\s*m\b/;
  const reGlobal = /(-?\d+(?:\.\d+)?)\s*m\b/g;
  const toUpdate = [];
  while (tw.nextNode()){
    const t = tw.currentNode;
    if (re.test(t.nodeValue)) toUpdate.push(t);
  }
  for (const t of toUpdate){
    t.nodeValue = t.nodeValue.replace(reGlobal, (_, num)=> `${(parseFloat(num)*1000).toFixed(2)} mm`);
  }
}
const mo = new MutationObserver((mutations)=>{
  for (const m of mutations){
    m.addedNodes?.forEach(n=> convertLabelsIn(n));
    if (m.type === "characterData") convertLabelsIn(m.target.parentNode);
  }
});
mo.observe(overlayHost, { childList:true, subtree:true, characterData:true });
convertLabelsIn(overlayHost); // premier passage

/* Toggle mesure (activate/deactivate) */
function setMeasureActive(on){
  if (on) { distanceCtrl.activate();  btnMeasure?.classList.add("btn-primary"); }
  else    { distanceCtrl.deactivate();btnMeasure?.classList.remove("btn-primary"); }
}
btnMeasure?.addEventListener("click", ()=> setMeasureActive(!distanceCtrl.active));
window.addEventListener("keydown", (e)=>{ if (e.key==="Escape" && distanceCtrl.active) setMeasureActive(false); });

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
fileInput?.addEventListener("change",()=>{
  const f=fileInput.files?.[0];
  if (f && fileNameLbl) fileNameLbl.textContent=f.name;
  if (f) uploadAndShow();
});
btnVisualiser?.addEventListener("click",(e)=>{ e.preventDefault(); uploadAndShow(); });

/* ---------- nav & rendu ---------- */
btnFit?.addEventListener("click", ()=> viewer.cameraFlight.flyTo(viewer.scene));
let proj="perspective";
btnProj?.addEventListener("click",()=>{
  proj = proj==="perspective" ? "ortho" : "perspective";
  viewer.camera.projection=proj;
  btnProj.textContent = proj==="perspective" ? "PERSPECTIVE" : "ORTHOGRAPHIQUE";
});

chkEdges?.addEventListener("change",()=> viewer.scene.edgeMaterial.edgesEnabled=!!chkEdges.checked);
viewer.scene.on("tick",()=>{ if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) viewer.scene.edgeMaterial.edgesEnabled=true; });

chkXray ?.addEventListener("change",()=>{ setAll("xrayed", !!chkXray.checked);  setSome([...selectedIds],"xrayed",false); });
chkGhost?.addEventListener("change",()=>{ setAll("ghosted",!!chkGhost.checked); setSome([...selectedIds],"ghosted",false); });
chkTheme?.addEventListener("change",()=> viewerShell?.classList.toggle("dark",!!chkTheme.checked));
opacityRange?.addEventListener("input",()=> setAll("opacity", parseFloat(opacityRange.value)||1));

/* ---------- recherche ---------- */
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

/* ---------- iso/cacher/montrer ---------- */
btnIsolate ?.addEventListener("click",()=>{ if (!selectedIds.size) return; setAll("visible",false); setSome([...selectedIds],"visible",true); });
btnHide    ?.addEventListener("click",()=>{ if (!selectedIds.size) return; setSome([...selectedIds],"visible",false); });
btnShowOnly?.addEventListener("click",()=>{ if (!selectedIds.size) return; setAll("visible",false); setSome([...selectedIds],"visible",true); });
btnClearSel?.addEventListener("click",()=>{ setAll("visible",true); setSome(allIds(),"highlighted",false); clearSelection(); });

/* ---------- modes / clic scène ---------- */
function setMode(m){
  appMode = (appMode===m) ? "select" : m;
  btnAnnot?.classList.toggle("btn-primary", appMode==="annotate");
}
btnAnnot?.addEventListener("click",()=> setMode("annotate"));

viewer.scene.input.on("mouseclicked", (coords)=>{
  if (distanceCtrl.active) return; // la mesure consomme le clic

  const hit = viewer.scene.pick({ canvasPos: coords, pickSurface: true });
  if (!hit || !hit.entity) {
    if (appMode==="select") clearSelection();
    return;
  }

  if (appMode==="annotate"){ handleAnnotClick(hit.worldPos); return; }

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

/* ---------- ANNOTATION : saisie inline ---------- */
function handleAnnotClick(worldPos){
  setMode("select");
  const id="a"+Date.now();
  const ann = annotations.createAnnotation({
    id,
    worldPos,
    markerHTML:`<div class="dot"></div>`,
    labelHTML:`<input class="annot-input" placeholder="Texte…" />`,
    labelShown:true
  });
  const input = overlayHost.querySelector(`[data-annotation_id="${id}"] .annot-input`);
  if (!input) return;
  input.focus();
  const commit=()=>{
    const val=(input.value||"Note");
    ann.setLabelHTML?.(`<div class="xk-badge">${val}</div>`) || (ann.labelHTML=`<div class="xk-badge">${val}</div>`);
  };
  input.addEventListener("keydown",(e)=>{ if (e.key==="Enter"){ e.preventDefault(); input.blur(); } });
  input.addEventListener("blur", commit, {once:true});
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

  clipPlateAnn = annotations.createAnnotation({
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
  if (clipPlateAnn?.setWorldPos) clipPlateAnn.setWorldPos(pos); else clipPlateAnn.worldPos=pos;
});

/* ---------- Screenshot ---------- */
btnShot?.addEventListener("click",()=>{
  try{
    const dataURL=canvasEl.toDataURL("image/png");
    const a=document.createElement("a"); a.href=dataURL; a.download="cadlytics_view.png"; a.click();
  }catch(e){ console.error(e); alert("Capture impossible."); }
});
