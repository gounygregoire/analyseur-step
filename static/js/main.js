// /static/js/main.js
import {
  Viewer,
  XKTLoaderPlugin,
  FastNavPlugin,
  NavCubePlugin,
  SectionPlanesPlugin,
  AnnotationsPlugin
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

/* ------------------ utils DOM ------------------ */
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ------------------ sélecteurs ------------------ */
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

/* ------------------ viewer + plugins ------------------ */
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

/* Overlays (pastilles / bulles / plaques) */
const annotations = new AnnotationsPlugin(viewer, {
  container: overlayHost,
  markerHTML: `<div class="dot"></div>`,
  labelHTML:  `<div class="bubble"></div>`
});

/* Canvas + overlay DPR-Ready */
const canvasEl = document.getElementById("xeokit-canvas");
function resizeCanvasAndOverlay() {
  const w = Math.max(1, viewerContainer.clientWidth);
  const h = Math.max(1, viewerContainer.clientHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvasEl.style.width = w + "px"; canvasEl.style.height = h + "px";
  canvasEl.width  = Math.floor(w * dpr); canvasEl.height = Math.floor(h * dpr);
  overlayHost.style.width = w + "px"; overlayHost.style.height = h + "px";
  if (viewer.resize) viewer.resize();
  viewer.scene?.setDirty?.(true);
}
new ResizeObserver(resizeCanvasAndOverlay).observe(viewerContainer);
addEventListener("resize", resizeCanvasAndOverlay);
resizeCanvasAndOverlay();

/* Cube d’axes */
(()=>{ const cube=document.createElement("canvas"); cube.width=cube.height=96;
  Object.assign(cube.style,{position:"absolute",left:"12px",top:"12px",zIndex:"5",
    borderRadius:"12px",boxShadow:"0 6px 18px rgba(0,0,0,.25)",background:"rgba(255,255,255,.06)",backdropFilter:"blur(2px)"});
  viewerContainer.appendChild(cube);
  new NavCubePlugin(viewer,{canvasElement:cube,cameraFlyToDuration:0.9});
})();

/* CSS overlay (injectée 1x) */
if (!$("#xeokit-overlay-css")){
  const css=document.createElement("style"); css.id="xeokit-overlay-css"; css.textContent=`
  .dot{width:10px;height:10px;border-radius:999px;background:#10b981;border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.15)}
  .bubble{min-width:8px;min-height:8px;border-radius:8px;background:rgba(0,0,0,.12);backdrop-filter:blur(2px)}
  .xk-badge{font:12px/1.3 Inter,system-ui,Segoe UI,Roboto,Arial;color:#0f172a;background:#fff;padding:.35rem .5rem;border-radius:.5rem;box-shadow:0 8px 24px rgba(2,6,23,.12);border:1px solid rgba(2,6,23,.06)}
  .measure-line{position:absolute;height:2px;background:#14b8a6;transform-origin:0 50%;pointer-events:none}
  .annot-input{font:12px/1.2 Inter,system-ui;min-width:120px;padding:.25rem .35rem;border-radius:.4rem;border:1px solid rgba(2,6,23,.15);box-shadow:0 8px 24px rgba(2,6,23,.08)}
  .cutplate{width:140px;height:140px;transform:translate(-50%,-50%);background:rgba(59,130,246,.12);border:1px dashed rgba(59,130,246,.6);border-radius:8px}
  `;
  document.head.appendChild(css);
}

/* ------------------ état appli ------------------ */
const models = new Map();
let lastModelId = null;
let selectedIds = new Set();
let appMode = "select";   // "select" | "measure" | "annotate"
let clipAxis = null;      // 'x' | 'y' | 'z' | null
let clipPlane = null;     // SectionPlane
let clipPlateAnnot = null;

const setProgress=(p)=>{ if (progressBar) progressBar.style.inset=`0 ${100-Math.max(0,Math.min(100,p))}% 0 0`; };
const allIds=()=> viewer.scene?.objectIds ?? [];
const setSome=(ids,prop,val)=> ids.forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const setAll=(prop,val)=> allIds().forEach(id=>{const o=viewer.scene.objects[id]; if(o) o[prop]=val;});
const clearSelection=()=>{ setSome([...selectedIds],"highlighted",false); selectedIds.clear(); propsPanel && (propsPanel.innerHTML=""); };

function refreshModelsList(){
  if (!modelsList) return;
  modelsList.innerHTML="";
  for (const [id, info] of models){
    const row=document.createElement("div");
    row.className="row mini"; row.style.justifyContent="space-between";
    row.innerHTML=`<span title="${id}">${info.name||id}</span>
      <span><button class="btn btn-outline mini" data-act="fly" data-id="${id}">Voir</button>
      <button class="btn btn-outline mini" data-act="toggle" data-id="${id}">${info.model.visible?"Cacher":"Montrer"}</button></span>`;
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
const flyAll=()=> viewer.cameraFlight.flyTo(viewer.scene);

/* ------------------ chargement XKT ------------------ */
async function loadXKT(url,nameHint){
  const id="m"+Date.now();
  const model=xktLoader.load({id,src:url,edges:!!chkEdges?.checked});
  setProgress(6);
  model.on("progress", p=> setProgress(6+Math.round(p*88)));
  model.on("loaded", ()=>{
    setProgress(100); setTimeout(()=>setProgress(0),350);
    viewer.cameraFlight.flyTo(model);
    models.set(id,{model,name:nameHint||id,src:url}); lastModelId=id; refreshModelsList();
    if (chkEdges?.checked) viewer.scene.edgeMaterial.edgesEnabled=true;
  });
  model.on("error", e=>{ console.error(e); setProgress(0); alert("Erreur chargement XKT."); });
  return id;
}

/* ------------------ upload ------------------ */
async function uploadAndShow(){
  const f=fileInput?.files?.[0];
  if (!f){ alert("Choisis un fichier .step/.stp/.stl"); return; }
  if (btnVisualiser){ btnVisualiser.disabled=true; btnVisualiser.textContent="Conversion…"; }
  setProgress(10);
  try{
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

/* ------------------ UI fichiers ------------------ */
btnChoose?.addEventListener("click",(e)=>{ e.preventDefault(); fileInput?.click(); });
fileInput?.addEventListener("change",()=>{
  const f=fileInput.files?.[0]; if (f && fileNameLbl) fileNameLbl.textContent=f.name;
  if (f) uploadAndShow();
});
btnVisualiser?.addEventListener("click",(e)=>{ e.preventDefault(); uploadAndShow(); });

/* ------------------ navigation & rendu ------------------ */
btnFit?.addEventListener("click", flyAll);
let proj="perspective";
btnProj?.addEventListener("click",()=>{
  proj = proj==="perspective" ? "ortho" : "perspective";
  viewer.camera.projection=proj;
  btnProj.textContent = proj==="perspective" ? "PERSPECTIVE" : "ORTHOGRAPHIQUE";
});
const setNav=(m)=> viewer.cameraControl.navMode = (m==="pan" ? "planView" : m);
navMode?.addEventListener("change",()=> setNav(navMode.value)); setNav(navMode?.value||"orbit");

chkEdges?.addEventListener("change",()=> viewer.scene.edgeMaterial.edgesEnabled=!!chkEdges.checked);
viewer.scene.on("tick",()=>{ if (chkEdges?.checked && !viewer.scene.edgeMaterial.edgesEnabled) viewer.scene.edgeMaterial.edgesEnabled=true; });

chkXray ?.addEventListener("change",()=>{ setAll("xrayed", !!chkXray.checked);  setSome([...selectedIds],"xrayed",false); });
chkGhost?.addEventListener("change",()=>{ setAll("ghosted",!!chkGhost.checked); setSome([...selectedIds],"ghosted",false); });

chkTheme?.addEventListener("change",()=> viewerShell?.classList.toggle("dark",!!chkTheme.checked));
opacityRange?.addEventListener("input",()=> setAll("opacity", parseFloat(opacityRange.value)||1));

/* ------------------ Modes outils ------------------ */
function setMode(m){
  appMode = (appMode===m) ? "select" : m;
  btnMeasure?.classList.toggle("btn-primary", appMode==="measure");
  btnAnnot  ?.classList.toggle("btn-primary", appMode==="annotate");
}
btnMeasure?.addEventListener("click",()=> setMode("measure"));
btnAnnot  ?.addEventListener("click",()=> setMode("annotate"));

/* =========================================================
 *  MESURE “maison” (pastilles + segment + label mm)
 * =======================================================*/
const measures = []; // {id, annA, annB, labelAnn, lineEl}
let measureBuffer = []; // 0..2 worldPos

function centerOf(el){
  const r=el.getBoundingClientRect(), p=overlayHost.getBoundingClientRect();
  return { x:r.left-p.left + r.width/2, y:r.top-p.top + r.height/2 };
}
function placeLine(line, p1, p2){
  const dx=p2.x-p1.x, dy=p2.y-p1.y;
  const L=Math.hypot(dx,dy);
  const a=Math.atan2(dy,dx)*180/Math.PI;
  line.style.width = `${L}px`;
  line.style.transform = `translate(${p1.x}px,${p1.y}px) rotate(${a}deg)`;
}
function mm(vMeters){ return (vMeters*1000).toFixed(2); }

viewer.scene.input.on("mouseclicked",(coords)=>{
  const hit = viewer.scene.pick({ canvasPos: coords, pickSurface:true });
  if (!hit || !hit.worldPos) return;

  // MESURE
  if (appMode==="measure"){
    measureBuffer.push(hit.worldPos.slice());
    if (measureBuffer.length===2){
      const [A,B]=measureBuffer; measureBuffer.length=0; setMode("select");

      // pastilles A/B
      const annA = annotations.createAnnotation({ id:"ma"+Date.now(), worldPos:A, markerHTML:`<div class="dot"></div>`, labelShown:false });
      const annB = annotations.createAnnotation({ id:"mb"+Date.now(), worldPos:B, markerHTML:`<div class="dot"></div>`, labelShown:false });

      // label au milieu
      const M=[ (A[0]+B[0])/2,(A[1]+B[1])/2,(A[2]+B[2])/2 ];
      const d = Math.hypot(B[0]-A[0], B[1]-A[1], B[2]-A[2]);
      const labelAnn = annotations.createAnnotation({
        id:"ml"+Date.now(), worldPos:M, labelHTML:`<div class="xk-badge"><b>${mm(d)}</b> mm</div>`, markerShown:false, labelShown:true
      });

      // ligne 2D qui suit les pastilles
      const line=document.createElement("div"); line.className="measure-line"; overlayHost.appendChild(line);

      const mId="M"+Date.now();
      measures.push({id:mId, annA, annB, labelAnn, lineEl:line});

      // entrée “Propriétés”
      if (propsPanel){
        const row=document.createElement("div");
        row.className="row"; row.style.gap="8px"; row.innerHTML=`
          <span style="flex:1">Mesure ${mId}</span>
          <button class="btn btn-outline mini" data-act="hide">Cacher/Montrer</button>
          <button class="btn btn-outline mini" data-act="del">Suppr.</button>`;
        propsPanel.appendChild(row);
        row.querySelector('[data-act="hide"]').addEventListener("click",()=>{
          const v = !(annA.visible); annA.visible=v; annB.visible=v; labelAnn.visible=v; line.style.display=v?"block":"none";
        });
        row.querySelector('[data-act="del"]').addEventListener("click",()=>{
          try{ annA.destroy(); annB.destroy(); labelAnn.destroy(); }catch{}
          line.remove(); row.remove();
        });
      }
    }
    return;
  }

  // ANNOTATION (saisie inline)
  if (appMode==="annotate"){
    setMode("select");
    const id="a"+Date.now();
    const ann = annotations.createAnnotation({
      id, worldPos: hit.worldPos, markerHTML:`<div class="dot"></div>`,
      labelHTML:`<input class="annot-input" placeholder="Texte…" />`,
      labelShown:true
    });
    const input = overlayHost.querySelector(`[data-annotation_id="${id}"] .annot-input`);
    if (input){
      input.focus();
      const commit = ()=>{
        const val=(input.value||"Note");
        ann.setLabelHTML?.(`<div class="xk-badge">${val}</div>`) || (ann.labelHTML=`<div class="xk-badge">${val}</div>`);
        if (propsPanel){
          const row=document.createElement("div");
          row.className="row"; row.style.gap="8px"; row.innerHTML=`
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
  }
});

/* Mise à jour des lignes de mesure à chaque frame (suit les pastilles) */
viewer.scene.on("tick",()=>{
  for (const m of measures){
    const elA = overlayHost.querySelector(`[data-annotation_id="${m.annA.id}"]`);
    const elB = overlayHost.querySelector(`[data-annotation_id="${m.annB.id}"]`);
    if (!elA || !elB) continue;
    const p1=centerOf(elA), p2=centerOf(elB);
    placeLine(m.lineEl, p1, p2);
  }
});

/* Iso / cacher / montrer */
btnIsolate ?.addEventListener("click",()=>{ if (!selectedIds.size) return; setAll("visible",false); setSome([...selectedIds],"visible",true); });
btnHide    ?.addEventListener("click",()=>{ if (!selectedIds.size) return; setSome([...selectedIds],"visible",false); });
btnShowOnly?.addEventListener("click",()=>{ if (!selectedIds.size) return; setAll("visible",false); setSome([...selectedIds],"visible",true); });
btnClearSel?.addEventListener("click",()=>{ setAll("visible",true); setSome(allIds(),"highlighted",false); clearSelection(); });

/* Recherche */
btnSearch?.addEventListener("click",()=>{
  const q=(searchInput?.value||"").toLowerCase().trim();
  if (!resultsBox) return; resultsBox.innerHTML=""; if(!q) return;
  const found=[]; allIds().forEach(id=>{
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
    b.addEventListener("click",()=>{ const id=b.dataset.id; const obj=viewer.scene.objects[id];
      if (obj){ viewer.cameraFlight.flyTo(obj); setSome([id],"highlighted",true); }
    });
  });
});

/* Reload / Unload */
btnReload?.addEventListener("click",()=>{
  if (!lastModelId) return;
  const info=models.get(lastModelId); if(!info) return;
  try{ info.model.destroy(); }catch{}
  models.delete(lastModelId);
  loadXKT(info.src, info.name);
});
btnUnload?.addEventListener("click",()=>{
  if (!lastModelId) return;
  const info=models.get(lastModelId); if(!info) return;
  try{ info.model.destroy(); }catch{}
  models.delete(lastModelId);
  lastModelId=[...models.keys()].pop()||null;
  refreshModelsList();
});

/* Explode */
explodeRange?.addEventListener("input",()=>{
  const k=parseFloat(explodeRange.value)||0;
  const c=viewer.scene?.aabbCenter || [0,0,0];
  allIds().forEach(id=>{
    const o=viewer.scene.objects[id]; if(!o) return;
    const p=o.aabbCenter || [0,0,0]; const v=[p[0]-c[0],p[1]-c[1],p[2]-c[2]];
    const L=Math.hypot(v[0],v[1],v[2])||1; const off=[v[0]/L*k*10,v[1]/L*k*10,v[2]/L*k*10];
    if ("offset" in o) o.offset=off;
  });
});

/* Screenshot */
btnShot?.addEventListener("click",()=>{
  try{ const dataURL=canvasEl.toDataURL("image/png");
    const a=document.createElement("a"); a.href=dataURL; a.download="cadlytics_view.png"; a.click();
  }catch(e){ console.error(e); alert("Capture impossible."); }
});

/* ------------------ Coupe : un axe à la fois ------------------ */
function setClipAxis(axis){
  const same=(clipAxis===axis); clipAxis = same ? null : axis;
  clipButtons.forEach(b=> b.classList.toggle("btn-primary", !same && b.dataset.axis===clipAxis));
  if (clipPlane){ try{ clipPlane.destroy(); }catch{} clipPlane=null; }
  if (clipPlateAnnot){ try{ clipPlateAnnot.destroy?.(); }catch{} clipPlateAnnot=null; }
  if (!clipAxis){ viewer.scene.sectionPlanesEnabled=false; return; }

  const aabb=viewer.scene?.aabb || [0,0,0, 0,0,0];
  const center=[(aabb[0]+aabb[3])/2,(aabb[1]+aabb[4])/2,(aabb[2]+aabb[5])/2];
  const dir = clipAxis==="x" ? [1,0,0] : clipAxis==="y" ? [0,1,0] : [0,0,1];

  clipPlane = sections.createSectionPlane({ id:"cut", pos:center, dir });
  viewer.scene.sectionPlanesEnabled=true;

  // plaque visuelle
  clipPlateAnnot = annotations.createAnnotation({
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
  if (clipPlateAnnot?.setWorldPos) clipPlateAnnot.setWorldPos(pos); else clipPlateAnnot.worldPos=pos;
});
