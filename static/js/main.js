// /static/js/main.js
import {
  Viewer,
  XKTLoaderPlugin,
  NavCubePlugin,
  FastNavPlugin,
  SectionPlanesPlugin,
  DistanceMeasurementsPlugin,
  AnnotationsPlugin
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- Basic UI refs ----------
const fileInput     = $("#fileInput");
const btnPick       = $("#btnPick");
const btnVisualiser = $("#btnVisualiser");
const chkAdditive   = $("#chkAdditive");
const fileNameLbl   = $("#fileName");

const btnFit  = $("#btnFit");
const btnProj = $("#btnProj");
const navMode = $("#navMode");
const chkEdges= $("#chkEdges");
const chkXray = $("#chkXray");
const chkGhost= $("#chkGhost");
const chkTheme= $("#chkTheme");

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

// ---------- Viewer & plugins ----------
const viewer = new Viewer({
  canvasId: "xeokit-canvas",
  transparent: true,
  dtxEnabled: true
});

new FastNavPlugin(viewer, { flyToDuration: 0.9 });
new NavCubePlugin(viewer, { size: 150, cameraFlyToDuration: 0.9 });

const xktLoader = new XKTLoaderPlugin(viewer, {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/"
});

const sections = new SectionPlanesPlugin(viewer, {});
const meas = new DistanceMeasurementsPlugin(viewer, { defaultDistancePrecision: 2 });
const ann  = new AnnotationsPlugin(viewer, { markerHTML: "<div style='width:10px;height:10px;border-radius:999px;background:#ef4444;border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.2)'></div>" });

// ---------- State ----------
const models = new Map(); // id -> { model, name }
let lastModelId = null;
let selectedIds = new Set();
let hoverId = null;
let oneSectionPlane = null;

// ---------- Helpers ----------
function uiToast(msg) { console.log(msg); /* on peut faire mieux si besoin */ }

function setProgress(p) {
  progressBar.style.width = `${Math.max(0, Math.min(100, p))}%`;
}

function refreshModelsList() {
  modelsList.innerHTML = "";
  for (const [id, info] of models) {
    const row = document.createElement("div");
    row.className = "row mini";
    row.style.justifyContent = "space-between";
    row.innerHTML = `
      <span title="${id}">${info.name || id}</span>
      <span>
        <button class="btn btn-outline mini" data-act="fly" data-id="${id}">Voir</button>
        <button class="btn btn-outline mini" data-act="toggle" data-id="${id}">${info.model.visible?"Cacher":"Montrer"}</button>
      </span>`;
    modelsList.appendChild(row);
  }
  modelsList.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const id = btn.dataset.id;
      const info = models.get(id); if (!info) return;
      if (btn.dataset.act==="fly") {
        viewer.cameraFlight.flyTo(info.model);
      } else {
        info.model.visible = !info.model.visible;
        refreshModelsList();
      }
    });
  });
}

function clearSelection() {
  if (selectedIds.size) {
    viewer.scene.setObjectsHighlighted([...selectedIds], false);
    viewer.scene.setObjectsXRayed([...selectedIds], false);
    viewer.scene.setObjectsGhosted([...selectedIds], false);
    selectedIds.clear();
  }
}

function showProps(meta) {
  propsPanel.innerHTML = "";
  if (!meta) { return; }
  const fill = (k, v) => {
    const kEl = document.createElement("div"); kEl.textContent = k;
    const vEl = document.createElement("div"); vEl.textContent = String(v);
    propsPanel.appendChild(kEl); propsPanel.appendChild(vEl);
  };
  // champs courants si présents
  const base = {
    id: meta.id, type: meta.type || meta.ifcType || "",
    name: meta.name || meta.displayName || ""
  };
  Object.entries(base).forEach(([k,v]) => v!==undefined && v!=="" && fill(k,v));
  // propriétés additionnelles
  const psets = meta.properties || meta.props;
  if (psets && typeof psets === "object") {
    Object.entries(psets).forEach(([k,v]) => fill(k, typeof v==="object"? JSON.stringify(v): v));
  }
}

