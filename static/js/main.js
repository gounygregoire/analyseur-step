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
const btnAnnot     = $("#btnAnnot");           // on va le masquer
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
  dracoDecompressorPath: "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});
const sections = new SectionPlanesPlugin(viewer);
new AnnotationsPlugin(viewer, { container: overlayHost }); // instance conservée

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
let clipAxis = null;
let clipPlane = null;

// partagées avec la plaque (SVG)
let clipPlateWorld = null;            // centre 3D du plan
let clipPlaneDir   = [1,0,0];         // normale du plan

const setProgress=(p)=>{ if (progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; };
const allIds=()=> viewer.scene?.objectIds ?? [];
const setSome=(ids,prop,val)=> ids.forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const setAll=(prop,val)=> allIds().forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const clearSelection=()=>{ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); if (propsPanel) propsPanel.innerHTML=""; };

/* ===================== MESURES — cotes en mm + snap “ALT” ===================== */
const MM_PER_M = 1000;
const mmNumber = (mm) => {
  const abs = Math.abs(mm);
  if (abs < 10)   return mm.toFixed(2);
  if (abs < 100)  return mm.toFixed(1);
  return Math.round(mm).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
};

// 1) Labels du plugin visibles (TOTAL), formatés en mm
const distancePlugin = new DistanceMeasurementsPlugin(viewer, {
  container: overlayHost,
  labelsShown: true,
  axisLabelsShown: true, // ignoré si non supporté par la version
  labelFormat: (meters) => `${mmNumber(meters * MM_PER_M)} mm`
});

// 2) Contrôle : aimantation douce et *opt-in* (ALT)
const distanceCtrl = new DistanceMeasurementsMouseControl(distancePlugin, { snapping: false });
if ("snapRadius"   in distanceCtrl) distanceCtrl.snapRadius   = 2;        // 2 px
if ("snapDistance" in distanceCtrl) distanceCtrl.snapDistance = 0.001;    // 1 mm (monde)
if ("snapToEdges"  in distanceCtrl) distanceCtrl.snapToEdges  = false;
if ("snapToVertices" in distanceCtrl) distanceCtrl.snapToVertices = true;
if ("snapping" in distanceCtrl) {
  addEventListener("keydown", (e)=>{ if (e.altKey) distanceCtrl.snapping = true;  }, {passive:true});
  addEventListener("keyup",   (e)=>{ if (!e.altKey) distanceCtrl.snapping = false; }, {passive:true});
}

// 3) Observer DOM pour convertir toute étiquette “m” → “mm” (X/Y/Z inclus)
const metersToMMInText = (txt) =>
  txt.replace(/(-?\d+(?:\.\d+)?)\s*m\b/g, (_, num) =>
    `${mmNumber(parseFloat(num) * MM_PER_M)} mm`
  );

function convertNodeTextToMM(root) {
  if (!root || root.nodeType !== 1) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const t of nodes) {
    const newText = metersToMMInText(t.nodeValue);
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

// Toggle mesure
function deactivateMeasure(){ if(distanceCtrl.active) distanceCtrl.deactivate(); btnMeasure?.classList.remove("btn-primary"); }
function activateMeasure(){ distanceCtrl.activate(); btnMeasure?.classList.add("btn-primary"); }
function toggleMeasure(){ distanceCtrl.active?deactivateMeasure():activateMeasure(); }
btnMeasure?.addEventListener("click", toggleMeasure);
addEventListener("keydown",(e)=>{ if(e.key==="Escape" && distanceCtrl.active) deactivateMeasure(); },{passive:true});

// Masquer le bouton Annotation (définitivement)
if (btnAnnot) { btnAnnot.style.display = "none"; btnAnnot.disabled = true; }

/* ====================== Panneau “Mesures” (liste simple) ====================== */
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
  const id=getMeasId(m);
  if(!measMap.has(id)){ measCounter+=1; measMap.set(id,{m,name:`Mesure ${measCounter}`}); }
  const {name}=measMap.get(id);
  if (measureListEl.querySelector(`[data-mid="${id}"]`)) return;

  const row=document.createElement("div");
  row.className="row mini"; row.dataset.mid=id; row.style.justifyContent="space-between";
  row.innerHTML=`<span class="measure-name" style="font-size:12px">${name}</span>
    <span><button class="btn btn-outline mini" data-act="toggle">Cacher</button>
    <button class="btn btn-outline mini btn-danger" data-act="del">Suppr.</button></span>`;
  measureListEl.appendChild(row);

  const btnT=row.querySelector('[data-act="toggle"]');
  const btnD=row.querySelector('[data-act="del"]');
  btnT.addEventListener("click",()=>{
    if ("visible" in m) { m.visible = !m.visible; }
    btnT.textContent = ("visible" in m) ? (m.visible ? "Cacher" : "Montrer") : (btnT.textContent==="Cacher"?"Montrer":"Cacher");
  });
  btnD.addEventListener("click",()=>{
    try{ m.destroy?m.destroy():distancePlugin.destroyMeasurement?.(m.id);}catch{}
    measMap.delete(id); row.remove();
  });
}
["measurementCreated","newMeasurement","measurementAdded"].forEach(evt=>{
  distancePlugin.on?.(evt, (ev)=> addMeasurementRow(ev.measurement||ev));
});
distancePlugin.on?.("measurementDestroyed",(ev)=>{
  const m=ev.measurement||ev, id=getMeasId(m);
  measureListEl.querySelector(`[data-mid="${id}"]`)?.remove(); measMap.delete(id);
});

