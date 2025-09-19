// /static/js/main.js
import {
  Viewer,
  XKTLoaderPlugin,
  FastNavPlugin,
  NavCubePlugin,
  SectionPlanesPlugin,
  AnnotationsPlugin
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

// Overlays HTML (pastilles / bulles / plaques) dans #overlayHost
const annotations = new AnnotationsPlugin(viewer, {
  container: overlayHost
});

/* ========= DPR & resizing — CRITIQUE pour que les pastilles collent ========= */
const canvasEl = document.getElementById("xeokit-canvas");
function syncCanvasAndOverlaySize() {
  const w = Math.max(1, viewerContainer.clientWidth);
  const h = Math.max(1, viewerContainer.clientHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // Taille CSS (en px) identique pour canvas et overlay
  canvasEl.style.width  = w + "px";
  canvasEl.style.height = h + "px";
  overlayHost.style.width  = w + "px";
  overlayHost.style.height = h + "px";

  // Taille "bitmap" du canvas pour éviter le flou et le décalage
  canvasEl.width  = Math.floor(w * dpr);
  canvasEl.height = Math.floor(h * dpr);

  // Notifie le viewer
  viewer.resize?.();
  viewer.scene?.setDirty?.(true);
}
new ResizeObserver(syncCanvasAndOverlaySize).observe(viewerContainer);
addEventListener("resize", syncCanvasAndOverlaySize, { passive: true });
syncCanvasAndOverlaySize();

/* Cube d’axes */
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
let appMode = "select";            // "select" | "measure" | "annotate"
let clipAxis = null;
let clipPlane = null;
let clipPlateAnn = null;

const setProgress=(p)=>{ if (progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,p))}%`; };
const allIds=()=> viewer.scene?.objectIds ?? [];
const setSome=(ids,prop,val)=> ids.forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const setAll=(prop,val)=> allIds().forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const clearSelection=()=>{ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); propsPanel && (propsPanel.innerHTML=""); };

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

/* ---------- sélection au clic (modes) ---------- */
function setMode(m){
  appMode = (appMode===m) ? "select" : m;
  btnMeasure?.classList.toggle("btn-primary", appMode==="measure");
  btnAnnot  ?.classList.toggle("btn-primary", appMode==="annotate");
}
btnMeasure?.addEventListener("click",()=> setMode("measure"));
btnAnnot  ?.addEventListener("click",()=> setMode("annotate"));

viewer.scene.input.on("mouseclicked", (coords)=>{
  const hit = viewer.scene.pick({ canvasPos: coords, pickSurface: true });
  if (!hit || !hit.entity) {
    if (appMode==="select") clearSelection();
    return;
  }

  if (appMode==="measure"){ handleMeasureClick(hit.worldPos); return; }
  if (appMode==="annotate"){ handleAnnotClick(hit.worldPos);  return; }

  // mode select
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

/* =========================================================
 *  MESURE (pastilles + segment 2D + label mm)
 * =======================================================*/
const measures = []; // {id, annA, annB, labelAnn, lineEl}
let measureBuffer = []; // 0..2 worldPos

function centerOf(el){
  const r=el.getBoundingClientRect(), p=overlayHost.getBoundingClientRect();
  return { x:r.left-p.left + r.width/2, y:r.top-p.top + r.height/2 };
}
function placeLine(line, p1, p2){
  const dx=p2.x-p1.x, dy=p2.y-p1.y, L=Math.hypot(dx,dy) || 0;
  const a=Math.atan2(dy,dx)*180/Math.PI;
  line.style.width = `${L}px`;
  line.style.transform = `translate(${p1.x}px,${p1.y}px) rotate(${a}deg)`;
}
const mm=(m)=> (m*1000).toFixed(2);

function handleMeasureClick(worldPos){
  if (!worldPos) return;
  measureBuffer.push(worldPos.slice());
  if (measureBuffer.length<2) return;

  const [A,B] = measureBuffer.splice(0,2);
  setMode("select");

  // Pastilles ancrées scène (AnnotationsPlugin)
  const annA = annotations.createAnnotation({ id:"ma"+Date.now(), worldPos:A, markerHTML:`<div class="dot"></div>`, labelShown:false });
  const annB = annotations.createAnnotation({ id:"mb"+Date.now(), worldPos:B, markerHTML:`<div class="dot"></div>`, labelShown:false });

  const M=[ (A[0]+B[0])/2,(A[1]+B[1])/2,(A[2]+B[2])/2 ];
  const d = Math.hypot(B[0]-A[0], B[1]-A[1], B[2]-A[2]);
  const labelAnn = annotations.createAnnotation({
    id:"ml"+Date.now(), worldPos:M, labelHTML:`<div class="xk-badge"><b>${mm(d)}</b> mm</div>`, markerShown:false, labelShown:true
  });

  // Ligne 2D (overlay)
  const line=document.createElement("div"); line.className="measure-line"; overlayHost.appendChild(line);
  const mId="M"+Date.now();
  measures.push({id:mId, annA, annB, labelAnn, lineEl:line});

  if (propsPanel){
    const row=document.createElement("div");
    row.className="row mini"; row.style.gap="8px"; row.innerHTML=`
      <span style="flex:1;font-size:12px">Mesure ${mId}</span>
      <button class="btn btn-outline mini" data-act="hide">Cacher/Montrer</button>
      <button class="btn btn-outline mini" data-act="del">Suppr.</button>`;
    propsPanel.append(row);
    row.querySelector('[data-act="hide"]').addEventListener("click",()=>{
      const v=!annA.visible; annA.visible=v; annB.visible=v; labelAnn.visible=v; line.style.display=v?"block":"none";
    });
    row.querySelector('[data-act="del"]').addEventListener("click",()=>{
      try{ annA.destroy(); annB.destroy(); labelAnn.destroy(); }catch{}
      line.remove(); row.remove();
    });
  }
}

/* Mise à jour (tick) — recalcule la ligne en partant de la position DOM des pastilles */
viewer.scene.on("tick",()=>{
  for (const m of measures){
    const elA = overlayHost.querySelector(`[data-annotation_id="${m.annA.id}"]`);
    const elB = overlayHost.querySelector(`[data-annotation_id="${m.annB.id}"]`);
    if (!elA || !elB) continue;
    const p1=centerOf(elA), p2=centerOf(elB);
    placeLine(m.lineEl, p1, p2);
  }
});

/* =========================================================
 *  ANNOTATION : saisie inline
 * =======================================================*/
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
    if (propsPanel){
      const row=document.createElement("div");
      row.className="row mini"; row.style.gap="8px"; row.innerHTML=`
        <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${val}</span>
        <button class="btn btn-outline mini" data-act="edit">Éditer</button>
        <button class="btn btn-outline mini" data-act="hide">Cacher/Montrer</button>
        <button class="btn btn-outline mini" data-act="del">Suppr.</button>`;
      propsPanel.appendChild(row);
      row.querySelector('[data-act="edit"]').addEventListener("click",()=>{
        const nv = prompt("Nouveau texte :", val);
        if (nv!=null){ ann.setLabelHTML?.(`<div class="xk-badge">${nv}</div>`) || (ann.labelHTML=`<div class="xk-badge">${nv}</div>`); row.firstElementChild.textContent=nv; }
      });
      row.querySelector('[data-act="hide"]').addEventListener("click",()=>{ ann.visible=!ann.visible; });
      row.querySelector('[data-act="del"]').addEventListener("click",()=>{ try{ ann.destroy(); }catch{} row.remove(); });
    }
  };
  input.addEventListener("keydown",(e)=>{ if (e.key==="Enter"){ e.preventDefault(); input.blur(); } });
  input.addEventListener("blur", commit, {once:true});
}

/* =========================================================
 *  COUPE : un axe à la fois + plaque translucide
 * =======================================================*/
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
