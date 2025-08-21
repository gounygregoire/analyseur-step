// NEW: imports Xeokit
import {
  Viewer,
  XKTLoaderPlugin,
  DistanceMeasurementsPlugin,
  SectionPlanesPlugin,
  EdgesPlugin,
  AxisGizmoPlugin
} from "@xeokit/xeokit-sdk";

// --- initialisation ---------------------------------------------------------
const canvas = document.getElementById("viewer3d");
const viewer = new Viewer({ canvasId: "viewer3d" });
const cameraControl = viewer.cameraControl;
const xktLoader = new XKTLoaderPlugin(viewer);
const dist = new DistanceMeasurementsPlugin(viewer);
const sections = new SectionPlanesPlugin(viewer);
const edges = new EdgesPlugin(viewer);                           // NEW:
new AxisGizmoPlugin(viewer, { canvasId: "axisGizmo" });         // NEW:

let loadedModel = null;                                             // NEW:
const measurements = [];                                           // NEW:
const sectionPlanes = [null, null, null];                           // NEW:
let exploded = 0;                                                   // NEW:
let highlighted = null;                                             // NEW:
let explodeData = [];                                               // NEW:

// --- molette ---------------------------------------------------------------
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();                                             // NEW:
  },
  { passive: false }
);

// --- chargement modèle -----------------------------------------------------
async function load(url) {                                          // NEW:
  clearAll();
  loadedModel = await xktLoader.load({ src: url, id: "model" });   // NEW:
  viewer.cameraFlight.flyTo(loadedModel);                          // NEW:

  const aabb = loadedModel.aabb;                                   // NEW:
  const center = [                                                 // NEW:
    (aabb[0] + aabb[3]) / 2,
    (aabb[1] + aabb[4]) / 2,
    (aabb[2] + aabb[5]) / 2,
  ];
  explodeData = [];                                                // NEW:
  viewer.scene.withObjects(loadedModel.objectIds, (entity) => {    // NEW:
    const eaabb = entity.aabb;
    if (!eaabb) return;
    const ec = [
      (eaabb[0] + eaabb[3]) / 2 - center[0],
      (eaabb[1] + eaabb[4]) / 2 - center[1],
      (eaabb[2] + eaabb[5]) / 2 - center[2],
    ];
    const len = Math.hypot(...ec) || 1;
    explodeData.push({ entity, dir: ec.map((v) => v / len) });
  });
}

// --- mesures ---------------------------------------------------------------
function enableMeasure(on) {                                        // NEW:
  dist.control.activate(on);
  document.getElementById("measureBtn").classList.toggle("active", on);
}

dist.on("measurementCreated", (m) => {                              // NEW:
  measurements.push(m);
  renderMeasureList();
});

document.getElementById("clearMeasures").onclick = () => {          // NEW:
  measurements.forEach((m) => m.destroy());
  measurements.length = 0;
  renderMeasureList();
};

// --- coupes ----------------------------------------------------------------
function toggleSection(i) {                                         // NEW:
  if (!sectionPlanes[i]) {
    sectionPlanes[i] = sections.createPlane({});                    // NEW:
  } else {
    sectionPlanes[i].active = !sectionPlanes[i].active;
  }
}

document.querySelectorAll(".section-control").forEach((ctrl) => {   // NEW:
  const i = Number(ctrl.dataset.plane);
  const slider = ctrl.querySelector("input");
  slider.oninput = () => {
    toggleSection(i);
    sectionPlanes[i].pos[1] = slider.value;                         // mapping simple
  };
});

// --- explosion -------------------------------------------------------------
function explodeTo(pct) {                                           // NEW:
  const factor = (pct / 100) * 10;                                 // NEW:
  exploded = pct / 100;                                            // NEW:
  explodeData.forEach(({ entity, dir }) => {
    entity.position = [dir[0] * factor, dir[1] * factor, dir[2] * factor];
  });
}

document.getElementById("explodeRange").oninput = (e) =>
  explodeTo(e.target.value);

// --- isolement/masquage ----------------------------------------------------
function isolate(nodeId) {                                          // NEW:
  viewer.scene.setObjectsVisible(viewer.scene.visibleObjectIds, false);
  viewer.scene.setObjectsVisible([nodeId], true);
}

function showAll() {                                                // NEW:
  viewer.scene.setObjectsVisible(viewer.scene.objectIds, true);
}

function hide(nodeId) {                                             // NEW:
  viewer.scene.setObjectsVisible([nodeId], false);
}

// --- menu contextuel -------------------------------------------------------
const contextMenu = document.getElementById("contextMenu");         // NEW:
canvas.addEventListener("contextmenu", (e) => {                     // NEW:
  e.preventDefault();
  const pick = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
  if (!pick) return;
  contextMenu.style.left = `${e.clientX}px`;
  contextMenu.style.top = `${e.clientY}px`;
  contextMenu.dataset.id = pick.entity.id;
  contextMenu.classList.add("show");
});

document.body.addEventListener("click", () =>                      // NEW:
  contextMenu.classList.remove("show")
);

contextMenu.addEventListener("click", (e) => {                      // NEW:
  const id = contextMenu.dataset.id;
  if (e.target.dataset.action === "isolate") isolate(id);
  if (e.target.dataset.action === "hide") hide(id);
  if (e.target.dataset.action === "showAll") showAll();
  contextMenu.classList.remove("show");
});

