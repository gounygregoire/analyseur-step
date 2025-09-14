import { Viewer, XKTLoaderPlugin }
  from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2/dist/xeokit-sdk.es.js";

// PATCH START: init with canvasElement
const _canvas = document.getElementById('xktCanvas');
if (!_canvas) { console.error('[viewer] missing #xktCanvas'); }
const _viewer = new Viewer({ canvasElement: _canvas });
const xktLoader = new XKTLoaderPlugin(_viewer);
try { _viewer.canvas.canvas.style.background = '#e9ecef'; } catch(e){}
// PATCH END

// PATCH START: optional camera preset
export async function loadCameraPresetOptional(u){
  try { const r = await fetch(u, {cache:'no-store'}); return r.ok ? await r.json() : null; }
  catch { return null; }
}
// PATCH END

// PATCH START: loadFromFileId with /models fallback
async function pickReachableUrl(id){
  const urls = [`/models/${id}.xkt`, `/static/converted/${id}.xkt`];
  for (const u of urls){
    try { const h = await fetch(u, { method:'HEAD', cache:'no-store' });
          console.log('[viewer] HEAD', u, h.status);
          if (h.ok) return u; } catch {}
  }
  return null;
}
export async function loadFromFileId(fileId){
  const url = await pickReachableUrl(fileId);
  if (!url){ console.error('[viewer] no reachable XKT'); return false; }
  console.log('[viewer] load', url);
  console.time('[viewer] xkt load');
  const model = await xktLoader.load({ src: url });
  console.timeEnd('[viewer] xkt load');
  const aabb = (model && model.aabb) || _viewer.scene.aabb;
  if (aabb) _viewer.cameraControl.fit(aabb);
  console.log('[viewer] fit ok', aabb);
  return true;
}
// expose pour l’orchestrateur
window.viewerAdapter = { viewer: _viewer, loadFromFileId };
// PATCH END
// PATCH START: xeokit v2 bootstrap + robust loader
import { Viewer, XKTLoaderPlugin } from "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2/dist/xeokit-sdk.es.js";

(function initViewerV2(){
  function ready(fn){ /complete|interactive/.test(document.readyState) ? fn() : document.addEventListener('DOMContentLoaded', fn); }
  ready(() => {
    const canvas = document.getElementById('xktCanvas');
    if (!canvas){ console.error('initViewer failed canvas introuvable'); return; }

    const viewer = new Viewer({ canvasElement: canvas });
    const xktLoader = new XKTLoaderPlugin(viewer);
    try { viewer.canvas.canvas.style.background = '#e9ecef'; } catch(e){}

    async function pickUrl(id){
      const urls = [`/models/${id}.xkt`, `/static/converted/${id}.xkt`];
      for (const u of urls){
        try { const h = await fetch(u, { method:'HEAD', cache:'no-store' });
              console.log('[viewer] HEAD', u, h.status);
              if (h.ok) return u; } catch {}
      }
      return null;
    }

    async function loadFromFileId(fileId){
      const url = await pickUrl(fileId);
      if (!url){ console.error('[viewer] no reachable XKT for', fileId); return false; }
      console.log('[viewer] load', url);
      console.time('[viewer] xkt load');
      const model = await xktLoader.load({ src: url });
      console.timeEnd('[viewer] xkt load');
      const aabb = (model && model.aabb) || viewer.scene.aabb;
      if (aabb) viewer.cameraControl.fit(aabb);
      console.log('[viewer] fit ok', aabb);
      return true;
    }

    // expose pour l’orchestrateur
    window.viewerAdapter = { viewer, loadFromFileId };
    console.log('[viewer] init ok');
  });
})();
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
