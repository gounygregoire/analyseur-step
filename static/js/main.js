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

/* ====== Analyse: sélecteurs panneau (app.html Étape A) ====== */
const volVal  = $("#volVal");
const projVal = $("#projVal");
const tminVal = $("#tminVal");
const tmaxVal = $("#tmaxVal");
const axisX   = $("#axisX");
const axisY   = $("#axisY");
const axisZ   = $("#axisZ");
const projAxisRadios = $$('input[name="projAxis"]');  // X / Y / Z  :contentReference[oaicite:3]{index=3}

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

// On garde l’instance, mais on n’utilise plus le plugin pour la plaque
new AnnotationsPlugin(viewer, { container: overlayHost });

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

// partagées avec la plaque (SVG)
let clipPlateWorld = null;
let clipPlaneDir   = [1,0,0];

/* ====== Analyse: état courant ====== */
let currentFileId = null;         // défini par /upload  :contentReference[oaicite:4]{index=4}
let currentAxis   = "Z";          // défaut Z (orthographe majuscules pour l’API)
const getSelectedAxis = () => (axisX?.checked && "X") || (axisY?.checked && "Y") || "Z";

const setProgress=(p)=>{ if (progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; };
const allIds=()=> viewer.scene?.objectIds ?? [];
const setSome=(ids,prop,val)=> ids.forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const setAll=(prop,val)=> allIds().forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const clearSelection=()=>{ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); if (propsPanel) propsPanel.innerHTML=""; };

/* ---------- Mesures (affichage "mm" SANS conversion) ---------- */
const prettyNumber = (v) => {
  const abs = Math.abs(v);
  if (abs < 10)   return v.toFixed(2);
  if (abs < 100)  return v.toFixed(1);
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
};
// Xeokit fournit des mètres. On garde la valeur et on affiche "mm".
const formatMM = (meters) => `${prettyNumber(meters)} mm`;

const distancePlugin = new DistanceMeasurementsPlugin(viewer, {
  container: overlayHost,
  labelsShown: true,
  labelFormat: formatMM
});

const distanceCtrl = new DistanceMeasurementsMouseControl(distancePlugin, { snapping: true });
if ("snapDistance" in distanceCtrl) distanceCtrl.snapDistance = 0.001;
if ("snapRadius"   in distanceCtrl) distanceCtrl.snapRadius   = 3;
if ("snapToEdges"  in distanceCtrl) distanceCtrl.snapToEdges  = false;
if ("snapToVertices" in distanceCtrl) distanceCtrl.snapToVertices = true;
if ("snapping" in distanceCtrl) {
  window.addEventListener("keydown", (e)=>{ if (e.altKey) distanceCtrl.snapping = false; }, {passive:true});
  window.addEventListener("keyup",   (e)=>{ if (!e.altKey) distanceCtrl.snapping = true;  }, {passive:true});
}

/* ---- Forçage des labels : remplacer "m" par "mm" (sans *1000) ---- */
function textMetersToMM(txt) {
  return txt.replace(/(~?\s*)(-?\d+(?:[.,]\d+)?)\s*m(?!m)/gi, (_all, pre, num) => {
    const val = parseFloat(String(num).replace(',', '.'));
    if (isNaN(val)) return _all;
    const pretty = prettyNumber(val); // même valeur, juste formatée
    return `${pre}${pretty} mm`;
  });
}
function convertNodeTextToMM(root) {
  if (!root || root.nodeType !== 1) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const toEdit = [];
  while (walker.nextNode()) toEdit.push(walker.currentNode);
  for (const t of toEdit) {
    const newText = textMetersToMM(t.nodeValue);
    if (newText !== t.nodeValue) t.nodeValue = newText;
  }
}
const mmObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    m.addedNodes?.forEach((n) => { if (n.nodeType === 1) convertNodeTextToMM(n); });
    if (m.type === "characterData" && m.target?.parentElement) convertNodeTextToMM(m.target.parentElement);
  }
});
mmObserver.observe(overlayHost, { childList: true, subtree: true, characterData: true });
convertNodeTextToMM(overlayHost);
viewer.scene.on("tick", ()=> convertNodeTextToMM(overlayHost));

