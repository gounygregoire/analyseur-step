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
    this.colors = {
      ok: [0.20, 0.80, 0.20],       // vert
      zero: [0.98, 0.80, 0.15],     // jaune
      undercut: [0.90, 0.25, 0.25]  // rouge
    };
    this.opacity = 0.85;
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

    const sourceEntries = Array.isArray(entries)
      ? entries
      : Array.isArray(this.registry?.heatmap?.state?.entries)
        ? this.registry.heatmap.state.entries
        : [];

    let created = 0;
    for (const entry of sourceEntries) {
      const mesh = entry?.mesh;
      if (!mesh || mesh.destroyed) continue;
      const bucket = entry?.buckets?.[resolvedMode];
      if (!bucket || !bucket.count || !bucket.tris) continue;
      if (this._createOverlay(scene, mesh, bucket.tris, resolvedMode)) {
        created++;
      }
    }

    this._signature = signature;
    this._setVisible(created > 0);
    return created > 0;
  }

  clear() {
    for (const handle of this._overlays) {
      try { handle.mesh?.destroy(); } catch {}
      try { handle.geom?.destroy(); } catch {}
      try { handle.material?.destroy?.(); } catch {}
    }
    this._overlays.length = 0;
    this._signature = null;
    this._visible = false;
    this._seq = 0;
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
}

export default HeatmapLayer;
