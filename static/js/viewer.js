// static/js/viewer.js

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
  if (window.__viewerBooted) {
    console.warn('[viewer] déjà initialisé');
    return window.__viewerInstance;
  }
  const { canvas } = await initViewer();
  smokeTestGL(canvas);
  const instance = { canvas /*, viewer */ };
  window.__viewerBooted = true;
  window.__viewerInstance = instance;
  console.info('[viewer] ready (sans modèle)');
  return instance;
}
