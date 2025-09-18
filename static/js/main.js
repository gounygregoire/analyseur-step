import {
  Viewer,
  XKTLoaderPlugin,
  NavCubePlugin,
  FastNavPlugin,
  SectionPlanesPlugin,
  AnnotationsPlugin
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

const $ = (s) => document.querySelector(s);

/* ====== Références UI (existantes dans app.html) ====== */
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

/* ====== Viewer & plugins ====== */
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  transparent: true,
  dtxEnabled: true
});
const loader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath: "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});
new FastNavPlugin(viewer,{ flyToDuration: .9, autoHideEdges: false, hideEdges: false });

/* Annotations (overlays HTML) */
const ann = new AnnotationsPlugin(viewer);

/* Section planes */
const sections = new SectionPlanesPlugin(viewer,{});

/* ====== petit style pour les overlays ====== */
{
  const css = `
  .anno-dot{width:10px;height:10px;border-radius:999px;border:2px solid #fff;
            box-shadow:0 0 0 2px rgba(0,0,0,.2)}
  .anno-dot.red{background:#ef4444}.anno-dot.blue{background:#3b82f6}
  .anno-bubble{padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.65);
               color:#fff;font:12px/1.2 Inter,system-ui,Segoe UI,Roboto,Arial;
               box-shadow:0 6px 20px rgba(0,0,0,.25)}
  .plane-hint{width:140px;height:140px;border-radius:8px;pointer-events:none;
              border:1px dashed;opacity:.9}
  .plane-x{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.7)}
  .plane-y{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.7)}
  .plane-z{background:rgba(96,165,250,.16);border-color:rgba(96,165,250,.7)}
  `;
  const style=document.createElement("style"); style.textContent=css; document.head.appendChild(style);
}

/* ====== cube d’axes + légende ====== */
(() => {
  const c = document.createElement("canvas");
  c.width=c.height=96;
  Object.assign(c.style,{position:"absolute",left:"12px",top:"12px",zIndex:5,
    borderRadius:"12px",boxShadow:"0 6px 18px rgba(0,0,0,.25)",background:"rgba(255,255,255,.06)",backdropFilter:"blur(2px)"});
  viewerContainer.appendChild(c);
  new NavCubePlugin(viewer,{canvasElement:c,cameraFlyToDuration:.9});
  const leg=document.createElement("div");
  leg.innerHTML=`<span style="color:#ef4444;font-weight:600">X</span>
                 <span style="color:#22c55e;font-weight:600;margin:0 6px">Y</span>
                 <span style="color:#60a5fa;font-weight:600">Z</span>`;
  Object.assign(leg.style,{position:"absolute",left:"12px",top:"114px",zIndex:6,
    padding:"4px 8px",background:"rgba(0,0,0,.35)",color:"#fff",borderRadius:"8px",
    font:"12px/1 Inter,system-ui,Segoe UI,Roboto,Arial"});
  viewerContainer.appendChild(leg);
})();

/* ====== état & helpers ====== */
const models = new Map();
let lastModelId=null;
let selectedIds = new Set();

const allIds = ()=> viewer.scene?.objectIds ?? [];
const setAll  = (prop,val)=> allIds().forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; });
const setSome = (ids,prop,val)=> ids.forEach(id=>{ const o=viewer.scene.objects[id]; if(o) o[prop]=val; });

function setProgress(p){ if(progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; }
function clearSelection(){ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); propsPanel&&(propsPanel.innerHTML=""); }

/* ====== MODE ====== */
let mode="none";
function setMode(m){
  mode = (mode===m)? "none" : m;
  btnMeasure?.classList.toggle("btn-primary",mode==="measure");
  btnAnnot?.classList.toggle("btn-primary",  mode==="annot");
  btnClip?.classList.toggle("btn-primary",   mode==="clip");
  viewerContainer.style.cursor = (mode==="measure"||mode==="annot"||mode==="clip")? "crosshair":"";
  if (mode!=="clip") disableClipping();
}
window.addEventListener("keydown",(e)=>{ if(e.key==="Escape") setMode("none"); });

