import { AnnotationsPlugin } from "@xeokit/xeokit-sdk";

// Interface d'affichage entre les résultats DFM et Xeokit
export class DFMViewerAdapter {
  constructor(viewerApp) {
    this.app = viewerApp;
    this.viewer = viewerApp.viewer || viewerApp;
    this.annotations = viewerApp.annotations || new AnnotationsPlugin(this.viewer);
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

  // Supprime heatmap + annotations
  clearDFMOverlays() {
    this._coloredMeshes.forEach(m => m.geometry.setColors(null));
    this._coloredMeshes = [];
    this._annotIds.forEach(id => this.annotations.removeAnnotation(id));
    this._annotIds = [];
  }
}

export default DFMViewerAdapter;
