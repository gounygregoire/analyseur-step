let viewer, xktLoader;
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('xeokitCanvas');
  if (!canvas || typeof xeokit === 'undefined') {
    console.warn('Xeokit non disponible, viewer désactivé');
    return;
  }
  viewer = new xeokit.Viewer({ canvasId: 'xeokitCanvas', transparent: false });
  viewer.scene.clearLights();
  new xeokit.AmbientLight(viewer, { color: [1, 1, 1], intensity: 1.0 });
  new xeokit.DirLight(viewer, { dir: [-1, -1, -1], color: [1, 1, 1], intensity: 0.8 });
  new xeokit.AxisGizmo(viewer, { containerId: 'viewerHost' });
  xktLoader = new xeokit.XKTLoaderPlugin(viewer, { edges: true });
});

async function loadXKT(url) {
  if (!viewer || !xktLoader) {
    console.warn('Viewer non initialisé');
    return;
  }
  viewer.scene.clear();
  try {
    const model = xktLoader.load({ src: url, edges: true });
    model.on('loaded', () => viewer.cameraFlight.flyTo(model));
  } catch (err) {
    console.warn('XKT load failed:', err);
  }
}

window.loadXKT = loadXKT;
