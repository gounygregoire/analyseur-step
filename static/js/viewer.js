// static/js/viewer.js

let _viewer, _xktLoader;

export async function loadCameraPresetOptional(u) {
  try {
    const r = await fetch(u, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function bootstrapViewer() {
  const ready = (d) => d.readyState === 'complete' || d.readyState === 'interactive';
  if (!ready(document)) {
    await new Promise(res => document.addEventListener('DOMContentLoaded', res, { once: true }));
    console.info('[viewer] DOMContentLoaded');
  }
  const container = document.getElementById('viewerContainer');
  if (!container) throw new Error('[viewer] viewerContainer introuvable');
  let canvas = document.getElementById('xktCanvas');
  if (!canvas) {
    console.warn('[viewer] xktCanvas absent, création…');
    canvas = document.createElement('canvas');
    canvas.id = 'xktCanvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);
  }
  // sécurité : garantir une hauteur au container
  const cs = getComputedStyle(container);
  const h = container.clientHeight || parseInt(cs.height) || 0;
  if (h < 200) {
    container.style.minHeight = '320px';
    console.warn('[viewer] container était trop petit, minHeight=320px appliqué');
  }
  console.info('[viewer] bootstrap ok', { w: container.clientWidth, h: container.clientHeight });
  return canvas;
}

export async function initViewer() {
  try {
    const canvas = await bootstrapViewer();
    console.info('[viewer] init ok', { canvas });
    // N’INSTANCIE PAS encore Xeokit ici, juste retourne le canvas
    return { canvas };
  } catch (e) {
    console.error('[viewer] init failed', e);
    throw e;
  }
}

function smokeTestGL(canvas) {
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) throw new Error('[viewer] WebGL non disponible');
  gl.clearColor(0.95, 0.95, 0.95, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  console.info('[viewer] WebGL smoke test ok');
}

export async function startViewer() {
  if (_viewer) {
    console.warn('[viewer] déjà initialisé');
    return { canvas: _viewer.canvas }; // retourne au moins le canvas
  }
  const { canvas } = await initViewer();
  smokeTestGL(canvas);
  if (window.__CADLYTICS_VIEWER) {
    _viewer = window.__CADLYTICS_VIEWER;
    _xktLoader = window.__CADLYTICS_XKT_LOADER || _xktLoader;
  } else {
    const mod = await import('https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2/dist/xeokit-sdk.es.js');
    const { Viewer, XKTLoaderPlugin } = mod;
    _viewer = new Viewer({ canvasId: canvas.id });
    _xktLoader = new XKTLoaderPlugin(_viewer);
    window.__CADLYTICS_VIEWER = _viewer;
    window.__CADLYTICS_XKT_LOADER = _xktLoader;
  }
  console.info('[viewer] ready (sans modèle)');
  return { canvas };
}

export async function loadXKT(url) {
  console.info('[viewer] loadXKT', url);
  if (!_viewer) throw new Error('viewer non initialisé');
  let model;
  if (_xktLoader && _xktLoader.load) {
    model = await _xktLoader.load({ id: 'model', src: url, edges: true });
    const aabb = model?.aabb || _viewer.scene?.aabb;
    if (aabb && _viewer.cameraFlight) {
      _viewer.cameraFlight.fit(aabb);
    }
  } else if (_viewer.loadXKT) {
    model = await _viewer.loadXKT(url);
    if (_viewer.fitAll) _viewer.fitAll();
  }
  console.info('[viewer] XKT affiché');
  return model;
}