/* ====== MEASURE (2 clics) ====== */
let firstPoint = null;
const overlayMeasures = new Set();
function addMeasureOverlay(p1,p2){
  const mid=[(p1[0]+p2[0])/2,(p1[1]+p2[1])/2,(p1[2]+p2[2])/2];
  const d = Math.hypot(p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]);
  const txt = d>=1 ? `${d.toFixed(3)} m` : `${(d*1000).toFixed(1)} mm`;
  const a1 = ann.createAnnotation({ worldPos:p1, occludable:true,  markerHTML:`<div class="anno-dot red"></div>`  });
  const a2 = ann.createAnnotation({ worldPos:p2, occludable:true,  markerHTML:`<div class="anno-dot blue"></div>` });
  const lab = ann.createAnnotation({ worldPos:mid, occludable:false, markerHTML:`<div class="anno-bubble">${txt}</div>` });
  overlayMeasures.add(a1); overlayMeasures.add(a2); overlayMeasures.add(lab);
}
btnMeasure?.addEventListener("click",()=>{ firstPoint=null; setMode("measure"); });

/* ====== ANNOTATION (1 clic) ====== */
btnAnnot?.addEventListener("click",()=> setMode("annot"));

/* ====== COUPE (1 axe à la fois, aucun sélectionné par défaut) ====== */
let planeX=null, planeY=null, planeZ=null, activeAxis=null, hint=null;
function ensurePlanes(){
  if (planeX && planeY && planeZ) return;
  const c = viewer.scene?.aabbCenter || [0,0,0];
  planeX = sections.createSectionPlane({ id:"cutX", pos:c.slice(), dir:[ 1,0,0] });
  planeY = sections.createSectionPlane({ id:"cutY", pos:c.slice(), dir:[ 0,1,0] });
  planeZ = sections.createSectionPlane({ id:"cutZ", pos:c.slice(), dir:[ 0,0,1] });
}
function disableClipping(){
  viewer.scene.sectionPlanesEnabled=false;
  activeAxis=null;
  if (hint){ ann.destroyAnnotation(hint); hint=null; }
}
function setPlanePos(axis, t){
  // t in [-1..1] sur l’étendue de l’AABB
  const bb=viewer.scene.aabb, c=[(bb[0]+bb[3])/2,(bb[1]+bb[4])/2,(bb[2]+bb[5])/2];
  const half=[(bb[3]-bb[0])/2,(bb[4]-bb[1])/2,(bb[5]-bb[2])/2];
  ensurePlanes();
  if (hint){ ann.destroyAnnotation(hint); hint=null; }
  if (axis==="x"){ planeX.pos=[c[0]+t*half[0],c[1],c[2]]; hint = ann.createAnnotation({ worldPos:planeX.pos, markerHTML:`<div class="plane-hint plane-x"></div>`, occludable:false }); }
  if (axis==="y"){ planeY.pos=[c[0],c[1]+t*half[1],c[2]]; hint = ann.createAnnotation({ worldPos:planeY.pos, markerHTML:`<div class="plane-hint plane-y"></div>`, occludable:false }); }
  if (axis==="z"){ planeZ.pos=[c[0],c[1],c[2]+t*half[2]]; hint = ann.createAnnotation({ worldPos:planeZ.pos, markerHTML:`<div class="plane-hint plane-z"></div>`, occludable:false }); }
  viewer.scene.sectionPlanesEnabled=true;
}
btnClip?.addEventListener("click",()=>{ setMode("clip"); /* aucun axe sélectionné ici */ });
/* lie ces 3 data-axes dans ton HTML (ex: <button data-axis="x" id="clipX">X</button> etc.)
   Si tu n’as pas ces boutons, garde le slider/existant et déclenche ci-dessous en conséquence. */
["x","y","z"].forEach(ax=>{
  const b = document.querySelector(`[data-axis="${ax}"]`);
  if (!b) return;
  b.addEventListener("click",()=>{
    if (mode!=="clip"){ setMode("clip"); }
    if (activeAxis===ax){ disableClipping(); return; } // toggle OFF
    activeAxis=ax;
    setPlanePos(activeAxis, 0); // centre au départ
  });
});
const clipRange = document.getElementById("clipRange");
clipRange?.addEventListener("input", ()=>{
  if (mode!=="clip" || !activeAxis) return;
  const t = Math.max(-1, Math.min(1, (parseFloat(clipRange.value)||0)/100));
  setPlanePos(activeAxis,t);
});

