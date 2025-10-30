// /static/js/HeatmapLayer.js — UTF-8 (NO BOM)
// Gestionnaire d'overlays pour la heatmap dépouille basé sur le registry CAD.
// Crée des meshes temporaires qui ne modifient pas les matériaux d'origine.

import {
  ReadableGeometry,
  Mesh,
  PhongMaterial
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

export class HeatmapLayer {
  constructor(registry) {
    this.registry = registry || {};
    this._overlays = [];
    this._visible = true;
    this._signature = null;
    this._seq = 0;
    this._lastToggleKey = null;
    this.isReady = false;
    this._waiting = false;
    this._lastReadyBroadcast = null;
    this._lastWaitingBroadcast = null;
    this._disposed = false;
    this.colors = {
      ok: [0.20, 0.80, 0.20],       // vert
      zero: [0.98, 0.80, 0.15],     // jaune
      undercut: [0.90, 0.25, 0.25]  // rouge
    };
    this.opacity = 0.85;
  }

  get globalWindow() {
    if (this._winRef === undefined) {
      this._winRef = typeof window !== "undefined" ? window : null;
    }
    return this._winRef;
  }

  get viewer() {
    return this.registry?.viewer || null;
  }

  get scene() {
    const viewer = this.viewer;
    if (viewer?.scene) return viewer.scene;
    const modelScene = this.registry?.model?.scene;
    if (modelScene) return modelScene;
    return null;
  }

  renderDraft({ axis, thresholdDeg, entries, mode } = {}) {
    const scene = this.scene;
    const viewer = this.viewer;
    if (!scene || !viewer) {
      throw new Error("MODEL_NOT_READY");
    }

    const meshCount = Number(scene.stats?.numMeshes ?? scene.numMeshes ?? 0);
    const hasMeshes = Number.isFinite(meshCount) && meshCount > 0;
    const cam = scene.camera;
    const projOk = !!(cam && cam.projection === "perspective" && cam.perspective &&
      Number.isFinite(cam.perspective.near) && Number.isFinite(cam.perspective.far));

    if (!hasMeshes || !projOk) {
      const scheduler = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
      const params = { axis, thresholdDeg, entries, mode };
      scheduler(() => {
        if (this._disposed) {
          return;
        }
        this.renderDraft(params);
      });
      return false;
    }

    const axisKey = this._normalizeAxisKey(axis);
    const thrKey = Number.isFinite(Number(thresholdDeg))
      ? Number(thresholdDeg).toFixed(3)
      : "auto";
    const resolvedMode = typeof mode === "string" ? mode : (this.registry?.heatmap?.mode || "ok");
    const signature = `${this._currentModelId()}|${resolvedMode}|${axisKey}|${thrKey}`;

    if (this._signature === signature) {
      this._setVisible(this._overlays.length > 0);
      return this._overlays.length > 0;
    }

    this.clear();
    this._disposed = false;

    const sourceEntries = Array.isArray(entries)
      ? entries
      : Array.isArray(this.registry?.heatmap?.state?.entries)
        ? this.registry.heatmap.state.entries
        : [];

    let created = 0;
    for (const entry of sourceEntries) {
      if (this._disposed) {
        break;
      }
      const mesh = entry?.mesh;
      if (!mesh || mesh.destroyed) continue;
      const bucket = entry?.buckets?.[resolvedMode];
      if (!bucket || !bucket.count || !bucket.tris) continue;
      if (this._createOverlay(scene, mesh, bucket.tris, resolvedMode)) {
        created++;
      }
    }

    if (this._disposed) {
      return false;
    }

    this._signature = signature;
    this._setVisible(created > 0);
    return created > 0;
  }

  clear() {
    this._disposed = true;
    for (const handle of this._overlays) {
      try { handle.mesh?.destroy(); } catch {}
      try { handle.geom?.destroy(); } catch {}
      try { handle.material?.destroy?.(); } catch {}
    }
    this._overlays.length = 0;
    this._signature = null;
    this._visible = false;
    this._seq = 0;
    this._lastToggleKey = null;
  }

  setVisible(flag) {
    this._setVisible(!!flag);
  }

  _setVisible(flag) {
    this._visible = !!flag;
    for (const handle of this._overlays) {
      if (handle.mesh && !handle.mesh.destroyed) {
        handle.mesh.visible = this._visible;
      }
    }
  }

  setReadyState(flag) {
    const ready = !!flag;
    const prev = this.isReady;
    this.isReady = ready;
    const heatmapState = this.registry?.heatmap;
    if (heatmapState && typeof heatmapState === "object") {
      heatmapState.ready = ready;
    }
    if (prev !== ready) {
      this._dispatchReadyEvent(ready);
    }
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
    return next;
  }

  toggle({ model, axis, renderFn } = {}) {
    const modelId = model?.id
      ?? this.registry?.model?.id
      ?? this.registry?.loaderModel?.id
      ?? this._currentModelId();
    const axisKey = this._normalizeAxisKey(axis);
    const key = `${modelId}|${axisKey}`;
    const same = key === this._lastToggleKey;
    const hasOverlays = this._overlays.length > 0;

    if (same && hasOverlays) {
      this._visible = !this._visible;
      this._setVisible(this._visible);
      if (typeof renderFn === "function") {
        renderFn({ visibleOnly: true, show: this._visible });
      }
      return this._visible;
    }

    this._lastToggleKey = key;
    this._visible = true;
    this._setVisible(true);
    if (typeof renderFn === "function") {
      renderFn({ recompute: true, axis, show: true });
    }
    return true;
  }

  _createOverlay(scene, mesh, triIndices, mode) {
    if (!mesh || mesh.destroyed) return null;
    if (!triIndices || triIndices.length === 0) return null;

    const geomData = this._resolveGeometry(mesh);
    if (!geomData) {
      console.warn("[heatmap] missing geometry on mesh", mesh?.id);
      return null;
    }

    const { positions, indices } = geomData;
    const triCount = (indices.length / 3) | 0;

    const triList = Array.from(triIndices).filter((t) => t >= 0 && t < triCount);
    if (!triList.length) return null;

    const matrix = this._resolveWorldMatrix(mesh);
    const hasMatrix = !!matrix;

    const vertexCount = triList.length * 3;
    const outPositions = new Float32Array(vertexCount * 3);
    const outIndices = new (vertexCount > 0xFFFF ? Uint32Array : Uint16Array)(vertexCount);
    let v = 0;

    for (const triIndex of triList) {
      const i0 = indices[triIndex * 3] * 3;
      const i1 = indices[triIndex * 3 + 1] * 3;
      const i2 = indices[triIndex * 3 + 2] * 3;

      this._writePosition(outPositions, v * 3, positions, i0, matrix, hasMatrix);
      this._writePosition(outPositions, (v + 1) * 3, positions, i1, matrix, hasMatrix);
      this._writePosition(outPositions, (v + 2) * 3, positions, i2, matrix, hasMatrix);

      outIndices[v] = v;
      outIndices[v + 1] = v + 1;
      outIndices[v + 2] = v + 2;
      v += 3;
    }

    if (!v) return null;

    const idSuffix = `${mesh.id || "mesh"}_${mode}_${this._seq++}`;
    let overlayGeom;
    try {
      overlayGeom = new ReadableGeometry(scene, {
        id: `draftGeom_${idSuffix}`,
        primitive: "triangles",
        positions: outPositions,
        indices: outIndices,
        backfaces: true
      });
    } catch (err) {
      console.warn("[heatmap] échec création géométrie", err);
      return null;
    }

    const color = this.colors[mode] || [0.6, 0.6, 0.6];
    const material = new PhongMaterial(scene, {
      id: `draftMat_${idSuffix}`,
      diffuse: color,
      opacity: this.opacity,
      alpha: true,
      backfaces: true
    });

    const overlayMesh = new Mesh(scene, {
      id: `draftMesh_${idSuffix}`,
      geometry: overlayGeom,
      material,
      pickable: false,
      visible: this._visible,
      collidable: false
    });

    this._overlays.push({ mesh: overlayMesh, geom: overlayGeom, material });
    return overlayMesh;
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

  _resolveGeometry(mesh) {
    const geom = mesh?.geometry || mesh?._geometry || null;
    if (!geom) return null;

    const positions = this._resolveGeometryArray(mesh, geom, "positions");
    const indices = this._resolveGeometryArray(mesh, geom, "indices") || this._resolveGeometryArray(mesh, geom, "triangles");

    if (!positions || !indices || !positions.length || !indices.length) {
      return null;
    }
    return { positions, indices };
  }

  _resolveGeometryArray(mesh, geom, type) {
    const state = geom?._state || geom?.state || {};
    const arrays = geom?.arrays || geom?._arrays || {};
    const geometryData = geom?.geometryData || geom?.data || {};
    const nestedGeom = geom?.geometry || geom?._geometry || state.geometry || {};
    const geometryState = geom?._geometryState || geom?.geometryState || state?._geometryState || state?.geometryState || {};
    const meshState = mesh?._geometryState || mesh?.geometryState || {};

    const candidates = [
      type === "positions" ? mesh?.__dfmPositions : mesh?.__dfmIndices,
      geom?.[`__dfm${type.charAt(0).toUpperCase()}${type.slice(1)}`],
      geom?.[type],
      geom?.[`_${type}`],
      geom?.[`decompressed${type.charAt(0).toUpperCase()}${type.slice(1)}`],
      geom?.[`compressed${type.charAt(0).toUpperCase()}${type.slice(1)}`],
      geom?.[`${type}Compressed`],
      geom?.[`${type}Decompressed`],
      arrays?.[type],
      arrays?.[type]?.data,
      arrays?.[type]?.array,
      state?.[type],
      state?.[`_${type}`],
      state?.[`${type}Data`],
      state?.[`${type}Decompressed`],
      state?.geometry?.[type],
      state?.geometry?.[type]?.data,
      state?.geometry?.[type]?.array,
      geometryState?.[type],
      geometryState?.[`_${type}`],
      geometryState?.[`${type}Data`],
      geometryState?.[`${type}Decompressed`],
      geometryState?.arrays?.[type],
      geometryState?.arrays?.[type]?.data,
      geometryState?.arrays?.[type]?.array,
      meshState?.[type],
      meshState?.[`_${type}`],
      meshState?.arrays?.[type],
      meshState?.arrays?.[type]?.data,
      meshState?.arrays?.[type]?.array,
      geometryData?.[type],
      geometryData?.[type]?.data,
      geometryData?.[type]?.array,
      nestedGeom?.[type],
      nestedGeom?.[type]?.data,
      nestedGeom?.[type]?.array
    ];

    for (const candidate of candidates) {
      const arr = this._pickGeometryArray(candidate);
      if (arr && arr.length) {
        return arr;
      }
    }
    return null;
  }

  _pickGeometryArray(src) {
    if (!src) return null;
    if (ArrayBuffer.isView(src)) return src;
    if (Array.isArray(src)) return src;
    const win = this.globalWindow;
    if (typeof src.length === "number" && src && src !== win) {
      try {
        const ctorName = src.constructor?.name || "";
        if (ctorName.endsWith("Array")) {
          return src;
        }
      } catch {}
    }
    const nestedKeys = ["data", "array", "values", "typedArray", "bufferView"];
    for (const key of nestedKeys) {
      if (src && src[key] && src[key] !== src) {
        const nested = this._pickGeometryArray(src[key]);
        if (nested) return nested;
      }
    }
    if (src.buffer && typeof src.byteLength === "number" && typeof src.BYTES_PER_ELEMENT === "number") {
      return src;
    }
    return null;
  }

  _normalizeAxisKey(axis) {
    if (!axis) return "Z";
    if (typeof axis === "string") {
      return axis.trim().toUpperCase() || "Z";
    }
    if (typeof axis === "object") {
      if (axis.letter) return axis.letter.toUpperCase();
      if (axis.vector) {
        return [axis.vector.x || 0, axis.vector.y || 0, axis.vector.z || 0]
          .map((v) => Number(v).toFixed(4))
          .join(",");
      }
      return [axis.x || 0, axis.y || 0, axis.z || 0]
        .map((v) => Number(v).toFixed(4))
        .join(",");
    }
    return "Z";
  }

  _currentModelId() {
    const model = this.registry?.model;
    return (
      model?.id ||
      model?.modelId ||
      model?.cfg?.id ||
      model?.meta?.id ||
      "model"
    );
  }

  _dispatchReadyEvent(ready) {
    if (this._lastReadyBroadcast === ready) {
      return;
    }
    this._lastReadyBroadcast = ready;
    if (typeof document !== "undefined" && typeof document.dispatchEvent === "function") {
      try {
        document.dispatchEvent(new CustomEvent("dfm:heatmap-ready", { detail: { ready } }));
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
}

export default HeatmapLayer;
