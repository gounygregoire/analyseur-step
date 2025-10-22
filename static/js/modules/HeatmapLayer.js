// /static/js/modules/HeatmapLayer.js — UTF-8 (NO BOM)
// Gestion simple d'une heatmap par overlays Xeokit basée sur un mapping face -> scalaire.
// Création d'un mesh temporaire par mesh source afin de ne pas modifier les matériaux d'origine.

import {
  ReadableGeometry,
  Mesh,
  PhongMaterial
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

const DEFAULT_HEATMAP_BUTTON_SELECTORS = [
  "#btnHeatmapDepouille",
  "#btnHeatmapOK",
  "#btnHeatmapZero",
  "#btnHeatmapUndercut",
  "#heatmapBtn",
  "[data-heatmap-toggle]",
  "[data-role=\"heatmap-toggle\"]"
];

let ensureModelGeometryReadyLoader = null;

async function loadEnsureModelGeometryReady() {
  if (ensureModelGeometryReadyLoader) {
    return ensureModelGeometryReadyLoader;
  }
  ensureModelGeometryReadyLoader = import("./DraftHeatmap.js")
    .then((mod) => {
      if (typeof mod.ensureModelGeometryReady === "function") {
        return mod.ensureModelGeometryReady;
      }
      throw new Error("ensureModelGeometryReady unavailable");
    })
    .catch((err) => {
      ensureModelGeometryReadyLoader = null;
      throw err;
    });
  return ensureModelGeometryReadyLoader;
}

function arrayFromLike(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.slice();
  if (typeof value.length === "number" && value !== value.window) {
    try { return Array.from(value); } catch { return []; }
  }
  return [];
}

function addSelectorCandidates(targetSet, candidate) {
  if (!candidate && candidate !== 0) return;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (trimmed) targetSet.add(trimmed);
    return;
  }
  if (typeof candidate === "function") {
    try { addSelectorCandidates(targetSet, candidate()); } catch {}
    return;
  }
  if (candidate && typeof candidate.length === "number") {
    for (const item of arrayFromLike(candidate)) {
      addSelectorCandidates(targetSet, item);
    }
    return;
  }
  if (candidate && typeof candidate === "object") {
    const maybeSel = candidate.selector || candidate.sel;
    if (typeof maybeSel === "string") {
      addSelectorCandidates(targetSet, maybeSel);
      return;
    }
  }
}

function addElementCandidates(push, candidate) {
  if (!candidate && candidate !== 0) return;
  if (typeof candidate === "function") {
    try { addElementCandidates(push, candidate()); } catch {}
    return;
  }
  if (typeof candidate === "string") {
    return; // handled via selectors
  }
  if (candidate && typeof candidate.nodeType === "number" && candidate.nodeType === 1) {
    push(candidate);
    return;
  }
  if (candidate && typeof candidate.length === "number") {
    for (const item of arrayFromLike(candidate)) {
      addElementCandidates(push, item);
    }
    return;
  }
  if (candidate && typeof candidate.forEach === "function") {
    try { candidate.forEach((item) => addElementCandidates(push, item)); } catch {}
    return;
  }
  if (candidate && typeof candidate.get === "function") {
    try { addElementCandidates(push, candidate.get()); } catch {}
  }
}

