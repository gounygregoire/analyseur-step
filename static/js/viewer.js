let _viewer, _loader;
const bus = new EventTarget();
export function onModelLoaded(cb){ bus.addEventListener('model-loaded', cb); }

async function loadXeokit(){
  try{ return await import('@xeokit/xeokit-sdk'); }
  catch{ console.warn('[viewer] fallback CDN ESM'); return await import('https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@1.8.2/+esm'); }
}

export async function bootstrapViewer(){
  if (document.readyState === 'loading') {
    await new Promise(res => document.addEventListener('DOMContentLoaded', res, {once:true}));
  }
  const container = document.getElementById('viewerContainer');
  if (!container) throw new Error('[viewer] #viewerContainer introuvable');
  let canvas = document.getElementById('xktCanvas');
  if (!canvas){
    canvas = document.createElement('canvas');
    canvas.id = 'xktCanvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);
  }
  if ((container.clientHeight||0) < 360) container.style.minHeight = '420px';
  return canvas;
}

export async function startViewer(){
  const canvas = await bootstrapViewer();
  const { Viewer, XKTLoaderPlugin } = await loadXeokit();
  _viewer = new Viewer({ canvasElement: canvas, transparent:false, logarithmicDepthBufferEnabled:true, dtxEnabled:true });
  _viewer.scene.gammaInput = true;
  _viewer.scene.gammaOutput = true;
  new ResizeObserver(()=>{ try{ _viewer.resize(); }catch{} }).observe(document.getElementById('viewerContainer'));
  _loader = new XKTLoaderPlugin(_viewer);
  console.info('[viewer] prêt');
  return _viewer;
}

export async function loadXKT(url){
  if (!_viewer) throw new Error('viewer non initialisé');
  const model = await _loader.load({ id:'model', src:url, edges:true });
  if (_viewer.cameraFlight) _viewer.cameraFlight.flyTo(model); else if (_viewer.fitAll) _viewer.fitAll();
  bus.dispatchEvent(new CustomEvent('model-loaded', { detail:{ url, model }}));
  return model;
}
