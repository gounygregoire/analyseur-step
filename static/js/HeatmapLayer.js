// /static/js/modules/HeatmapLayer.js — UTF-8 (NO BOM)
// Affiche des "overlays" de triangles pour la heatmap dépouille (masques par bucket).
// Utilise des meshes temporaires (overlays) construits à partir d'un sous-ensemble de triangles.
// Dépendances: xeokit SDK (TrianglesGeometry, Mesh, PhongMaterial)

import {
  TrianglesGeometry,
  Mesh,
  PhongMaterial
} from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

export class HeatmapLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this._overlays = [];   // { mesh, geom }
    this._visible = true;
    // couleurs par bucket
    this.colors = {
      ok:        [0.20, 0.80, 0.20],   // vert
      zero:      [0.98, 0.80, 0.15],   // jaune
      undercut:  [0.90, 0.25, 0.25],   // rouge
    };
    this.opacity = 0.85;
  }

  setVisible(flag) {
    this._visible = !!flag;
    for (const o of this._overlays) {
      if (o.mesh && !o.mesh.destroyed) o.mesh.visible = this._visible;
    }
  }

  clear() {
    for (const o of this._overlays) {
      try { o.mesh?.destroy(); } catch(e) {}
      try { o.geom?.destroy(); } catch(e) {}
    }
    this._overlays.length = 0;
  }

  /**
   * Construit et affiche un overlay avec uniquement les triangles fournis.
   * @param {Object} params
   * @param {Object} params.mesh   - Mesh xeokit d'origine (celui qui porte la géométrie complète)
   * @param {Uint32Array|Uint16Array|Array<number>} params.triIndices - index de triangles (dans le buffer indices du mesh d'origine)
   * @param {"ok"|"zero"|"undercut"} params.mode
   * @returns {Mesh|null}
   */
  showDraftMask({ mesh, triIndices, mode }) {
    if (!mesh || mesh.destroyed) return null;
    if (!triIndices || triIndices.length === 0) return null;

    const geom0 = mesh.geometry;
    if (!geom0 || !geom0.positions || !geom0.indices) {
      console.warn("[HeatmapLayer] géométrie manquante sur mesh:", mesh.id);
      return null;
    }

    const pos0 = geom0.positions;   // Float32Array
    const idx0 = geom0.indices;     // Uint16/32
    const nTris0 = (idx0.length / 3) | 0;

    // Sanity
    const triList = Array.from(triIndices).filter(t => t >= 0 && t < nTris0);
    if (triList.length === 0) return null;

    // Construit une nouvelle géométrie avec uniquement ces triangles.
    const outPositions = [];
    const outIndices = [];
    let v = 0;

    for (let k = 0; k < triList.length; k++) {
      const t = triList[k];
      const i0 = idx0[t*3]   * 3;
      const i1 = idx0[t*3+1] * 3;
      const i2 = idx0[t*3+2] * 3;

      // copie positions (duplique pour isoler la face)
      outPositions.push(
        pos0[i0],   pos0[i0+1],   pos0[i0+2],
        pos0[i1],   pos0[i1+1],   pos0[i1+2],
        pos0[i2],   pos0[i2+1],   pos0[i2+2]
      );
      outIndices.push(v, v+1, v+2);
      v += 3;
    }

    const idSuffix = `${mesh.id}_${mode}_${Date.now()}`;
    const overlayGeom = new TrianglesGeometry(this.scene, {
      id: `draftGeom_${idSuffix}`,
      positions: new Float32Array(outPositions),
      indices:   (outPositions.length/3 > 65535) ? new Uint32Array(outIndices) : new Uint16Array(outIndices),
      // backfaces true pour voir les faces quelle que soit l'orientation des normales
      backfaces: true
    });

    const color = this.colors[mode] || [0.6, 0.6, 0.6];
    const mat = new PhongMaterial(this.scene, {
      id: `draftMat_${idSuffix}`,
      diffuse: color,
      opacity: this.opacity,
      alpha: true,
      backfaces: true
    });

    const overlayMesh = new Mesh(this.scene, {
      id: `draftMesh_${idSuffix}`,
      geometry: overlayGeom,
      material: mat,
      pickable: false,
      visible: this._visible,
      collidable: false
    });

    this._overlays.push({ mesh: overlayMesh, geom: overlayGeom });
    return overlayMesh;
  }

  /**
   * Confort : applique un bucket sur un tableau de meshes.
   * @param {Object} params
   * @param {Array<Object>} params.meshes
   * @param {Array<Uint32Array|Uint16Array|Array<number>>} params.triBuckets - même longueur que meshes
   * @param {"ok"|"zero"|"undercut"} params.mode
   */
  showDraftMasksBatch({ meshes, triBuckets, mode }) {
    if (!meshes || !triBuckets) return;
    for (let i = 0; i < meshes.length; i++) {
      this.showDraftMask({ mesh: meshes[i], triIndices: triBuckets[i], mode });
    }
  }
}

export default HeatmapLayer;
