let viewer, xktLoader;
window.addEventListener('DOMContentLoaded', () => {
  viewer = new xeokit.Viewer({ canvasId: "xeokitCanvas", transparent: false });
  viewer.scene.clearLights();
  new xeokit.AmbientLight(viewer,{ color:[1,1,1], intensity:1 });
  new xeokit.DirLight(viewer,{ dir:[-1,-1,-1], color:[1,1,1], intensity:.8 });
  new xeokit.AxisGizmo(viewer,{ containerId:"viewerHost" });
  xktLoader = new xeokit.XKTLoaderPlugin(viewer, { edges:true });
});
async function loadXKT(url){
  viewer.scene.clear();
  const model = xktLoader.load({ src:url, edges:true });
  model.on("loaded", () => viewer.cameraFlight.flyTo(model));
}
window.loadXKT = loadXKT;
