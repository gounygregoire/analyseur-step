import { Viewer, XKTLoaderPlugin, CameraControl, CameraFlightAnimation } from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2/dist/xeokit-sdk.es.js";

// Initialise le viewer Xeokit (v2) sans EdgesPlugin
const _viewer = new Viewer({
  canvasId: "viewerCanvas",
  transparent: false,
});
new CameraControl(_viewer);
new CameraFlightAnimation(_viewer);
const xktLoader = new XKTLoaderPlugin(_viewer);

// Liste des emplacements possibles pour les fichiers XKT
const xktUrlCandidates = (id) => [
  `/static/converted/${id}.xkt`,
  `/models/${id}.xkt`,
];

// Charge un modèle à partir d'un fileId en essayant plusieurs URLs
export async function loadFromFileId(fileId) {
  let lastErr;
  const urls = xktUrlCandidates(fileId);
  for (const url of urls) {
    try {
      console.log('[viewer] try xkt', url);
      console.time('[viewer] xkt load');
      const model = await xktLoader.load({ src: url });
      console.timeEnd('[viewer] xkt load');
      const aabb = (model && model.aabb) || _viewer.scene.aabb;
      _viewer.cameraControl.fit(aabb);
      console.log('[viewer] fit ok', aabb);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error('[viewer] all xkt URLs failed', urls, lastErr);
}

try { _viewer.canvas.canvas.style.background = '#222'; } catch (e) {}

// Expose l'API minimale attendue par l'orchestrateur
window.viewer = {
  loadFromFileId,
  scene: _viewer.scene,
  cameraControl: _viewer.cameraControl,
  cameraFlight: _viewer.cameraFlight,
};

export default window.viewer;
