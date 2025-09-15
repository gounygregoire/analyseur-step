// static/js/viewer.js
let _viewer, _loader;
const bus = new EventTarget();

export function onModelLoaded(cb) { bus.addEventListener('model-loaded', cb, { once:false }); }

export async function bootstrapViewer() {
  const ready = d => d.readyState === 'complete' || d.readyState === 'interactive';
  if (!ready(document)) {
    await new Promise(res => document.addEventListener('DOMContentLoaded', res, { once: true }));
    console.info('[viewer] DOMContentLoaded');
  }
  const container = document.getElementById('viewerContainer');
  if (!container) throw new Error('[viewer] viewerContainer introuvable');

  let canvas = document.getElementById('xktCanvas');
  if (!canvas) {
    console.warn('[viewer] xktCanvas absent, création.');
    canvas = document.createElement('canvas');
    canvas.id = 'xktCanvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);
  }

  // Garantir une zone visible
  if ((container.clientHeight || 0) < 320) {
    container.style.minHeight = '360px';
  }

  console.info('[viewer] bootstrap ok', { w: container.clientWidth, h: container.clientHeight });
  return canvas;
}

export async function startViewer() {
  const canvas = await bootstrapViewer();

  // 👉 ESM via npm (@xeokit/xeokit-sdk) – conseillé
  const { Viewer, XKTLoaderPlugin } = await import('@xeokit/xeokit-sdk');

  _viewer = new Viewer({
    canvasElement: canvas,
    transparent: false,
    logarithmicDepthBufferEnabled: true,
    dtxEnabled: true
  });

  // Améliorations visuelles basiques
  _viewer.scene.gammaOutput = true;
  _viewer.scene.gammaInput = true;

  // Resize robuste
  const container = document.getElementById('viewerContainer');
  const ro = new ResizeObserver(() => { try { _viewer.resize(); } catch {} });
  ro.observe(container);

  // Loader XKT
  _loader = new XKTLoaderPlugin(_viewer);

  console.info('[viewer] ready (sans modèle)');
  return { canvas, viewer: _viewer };
}

export async function loadXKT(url) {
  if (!_viewer || !_loader) throw new Error('viewer non initialisé');
  console.info('[viewer] loadXKT', url);
  const model = await _loader.load({ id: 'model', src: url, edges: true });
  if (_viewer.cameraFlight) {
    _viewer.cameraFlight.flyTo(model);
  } else if (_viewer.fitAll) {
    _viewer.fitAll();
  }
  bus.dispatchEvent(new CustomEvent('model-loaded', { detail: { url, model } }));
  console.info('[viewer] XKT affiché');
  return model;
}

// --- Compat pour DFMOrchestrator (no-op sûr) ---
export function loadCameraPresetOptional(preset) {
  try {
    if (!_viewer) return;
    if (_viewer.cameraFlight && preset?.aabb) _viewer.cameraFlight.flyTo(preset.aabb);
    else if (_viewer.fitAll) _viewer.fitAll();
  } catch (e) { console.warn('[viewer] camera preset ignoré', e); }
}
