// src/main.js
// Viewer Xeokit + outils, aligné avec ton HTML actuel

import {
  Viewer,
  XKTLoaderPlugin,
  DistanceMeasurementsPlugin,
  SectionPlanesPlugin
  // PAS d'EdgesPlugin dans ta version
} from "@xeokit/xeokit-sdk";

let viewer, cameraControl, xktLoader, dist, sections;

const state = {
  measurements: [],
  sectionPlane: null,
  exploded: 0
};

// ---------- Initialisation ---------------------------------------------------
export async function initViewer(modelUrl) {
  const canvas = document.getElementById("viewer3d");
  if (!canvas) {
    console.warn("viewer3d canvas not found, skipping viewer init");
    return;
  }

  viewer = new Viewer({ canvasElement: canvas });
  window.viewer = viewer;

  cameraControl = viewer.cameraControl;

  xktLoader = new XKTLoaderPlugin(viewer);
  dist      = new DistanceMeasurementsPlugin(viewer);
  sections  = new SectionPlanesPlugin(viewer);

  // Empêcher le scroll de page quand la molette est sur le canvas
  viewer.canvas.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });

  // Mesures -> UI
  dist.on?.("measurementCreated", (m) => {
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

// Chargement auto via data-model
document.addEventListener("DOMContentLoaded", () => {
  const fname = document.body.dataset.model;
  initViewer(fname ? `/uploads/${fname}` : undefined);
});

// ---------- UI ---------------------------------------------------------------
function bindUI() {
  // Fit
  byId("fitBtn")?.addEventListener("click", () => cameraControl.fit?.());

  // Mesure (toggle)
  byId("measureBtn")?.addEventListener("click", () => {
    const on = !(dist.control?.active || dist.active);
    if (dist.control?.activate) dist.control.activate(on);
    else if (typeof dist.setActive === "function") dist.setActive(on);
    toggleActive("measureBtn", on);
  });

  // Reset mesures
  byId("clearMeasures")?.addEventListener("click", () => {
    try { dist.clear?.(); } catch {}
    state.measurements.forEach((m) => m.destroy?.());
    state.measurements.length = 0;
    renderMeasurements();
  });

  // Coupes (toggle)
  byId("sectionBtn")?.addEventListener("click", () => {
    if (!state.sectionPlane) {
      state.sectionPlane = sections.createPlane?.({ dir: [0, 1, 0] })
                          || sections.createSectionPlane?.({ dir: [0, 1, 0] });
    }
    const on = !state.sectionPlane.active;
    state.sectionPlane.active = on;
    toggleActive("sectionBtn", on);
  });

  // Sliders coupes (3 plans UI mappés sur Y)
  document.querySelectorAll(".section-control input")?.forEach((slider) => {
    slider.addEventListener("input", () => {
      if (!state.sectionPlane) {
        state.sectionPlane = sections.createPlane?.({ dir: [0, 1, 0] })
                            || sections.createSectionPlane?.({ dir: [0, 1, 0] });
        state.sectionPlane.active = true;
        toggleActive("sectionBtn", true);
      }
      const aabb = viewer.scene.getAABB();
      const minY = aabb[1], maxY = aabb[4];
      const y = minY + ((Number(slider.value) + 1) / 2) * (maxY - minY);
      state.sectionPlane.pos = [0, y, 0];
      viewer.scene.glRedraw?.();
    });
  });

  // Explosion (slider)
  byId("explodeRange")?.addEventListener("input", (e) => {
    const pct = Number(e.target.value);
    state.exploded = pct / 100;
    viewer.scene.root.explode(state.exploded);
  });

  // Bouton Explosion (toggle 0/30 %)
  byId("explodeBtn")?.addEventListener("click", () => {
    const next = state.exploded ? 0 : 0.3;
    state.exploded = next;
    viewer.scene.root.explode(next);
    const r = byId("explodeRange");
    if (r) r.value = String(next * 100);
  });

  // Isoler (objet sous le centre du canvas)
  byId("isoBtn")?.addEventListener("click", () => {
    const rect = viewer.canvas.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const hit = viewer.scene.pick({ canvasPos: [cx, cy] });
    if (hit?.entity?.id) isolate(hit.entity.id);
  });

  // Arêtes (fallback = filaire, car EdgesPlugin indisponible)
  byId("edgesBtn")?.addEventListener("click", () => {
    const on = !viewer.scene.objectsWireframe;
    viewer.scene.setObjectsWireframe(viewer.scene.objects, on);
    toggleActive("edgesBtn", on);
  });

  // Reset complet
  byId("resetBtn")?.addEventListener("click", resetAll);

  // Export PNG
  byId("pngBtn")?.addEventListener("click", () => {
    const data = viewer.getSnapshot();
    const a = document.createElement("a");
    a.download = "capture.png";
    a.href = data;
    a.click();
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
    const len = typeof m.length === "number" ? m.length : (m.getLength?.() ?? 0);
    const li = document.createElement("li");
    li.textContent = `Mesure ${i + 1}: ${len.toFixed(2)} mm`;
    list.appendChild(li);
  });
}

// ---------- Menu contextuel / Tooltip ---------------------------------------
function setupContextMenu() {
  const menu = byId("contextMenu");
  if (!menu) return;
  const canvas = viewer.canvas;

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
    if (!hit || !hit.entity) return;
    menu.dataset.id = hit.entity.id;
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.classList.add("show");
  });

  document.addEventListener("click", () => menu.classList.remove("show"));

  menu.addEventListener("click", (e) => {
    const id = menu.dataset.id;
    const action = e.target?.dataset?.action;
    if (action === "isolate") isolate(id);
    if (action === "hide")    hide(id);
    if (action === "showAll") showAll();
    menu.classList.remove("show");
  });
}

function setupTooltip() {
  const canvas = viewer.canvas;
  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  document.body.appendChild(tooltip);

  canvas.addEventListener("mousemove", (e) => {
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

  canvas.addEventListener("dblclick", (e) => {
    const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
    if (hit && hit.entity) {
      isolate(hit.entity.id);
      cameraControl.fit?.({ aabb: hit.entity.aabb });
    }
  });
}

// ---------- Helpers ---------------------------------------------------------
function fitScene() {
  try {
    const aabb = viewer.scene.getAABB();
    viewer.cameraFlight.flyTo?.({ aabb });
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
  try { dist.clear?.(); } catch {}
  state.measurements.length = 0;
  if (state.sectionPlane) state.sectionPlane.active = false;
  viewer.scene.root.explode(0);
  // edges plugin absent → on s'assure de couper le filaire
  viewer.scene.setObjectsWireframe(viewer.scene.objects, false);
  cameraControl.reset?.();
  renderMeasurements();
  ["measureBtn","sectionBtn","edgesBtn"].forEach((id) => toggleActive(id, false));
  const r = byId("explodeRange"); if (r) r.value = "0";
}

function toggleActive(id, on) {
  const btn = document.getElementById(id);
  btn?.classList.toggle("active", on);
}

function byId(name) {
  return document.getElementById(name);
}
