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