/* ====== Panneau "Mesures" ====== */
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
  btnT.addEventListener("click", ()=>{ m.visible = !m.visible; btnT.textContent = m.visible ? "Cacher" : "Montrer"; });
  btnD.addEventListener("click", ()=>{ try { m.destroy ? m.destroy() : distancePlugin.destroyMeasurement?.(m.id); } catch {} measMap.delete(id); row.remove(); });
}
["measurementCreated","newMeasurement","measurementAdded"].forEach(evt=>{
  distancePlugin.on?.(evt, (ev)=>{
    const meas = ev.measurement || ev;
    addMeasurementRow(meas);
    setTimeout(()=> convertNodeTextToMM(overlayHost), 0);
  });
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
function deactivateMeasure() { if (distanceCtrl.active) distanceCtrl.deactivate(); btnMeasure?.classList.remove("btn-primary"); }
function activateMeasure()   { distanceCtrl.activate();  btnMeasure?.classList.add("btn-primary"); }
function toggleMeasure()     { if (distanceCtrl.active) deactivateMeasure(); else activateMeasure(); }
btnMeasure?.addEventListener("click", toggleMeasure);
window.addEventListener("keydown", (e)=>{ if (e.key==="Escape" && distanceCtrl.active) deactivateMeasure(); }, {passive:true});
if (btnAnnot) { btnAnnot.style.display = "none"; btnAnnot.disabled = true; }

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

    // === Analyse: déclencher le fetch de stats à Z si on a un file_id ===
    try {
      currentAxis = getSelectedAxis(); // prend l'état des radios (Z par défaut)  :contentReference[oaicite:5]{index=5}
      if (currentFileId) { fetchStats(currentAxis, /*soft=*/false); }
    } catch (e) { console.warn("[analyse] fetch initial ignoré:", e); }
  });
  model.on("error", e=>{ console.error(e); setProgress(0); alert("Erreur chargement XKT."); });
  return id;
}

/* ---------- Upload / Conversion ---------- */
async function uploadAndShow(file){
  const f = file || fileInput?.files?.[0];
  if (!f){ alert("Choisis un fichier .step/.stp/.stl (ou .xkt)"); return; }
  if (fileNameLbl) fileNameLbl.textContent = f.name;
  if (btnVisualiser){ btnVisualiser.disabled=true; btnVisualiser.textContent="Conversion…"; }
  setProgress(12);
  try{
    if (/\.(xkt)$/i.test(f.name)) {
      // Chargement direct d'un XKT local : pas d'API d'analyse (pas de file_id)
      currentFileId = null;
      const fileURL = URL.createObjectURL(f);
      if (!chkAdditive?.checked){ for (const [,i] of models){ try{i.model.destroy();}catch{} } models.clear(); selectedIds.clear(); }
      await loadXKT(fileURL, f.name);
      return;
    }
    const fd=new FormData(); fd.append("file",f);
    const res=await fetch("/upload",{method:"POST",body:fd}); // renvoie {file_id, xkt_url}  :contentReference[oaicite:6]{index=6}
    const j=await res.json();
    if (!res.ok || !j.xkt_url) throw new Error(JSON.stringify(j));
    currentFileId = j.file_id || null; // <— on garde le file_id pour /api/shape/stats
    const xktUrl=new URL(j.xkt_url, location.origin).toString();
    if (!chkAdditive?.checked){ for (const [,i] of models){ try{i.model.destroy();}catch{} } models.clear(); selectedIds.clear(); }
    await loadXKT(xktUrl, f.name);
  }catch(e){ console.error(e); alert("Erreur conversion/chargement (voir Console)."); }
  finally{ if (btnVisualiser){ btnVisualiser.disabled=false; btnVisualiser.textContent="VISUALISER"; } }
}