export default class HeatmapLayer {
  constructor(viewerAdapter) {
    this.viewerAdapter = viewerAdapter;
    const registry = viewerAdapter?.registry || viewerAdapter;
    this.registry = registry;
    this.viewer = registry?.viewer || viewerAdapter?.viewer || viewerAdapter;
    this._overlays = [];
    this._visible = true;
    this._seq = 0;
    this.opacity = 0.85;
    this.isReady = false;
    this._waiting = false;
    this._warmupDone = new WeakSet();
    this._warmupPromises = new WeakMap();
    this._lastReadyBroadcast = null;
    this._lastWaitingBroadcast = null;
    this._buttonMeta = new WeakMap();
    if (this.registry && typeof this.registry === "object") {
      const heatmapState = this.registry.heatmap || (this.registry.heatmap = {});
      if (!heatmapState.layer) {
        heatmapState.layer = this;
      }
      if (typeof heatmapState.ready === "boolean") {
        this.isReady = heatmapState.ready;
      }
      if (typeof heatmapState.waiting === "boolean") {
        this._waiting = heatmapState.waiting;
      }
    }
    this._refreshButtons();
    if (typeof document !== "undefined" && document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this._refreshButtons(), { once: true });
    }
  }

  get scene() {
    const registryScene = this.registry?.model?.scene;
    if (registryScene) return registryScene;
    const viewerScene = this.viewer?.scene;
    if (viewerScene) return viewerScene;
    return null;
  }

  setReadyState(flag) {
    const ready = !!flag;
    const heatmapState = this.registry?.heatmap;
    const previous = typeof heatmapState?.ready === "boolean"
      ? heatmapState.ready
      : this.isReady;
    this.isReady = ready;
    if (heatmapState && typeof heatmapState === "object") {
      heatmapState.ready = ready;
    }
    if (previous !== ready) {
      this._dispatchReadyEvent(ready);
    }
    this._refreshButtons();
    return ready;
  }

  setWaiting(waiting) {
    const next = !!waiting;
    const prev = this._waiting;
    this._waiting = next;
    const heatmapState = this.registry?.heatmap;
    if (heatmapState && typeof heatmapState === "object") {
      heatmapState.waiting = next;
    }
    if (prev !== next) {
      this._dispatchWaitingEvent(next);
    }
    this._refreshButtons();
    return next;
  }

  async awaitReadyAndMaybeWarmup({ viewer, model } = {}) {
    const targetViewer = viewer || this.viewer || this.registry?.viewer;
    const registryModel = this.registry?.model;
    const candidateModel = model || registryModel || this.registry?.loaderModel;
    if (!targetViewer || !candidateModel) {
      this.setWaiting(false);
      this.setReadyState(false);
      return false;
    }

    if (this._warmupDone.has(candidateModel)) {
      this.setWaiting(false);
      this.setReadyState(true);
      return true;
    }

    const existing = this._warmupPromises.get(candidateModel);
    if (existing) {
      this.setWaiting(true);
      try {
        const ok = await existing;
        this.setReadyState(ok === true);
        return ok === true;
      } catch (err) {
        this.setReadyState(false);
        throw err;
      } finally {
        this.setWaiting(false);
      }
    }

    this.setWaiting(true);
    this.setReadyState(false);

    const waitPromise = (async () => {
      const ensureReady = await loadEnsureModelGeometryReady();
      await ensureReady({ viewer: targetViewer, model: candidateModel });
      this._warmupDone.add(candidateModel);
      return true;
    })();

    this._warmupPromises.set(candidateModel, waitPromise);

    try {
      const ok = await waitPromise;
      this.setReadyState(ok === true);
      return ok === true;
    } catch (err) {
      this._warmupDone.delete(candidateModel);
      this.setReadyState(false);
      throw err;
    } finally {
      this._warmupPromises.delete(candidateModel);
      this.setWaiting(false);
    }
  }

  clear() {
    let cleared = false;
    for (const handle of this._overlays) {
      try {
        if (handle?.dispose) {
          handle.dispose();
        } else {
          try { handle?.mesh?.destroy?.(); } catch {}
          try { handle?.geom?.destroy?.(); } catch {}
          try { handle?.material?.destroy?.(); } catch {}
        }
        cleared = true;
      } catch {}
    }
    this._overlays.length = 0;
    this._seq = 0;
    return cleared;
  }

  setVisible(flag) {
    this._visible = !!flag;
    for (const handle of this._overlays) {
      if (handle.mesh && !handle.mesh.destroyed) {
        handle.mesh.visible = this._visible;
      }
    }
  }

  apply(mapping = {}) {
    const model = this.registry?.model;
    const scene = this.scene;
    if (!model || !scene) {
      this.clear();
      return [];
    }

    const values = Object.values(mapping)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (!values.length) {
      this.clear();
      return [];
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    this.clear();

    let faceId = 0;
    const meshes = Array.isArray(model.meshes) ? model.meshes : model.meshList || [];

    for (const mesh of meshes) {
      if (!mesh || mesh.destroyed) {
        faceId += this._countFaces(mesh);
        continue;
      }

      const geomData = this._resolveGeometry(mesh);
      if (!geomData) {
        faceId += this._countFaces(mesh);
        continue;
      }

      const { positions, indices } = geomData;
      const triCount = Math.floor(indices.length / 3);
      if (!triCount) {
        continue;
      }

      const overlayPositions = new Float32Array(triCount * 9);
      const indexArrayCtor = triCount * 3 > 0xFFFF ? Uint32Array : Uint16Array;
      const overlayIndices = new indexArrayCtor(triCount * 3);
      const overlayColors = new Float32Array(triCount * 9);

      const matrix = this._resolveWorldMatrix(mesh);
      const hasMatrix = !!matrix;

      let v = 0;
      for (let tri = 0; tri < triCount; tri++) {
        const baseIndex = tri * 3;
        const i0 = indices[baseIndex] * 3;
        const i1 = indices[baseIndex + 1] * 3;
        const i2 = indices[baseIndex + 2] * 3;

        this._writePosition(overlayPositions, v * 3, positions, i0, matrix, hasMatrix);
        this._writePosition(overlayPositions, (v + 1) * 3, positions, i1, matrix, hasMatrix);
        this._writePosition(overlayPositions, (v + 2) * 3, positions, i2, matrix, hasMatrix);

        overlayIndices[v] = v;
        overlayIndices[v + 1] = v + 1;
        overlayIndices[v + 2] = v + 2;

        const val = Number(mapping[faceId]);
        const clamped = Number.isFinite(val) ? (val - min) / range : 0;
        const t = Math.min(1, Math.max(0, clamped));
        const rgb = this._colormap(t);
        overlayColors.set(rgb, v * 3);
        overlayColors.set(rgb, (v + 1) * 3);
        overlayColors.set(rgb, (v + 2) * 3);

        v += 3;
        faceId++;
      }

      if (!v) {
        continue;
      }

      const idSuffix = `${mesh.id || "mesh"}_${this._seq++}`;
      let overlayGeom;
      try {
        overlayGeom = new ReadableGeometry(scene, {
          id: `heatGeom_${idSuffix}`,
          primitive: "triangles",
          positions: overlayPositions,
          indices: overlayIndices,
          colors: overlayColors,
          backfaces: true
        });
      } catch (err) {
        console.warn("[heatmap] échec création géométrie", err);
        continue;
      }

      let material;
      try {
        material = new PhongMaterial(scene, {
          id: `heatMat_${idSuffix}`,
          vertexColors: true,
          alpha: true,
          opacity: this.opacity,
          backfaces: true
        });
      } catch (err) {
        console.warn("[heatmap] échec création matériau", err);
        try { overlayGeom.destroy(); } catch {}
        continue;
      }

      let overlayMesh;
      try {
        overlayMesh = new Mesh(scene, {
          id: `heatMesh_${idSuffix}`,
          geometry: overlayGeom,
          material,
          pickable: false,
          collidable: false,
          visible: this._visible
        });
      } catch (err) {
        console.warn("[heatmap] échec création mesh", err);
        try { overlayGeom.destroy(); } catch {}
        try { material.destroy?.(); } catch {}
        continue;
      }

      const handle = {
        mesh: overlayMesh,
        geom: overlayGeom,
        material,
        managedByLayer: true,
        dispose() {
          try { overlayMesh?.destroy?.(); } catch {}
          try { overlayGeom?.destroy?.(); } catch {}
          try { material?.destroy?.(); } catch {}
        }
      };
      this._overlays.push(handle);
    }

    if (!this._overlays.length) {
      this.clear();
    }
    return this.getHandles();
  }

  getHandles() {
    return this._overlays.slice();
  }

  _dispatchReadyEvent(ready) {
    if (this._lastReadyBroadcast === ready) {
      return;
    }
    this._lastReadyBroadcast = ready;
    if (typeof document !== "undefined" && typeof document.dispatchEvent === "function") {
      try {
        document.dispatchEvent(new CustomEvent("dfm:heatmap-ready", {
          detail: { ready }
        }));
      } catch {}
    }
  }

  _dispatchWaitingEvent(waiting) {
    if (this._lastWaitingBroadcast === waiting) {
      return;
    }
    this._lastWaitingBroadcast = waiting;
    if (typeof document !== "undefined" && typeof document.dispatchEvent === "function") {
      try {
        document.dispatchEvent(new CustomEvent("dfm:heatmap-wait", {
          detail: { waiting, ready: this.isReady }
        }));
      } catch {}
    }
  }

  _refreshButtons() {
    const shouldDisable = this._waiting || !this.isReady;
    this._applyButtonDisabledState(shouldDisable);
  }

  _resolveButtons() {
    if (typeof document === "undefined") {
      return [];
    }
    const heatmapState = this.registry?.heatmap || {};
    const selectors = new Set(DEFAULT_HEATMAP_BUTTON_SELECTORS);
    addSelectorCandidates(selectors, heatmapState.buttonSelector);
    addSelectorCandidates(selectors, heatmapState.buttonSelectors);

    const elements = [];
    const seen = new Set();
    const pushElement = (el) => {
      if (!el || typeof el !== "object") return;
      if (typeof el.nodeType === "number" && el.nodeType === 1) {
        if (!seen.has(el)) {
          seen.add(el);
          elements.push(el);
        }
      }
    };

    addElementCandidates(pushElement, heatmapState.buttonElement);
    addElementCandidates(pushElement, heatmapState.buttonElements);

    for (const sel of selectors) {
      try {
        const list = document.querySelectorAll(sel);
        for (const el of list) {
          pushElement(el);
        }
      } catch {}
    }

    return elements;
  }

  _applyButtonDisabledState(disable) {
    const buttons = this._resolveButtons();
    if (!buttons.length) {
      return;
    }
    for (const btn of buttons) {
      if (!btn || typeof btn.disabled === "undefined") continue;
      const meta = this._buttonMeta.get(btn) || {};
      if (disable) {
        if (!meta.hasOwnProperty("prevDisabled")) {
          meta.prevDisabled = !!btn.disabled;
        }
        btn.disabled = true;
        if (this._waiting) {
          btn.setAttribute("aria-busy", "true");
        } else {
          btn.removeAttribute("aria-busy");
        }
        this._buttonMeta.set(btn, meta);
      } else {
        const hadPrev = meta.hasOwnProperty("prevDisabled");
        if (hadPrev && meta.prevDisabled === false) {
          btn.disabled = false;
        }
        if (!this._waiting) {
          btn.removeAttribute("aria-busy");
        } else {
          btn.setAttribute("aria-busy", "true");
        }
        delete meta.prevDisabled;
        if (Object.keys(meta).length) {
          this._buttonMeta.set(btn, meta);
        } else {
          this._buttonMeta.delete(btn);
        }
      }
    }
  }

  _pickGeometryArray(src) {
    if (!src) return null;
    if (ArrayBuffer.isView(src)) return src;
    if (Array.isArray(src)) return src;
    if (src.data && src.data !== src) {
      const data = this._pickGeometryArray(src.data);
      if (data) return data;
    }
    if (src.array && src.array !== src) {
      const arr = this._pickGeometryArray(src.array);
      if (arr) return arr;
    }
    return null;
  }

  _resolveGeometry(mesh) {
    const geom = mesh?.geometry || mesh?._geometry || null;
    if (!geom) return null;

    const positions = this._pickGeometryArray(
      geom.positions ||
      geom._positions ||
      geom.decompressedPositions ||
      geom.__dfmPositions ||
      mesh?.__dfmPositions
    );

    const indices = this._pickGeometryArray(
      geom.indices ||
      geom._indices ||
      geom.triangles ||
      geom.__dfmIndices ||
      mesh?.__dfmIndices
    );

    if (!positions || !indices || !positions.length || !indices.length) {
      return null;
    }

    return { positions, indices };
  }

  _countFaces(target) {
    const geom = target?.geometry || target || null;
    if (!geom) return 0;

    const indices = this._pickGeometryArray(
      geom.indices ||
      geom._indices ||
      geom.triangles ||
      geom.__dfmIndices ||
      target?.__dfmIndices
    );
    if (indices && indices.length) {
      return Math.floor(indices.length / 3);
    }

    const positions = this._pickGeometryArray(
      geom.positions ||
      geom._positions ||
      geom.decompressedPositions ||
      geom.__dfmPositions ||
      target?.__dfmPositions
    );
    if (positions && positions.length) {
      return Math.floor(positions.length / 9);
    }

    return 0;
  }

  _resolveWorldMatrix(mesh) {
    if (!mesh) return null;
    const matrix = (
      mesh.worldMatrix ||
      mesh.matrix ||
      mesh.worldTransform?.matrix ||
      mesh.transform?.matrix ||
      null
    );
    if (!matrix) return null;
    if (Array.isArray(matrix) || ArrayBuffer.isView(matrix)) {
      return matrix;
    }
    return null;
  }

  _writePosition(target, offset, source, srcIndex, matrix, hasMatrix) {
    const x = source[srcIndex];
    const y = source[srcIndex + 1];
    const z = source[srcIndex + 2];
    if (!hasMatrix) {
      target[offset] = x;
      target[offset + 1] = y;
      target[offset + 2] = z;
      return;
    }
    target[offset] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    target[offset + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    target[offset + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }

  _colormap(t) {
    const clamped = Math.min(1, Math.max(0, t));
    const r = clamped;
    const g = 0;
    const b = 1 - clamped;
    return [r, g, b];
  }
}