let allHidden=false;
btnHideAll.addEventListener("click",()=>{
  allHidden=!allHidden;
  for (const {m} of measMap.values()){
    if ("visible" in m) m.visible = !allHidden;
  }
});
btnClearMeas.addEventListener("click",()=>{
  if (typeof distancePlugin.clear==="function") distancePlugin.clear();
  else if (typeof distancePlugin.destroyAll==="function") distancePlugin.destroyAll();
  measureListEl.innerHTML=""; measMap.clear(); measCounter=0; allHidden=false;
});

/* ====================== Projection world -> overlay (utilisée par la coupe) ====================== */
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

/* ====================== PLAQUE DE COUPE : quad SVG en perspective ====================== */
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot  =(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm =(v)=>{const L=Math.hypot(v[0],v[1],v[2])||1;return [v[0]/L,v[1]/L,v[2]/L];};
const add3 =(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const mul3 =(v,s)=>[v[0]*s,v[1]*s,v[2]*s];

/* --- overlay SVG (quad + axe) --- */
let cutSvg=null,cutPoly=null,cutAxis=null;
function ensureCutSvg(){
  if (cutSvg) return;
  cutSvg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  cutSvg.setAttribute("width","100%"); cutSvg.setAttribute("height","100%");
  Object.assign(cutSvg.style,{position:"absolute",inset:"0",pointerEvents:"none",zIndex:"10"});
  overlayHost.appendChild(cutSvg);
  cutPoly=document.createElementNS("http://www.w3.org/2000/svg","polygon");
  cutPoly.setAttribute("fill","rgba(80,140,255,.20)");
  cutPoly.setAttribute("stroke","rgba(80,140,255,.45)");
  cutPoly.setAttribute("stroke-width","1");
  cutPoly.style.filter="drop-shadow(0 6px 14px rgba(20,60,140,.18))";
  cutSvg.appendChild(cutPoly);
  cutAxis=document.createElementNS("http://www.w3.org/2000/svg","line");
  cutAxis.setAttribute("stroke","rgba(80,140,255,.65)");
  cutAxis.setAttribute("stroke-width","2");
  cutAxis.setAttribute("stroke-linecap","round");
  cutSvg.appendChild(cutAxis);
}
function updateCutPlaneVisual(){
  if (!clipPlateWorld){ if(cutPoly) cutPoly.setAttribute("points",""); return; }
  ensureCutSvg();
  const n=norm(clipPlaneDir); let up=[0,1,0]; if(Math.abs(dot(up,n))>0.95) up=[1,0,0];
  const u=norm(cross(up,n)), v=norm(cross(n,u));
  const aabb=viewer.scene?.aabb||[0,0,0,0,0,0];
  const corners=[[aabb[0],aabb[1],aabb[2]],[aabb[3],aabb[1],aabb[2]],[aabb[0],aabb[4],aabb[2]],[aabb[3],aabb[4],aabb[2]],
                 [aabb[0],aabb[1],aabb[5]],[aabb[3],aabb[1],aabb[5]],[aabb[0],aabb[4],aabb[5]],[aabb[3],aabb[4],aabb[5]]];
  let minU=+Infinity,maxU=-Infinity,minV=+Infinity,maxV=-Infinity;
  for(const p of corners){
    const r=[p[0]-clipPlateWorld[0],p[1]-clipPlateWorld[1],p[2]-clipPlateWorld[2]];
    const su=r[0]*u[0]+r[1]*u[1]+r[2]*u[2], sv=r[0]*v[0]+r[1]*v[1]+r[2]*v[2];
    if(su<minU)minU=su; if(su>maxU)maxU=su; if(sv<minV)minV=sv; if(sv>maxV)maxV=sv;
  }
  const SCALE=0.92, halfU=Math.max((maxU-minU)*0.5*SCALE,1e-3), halfV=Math.max((maxV-minV)*0.5*SCALE,1e-3);
  const P0=add3(add3(clipPlateWorld,mul3(u,-halfU)),mul3(v,-halfV));
  const P1=add3(add3(clipPlateWorld,mul3(u, halfU)),mul3(v,-halfV));
  const P2=add3(add3(clipPlateWorld,mul3(u, halfU)),mul3(v, halfV));
  const P3=add3(add3(clipPlateWorld,mul3(u,-halfU)),mul3(v, halfV));
  const q0=worldToOverlayXY(P0),q1=worldToOverlayXY(P1),q2=worldToOverlayXY(P2),q3=worldToOverlayXY(P3);
  if(!q0||!q1||!q2||!q3){ cutPoly.setAttribute("points",""); return; }
  cutPoly.setAttribute("points",`${q0.x},${q0.y} ${q1.x},${q1.y} ${q2.x},${q2.y} ${q3.x},${q3.y}`);
  const Au=worldToOverlayXY(add3(clipPlateWorld,mul3(u,halfU*0.55)));
  const Bu=worldToOverlayXY(add3(clipPlateWorld,mul3(u,-halfU*0.55)));
  if(Au&&Bu){ cutAxis.setAttribute("x1",Au.x);cutAxis.setAttribute("y1",Au.y);
              cutAxis.setAttribute("x2",Bu.x);cutAxis.setAttribute("y2",Bu.y);cutAxis.style.display="block"; }
  else      { cutAxis.style.display="none"; }
}

/* ---------- COUPE ---------- */
function setClipAxis(axis){
  const same=(clipAxis===axis);
  clipAxis=same?null:axis;
  clipButtons.forEach(b=>b.classList.toggle("btn-primary",!same&&b.dataset.axis===clipAxis));
  if(clipPlane){ try{clipPlane.destroy();}catch{} clipPlane=null; }
  clipPlateWorld=null;
  if(!clipAxis){
    viewer.scene.sectionPlanesEnabled=false;
    if(cutPoly) cutPoly.setAttribute("points","");
    return;
  }
  const aabb=viewer.scene?.aabb||[0,0,0,0,0,0];
  const center=[(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  clipPlaneDir=(clipAxis==="x")?[1,0,0]:(clipAxis==="y")?[0,1,0]:[0,0,1];
  clipPlane=sections.createSectionPlane({id:"cut",pos:center,dir:clipPlaneDir});
  viewer.scene.sectionPlanesEnabled=true;
  clipPlateWorld=center.slice();
  clipRange.value="0";
  updateCutPlaneVisual();
}
clipButtons.forEach(b=>b.addEventListener("click",()=>setClipAxis(b.dataset.axis)));

clipRange?.addEventListener("input",()=>{
  if(!clipPlane||!clipAxis) return;
  const k=parseFloat(clipRange.value)||0;
  const aabb=viewer.scene?.aabb||[0,0,0,0,0,0];
  const center=[(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  const half=[(aabb[3]-aabb[0])/2,(aabb[4]-aabb[1])/2,(aabb[5]-aabb[2])/2];
  const shift=(clipAxis==="x"?half[0]:clipAxis==="y"?half[1]:half[2])*(k/100);
  const pos=center.slice();
  if(clipAxis==="x") pos[0]+=shift; else if(clipAxis==="y") pos[1]+=shift; else pos[2]+=shift;
  clipPlane.pos=pos; clipPlateWorld=pos; updateCutPlaneVisual();
});

/* ---------- TICK : plaque + arêtes (labels mm gérés par l'observer) ---------- */
viewer.scene.on("tick", ()=>{
  if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) {
    viewer.scene.edgeMaterial.edgesEnabled = true;
  }
  updateCutPlaneVisual();
});

/* ---------- Switchs d’affichage ---------- */
chkXray ?.addEventListener("change",()=>{ setAll("xrayed",!!chkXray.checked);  setSome([...selectedIds],"xrayed",false); });
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
