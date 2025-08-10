// src/main.js
// Xeokit + outils barre + contexte, aligné avec ton HTML fusionné

import {
  Viewer,
  CameraControl,
  XKTLoaderPlugin,
  DistanceMeasurementsPlugin,
  SectionPlanesPlugin,
  EdgesPlugin,
  GizmoPlugin
} from "@xeokit/xeokit-sdk";

let viewer, cameraControl, xktLoader, dist, sections, edges, gizmo;

const state = {
  measurements: [],
  sectionPlane: null,
  exploded: 0
};

// ---------- Initialisation ---------------------------------------------------
export async function initViewer(modelUrl) {
  viewer = new Viewer({ canvasId: "viewer3d" });
  window.viewer = viewer; // compat

  cameraControl = new CameraControl(viewer);
  xktLoader = new XKTLoaderPlugin(viewer);
  dist = new DistanceMeasurementsPlugin(viewer);
  sections = new SectionPlanesPlugin(viewer);
  edges = new EdgesPlugin(viewer);
  gizmo = new GizmoPlugin(viewer);
  gizmo.setVisible(false);

  // Empêche le scroll de la page quand on zoome à la molette
  viewer.canvas.addEventListener("wheel", e => e.preventDefault(), { passive: false });

  // Mesures créées -> UI
  dist.on("measurementCreated", m => {
    state.measurements.push(m);
    renderMeasurements();
  });

  if (modelUrl) {
    await xktLoader.load({ src: modelUrl });
    fitScene();
  }

  bindUI();
  return viewer;
}
window.initViewer = initViewer;

// --------- Chargement auto via data-model -----------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const url = document.body.dataset.model;
  initViewer(url ? `/view/${url}` : undefined);
});

// ---------- UI ---------------------------------------------------------------
function bindUI() {
  byId("measureBtn")?.addEventListener("click", () => {
    const on = !dist.control.active;
    dist.control.activate(on);
    toggleActive("measureBtn", on);
  });

  byId("clearMeasurementsBtn")?.addEventListener("click", () => {
    state.measurements.forEach(m => m.destroy());
    state.measurements.length = 0;
    dist.clear();
    renderMeasurements();
  });

  // Coupe 3D: toggle plan avec le bouton
  byId("crossSectionBtn")?.addEventListener("click", () => {
    if (!state.sectionPlane) {
      state.sectionPlane = sections.createPlane({ dir: [0, 1, 0] });
    }
    const on = !state.sectionPlane.active;
    state.sectionPlane.active = on;
    toggleActive("crossSectionBtn", on);
  });

  // Sliders de coupe (dans .section-control, mapping Y simple)
  document.querySelectorAll(".section-control input").forEach((slider) => {
    slider.addEventListener("input", () => {
      if (!state.sectionPlane) {
        state.sectionPlane = sections.createPlane({ dir: [0, 1, 0] });
        state.sectionPlane.active = true;
        toggleActive("crossSectionBtn", true);
      }
      // mappe [-1;1] sur bboxY
      const aabb = viewer.scene.getAABB();
      const minY = aabb[1], maxY = aabb[4];
      const y = minY + ((Number(slider.value) + 1) / 2) * (maxY - minY);
      state.sectionPlane.pos = [0, y, 0];
      viewer.scene.glRedraw && viewer.scene.glRedraw();
    });
  });

  // Filaire
  byId("toggleWireframeBtn")?.addEventListener("click", () => {
    const on = !viewer.scene.objectsWireframe;
    viewer.scene.setObjectsWireframe(viewer.scene.objects, on);
    toggleActive("toggleWireframeBtn", on);
  });

  // Arêtes
  byId("toggleEdgesBtn")?.addEventListener("click", () => {
    edges.enabled = !edges.enabled;
    toggleActive("toggleEdgesBtn", edges.enabled);
  });

  // Axes (gizmo)
  byId("toggleAxesBtn")?.addEventListener("click", () => {
    const on = !gizmo.visible;
    gizmo.setVisible(on);
    toggleActive("toggleAxesBtn", on);
  });

  // Explosion (slider = #explodeRange)
  byId("explodeRange")?.addEventListener("input", (e) => {
    const pct = Number(e.target.value);
    state.exploded = pct / 100;
    viewer.scene.root.explode(state.exploded);
  });

  // Reset
  byId("resetViewBtn")?.addEventListener("click", resetAll);

  // Export PNG (si tu as un bouton avec cet id ; sinon retire)
  byId("exportPngBtn")?.addEventListener("click", () => {
    const data = viewer.getSnapshot();
    const a = document.createElement("a");
    a.download = "capture.png";
    a.href = data;
    a.click();
  });

  // Thème (optionnel)
  byId("themeToggleBtn")?.addEventListener("click", () => {
    document.body.classList.toggle("dark-theme");
  });

  setupContextMenu();
  setupTooltip();
}

