// static/js/viewer.js
let _viewer, _loader;
const bus = new EventTarget();
export function onModelLoaded(cb) { bus.addEventListener('model-loaded', cb, { once:false }); }

async function loadXeokit() {
  try {
    // ✅ si tu bundles vraiment, ça marchera
    return await import('@xeokit/xeokit-sdk');
  } catch (e) {
    console.warn('[viewer] import local xeokit raté, fallback CDN ESM…', e);
    // ✅ fallback sans bundler
    return await import('https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@1.8.2/+esm');
  }
}

export async function bootstrapViewer() {
  const ready = d => d.readyState === 'complete' || d.readyState === 'interactive';
  if (!ready(document)) {
    await new Promise(res => document.addEventListener('DOMContentLoaded', res, { once:true }));
  }
  const container = document.getElementById('viewerContainer');
  if (!container) throw new Error('[viewer] viewerContainer introuvable');

  let canvas = document.getElementById('xktCanvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'xktCanvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);
  }
  if ((container.clientHeight || 0) < 320) container.style.minHeight = '360px';
  console.info('[viewer] bootstrap ok', { w: container.clientWidth, h: container.clientHeight });
  return canvas;
}

export async function startViewer() {
  const canvas = await bootstrapViewer();

  // Test WebGL offscreen (pas sur le vrai canvas)
  try {
    const test = document.createElement('canvas');
    const gl = test.getContext('webgl2') || test.getContext('webgl') || test.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL indisponible');
    console.info('[viewer] WebGL smoke test ok');
  } catch (e) {
    console.warn('[viewer] Pas de WebGL : la visu ne sera pas dispo, mais l’upload restera fonctionnel.', e);
  }

  // Charge Xeokit (local ou CDN)
  const { Viewer, XKTLoaderPlugin } = await loadXeokit();

  _viewer = new Viewer({
    canvasElement: canvas,
    transparent: false,
    logarithmicDepthBufferEnabled: true,
    dtxEnabled: true
  });

  _viewer.scene.gammaOutput = true;
  _viewer.scene.gammaInput = true;

  const ro = new ResizeObserver(() => { try { _viewer.resize(); } catch {} });
  ro.observe(document.getElementById('viewerContainer'));

  _loader = new XKTLoaderPlugin(_viewer);

  console.info('[viewer] ready (sans modèle)');
  return { canvas, viewer: _viewer };
}

export async function loadXKT(url) {
  if (!_viewer || !_loader) throw new Error('viewer non initialisé');
  console.info('[viewer] loadXKT', url);
  const model = await _loader.load({ id: 'model', src: url, edges: true });
  if (_viewer.cameraFlight) _viewer.cameraFlight.flyTo(model);
  else if (_viewer.fitAll) _viewer.fitAll();
  bus.dispatchEvent(new CustomEvent('model-loaded', { detail: { url, model } }));
  console.info('[viewer] XKT affiché');
  return model;
}

// — Compat éventuelle avec DFMOrchestrator —
export function loadCameraPresetOptional(preset) {
  try {
    if (!_viewer) return;
    if (_viewer.cameraFlight && preset?.aabb) _viewer.cameraFlight.flyTo(preset.aabb);
    else if (_viewer.fitAll) _viewer.fitAll();
  } catch(e){ console.warn('[viewer] camera preset ignoré', e); }
}