function downloadDataURL(dataURL, filename) {
  const a = document.createElement("a");
  a.href = dataURL; a.download = filename; a.click();
}

function flyToAll() {
  viewer.cameraFlight.flyTo(viewer.scene); // centre sur la scène
}

// ---------- Upload / Load ----------
btnPick.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  fileNameLbl.textContent = f ? f.name : "Aucun fichier sélectionné";
  const dz = document.querySelector("[data-dropzone]");
  if (f) { dz?.classList.remove("is-error","is-success"); dz?.classList.add("is-ready"); }
});

async function loadXKT(xktUrl, nameHint) {
  const id = "m" + Date.now();
  const model = xktLoader.load({ id, src: xktUrl, edges: chkEdges.checked });

  setProgress(10);
  model.on("loaded", () => {
    setProgress(100);
    setTimeout(()=>setProgress(0), 400);
    viewer.cameraFlight.flyTo(model);
    models.set(id, { model, name: nameHint || id });
    lastModelId = id;
    refreshModelsList();
  });
  model.on("progress", (p)=> setProgress(10 + Math.round(p*80)));
  model.on("error", (e)=> { setProgress(0); uiToast("Erreur de chargement XKT"); console.error(e);});
  return id;
}

async function uploadAndShow() {
  const f = fileInput.files?.[0];
  if (!f) { alert("Choisis un fichier .step/.stp/.stl"); return; }

  btnVisualiser.disabled = true; btnVisualiser.textContent = "Conversion…";
  setProgress(8);

  try {
    const fd = new FormData(); fd.append("file", f);
    const res = await fetch("/upload", { method: "POST", body: fd });
    const json = await res.json();
    if (!res.ok || !json.xkt_url) throw new Error(JSON.stringify(json));

    const xktUrl = new URL(json.xkt_url, location.origin).toString();
    if (!chkAdditive.checked) { // mono-modèle : on nettoie
      for (const [id, info] of models) { try { info.model.destroy(); } catch{} }
      models.clear(); selectedIds.clear();
    }
    await loadXKT(xktUrl, f.name);
    const dz = document.querySelector("[data-dropzone]");
    dz?.classList.remove("is-ready"); dz?.classList.add("is-success");
  } catch (e) {
    console.error(e);
    const dz = document.querySelector("[data-dropzone]");
    dz?.classList.remove("is-ready"); dz?.classList.add("is-error");
    alert("Erreur de conversion/chargement (voir Console).");
  } finally {
    btnVisualiser.disabled = false; btnVisualiser.textContent = "Visualiser";
  }
}
btnVisualiser.addEventListener("click", (e)=>{ e.preventDefault(); uploadAndShow(); });

// ---------- Navigation & caméra ----------
btnFit.addEventListener("click", flyToAll);

let proj = "perspective";
btnProj.addEventListener("click", ()=>{
  proj = (proj==="perspective") ? "ortho" : "perspective";
  viewer.camera.projection = proj;
  btnProj.textContent = proj==="perspective" ? "Perspective" : "Orthographique";
});

navMode.addEventListener("change", ()=> {
  viewer.cameraControl.navMode = navMode.value;
});

// ---------- Rendu / apparence ----------
chkEdges.addEventListener("change", ()=>{
  viewer.scene.edgeMaterial.edgesEnabled = chkEdges.checked;
});
chkXray.addEventListener("change", ()=>{
  // X-ray sur le "reste" : on met tout en xray, puis on enlève pour la sélection
  const all = viewer.scene.objectIds;
  viewer.scene.setObjectsXRayed(all, chkXray.checked);
  if (selectedIds.size) viewer.scene.setObjectsXRayed([...selectedIds], false);
});
chkGhost.addEventListener("change", ()=>{
  const all = viewer.scene.objectIds;
  viewer.scene.setObjectsGhosted(all, chkGhost.checked);
  if (selectedIds.size) viewer.scene.setObjectsGhosted([...selectedIds], false);
});
opacityRange.addEventListener("input", ()=>{
  const alpha = parseFloat(opacityRange.value);
  const all = viewer.scene.objectIds;
  viewer.scene.setObjectsOpacity(all, alpha);
});