/* ---------- FICHIERS UI (fiabilisé) ---------- */
function openFileChooser(){
  try{
    if (fileInput && !fileInput.disabled){
      if (typeof fileInput.showPicker === "function") {
        fileInput.showPicker();
      } else {
        fileInput.click();
      }
      return;
    }
    const tmp = document.createElement("input");
    tmp.type = "file";
    tmp.accept = ".step,.stp,.stl,.xkt,model/step,model/stl,application/octet-stream";
    tmp.style.position = "fixed";
    tmp.style.left = "-9999px";
    document.body.appendChild(tmp);
    tmp.addEventListener("change", ()=>{ if (tmp.files?.[0]) uploadAndShow(tmp.files[0]); tmp.remove(); });
    tmp.click();
  }catch(err){
    console.error(err);
    alert("Impossible d’ouvrir le sélecteur de fichiers (popup bloquée ?).");
  }
}
btnChoose?.setAttribute("type","button");
btnChoose?.setAttribute("tabindex","0");
btnChoose?.addEventListener("click",  (e)=>{ e.preventDefault(); openFileChooser(); });
btnChoose?.addEventListener("keydown",(e)=>{ if (e.key==="Enter"||e.key===" ") { e.preventDefault(); openFileChooser(); } });

fileInput?.addEventListener("change",()=>{
  const f=fileInput.files?.[0];
  if (f && fileNameLbl) fileNameLbl.textContent=f.name;
  if (f) uploadAndShow(f);
});
btnVisualiser?.addEventListener("click",(e)=>{ e.preventDefault(); uploadAndShow(); });

["dragenter","dragover"].forEach(ev=>{
  viewerContainer?.addEventListener(ev,(e)=>{ e.preventDefault(); e.dataTransfer.dropEffect="copy"; }, false);
});
viewerContainer?.addEventListener("drop",(e)=>{
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) uploadAndShow(f);
});

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

