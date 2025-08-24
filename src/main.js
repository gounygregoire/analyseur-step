// src/main.js
// Viewer Xeokit + outils, aligné avec ton HTML actuel

import {
  Viewer,
  XKTLoaderPlugin,
  DistanceMeasurementsPlugin,
  SectionPlanesPlugin,
  AxisGizmoPlugin
  // PAS d'EdgesPlugin dans ta version
} from "@xeokit/xeokit-sdk";

let viewer, cameraControl, xktLoader, dist, sections, canvas;

const state = {
  measurements: [],
  sectionPlane: null
};

// ---------- Initialisation ---------------------------------------------------
export async function initViewer(modelUrl) {
  const canvasEl = document.getElementById("viewer3d");
  if (!canvasEl) {
    console.warn("viewer3d canvas not found, skipping viewer init");
    return;
  }

  viewer = new Viewer({ canvasElement: canvasEl });
  window.viewer = viewer;

  cameraControl = viewer.cameraControl;

  xktLoader = new XKTLoaderPlugin(viewer);
  dist      = new DistanceMeasurementsPlugin(viewer);
  sections  = new SectionPlanesPlugin(viewer);

  try {
    if (!window.__axes_gizmo__) {
      window.__axes_gizmo__ = new AxisGizmoPlugin(viewer, { canvasId: "axisGizmo" });
    }
  } catch (e) {
    console.warn("AxisGizmoPlugin indisponible", e);
  }

  // Référence directe vers l'élément canvas du viewer
  canvas = viewer.scene.canvas.canvas;

  // Empêcher le scroll de page quand la molette est sur le canvas
  canvas.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });

  // Mesures -> UI
  dist.on?.("measurementCreated", (m) => {
    state.measurements.push(m);
    renderMeasurements();
  });

  if (modelUrl) {
    const model = await xktLoader.load({ id: "current", src: modelUrl });
    try {
      viewer.cameraFlight.flyTo(model);
    } catch (e) {
      try { viewer.cameraFlight.fit?.(); } catch {}
    }
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
  const root = document;
  if (root.__viewer_ui_bound__) return;
  root.__viewer_ui_bound__ = true;

  const uiState = (window.__viewerState__ = window.__viewerState__ || {
    measuring: false,
    sectioning: false,
  });

  const btnFit = byId("fitBtn");
  if (btnFit && window.viewer) {
    btnFit.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      btnFit.classList.add("active");
      try {
        if (viewer.scene?.root) {
          viewer.cameraFlight.flyTo(viewer.scene.root);
        } else {
          viewer.cameraFlight.fit?.();
        }
      } catch {
        try {
          viewer.cameraFlight.fit?.();
        } catch {}
      } finally {
        setTimeout(() => btnFit.classList.remove("active"), 250);
      }
    });
  }

  const btnMeasure = byId("measureBtn");
  if (btnMeasure && dist) {
    btnMeasure.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      uiState.measuring = !uiState.measuring;
      btnMeasure.classList.toggle("active", uiState.measuring);
      if (dist.control?.activate) dist.control.activate(uiState.measuring);
      if (typeof dist.setActive === "function") dist.setActive(uiState.measuring);
      if (typeof dist.enable === "function") dist.enable(uiState.measuring);
    });
  }

  // Reset mesures
  byId("clearMeasures")?.addEventListener("click", () => {
    try {
      dist.clear?.();
    } catch {}
    state.measurements.forEach((m) => m.destroy?.());
    state.measurements.length = 0;
    renderMeasurements();
  });

  const btnSection = byId("sectionBtn");
  if (btnSection && sections) {
    btnSection.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      uiState.sectioning = !uiState.sectioning;
      btnSection.classList.toggle("active", uiState.sectioning);
      if (uiState.sectioning) {
        if (!state.sectionPlane) {
          state.sectionPlane =
            sections.createPlane?.({ dir: [0, 1, 0] }) ||
            sections.createSectionPlane?.({ dir: [0, 1, 0] });
        }
        sections.setVisible?.(true);
        if (state.sectionPlane) state.sectionPlane.active = true;
      } else {
        sections.setVisible?.(false);
        if (state.sectionPlane) state.sectionPlane.active = false;
      }
    });
  }

  // Sliders coupes (3 plans UI mappés sur Y)
  document.querySelectorAll(".section-control input")?.forEach((slider) => {
    slider.addEventListener("input", () => {
      if (!state.sectionPlane) {
        state.sectionPlane =
          sections.createPlane?.({ dir: [0, 1, 0] }) ||
          sections.createSectionPlane?.({ dir: [0, 1, 0] });
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

  // Arêtes (fallback = filaire, car EdgesPlugin indisponible)
  byId("edgesBtn")?.addEventListener("click", () => {
    const on = !viewer.scene.objectsWireframe;
    setWireframe(on);
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

  const analyzeBtn = byId("dfmAnalyzeBtn");
  const materialModal = document.getElementById("materialQuestionnaireModal");
  const materialConfirmBtn = byId("submitQuestionnaire");
  const stiffnessInput = materialModal?.querySelector("#stiffness");
  const flexibilityInput = materialModal?.querySelector("#flexibility");
  const mechWarn = document.getElementById("mechanicalWarning");
  const mechWarnText = document.getElementById("mechanicalWarningText");
  const foodInput = materialModal?.querySelector("#food_contact");
  const medicalInput = materialModal?.querySelector("#medical_grade");
  const flameInput = materialModal?.querySelector("#flame_retardant");
  const electricalInput = materialModal?.querySelector("#electrical");
  const regWarn = document.getElementById("regulatoryWarning");
  const regWarnText = document.getElementById("regulatoryWarningText");
  const transparentInput = materialModal?.querySelector("#transparent");
  const textureInput = materialModal?.querySelector("#texture");
  const aestheticWarn = document.getElementById("aestheticWarning");
  const aestheticWarnText = document.getElementById("aestheticWarningText");

  const mechInputs = materialModal
    ? Array.from(materialModal.querySelectorAll("input[name='mechanical[]']"))
    : [];
  const aestheticInputs = materialModal
    ? Array.from(materialModal.querySelectorAll("input[name='aesthetic[]']"))
    : [];
  const regInputs = materialModal
    ? Array.from(materialModal.querySelectorAll("input[name='regulatory[]']"))
    : [];

  if (analyzeBtn) {
    analyzeBtn.setAttribute("type", "button");
    analyzeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (materialModal) {
        try {
          bootstrap.Modal.getOrCreateInstance(materialModal).show();
        } catch (err) {
          materialModal.style.display = "block";
          materialModal.classList.add("show");
        }
      } else {
        console.warn(
          "materialQuestionnaireModal introuvable — on enchaîne direct sur la DFM"
        );
        startDFMProcess();
      }
    });
  }

  if (materialConfirmBtn) {
    materialConfirmBtn.addEventListener("click", async (e) => {
      if (materialConfirmBtn.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const materialForm = materialModal?.querySelector("form");
      const formData = materialForm ? new FormData(materialForm) : new FormData();
      try {
        const m =
          bootstrap.Modal.getInstance(materialModal) ||
          bootstrap.Modal.getOrCreateInstance(materialModal);
        m.hide();
      } catch (e) {
        if (materialModal) {
          materialModal.classList.remove("show");
          materialModal.style.display = "none";
        }
      }
      startDFMProcess(formData);
    });
  }

  function handleMechanicalConflict(e) {
    if (!stiffnessInput || !flexibilityInput) return;
    if (stiffnessInput.checked && flexibilityInput.checked) {
      if (e.target === stiffnessInput) {
        flexibilityInput.checked = false;
      } else {
        stiffnessInput.checked = false;
      }
      if (mechWarn && mechWarnText) {
        mechWarnText.textContent =
          "Rigidité élevée et Flexibilité ne peuvent pas être sélectionnées ensemble.";
        mechWarn.style.display = "block";
      }
    } else if (mechWarn) {
      mechWarn.style.display = "none";
    }
  }

  function handleRegulatoryConflict(e) {
    if (!foodInput || !medicalInput || !flameInput || !electricalInput) return;
    const sensitive = foodInput.checked || medicalInput.checked;
    const conflict = flameInput.checked || electricalInput.checked;
    if (sensitive && conflict) {
      if (e.target === flameInput || e.target === electricalInput) {
        e.target.checked = false;
      } else {
        flameInput.checked = false;
        electricalInput.checked = false;
      }
      if (regWarn && regWarnText) {
        regWarnText.textContent =
          "Contact alimentaire ou qualité médicale incompatibles avec retardateur de flamme ou propriétés électriques.";
        regWarn.style.display = "block";
      }
    } else if (regWarn) {
      regWarn.style.display = "none";
    }
  }

  function validateQuestionnaire(e) {
    let blocking = false;

    if (mechInputs.filter((i) => i.checked).length > 3) {
      if (e?.target?.checked) e.target.checked = false;
      if (mechWarn && mechWarnText) {
        mechWarnText.textContent = "Maximum 3 contraintes mécaniques.";
        mechWarn.style.display = "block";
      }
    } else if (
      mechWarn &&
      mechWarnText &&
      mechWarnText.textContent === "Maximum 3 contraintes mécaniques."
    ) {
      mechWarn.style.display = "none";
    }

    let aestheticLimit = false;
    if (aestheticInputs.filter((i) => i.checked).length > 2) {
      aestheticLimit = true;
      if (e?.target?.checked) e.target.checked = false;
      if (aestheticWarn && aestheticWarnText) {
        aestheticWarnText.textContent = "Maximum 2 exigences esthétiques.";
        aestheticWarn.style.display = "block";
      }
    } else if (
      aestheticWarn &&
      aestheticWarnText &&
      aestheticWarnText.textContent === "Maximum 2 exigences esthétiques."
    ) {
      aestheticWarn.style.display = "none";
    }

    if (
      regInputs.filter((i) => i.checked && i.dataset.strong === "true").length > 1
    ) {
      if (e?.target?.checked && e.target.dataset.strong === "true")
        e.target.checked = false;
      if (regWarn && regWarnText) {
        regWarnText.textContent = "Maximum 1 contrainte réglementaire forte.";
        regWarn.style.display = "block";
      }
    } else if (
      regWarn &&
      regWarnText &&
      regWarnText.textContent === "Maximum 1 contrainte réglementaire forte."
    ) {
      regWarn.style.display = "none";
    }

    if (!aestheticLimit) {
      const transFlameMsg =
        "Transparence incompatible avec retardateur de flamme.";
      const transTextureMsg =
        "Transparence et texturation : vérifier la faisabilité.";
      if (transparentInput?.checked && flameInput?.checked) {
        if (aestheticWarn && aestheticWarnText) {
          aestheticWarnText.textContent = transFlameMsg;
          aestheticWarn.style.display = "block";
        }
        blocking = true;
      } else if (transparentInput?.checked && textureInput?.checked) {
        if (aestheticWarn && aestheticWarnText) {
          aestheticWarnText.textContent = transTextureMsg;
          aestheticWarn.style.display = "block";
        }
      } else if (
        aestheticWarn &&
        aestheticWarnText &&
        (aestheticWarnText.textContent === transFlameMsg ||
          aestheticWarnText.textContent === transTextureMsg)
      ) {
        aestheticWarn.style.display = "none";
      }
    }

    if (materialConfirmBtn) materialConfirmBtn.disabled = blocking;
  }

  stiffnessInput?.addEventListener("change", (e) => {
    handleMechanicalConflict(e);
    validateQuestionnaire(e);
  });
  flexibilityInput?.addEventListener("change", (e) => {
    handleMechanicalConflict(e);
    validateQuestionnaire(e);
  });
  foodInput?.addEventListener("change", (e) => {
    handleRegulatoryConflict(e);
    validateQuestionnaire(e);
  });
  medicalInput?.addEventListener("change", (e) => {
    handleRegulatoryConflict(e);
    validateQuestionnaire(e);
  });
  flameInput?.addEventListener("change", (e) => {
    handleRegulatoryConflict(e);
    validateQuestionnaire(e);
  });
  electricalInput?.addEventListener("change", (e) => {
    handleRegulatoryConflict(e);
    validateQuestionnaire(e);
  });
  mechInputs.forEach((i) => {
    if (i !== stiffnessInput && i !== flexibilityInput)
      i.addEventListener("change", validateQuestionnaire);
  });
  aestheticInputs.forEach((i) => i.addEventListener("change", validateQuestionnaire));

  validateQuestionnaire();

  setupContextMenu();
  setupTooltip();
}

async function startDFMProcess(materialFormData = new FormData()) {
  try {
    const res = await fetch("/dfm/analyze", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: materialFormData,
    });
    if (!res.ok) throw new Error("DFM HTTP " + res.status);
    const data = await res.json();
    console.log("DFM OK", data);
  } catch (err) {
    console.error("DFM failed", err);
    alert("Analyse DFM échouée. Réessaie.");
  }
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
  if (!menu || !canvas) return;
  const canvasEl = canvas;

  canvasEl.addEventListener("contextmenu", (e) => {
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
    if (action === "hide")    hide(id);
    if (action === "showAll") showAll();
    menu.classList.remove("show");
  });
}

function setupTooltip() {
  if (!canvas) return;
  const canvasEl = canvas;
  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  document.body.appendChild(tooltip);

  canvasEl.addEventListener("mousemove", (e) => {
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

  canvasEl.addEventListener("dblclick", (e) => {
    const hit = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
    if (hit && hit.entity) {
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

function hide(id) {
  viewer.scene.setObjectVisible(id, false);
}

function showAll() {
  viewer.scene.setObjectsVisible(viewer.scene.objects, true);
}

function setWireframe(on) {
  const objs = viewer.scene.objects;
  for (const id in objs) {
    objs[id].wireframe = on;
  }
  viewer.scene.objectsWireframe = on;
}

function resetAll() {
  showAll();
  try { dist.clear?.(); } catch {}
  state.measurements.length = 0;
  if (state.sectionPlane) state.sectionPlane.active = false;
  // edges plugin absent → on s'assure de couper le filaire
  setWireframe(false);
  cameraControl.reset?.();
  renderMeasurements();
  ["measureBtn","sectionBtn","edgesBtn"].forEach((id) => toggleActive(id, false));
}

function toggleActive(id, on) {
  const btn = document.getElementById(id);
  btn?.classList.toggle("active", on);
}

function byId(name) {
  return document.getElementById(name);
}

(function wireUploadAndPreview(){
  const uploadArea = document.getElementById('uploadArea') || document.querySelector('.upload-area');
  if (!uploadArea || uploadArea.dataset.previewBound === '1') return;
  uploadArea.dataset.previewBound = '1';

  const fileInput = document.getElementById('fileInput') || uploadArea.querySelector('input[type="file"]');
  const dropzone  = document.getElementById('dropzone')  || uploadArea.querySelector('.dropzone');
  const visualizeBtn = document.getElementById('visualizeBtn');

  // ---- Helpers ----
  let lastXktUrl = null;
  function setHasFileUI(has){
    if (!dropzone) return;
    dropzone.classList.toggle('has-file', !!has);
  }
  function enableVisualizeBtn(enable){
    if (!visualizeBtn) return;
    visualizeBtn.disabled = !enable;
    visualizeBtn.setAttribute('aria-disabled', String(!enable));
  }
  function showLoading(state){
    if (visualizeBtn) visualizeBtn.classList.toggle('is-loading', !!state);
  }

  async function convertAndGetXKT(files){
    const fd = new FormData();
    [...files].forEach(f => fd.append('file', f));
    const res = await fetch('/convert', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`Convert fail HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.xktUrl) throw new Error('No xktUrl returned');
    return data.xktUrl;
  }

  async function visualizeFromFiles(files){
    if (!files || !files.length) return;
    try {
      showLoading(true);
      setHasFileUI(true);
      enableVisualizeBtn(false);
      const xktUrl = await convertAndGetXKT(files);
      lastXktUrl = xktUrl;
      if (typeof initViewer === 'function') {
        await initViewer(xktUrl);
      } else {
        console.warn('initViewer(modelUrl) is not available.');
      }
      enableVisualizeBtn(true);
    } catch (err) {
      console.error('Visualization error:', err);
      enableVisualizeBtn(false);
      setHasFileUI(false);
      alert('Échec de la visualisation. Merci de réessayer.');
    } finally {
      showLoading(false);
    }
  }

  // ---- Écouteurs fichier ----
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) {
        setHasFileUI(true);
        visualizeFromFiles(fileInput.files);
      } else {
        setHasFileUI(false);
      }
    });
  }

  if (dropzone) {
    ['dragenter','dragover'].forEach(ev =>
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.add('drag-over');
      }, { passive:false })
    );
    ['dragleave','drop'].forEach(ev =>
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.remove('drag-over');
      }, { passive:false })
    );
    dropzone.addEventListener('drop', (e) => {
      const files = e.dataTransfer?.files;
      if (files && files.length) {
        setHasFileUI(true);
        visualizeFromFiles(files);
      }
    }, { passive:false });
  }

  // ---- Bouton “Visualiser” sans reload ----
  if (visualizeBtn) {
    visualizeBtn.setAttribute('type', 'button');
    visualizeBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (lastXktUrl) {
        if (typeof initViewer === 'function') {
          await initViewer(lastXktUrl);
        }
        return;
      }
      if (fileInput?.files?.length) {
        await visualizeFromFiles(fileInput.files);
      } else {
        alert('Aucun fichier sélectionné.');
      }
    });
  }

  setHasFileUI(!!(fileInput?.files?.length));
  enableVisualizeBtn(false);
})();
