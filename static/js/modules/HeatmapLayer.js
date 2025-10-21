// /static/js/modules/HeatmapLayer.js — UTF-8 (NO BOM)
// Gestion simple d'une heatmap par overlays Xeokit basée sur un mapping face -> scalaire.
// Création d'un mesh temporaire par mesh source afin de ne pas modifier les matériaux d'origine.

import {
  ReadableGeometry,
  Mesh,
  PhongMaterial
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@1.9.20/dist/xeokit-sdk.es.min.js";

export default class HeatmapLayer {
  constructor(viewerAdapter) {
    this.viewerAdapter = viewerAdapter;
    this.viewer = viewerAdapter?.viewer || viewerAdapter;
    this._overlays = [];
    this._visible = true;
    this._seq = 0;
    this.opacity = 0.85;
  }

  get scene() {
    const viewerScene = this.viewer?.scene;
    if (viewerScene) return viewerScene;
    const registryScene = this.viewerAdapter?.app?.model?.scene;
    if (registryScene) return registryScene;
    return null;
  }

  clear() {
    for (const handle of this._overlays) {
      try { handle.mesh?.destroy(); } catch {}
      try { handle.geom?.destroy?.(); } catch {}
      try { handle.material?.destroy?.(); } catch {}
    }
    this._overlays.length = 0;
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
    const model = this.viewerAdapter?.app?.model || this.viewer?.scene?.models?.[0];
    const scene = this.scene;
    if (!model || !scene) {
      this.clear();
      return;
    }

    const values = Object.values(mapping)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (!values.length) {
      this.clear();
      return;
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

      this._overlays.push({ mesh: overlayMesh, geom: overlayGeom, material });
    }

    if (!this._overlays.length) {
      this.clear();
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