/* ====================== PLAQUE DE COUPE : quad SVG ====================== */
const cross = (a,b)=> [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot   = (a,b)=> a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const len   = (v)=> Math.hypot(v[0],v[1],v[2]) || 1;
const norm  = (v)=>{ const L=len(v); return [v[0]/L,v[1]/L,v[2]/L]; };
const add3  = (a,b)=> [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const mul3  = (v,s)=> [v[0]*s, v[1]*s, v[2]*s];

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

/* --- overlay SVG (quad + axe) --- */
let cutSvg = null, cutPoly = null, cutAxisLine = null;
function ensureCutSvg(){
  if (cutSvg) return;
  cutSvg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  cutSvg.setAttribute("width","100%");
  cutSvg.setAttribute("height","100%");
  Object.assign(cutSvg.style, { position:"absolute", inset:"0", pointerEvents:"none", zIndex:"10" });
  overlayHost.appendChild(cutSvg);

  cutPoly = document.createElementNS("http://www.w3.org/2000/svg","polygon");
  cutPoly.setAttribute("fill","rgba(80,140,255,.20)");
  cutPoly.setAttribute("stroke","rgba(80,140,255,.45)");
  cutPoly.setAttribute("stroke-width","1");
  cutPoly.style.filter = "drop-shadow(0 6px 14px rgba(20,60,140,.18))";
  cutSvg.appendChild(cutPoly);

  cutAxisLine = document.createElementNS("http://www.w3.org/2000/svg","line");
  cutAxisLine.setAttribute("stroke","rgba(80,140,255,.65)");
  cutAxisLine.setAttribute("stroke-width","2");
  cutAxisLine.setAttribute("stroke-linecap","round");
  cutSvg.appendChild(cutAxisLine);
}
// supprime totalement l’overlay pour éviter tout “trait” résiduel
function clearCutSvg(){
  try { cutSvg?.remove(); } catch {}
  cutSvg = null; cutPoly = null; cutAxisLine = null;
}

function updateCutPlaneVisual(){
  if (!clipPlateWorld) { if (cutPoly) cutPoly.setAttribute("points",""); return; }
  ensureCutSvg();

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
    const su = dot(r,u), sv = dot(r,v);
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
    cutAxisLine.setAttribute("x1", Au.x); cutAxisLine.setAttribute("y1", Au.y);
    cutAxisLine.setAttribute("x2", Bu.x); cutAxisLine.setAttribute("y2", Bu.y);
    cutAxisLine.style.display = "block";
  } else {
    cutAxisLine.style.display = "none";
  }
}

/* ---------- COUPE ---------- */
function setClipAxis(axis){
  const same = (clipAxis === axis);
  clipAxis = same ? null : axis;

  clipButtons.forEach(b => b.classList.toggle("btn-primary", !same && b.dataset.axis === clipAxis));

  if (clipPlane){ try{ clipPlane.destroy(); }catch{} clipPlane=null; }
  try { sections.clear?.(); } catch {}

  clipPlateWorld = null;

  if (!clipAxis){
    viewer.scene.sectionPlanesEnabled=false;
    clearCutSvg(); // <— plus de trait bleu
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

viewer.scene.on("tick", ()=>{
  if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) {
    viewer.scene.edgeMaterial.edgesEnabled = true;
  }
  updateCutPlaneVisual();
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

/* ==================== ANALYSE : fetch & rendu ==================== */
/** Met à jour le panneau Analyse avec les valeurs JSON reçues (aucune conversion côté front). */
function renderStats(json){
  if (!json || typeof json !== "object") return;
  if (volVal)  volVal.textContent  = (json.volume_cm3 ?? "—");
  if (projVal) projVal.textContent = (json.projected_area_cm2 ?? "—");
  if (tminVal) tminVal.textContent = (json.thickness_min_mm ?? "—");
  if (tmaxVal) tmaxVal.textContent = (json.thickness_max_mm ?? "—");
}

/**
 * Récupère les stats serveur pour un file_id donné.
 * @param {('X'|'Y'|'Z')} axis
 * @param {boolean} soft - si true, on n'alerte pas en cas d'absence de file_id (ex: XKT local)
 */
async function fetchStats(fileId, axis = 'Z') {
  try {
    const res = await fetch(`/api/shape/stats?file_id=${encodeURIComponent(fileId)}&axis=${axis}`, { cache: 'no-store' });
    const data = await res.json();

    if (res.status === 200 && data && typeof data.volume_cm3 !== 'undefined') {
      // ✅ mettre à jour l’UI
      document.querySelector('[data-metric="volume"]').textContent         = Number(data.volume_cm3).toFixed(3);
      document.querySelector('[data-metric="tmin"]').textContent           = Number(data.thickness_min_mm).toFixed(3);
      document.querySelector('[data-metric="tmax"]').textContent           = Number(data.thickness_max_mm).toFixed(3);
      document.querySelector('[data-metric="projected_area"]').textContent = Number(data.projected_area_cm2).toFixed(3);
      return;
    }

    // Tant que le job n'est pas fini on repoll
    if (res.status === 202 && data && (data.status === 'queued' || data.status === 'processing')) {
      const delayMs = ((data.retry_in_sec ?? 2) * 1000);
      setTimeout(() => fetchStats(fileId, axis), delayMs);
      return;
    }

    // Cas d'erreur : log utile pour diag
    console.warn('[analyse] erreur API', res.status, data);

  } catch (err) {
    console.error('[analyse] fetchStats failed', err);
  }
}



/* Radios X/Y/Z → met à jour uniquement la Surface projetée (les autres valeurs sont indépendantes de l’axe) */
projAxisRadios.forEach(r => r?.addEventListener("change", ()=>{
  const ax = getSelectedAxis();
  currentAxis = ax;
  fetchStats(ax);
}));
