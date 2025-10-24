const XEOKIT_CDN_URL = "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/dist/xeokit-sdk.es.min.js";

let _viewer, _loader;

const DEFAULT_XKT_LOADER_OPTIONS = {
  dracoDecompressorPath:
    "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@latest/resources/draco/",
  storeGeometry: true,
  keepGeometry: true,
  parseGeometryStreams: true,
  readGeometry: true,
  decodeGeometry: true,
  decompressGeometry: true
};

function buildLoadConfig(config = {}) {
  return {
    edges: true,
    storeGeometry: true,
    keepGeometry: true,
    parseGeometryStreams: true,
    readGeometry: true,
    decodeGeometry: true,
    decompressGeometry: true,
    ...config
  };
}
const bus = new EventTarget();
export function onModelLoaded(cb){ bus.addEventListener('model-loaded', cb); }

async function loadXeokit(){
  try {
    return await import(XEOKIT_CDN_URL);
  } catch (err) {
    console.error('[viewer] impossible de charger Xeokit', err);
    throw err;
  }
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
  _loader = new XKTLoaderPlugin(_viewer, DEFAULT_XKT_LOADER_OPTIONS);
  console.info('[viewer] prêt');
  return _viewer;
}

export async function loadXKT(url){
  if (!_viewer) throw new Error('viewer non initialisé');
  const model = await _loader.load(buildLoadConfig({ id: 'model', src: url }));
  if (_viewer.cameraFlight) _viewer.cameraFlight.flyTo(model); else if (_viewer.fitAll) _viewer.fitAll();
  bus.dispatchEvent(new CustomEvent('model-loaded', { detail:{ url, model }}));
  return model;
}
