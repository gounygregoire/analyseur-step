// /static/js/modules/ModelRegistry.js — UTF-8 (NO BOM)
// Gestion centralisée du modèle XKT courant et de son état de readiness.
// Permet d'obtenir le modèle/meshes actifs quel que soit le chemin de chargement.

const listeners = new Set();
let currentEntry = null;

function notify() {
  for (const cb of Array.from(listeners)) {
    try { cb(currentEntry); } catch (err) { console.warn('[heatmap] listener error', err); }
  }
}

function pickGeometryArray(src) {
  if (!src) return null;
  if (ArrayBuffer.isView(src)) return src;
  if (Array.isArray(src)) return src;
  if (src.data && src.data !== src) {
    const data = pickGeometryArray(src.data);
    if (data) return data;
  }
  if (src.array && src.array !== src) {
    const arr = pickGeometryArray(src.array);
    if (arr) return arr;
  }
  return null;
}

export function meshHasGeometry(mesh) {
  if (!mesh || mesh.destroyed) return false;
  const geom = mesh.geometry || mesh._geometry || mesh._state?.geometry || null;
  if (!geom) return false;

  const positions = pickGeometryArray(
    geom.positions ||
    geom._positions ||
    geom.decompressedPositions ||
    geom.__dfmPositions ||
    mesh.__dfmPositions
  );

  const indices = pickGeometryArray(
    geom.indices ||
    geom._indices ||
    geom.triangles ||
    geom.__dfmIndices ||
    mesh.__dfmIndices
  );

  return !!(positions && indices && positions.length >= 3 && indices.length >= 3);
}

function pushUnique(out, seen, mesh) {
  if (!mesh || seen.has(mesh) || mesh.destroyed) return;
  seen.add(mesh);
  out.push(mesh);
}

function collectFromScene(scene, includeHidden, seen, out) {
  if (!scene) return;
  if (scene.meshes && typeof scene.meshes === 'object') {
    for (const key in scene.meshes) {
      pushUnique(out, seen, scene.meshes[key]);
    }
  }
  if (scene.objects && typeof scene.objects === 'object') {
    for (const key in scene.objects) {
      const obj = scene.objects[key];
      if (obj?.geometry) pushUnique(out, seen, obj);
    }
  }
  if (typeof scene.iterate === 'function') {
    try {
      scene.iterate(node => { if (node?.geometry) pushUnique(out, seen, node); });
    } catch (err) {
      console.warn('[heatmap] scene.iterate failed', err);
    }
  }
}

function collectMeshes(entry, { includeHidden = false } = {}) {
  if (!entry?.model) return [];
  const { model, meta = {} } = entry;
  const out = [];
  const seen = new Set();

  const meshes = model.meshes;
  if (meshes) {
    if (typeof meshes.forEach === 'function') {
      try { meshes.forEach(mesh => pushUnique(out, seen, mesh)); } catch {}
    } else if (Array.isArray(meshes)) {
      meshes.forEach(mesh => pushUnique(out, seen, mesh));
    } else if (typeof meshes === 'object') {
      for (const key in meshes) pushUnique(out, seen, meshes[key]);
    }
  }

  if (!out.length) {
    const scene = meta.scene || meta.viewer?.scene || model.scene || model.viewer?.scene;
    collectFromScene(scene, includeHidden, seen, out);
  }

  return out.filter(mesh => mesh && !mesh.destroyed && mesh.geometry && (includeHidden || mesh.visible !== false));
}

export function registerModelInstance(model, meta = {}) {
  if (!model) return () => {};
  if (currentEntry?.cleanup) {
    try { currentEntry.cleanup(); } catch {}
  }

  const entry = { model, meta, ready: false };
  const destroyHandler = () => {
    if (currentEntry === entry) {
      currentEntry = null;
      notify();
    }
  };

  if (typeof model.on === 'function') {
    try { model.on('destroyed', destroyHandler); } catch (err) { console.warn('[heatmap] register destroy hook failed', err); }
  }

  entry.cleanup = () => {
    if (typeof model.off === 'function') {
      try { model.off('destroyed', destroyHandler); } catch {}
    }
    if (currentEntry === entry) {
      currentEntry = null;
      notify();
    }
  };

  currentEntry = entry;
  notify();
  return entry.cleanup;
}

export function markModelReady(model, extraMeta = {}) {
  if (!model) return;
  if (currentEntry && currentEntry.model === model) {
    currentEntry.ready = true;
    currentEntry.meta = { ...(currentEntry.meta || {}), ...extraMeta };
    notify();
  }
}

export function clearModelRegistry() {
  if (currentEntry?.cleanup) {
    try { currentEntry.cleanup(); } catch {}
  }
  currentEntry = null;
  notify();
}

export function getCurrentModel() {
  return currentEntry?.model || null;
}

export function getCurrentMeshes(options = {}) {
  return collectMeshes(currentEntry, options);
}

export async function waitForModelReady({ timeoutMs = 6000, pollMs = 80, includeHidden = true, requireGeometry = false } = {}) {
  const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  while (true) {
    const model = getCurrentModel();
    const meshes = getCurrentMeshes({ includeHidden });
    if (model && meshes.length) {
      if (!requireGeometry) {
        return model;
      }
      if (meshes.some(meshHasGeometry)) {
        return model;
      }
    }
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - start >= timeoutMs) {
      if (requireGeometry) {
        return null;
      }
      if (model && meshes.length) {
        return model;
      }
      return null;
    }
    await new Promise(res => setTimeout(res, pollMs));
  }
}

export function onModelChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  if (currentEntry) {
    try { cb(currentEntry); } catch {}
  }
  return () => listeners.delete(cb);
}

export function getCurrentMeta() {
  return currentEntry?.meta || {};
}

export default {
  registerModelInstance,
  markModelReady,
  clearModelRegistry,
  getCurrentModel,
  getCurrentMeshes,
  waitForModelReady,
  onModelChange,
  getCurrentMeta,
  meshHasGeometry
};