/* ====== PICK ROUTER ====== */
viewer.scene.input.on("mouseclicked",(coords)=>{
  const hit = viewer.scene.pick({ canvasPos:[coords[0],coords[1]], pickSurface:true });

  if (mode==="measure"){
    if (hit?.worldPos){
      if (!firstPoint){ firstPoint = hit.worldPos.slice(); ann.createAnnotation({worldPos:firstPoint, markerHTML:`<div class="anno-dot red"></div>`, occludable:true}); }
      else { addMeasureOverlay(firstPoint, hit.worldPos.slice()); firstPoint=null; setMode("none"); }
    }
    return;
  }

  if (mode==="annot"){
    if (hit?.worldPos){
      ann.createAnnotation({ worldPos:hit.worldPos.slice(),
        markerHTML:`<div class="anno-bubble">Annotation</div>`, occludable:false });
      setMode("none");
    }
    return;
  }

  if (mode==="clip"){
    if (activeAxis && hit?.worldPos){
      // repositionne le plan sur le point cliqué
      ensurePlanes();
      if (hint){ ann.destroyAnnotation(hint); hint=null; }
      if (activeAxis==="x"){ planeX.pos=hit.worldPos.slice(); hint=ann.createAnnotation({worldPos:planeX.pos, markerHTML:`<div class="plane-hint plane-x"></div>`, occludable:false}); }
      if (activeAxis==="y"){ planeY.pos=hit.worldPos.slice(); hint=ann.createAnnotation({worldPos:planeY.pos, markerHTML:`<div class="plane-hint plane-y"></div>`, occludable:false}); }
      if (activeAxis==="z"){ planeZ.pos=hit.worldPos.slice(); hint=ann.createAnnotation({worldPos:planeZ.pos, markerHTML:`<div class="plane-hint plane-z"></div>`, occludable:false}); }
      viewer.scene.sectionPlanesEnabled=true;
    }
    return;
  }

  // Sélection simple
  if (!hit || !hit.entity){ clearSelection(); return; }
  const id=hit.entity.id;
  setSome(allIds(),"highlighted",false);
  selectedIds=new Set([id]);
  setSome([id],"highlighted",true);
  const meta = hit.entity.metaObject || hit.entity.meta;
  if (propsPanel){
    propsPanel.innerHTML="";
    const add=(k,v)=>{const a=document.createElement("div");a.textContent=k; const b=document.createElement("div");b.textContent=String(v); propsPanel.append(a,b);};
    if (meta){
      const base={ id:meta.id, type:meta.type||meta.ifcType||"", name:meta.name||meta.displayName||"" };
      Object.entries(base).forEach(([k,v])=> (v!==undefined && v!=="") && add(k,v));
    } else add("id",id);
  }
});

/* ====== NAV & rendu ====== */
btnFit?.addEventListener("click",()=> viewer.cameraFlight.flyTo(viewer.scene));
let proj="perspective";
btnProj?.addEventListener("click",()=>{
  proj = (proj==="perspective")? "ortho":"perspective";
  viewer.camera.projection = proj;
  btnProj.textContent = proj==="perspective" ? "Perspective" : "Orthographique";
});
(() => {
  if (!navMode) return; const opt=[...navMode.options].find(o=>o.value==="pan");
  if (opt){ opt.value="planView"; opt.textContent="Plan"; }
})();
navMode?.addEventListener("change",()=> viewer.cameraControl.navMode = navMode.value);

function applyEdges(on){
  viewer.scene.edgeMaterial.edgesEnabled=!!on;
  (viewer.scene.objectIds||[]).forEach(id=>{
    const o=viewer.scene.objects[id];
    if (o){ if ("edges" in o) o.edges=!!on; if (o.mesh && ("edges" in o.mesh)) o.mesh.edges=!!on; }
  });
}
chkEdges?.addEventListener("change",()=> applyEdges(!!chkEdges.checked));
viewer.scene.on("tick",()=>{ if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) viewer.scene.edgeMaterial.edgesEnabled=true; });

chkXray?.addEventListener("change",()=>{ setAll("xrayed", !!chkXray.checked); if (selectedIds.size) setSome([...selectedIds],"xrayed",false); });
chkGhost?.addEventListener("change",()=>{ setAll("ghosted", !!chkGhost.checked); if (selectedIds.size) setSome([...selectedIds],"ghosted",false); });

chkTheme?.addEventListener("change",()=>{
  viewerContainer?.classList.toggle("dark",!!chkTheme.checked);
  viewer.scene.clearColor = chkTheme.checked ? [0.06,0.07,0.08] : [0.965,0.957,0.937];
});
opacityRange?.addEventListener("input",()=> setAll("opacity", parseFloat(opacityRange.value)||1));