// ---------- Mesures ---------------------------------------------------------
function renderMeasurements() {
  const list = byId("measureList");
  if (!list) return;
  list.innerHTML = "";
  state.measurements.forEach((m, i) => {
    const li = document.createElement("li");
    li.textContent = `Mesure ${i + 1}: ${m.length.toFixed(2)} mm`;
    list.appendChild(li);
  });
}

// ---------- Menu contextuel / Tooltip ---------------------------------------
function setupContextMenu() {
  const menu = byId("contextMenu");
  if (!menu) return;
  const canvas = viewer.canvas;

  canvas.addEventListener("contextmenu", e => {
    e.preventDefault();
    const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
    if (!hit || !hit.entity) return;
    menu.dataset.id = hit.entity.id;
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.classList.add("show");
  });

  document.addEventListener("click", () => menu.classList.remove("show"));

  menu.addEventListener("click", e => {
    const id = menu.dataset.id;
    switch (e.target.dataset.action) {
      case "isolate": isolate(id); break;
      case "hide":    hide(id);    break;
      case "showAll": showAll();   break;
    }
    menu.classList.remove("show");
  });
}

function setupTooltip() {
  const canvas = viewer.canvas;
  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  document.body.appendChild(tooltip);

  canvas.addEventListener("mousemove", e => {
    const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
    if (hit && hit.entity) {
      tooltip.textContent = hit.entity.id;
      tooltip.style.left = `${e.clientX + 10}px`;
      tooltip.style.top  = `${e.clientY + 10}px`;
      tooltip.classList.add("show");
    } else {
      tooltip.classList.remove("show");
    }
  });

  canvas.addEventListener("dblclick", e => {
    const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
    if (hit && hit.entity) {
      isolate(hit.entity.id);
      cameraControl.fit({ aabb: hit.entity.aabb });
    }
  });
}

// ---------- Helpers ---------------------------------------------------------
function fitScene() {
  try {
    const aabb = viewer.scene.getAABB();
    viewer.cameraFlight.flyTo({ aabb });
  } catch {}
}

function isolate(id) {
  viewer.scene.setObjectsVisible(viewer.scene.visibleObjects, false);
  viewer.scene.setObjectVisible(id, true);
}

function hide(id) {
  viewer.scene.setObjectVisible(id, false);
}

function showAll() {
  viewer.scene.setObjectsVisible(viewer.scene.objects, true);
}

function resetAll() {
  showAll();
  try { dist.clear(); } catch {}
  state.measurements.length = 0;
  if (state.sectionPlane) state.sectionPlane.active = false;
  viewer.scene.root.explode(0);
  edges.enabled = false;
  viewer.scene.setObjectsWireframe(viewer.scene.objects, false);
  gizmo.setVisible(false);
  cameraControl.reset();
  renderMeasurements();
  ["measureBtn","crossSectionBtn","toggleWireframeBtn",
   "toggleEdgesBtn","toggleAxesBtn"].forEach(id => toggleActive(id, false));
  const ex = byId("explodeRange"); if (ex) ex.value = "0";
}

function toggleActive(id, on) {
  const btn = document.getElementById(id);
  btn?.classList.toggle("active", on);
}

function byId(name) {
  return document.getElementById(name);
}
