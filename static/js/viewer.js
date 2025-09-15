// static/js/viewer.js
let _viewer; // instance moteur si besoin (xeokit, etc.)
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

// Test WebGL sur un canvas jetable (ne touche JAMAIS au canvas du viewer)
function smokeTestGL() {
  const test = document.createElement('canvas');
  const gl2 = test.getContext('webgl2');
  const gl = gl2 || test.getContext('webgl') || test.getContext('experimental-webgl');
  if (!gl) throw new Error('[viewer] WebGL indisponible');
  gl.clearColor(0.95, 0.95, 0.95, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  console.info(`[viewer] WebGL smoke test ok (${gl2 ? 'webgl2' : 'webgl1'})`);
}

export async function startViewer() {
  const canvas = await bootstrapViewer();
  smokeTestGL();            // ✅ test offscreen, pas sur `canvas`
  // ⬇️ Ici seulement, on laisse le moteur créer SON contexte sur `canvas`
  // Exemple (à adapter à ta lib) :
  // const { Viewer, XKTLoaderPlugin } = await import('@xeokit/xeokit-sdk');
  // _viewer = new Viewer({ canvasElement: canvas, transparent: false });
  // _viewer.cameraControl.navMode = "orbit";
  console.info('[viewer] ready (sans modèle)');
  return { canvas };
}

export async function loadXKT(url) {
  if (!_viewer) console.warn('[viewer] init attendu avant loadXKT');
  console.info('[viewer] loadXKT', url);
  // Adapte selon ta lib. Exemple générique :
  if (_viewer?.loadXKT) {
    const model = await _viewer.loadXKT(url);
    if (_viewer.fitAll) _viewer.fitAll();
    bus.dispatchEvent(new CustomEvent('model-loaded', { detail: { url, model } }));
    return model;
  }
  // Exemple xeokit (si tu utilises le SDK ESM) :
  // const loader = new XKTLoaderPlugin(_viewer);
  // const model = await loader.load({ id: 'model', src: url, edges: true });
  // _viewer.cameraFlight.flyTo(model);
  // bus.dispatchEvent(new CustomEvent('model-loaded', { detail: { url, model } }));
}

// --- Compat (répare l'import de DFMOrchestrator.js) ---
export function loadCameraPresetOptional(preset) {
  try {
    const v = (typeof _viewer !== 'undefined') ? _viewer : null;
    if (!v) return; // no-op si le viewer n'est pas prêt
    // Adapte si tu utilises xeokit : cameraFlight / zoomTo / fitAll
    if (v.cameraFlight && preset?.aabb) {
      v.cameraFlight.flyTo(preset.aabb);
    } else if (v.fitAll) {
      v.fitAll();
    }
  } catch (e) {
    console.warn('[viewer] camera preset ignoré', e);
  }
}