// --- surbrillance Alt+clic -------------------------------------------------
canvas.addEventListener("mousemove", (e) => {                       // NEW:
  if (!e.altKey) return;
  const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
  if (highlighted && (!hit || hit.entity.id !== highlighted.id)) {
    highlighted.highlighted = false;
    highlighted = null;
  }
  if (hit && hit.entity && hit.entity !== highlighted) {
    highlighted = hit.entity;
    highlighted.highlighted = true;
  }
});

// --- double clic isoler + fit ----------------------------------------------
canvas.addEventListener("dblclick", (e) => {                        // NEW:
  const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
  if (hit) {
    isolate(hit.entity.id);
    cameraControl.fit({ aabb: hit.entity.aabb });
  }
});

// --- vues standard ---------------------------------------------------------
document.getElementById("fitBtn").onclick = () => cameraControl.fit();    // NEW:
document.getElementById("measureBtn").onclick = () => enableMeasure(!dist.control.active); // NEW:
document.getElementById("sectionBtn").onclick = () => toggleSection(0);   // NEW:
document.getElementById("explodeBtn").onclick = () => {                   // NEW:
  const val = exploded ? 0 : 30;
  explodeTo(val);
  document.getElementById("explodeRange").value = val;
};
document.getElementById("isoBtn").onclick = () => highlighted && isolate(highlighted.id); // NEW:
document.getElementById("resetBtn").onclick = () => resetAll();          // NEW:
document.getElementById("edgesBtn").onclick = () => edges.enabled = !edges.enabled; // NEW:

// --- raccourcis ------------------------------------------------------------
document.addEventListener("keydown", (e) => {                       // NEW:
  if (e.target.tagName === "INPUT") return;
  switch (e.key.toLowerCase()) {
    case "f":
      cameraControl.fit();
      break;
    case "m":
      enableMeasure(!dist.control.active);
      break;
    case "x":
      toggleSection(0);
      break;
    case "e":
      explodeTo(exploded ? 0 : 30);
      document.getElementById("explodeRange").value = exploded * 100;
      break;
    case "i":
      if (highlighted) isolate(highlighted.id);
      break;
    case "r":
      resetAll();
      break;
  }
});

// --- export PNG ------------------------------------------------------------
document.getElementById("pngBtn").onclick = () => {                 // NEW:
  const data = viewer.getSnapshot();
  const link = document.createElement("a");
  link.download = "capture.png";
  link.href = data;
  link.click();
};

// --- reset complet ---------------------------------------------------------
function resetAll() {                                               // NEW:
  showAll();
  dist.clear();
  measurements.length = 0;
  sectionPlanes.forEach((p) => p && (p.active = false));
  explodeTo(0);
  edges.enabled = false;
  cameraControl.reset();
  renderMeasureList();
}

// --- UI --------------------------------------------------------------------
function renderMeasureList() {                                      // NEW:
  const ul = document.getElementById("measureList");
  ul.innerHTML = "";
  measurements.forEach((m, i) => {
    const li = document.createElement("li");
    li.textContent = `Mesure ${i + 1} : ${m.length.toFixed(2)} mm`;
    const del = document.createElement("button");
    del.textContent = "×";
    del.onclick = () => {
      m.destroy();
      measurements.splice(i, 1);
      renderMeasureList();
    };
    li.appendChild(del);
    ul.appendChild(li);
  });
}

// panneau latéral
document.getElementById("panelToggle").onclick = () =>
  document.getElementById("sidePanel").classList.toggle("collapsed"); // NEW:

// --- resize ----------------------------------------------------------------
window.addEventListener(
  "resize",
  debounce(() => viewer.resize(), 200)                              // NEW:
);

// debounce simple
function debounce(fn, delay) {                                      // NEW:
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// --- API publique ----------------------------------------------------------
window.viewerApp = {                                                // NEW:
  load,
  fit: () => cameraControl.fit(),
  enableMeasure,
  toggleSection,
  explodeTo,
  isolate,
  resetAll,
  edges: (on) => (edges.enabled = on),
};

// --- chargement auto -------------------------------------------------------
const modelParam = document.body.dataset.model;                     // NEW:
if (modelParam) load(`/uploads/${modelParam}`);

// --- tooltip ---------------------------------------------------------------
const tooltip = document.createElement("div");                      // NEW:
tooltip.className = "tooltip";
document.body.appendChild(tooltip);

canvas.addEventListener("mousemove", (e) => {                       // NEW:
  const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
  if (hit && hit.entity) {
    tooltip.style.left = `${e.clientX + 10}px`;
    tooltip.style.top = `${e.clientY + 10}px`;
    tooltip.textContent = hit.entity.id;
    tooltip.classList.add("show");
  } else {
    tooltip.classList.remove("show");
  }
});

const analyzeBtn = document.getElementById("dfmAnalyzeBtn");       // NEW:
if (analyzeBtn) {                                                   // NEW:
  analyzeBtn.addEventListener("click", () => {                      // NEW:
    const modalEl = document.getElementById("materialQuestionnaireModal");
    if (modalEl) new bootstrap.Modal(modalEl).show();
  });
}                                                                   // NEW:

// --- nettoyage -------------------------------------------------------------
function clearAll() {                                               // NEW:
  resetAll();
  if (loadedModel) {
    loadedModel.destroy();
    loadedModel = null;
  }
}