// Thème clair/sombre (+ couleur de fond du canvas)
chkTheme.addEventListener("change", ()=>{
  document.documentElement.classList.toggle("theme-dark", chkTheme.checked);
  viewer.scene.clearColor = chkTheme.checked ? [0.09,0.1,0.09] : [0.965,0.957,0.937];
});

// ---------- Pick / hover / propriétés ----------
viewer.scene.input.on("mousemove", (coords)=>{
  const hit = viewer.scene.pick({canvasPos:[coords[0],coords[1]]});
  if (hoverId && hoverId!==hit?.entity?.id) {
    viewer.scene.setObjectsHighlighted([hoverId], false);
    hoverId=null;
  }
  if (hit && hit.entity) {
    hoverId = hit.entity.id;
    viewer.scene.setObjectsHighlighted([hoverId], true);
  }
});

viewer.scene.input.on("mouseclicked", (coords)=>{
  const hit = viewer.scene.pick({canvasPos:[coords[0],coords[1]]});
  if (!hit || !hit.entity) return;
  clearSelection();
  const id = hit.entity.id;
  selectedIds.add(id);
  viewer.scene.setObjectsHighlighted([id], true);

  // props si méta dispo
  const meta = hit.entity.metaObject || hit.entity.meta; // suivant XKT
  showProps(meta || { id });
});

// Isoler / cacher / montrer
btnIsolate.addEventListener("click", ()=>{
  if (!selectedIds.size) { uiToast("Sélectionne un objet"); return; }
  const all = viewer.scene.objectIds;
  viewer.scene.setObjectsVisible(all, false);
  viewer.scene.setObjectsVisible([...selectedIds], true);
});
btnHide.addEventListener("click", ()=>{
  if (!selectedIds.size) { uiToast("Sélectionne un objet"); return; }
  viewer.scene.setObjectsVisible([...selectedIds], false);
});
btnShowOnly.addEventListener("click", ()=>{
  if (!selectedIds.size) { uiToast("Sélectionne un objet"); return; }
  const all = viewer.scene.objectIds;
  viewer.scene.setObjectsVisible(all, false);
  viewer.scene.setObjectsVisible([...selectedIds], true);
});
btnClearSel.addEventListener("click", ()=>{
  const all = viewer.scene.objectIds;
  viewer.scene.setObjectsVisible(all, true);
  clearSelection();
});

// ---------- Recherche (simple : id/type/nom dans le meta) ----------
btnSearch.addEventListener("click", ()=>{
  const q = (searchInput.value || "").toLowerCase().trim();
  resultsBox.innerHTML = "";
  if (!q) return;

  const found = [];
  for (const obj of viewer.scene.objects) {
    const id = obj.id || "";
    const meta = obj.metaObject || {};
    const hay = [id, meta.type, meta.name, meta.ifcType, meta.displayName].join(" ").toLowerCase();
    if (hay.includes(q)) found.push({id, meta});
  }
  if (!found.length) { resultsBox.textContent = "Aucun résultat"; return; }

  found.slice(0,200).forEach(({id,meta})=>{
    const div = document.createElement("div");
    div.className="row"; div.style.justifyContent="space-between";
    div.innerHTML = `<span>${meta?.name||meta?.displayName||meta?.type||id}</span>
      <button class="btn btn-outline mini" data-id="${id}">Voir</button>`;
    resultsBox.appendChild(div);
  });
  resultsBox.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", ()=>{
      const id = b.dataset.id;
      viewer.cameraFlight.flyTo(viewer.scene.objects[id]);
      viewer.scene.setObjectsHighlighted([id], true);
    });
  });
});

