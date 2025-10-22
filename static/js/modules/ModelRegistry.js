// /static/js/modules/ModelRegistry.js — UTF-8 (NO BOM)
// Gestion centralisée du modèle XKT courant et de son état de readiness.
// Permet d'obtenir le modèle/meshes actifs quel que soit le chemin de chargement.

const listeners = new Set();
let currentEntry = null;
const globalWindowRef = typeof window !== "undefined" ? window : null;

function notify() {
  for (const cb of Array.from(listeners)) {
    try { cb(currentEntry); } catch (err) { console.warn('[heatmap] listener error', err); }
  }
}

function pickGeometryArray(src) {
  if (!src) return null;
  if (ArrayBuffer.isView(src)) return src;
  if (Array.isArray(src)) return src;
  if (typeof src.length === "number" && src && src !== globalWindowRef) {
    try {
      const ctorName = src.constructor?.name || "";
      if (ctorName.endsWith("Array")) {
        return src;
      }
    } catch {}
  }

  const nestedKeys = ["data", "array", "values", "typedArray", "bufferView"];
  for (const key of nestedKeys) {
    if (src && src[key] && src[key] !== src) {
      const nested = pickGeometryArray(src[key]);
      if (nested) return nested;
    }
  }

  if (src.buffer && typeof src.byteLength === "number" && typeof src.BYTES_PER_ELEMENT === "number") {
    return src;
  }

  return null;
}

function resolveGeometryArray(mesh, geom, type) {
  const state = geom?._state || geom?.state || {};
  const arrays = geom?.arrays || geom?._arrays || {};
  const geometryData = geom?.geometryData || geom?.data || {};
  const nestedGeom = geom?.geometry || geom?._geometry || state.geometry || {};
  const geometryState = geom?._geometryState || geom?.geometryState || state?._geometryState || state?.geometryState || {};
  const meshState = mesh?._geometryState || mesh?.geometryState || {};

  const candidates = [
    type === "positions"
      ? mesh?.__dfmPositions
      : mesh?.__dfmIndices,
    geom?.[`__dfm${type.charAt(0).toUpperCase()}${type.slice(1)}`],
    geom?.[type],
    geom?.[`_${type}`],
    geom?.[`decompressed${type.charAt(0).toUpperCase()}${type.slice(1)}`],
    geom?.[`compressed${type.charAt(0).toUpperCase()}${type.slice(1)}`],
    geom?.[`${type}Compressed`],
    geom?.[`${type}Decompressed`],
    arrays?.[type],
    arrays?.[type]?.data,
    arrays?.[type]?.array,
    state?.[type],
    state?.[`_${type}`],
    state?.[`${type}Data`],
    state?.[`${type}Decompressed`],
    state?.geometry?.[type],
    state?.geometry?.[type]?.data,
    state?.geometry?.[type]?.array,
    geometryState?.[type],
    geometryState?.[`_${type}`],
    geometryState?.[`${type}Data`],
    geometryState?.[`${type}Decompressed`],
    geometryState?.arrays?.[type],
    geometryState?.arrays?.[type]?.data,
    geometryState?.arrays?.[type]?.array,
    meshState?.[type],
    meshState?.[`_${type}`],
    meshState?.arrays?.[type],
    meshState?.arrays?.[type]?.data,
    meshState?.arrays?.[type]?.array,
    geometryData?.[type],
    geometryData?.[type]?.data,
    geometryData?.[type]?.array,
    nestedGeom?.[type],
    nestedGeom?.[type]?.data,
    nestedGeom?.[type]?.array
  ];

  for (const candidate of candidates) {
    const arr = pickGeometryArray(candidate);
    if (arr && arr.length) {
      return arr;
    }
  }
  return null;
}

export function meshHasGeometry(mesh) {
  if (!mesh || mesh.destroyed) return false;
  const geom = mesh.geometry || mesh._geometry || mesh._state?.geometry || null;
  if (!geom) return false;

  const positions = resolveGeometryArray(mesh, geom, "positions");
  const indices = resolveGeometryArray(mesh, geom, "indices") || resolveGeometryArray(mesh, geom, "triangles");

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
