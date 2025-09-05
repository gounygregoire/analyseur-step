// Simple per-face heatmap renderer for Xeokit
// mapping: {faceId: scalar}
export default class HeatmapLayer {
  constructor(viewerAdapter) {
    this.viewerAdapter = viewerAdapter;
    this.viewer = viewerAdapter?.viewer || viewerAdapter;
  }

  apply(mapping = {}) {
    const model = this.viewerAdapter?.app?.model || this.viewer?.scene?.models?.[0];
    if (!model || !mapping) return;

    const values = Object.values(mapping).map(Number);
    if (!values.length) return;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    let faceId = 0;
    model.meshes.forEach((mesh) => {
      const geom = mesh.geometry;
      const indices = geom.indices;
      const faceCount = indices ? indices.length / 3 : (geom.positions?.length || 0) / 9;
      const colors = new Float32Array(faceCount * 3);
      for (let i = 0; i < faceCount; i++) {
        const val = mapping[faceId] ?? min;
        const t = (val - min) / range;
        const rgb = this._colormap(t);
        colors.set(rgb, i * 3);
        faceId++;
      }
      try {
        geom.setColors({ colors, space: "faces" });
      } catch (_) {
        /* ignore coloring errors */
      }
    });
  }

  _colormap(t) {
    const r = t;
    const g = 0;
    const b = 1 - t;
    return [r, g, b];
  }
}

