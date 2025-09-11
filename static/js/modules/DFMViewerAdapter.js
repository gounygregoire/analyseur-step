import { AnnotationsPlugin } from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2/dist/xeokit-sdk.es.js";

// Interface d'affichage entre les résultats DFM et Xeokit
export class DFMViewerAdapter {
  constructor(viewerApp) {
    this.app = viewerApp;
    this.viewer = viewerApp.viewer || viewerApp;
    this.annotations = viewerApp.annotations || new AnnotationsPlugin(this.viewer, {});
    this._annotIds = [];
    this._coloredMeshes = [];
  }

  // Applique une heatmap. Préfère le per-vertex, fallback sur per-face.
  applyHeatmap(heatmap) {
    const model = this.app.model;
    if (!model || !heatmap) return;
    this._coloredMeshes = [];
    model.meshes.forEach(m => {
      const g = m.geometry;
      let ok = false;
      if (heatmap.vertexColors) {
        try {
          g.setColors({ colors: heatmap.vertexColors });
          ok = true;
        } catch (_) { /* fallback */ }
      }
      if (!ok && heatmap.faceColors) {
        try {
          g.setColors({ colors: heatmap.faceColors, space: "faces" });
          ok = true;
        } catch (_) { /* ignore */ }
      }
      if (ok) this._coloredMeshes.push(m);
    });
  }

  // Ajoute des annotations cliquables qui zooment sur la zone.
  addAnnotations(annotations = []) {
    annotations.forEach(a => {
      const ann = this.annotations.createAnnotation({
        id: a.id,
        worldPos: a.worldPos,
        text: a.label
      });
      ann.on("click", () => {
        if (a.aabb) {
          this.viewer.cameraFlight.flyTo({ aabb: a.aabb });
        } else if (a.worldPos) {
          this.viewer.cameraFlight.flyTo({ look: a.worldPos });
        }
      });
      this._annotIds.push(ann.id);
    });
  }

  // Centre la caméra sur une annotation existante.
  focusAnnotation(id) {
    const ann = this.annotations.getAnnotation?.(id);
    if (!ann) return;
    const aabb = ann.aabb;
    if (aabb) {
      this.viewer.cameraFlight.flyTo({ aabb });
    } else if (ann.worldPos) {
      this.viewer.cameraFlight.flyTo({ look: ann.worldPos });
    }
  }

  // Supprime heatmap + annotations
  clearDFMOverlays() {
    this._coloredMeshes.forEach(m => m.geometry.setColors(null));
    this._coloredMeshes = [];
    this._annotIds.forEach(id => this.annotations.removeAnnotation(id));
    this._annotIds = [];
  }

  // Affiche une flèche simple représentant l'axe de démoulage
  previewDemouldAxis({ axis = "X", direction = 1, vector = null } = {}) {
    if (!this.viewer || !this.app.measure) return;
    this.clearAxisPreview();

    const aabb = this.viewer.scene.getAABB();
    const cx = (aabb[0] + aabb[3]) / 2;
    const cy = (aabb[1] + aabb[4]) / 2;
    const cz = (aabb[2] + aabb[5]) / 2;
    const size = Math.max(aabb[3] - aabb[0], aabb[4] - aabb[1], aabb[5] - aabb[2]);

    let dir;
    if (vector) {
      const len = Math.hypot(vector[0], vector[1], vector[2]) || 1;
      dir = [vector[0] / len, vector[1] / len, vector[2] / len];
    } else {
      dir = axis === "Y" ? [0, 1, 0] : axis === "Z" ? [0, 0, 1] : [1, 0, 0];
    }
    dir = dir.map((v) => v * (direction >= 0 ? 1 : -1));
    const end = [cx + dir[0] * size, cy + dir[1] * size, cz + dir[2] * size];

    this._axisMeasurement = this.app.measure.createMeasurement({
      positions: [cx, cy, cz, ...end],
      labelsShown: false
    });
  }

  // Efface la prévisualisation d'axe
  clearAxisPreview() {
    if (this._axisMeasurement) {
      this._axisMeasurement.destroy?.();
      this._axisMeasurement = null;
    }
  }
}

export default DFMViewerAdapter;
