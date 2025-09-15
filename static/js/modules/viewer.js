import { Viewer as XEViewer, XKTLoaderPlugin as XEXKTLoaderPlugin }
  from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2/dist/xeokit-sdk.es.js";

// PATCH START: optional camera preset
export async function loadCameraPresetOptional(u){
  try { const r = await fetch(u, {cache:'no-store'}); return r.ok ? await r.json() : null; }
  catch { return null; }
}
// PATCH END

// PATCH START: visualiser flow + axis show after material
(function(){
  function $(s){ return document.querySelector(s); }
  const btnVisualiser = $('#btn-visualiser, #visualizeBtn');
  const axisPanel = $('#dfmAxisPanel, #axis-panel');

  // Montre l'axe dès que la matière est validée (et seulement alors)
  function materialIsConfirmed(){ return !!window.selectedMaterial; }
  function showAxisIfReady(){
    if (!axisPanel) return;
    if (!window.currentFileId || !materialIsConfirmed()) return;
    axisPanel.style.display = '';
  }
  window.addEventListener('material:confirmed', showAxisIfReady);
  window.addEventListener('material:selected',  showAxisIfReady);

  async function convert(fileId){
    if (!fileId) return { ok:false };
    try{
      const r = await fetch('/api/simple/convert', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ file_id: fileId, tolerance: window.getTolerance?.() })
      });
      console.log('[visualiser] convert status', r.status);
      let j=null; try{ j = await r.json(); }catch{}
      console.log('[visualiser] payload', j);
      return { ok:r.ok, data:j };
    }catch(e){
      console.warn('[visualiser] convert fetch error', e); return { ok:false };
    }
  }

  async function doVisualize(fid){
    const va = window.viewerAdapter;
    if (!va || !va.loadFromFileId){ console.error('[visualiser] viewerAdapter manquant'); return; }
    await convert(fid);              // idempotent : OK si déjà converti
    await va.loadFromFileId(fid);    // la fonction choisit l’URL qui marche
  }

  if (btnVisualiser) {
    btnVisualiser.addEventListener('click', () => {
      if (!window.currentFileId) { console.warn('[visualiser] no fileId'); return; }
      doVisualize(window.currentFileId);
    });
  }

  // Autoconversion après upload si l’app envoie l’évènement
  window.addEventListener('dfm:fileReady', (e) => {
    const fid = (e?.detail && e.detail.fileId) || window.currentFileId;
    if (fid) doVisualize(fid);
  });
})();
// PATCH END

// PATCH START: single-boot viewer with default canvas + robust loader
if (!window.__XE_VIEWER_BOOT__) {
  window.__XE_VIEWER_BOOT__ = true;

  function getCanvasFromConfig(cfg = {}) {
    return (
      cfg.canvasElement ||
      (cfg.canvasId && document.getElementById(cfg.canvasId)) ||
      document.getElementById('xktCanvas')
    );
  }

  // initViewer peut être appelée par le code existant (main.js). On la rend tolérante.
  window.initViewer = function initViewer(cfg = {}) {
    const canvas = getCanvasFromConfig(cfg);
    if (!canvas) {
      console.error('[viewer] canvas introuvable', { cfg });
      return null;
    }
    const viewer = new XEViewer({ canvasElement: canvas });
    try { viewer.canvas.canvas.style.background = '#e9ecef'; } catch (e) {}
    const xktLoader = new XEXKTLoaderPlugin(viewer);

    async function pickUrl(id) {
      const urls = [
        `/models/${id}.xkt`,
        `/static/converted/${id}.xkt`
      ];
      for (const u of urls) {
        try {
          const h = await fetch(u, { method: 'HEAD', cache: 'no-store' });
          console.log('[viewer] HEAD', u, h.status);
          if (h.ok) return u;
        } catch (_) {}
      }
      return null;
    }

    async function loadFromFileId(fileId) {
      const url = await pickUrl(fileId);
      if (!url) { console.error('[viewer] no reachable XKT for', fileId); return false; }
      console.log('[viewer] load', url);
      console.time('[viewer] xkt load');
      const model = await xktLoader.load({ src: url });
      console.timeEnd('[viewer] xkt load');
      const aabb = (model && model.aabb) || viewer.scene.aabb;
      if (aabb) viewer.cameraControl.fit(aabb);
      console.log('[viewer] fit ok', aabb);
      return true;
    }

    // Expose un adaptateur global unique
    window.viewerAdapter = { viewer, loadFromFileId };
    console.log('[viewer] init ok');
    return viewer;
  };

  // Démarrage automatique après DOM si personne n'appelle initViewer explicitement
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.viewerAdapter) {
      const canvas = document.getElementById('xktCanvas');
      if (canvas) window.initViewer({ canvasElement: canvas });
    }
  });
}
// PATCH END