/* ====== UPLOAD / LOAD ====== */
async function loadXKT(url,name){
  const id="m"+Date.now();
  const model = loader.load({ id, src:url, edges:!!chkEdges?.checked });
  setProgress(10);
  model.on("progress",p=> setProgress(10+Math.round(p*80)));
  model.on("loaded",()=>{
    setProgress(100); setTimeout(()=>setProgress(0),300);
    viewer.cameraFlight.flyTo(model);
    models.set(id,{model,name:name||id,src:url}); lastModelId=id; refreshModelsList();
    if (chkEdges?.checked) applyEdges(true);
  });
  model.on("error",e=>{ setProgress(0); console.error(e); alert("Erreur chargement XKT."); });
}
function refreshModelsList(){
  if (!modelsList) return;
  modelsList.innerHTML="";
  for (const [id,info] of models){
    const row=document.createElement("div");
    row.className="row mini"; row.style.justifyContent="space-between";
    row.innerHTML=`<span title="${id}">${info.name||id}</span>
      <span>
        <button class="btn btn-outline mini" data-act="fly" data-id="${id}">Voir</button>
        <button class="btn btn-outline mini" data-act="toggle" data-id="${id}">${info.model.visible?"Cacher":"Montrer"}</button>
      </span>`;
    modelsList.appendChild(row);
  }
  modelsList.querySelectorAll("button").forEach(b=>{
    b.onclick=()=>{
      const id=b.dataset.id, info=models.get(id); if(!info) return;
      if (b.dataset.act==="fly") viewer.cameraFlight.flyTo(info.model);
      else { info.model.visible=!info.model.visible; refreshModelsList(); }
    };
  });
}
async function uploadAndShow(){
  const f=fileInput?.files?.[0]; if(!f){ alert("Choisis un fichier .step/.stp/.stl"); return; }
  btnVisualiser && (btnVisualiser.disabled=true, btnVisualiser.textContent="Conversion…");
  setProgress(8);
  try{
    const fd=new FormData(); fd.append("file",f);
    const res=await fetch("/upload",{method:"POST",body:fd});
    const j=await res.json();
    if(!res.ok||!j.xkt_url) throw new Error(JSON.stringify(j));
    const xktUrl = new URL(j.xkt_url, location.origin).toString();
    if (!chkAdditive?.checked){ for(const [,m] of models){ try{m.model.destroy();}catch{} } models.clear(); selectedIds.clear(); }
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
btnChoose?.addEventListener("click",(e)=>{ e.preventDefault(); fileInput?.click(); });
fileInput?.addEventListener("change",()=>{ const f=fileInput.files?.[0]; if(f&&fileNameLbl) fileNameLbl.textContent=f.name; if(f) uploadAndShow(); });
btnVisualiser?.addEventListener("click",(e)=>{ e.preventDefault(); uploadAndShow(); });

/* ====== Divers ====== */
btnIsolate?.addEventListener("click",()=>{ if(!selectedIds.size) return; setAll("visible",false); setSome([...selectedIds],"visible",true); });
btnHide?.addEventListener("click",   ()=>{ if(!selectedIds.size) return; setSome([...selectedIds],"visible",false); });
btnShowOnly?.addEventListener("click",()=>{ if(!selectedIds.size) return; setAll("visible",false); setSome([...selectedIds],"visible",true); });
btnClearSel?.addEventListener("click",()=>{ setAll("visible",true); setSome(allIds(),"highlighted",false); clearSelection(); });

explodeRange?.addEventListener("input",()=>{
  const ids=allIds(); if(!ids.length) return;
  const k=parseFloat(explodeRange.value)||0, bb=viewer.scene.aabb, c=[(bb[0]+bb[3])/2,(bb[1]+bb[4])/2,(bb[2]+bb[5])/2];
  ids.forEach(id=>{ const o=viewer.scene.objects[id]; if(!o) return;
    const p=o.aabbCenter||[0,0,0], v=[p[0]-c[0],p[1]-c[1],p[2]-c[2]], len=Math.hypot(v[0],v[1],v[2])||1,
          off=[v[0]/len*k*10,v[1]/len*k*10,v[2]/len*k*10]; if("offset" in o) o.offset=off; });
});
btnReload?.addEventListener("click",()=>{ if(!lastModelId) return; const i=models.get(lastModelId); if(!i) return; try{i.model.destroy();}catch{} models.delete(lastModelId); loadXKT(i.src,i.name); });
btnUnload?.addEventListener("click",()=>{ if(!lastModelId) return; const i=models.get(lastModelId); if(!i) return; try{i.model.destroy();}catch{} models.delete(lastModelId); lastModelId=[...models.keys()].pop()||null; refreshModelsList(); });
btnShot?.addEventListener("click",()=>{ try{ const dataURL=document.getElementById("xeokit-canvas").toDataURL("image/png"); const a=document.createElement("a"); a.href=dataURL; a.download="cadlytics_view.png"; a.click(); }catch(e){ console.error(e); alert("Capture impossible."); }});