// ---------- Recharger / Décharger ----------
btnReload.addEventListener("click", ()=>{
  // Rechargement du dernier modèle
  if (!lastModelId) return;
  const info = models.get(lastModelId); if (!info) return;
  const src = info.model.src;
  try { info.model.destroy(); } catch{}
  models.delete(lastModelId);
  loadXKT(src, info.name);
});
btnUnload.addEventListener("click", ()=>{
  if (!lastModelId) return;
  const info = models.get(lastModelId); if (!info) return;
  try { info.model.destroy(); } catch{}
  models.delete(lastModelId);
  lastModelId = [...models.keys()].pop() || null;
  refreshModelsList();
});

// ---------- Mesures / Annotations / Coupes ----------
let measureOn = false;
btnMeasure.addEventListener("click", ()=>{
  measureOn = !measureOn;
  meas.ctrlPickMeasurement = measureOn;
  btnMeasure.classList.toggle("btn-primary", measureOn);
});

btnAnnot.addEventListener("click", ()=>{
  // clic dans la scène pour poser un pin
  const handle = (coords)=>{
    const hit = viewer.scene.pick({canvasPos:[coords[0], coords[1]]});
    if (!hit || !hit.worldPos) return;
    ann.createAnnotation({
      id: "a"+Date.now(),
      worldPos: hit.worldPos,
      occludable: true,
      label: "Note"
    });
    viewer.scene.input.off("mouseclicked", handle);
    btnAnnot.classList.remove("btn-primary");
  };
  btnAnnot.classList.add("btn-primary");
  viewer.scene.input.on("mouseclicked", handle);
});

let clippingOn = false;
btnClip.addEventListener("click", ()=>{
  clippingOn = !clippingOn;
  btnClip.classList.toggle("btn-primary", clippingOn);
  if (!clippingOn) {
    if (oneSectionPlane) { oneSectionPlane.destroy(); oneSectionPlane=null; }
    return;
  }
  if (oneSectionPlane) oneSectionPlane.destroy();
  oneSectionPlane = sections.createSectionPlane({ id:"cut", pos:[0,0,0], dir:[0,1,0] });
  viewer.cameraFlight.flyTo(oneSectionPlane);
});

// ---------- Explode (bêta) ----------
explodeRange.addEventListener("input", ()=>{
  const k = parseFloat(explodeRange.value);
  // Explode naïf : appliquer un offset radial aux objets
  // Si l’API setObjectsOffset n’existe pas, on ignore silencieusement
  const center = viewer.scene.aabbCenter;
  try {
    for (const obj of viewer.scene.objects) {
      const p = obj.aabbCenter || obj.center || [0,0,0];
      const dir = [p[0]-center[0], p[1]-center[1], p[2]-center[2]];
      const len = Math.hypot(...dir) || 1;
      const off = [dir[0]/len*k*10, dir[1]/len*k*10, dir[2]/len*k*10];
      if ("offset" in obj) obj.offset = off;
    }
  } catch(e) {
    // no-op si non supporté
  }
});

// ---------- Screenshot ----------
btnShot.addEventListener("click", async ()=>{
  try {
    const dataURL = viewer.getSnapshot ? viewer.getSnapshot({width:1920,height:1080}) :
                      viewer.scene.canvas.canvas.toDataURL("image/png");
    downloadDataURL(dataURL, "cadlytics_view.png");
  } catch(e) {
    console.error(e); alert("Capture impossible sur ce navigateur.");
  }
});

// ---------- Drag & drop (panneau gauche) ----------
const dz = document.querySelector("[data-dropzone]");
if (dz) {
  ["dragenter","dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("is-ready"); }));
  ["dragleave","drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("is-ready"); }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      const dt = new DataTransfer(); dt.items.add(f); fileInput.files = dt.files;
      fileNameLbl.textContent = f.name; dz.classList.add("is-ready");
    }
  });
}
