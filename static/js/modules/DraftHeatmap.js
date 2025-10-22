// /static/js/modules/DraftHeatmap.js — UTF-8 (NO BOM)
// API de heatmap dépouille basée sur le registry CAD (single source of truth).
// Calcule la dépouille par triangle à partir du modèle Xeokit courant et gère
// les overlays via HeatmapLayer sans modifier les matériaux d'origine.

import HeatmapLayer from "../HeatmapLayer.js";

const geometryCache = new WeakMap(); // mesh -> { geom, data }
const meshResultCache = new WeakMap(); // mesh -> Map(cacheKey, DraftResult)
const globalWindowRef = typeof window !== "undefined" ? window : null;

const DEFAULT_THRESHOLD_DEG = 2;
const MODE_OK = "ok";
const MODE_ZERO = "zero";
const MODE_UNDERCUT = "undercut";
const VALID_MODES = new Set([MODE_OK, MODE_ZERO, MODE_UNDERCUT]);

/**
 * @typedef {Object} DraftBuckets
 * @property {{ tris: Uint32Array, count: number }} ok
 * @property {{ tris: Uint32Array, count: number }} zero
 * @property {{ tris: Uint32Array, count: number }} undercut
 * @property {number} totalTriangles
 */

/**
 * @typedef {Object} DraftState
 * @property {{ letter: string, vector: {x:number,y:number,z:number} }} axis
 * @property {number} thresholdDeg
 * @property {{ ok:number, zero:number, undercut:number, other:number }} totals
 * @property {number} totalFaces
 * @property {Array<{ mesh:any, buckets:DraftBuckets }>} entries
 * @property {string} mode
 * @property {(mode:string)=>string} applyMode
 */

function ensureRegistry(registry) {
  if (registry && typeof registry === "object") {
    return registry;
  }
  if (typeof window !== "undefined" && window.CAD && typeof window.CAD === "object") {
    return window.CAD;
  }
  return {};
}

function ensureLayer(registry) {
  if (!registry?.viewer) {
    throw new Error("MODEL_NOT_READY");
  }
  const heatmapState = registry.heatmap || (registry.heatmap = {});
  if (heatmapState.layer && heatmapState.layer.viewer !== registry.viewer) {
    try { heatmapState.layer.clear(); } catch {}
    heatmapState.layer = null;
  }
  if (!heatmapState.layer) {
    heatmapState.layer = new HeatmapLayer(registry);
  }
  return heatmapState.layer;
}

function normalizeAxis(axis) {
  if (typeof axis === "string") {
    const letter = axis.trim().charAt(0).toUpperCase();
    if (letter === "X" || letter === "Y" || letter === "Z") {
      const vec = { x: 0, y: 0, z: 0 };
      vec[letter.toLowerCase()] = 1;
      return { letter, vector: vec };
    }
  }
  if (axis && typeof axis === "object") {
    const vec = {
      x: Number(axis.x) || 0,
      y: Number(axis.y) || 0,
      z: Number(axis.z) || 0
    };
    const length = Math.hypot(vec.x, vec.y, vec.z);
    if (length > 0) {
      vec.x /= length;
      vec.y /= length;
      vec.z /= length;
    } else {
      vec.x = 0; vec.y = 0; vec.z = 1;
    }
    const comps = [
      { letter: "X", value: vec.x },
      { letter: "Y", value: vec.y },
      { letter: "Z", value: vec.z }
    ];
    const dominant = comps.reduce((best, cur) => (
      Math.abs(cur.value) > Math.abs(best.value) ? cur : best
    ), comps[0]);
    const sign = Math.sign(dominant.value) || 1;
    const canonical = { x: 0, y: 0, z: 0 };
    canonical[dominant.letter.toLowerCase()] = sign;
    return { letter: dominant.letter, vector: canonical };
  }
  return { letter: "Z", vector: { x: 0, y: 0, z: 1 } };
}

function makeAxisKey(vec) {
  return [vec.x || 0, vec.y || 0, vec.z || 0]
    .map((v) => Number(v).toFixed(4))
    .join(",");
}

function makeCacheKey(model, axisVec, thresholdDeg) {
  const modelId = model?.id || model?.modelId || model?.cfg?.id || model?.meta?.id || "model";
  return `${modelId}|${makeAxisKey(axisVec)}|${Number(thresholdDeg || 0).toFixed(3)}`;
}

function collectMeshesFromRegistry(registry) {
  const meshes = [];
  const seen = new Set();
  const push = (mesh) => {
    if (!mesh || seen.has(mesh) || mesh.destroyed) return;
    if (!mesh.geometry) return;
    seen.add(mesh);
    meshes.push(mesh);
  };

  const model = registry?.model;
  const collections = [
    model?.meshes,
    model?.meshList,
    model?.meshArray,
    model?.scene?.meshes,
    model?.scene?.objects,
    model?.viewer?.scene?.meshes,
    model?.viewer?.scene?.objects
  ];
  for (const col of collections) {
    if (!col) continue;
    if (Array.isArray(col)) {
      col.forEach(push);
    } else if (typeof col.forEach === "function") {
      try { col.forEach(push); } catch {}
    } else if (typeof col === "object") {
      for (const key in col) push(col[key]);
    }
  }

  const iterators = [model, model?.scene, registry?.viewer?.scene];
  for (const ctx of iterators) {
    if (ctx && typeof ctx.iterate === "function") {
      try { ctx.iterate((node) => push(node)); } catch {}
    }
  }

  return meshes;
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

function toFloat32(arrayLike) {
  if (!arrayLike) return null;
  if (arrayLike instanceof Float32Array) return arrayLike.slice();
  if (ArrayBuffer.isView(arrayLike)) return Float32Array.from(arrayLike);
  if (Array.isArray(arrayLike)) return Float32Array.from(arrayLike);
  if (typeof arrayLike.length === "number") {
    const out = new Float32Array(arrayLike.length);
    for (let i = 0; i < arrayLike.length; i++) out[i] = Number(arrayLike[i] || 0);
    return out;
  }
  return null;
}

function toIndexArray(arrayLike) {
  if (!arrayLike) return null;
  if (arrayLike instanceof Uint32Array) return arrayLike.slice();
  if (arrayLike instanceof Uint16Array || arrayLike instanceof Uint8Array || arrayLike instanceof Int32Array || arrayLike instanceof Int16Array) {
    return Uint32Array.from(arrayLike);
  }
  if (ArrayBuffer.isView(arrayLike)) return Uint32Array.from(arrayLike);
  if (Array.isArray(arrayLike)) return Uint32Array.from(arrayLike);
  if (typeof arrayLike.length === "number") {
    const out = new Uint32Array(arrayLike.length);
    for (let i = 0; i < arrayLike.length; i++) out[i] = Number(arrayLike[i] || 0);
    return out;
  }
  return null;
}

function applyMatrixToPositions(positions, matrix) {
  if (!matrix || matrix.length < 16) {
    return positions.slice();
  }
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    out[i]     = matrix[0] * x + matrix[4] * y + matrix[8]  * z + matrix[12];
    out[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9]  * z + matrix[13];
    out[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }
  return out;
}

function resolveGeometryArray(mesh, geom, type) {
  const state = geom?._state || geom?.state || {};
  const arrays = geom?.arrays || geom?._arrays || {};
  const geometryData = geom?.geometryData || geom?.data || {};
  const nestedGeom = geom?.geometry || geom?._geometry || state.geometry || {};

  const candidates = [
    type === "positions" ? mesh?.__dfmPositions : mesh?.__dfmIndices,
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
    state?.[`${type}Data`],
    state?.[`${type}Decompressed`],
    state?.geometry?.[type],
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

function captureGeometry(mesh) {
  if (!mesh || mesh.destroyed) return null;
  const geom = mesh.geometry || mesh._geometry || mesh._state?.geometry || null;
  if (!geom) return null;

  const cached = geometryCache.get(mesh);
  if (cached && cached.geom === geom) {
    return cached.data;
  }

  const positionsRaw = resolveGeometryArray(mesh, geom, "positions");
  const indicesRaw = resolveGeometryArray(mesh, geom, "indices") || resolveGeometryArray(mesh, geom, "triangles");

  if (!positionsRaw || !indicesRaw) return null;

  const positions = toFloat32(positionsRaw);
  const indices = toIndexArray(indicesRaw);
  if (!positions || !indices) return null;

  const matrix = mesh.worldMatrix || mesh.matrix || mesh.worldTransform?.matrix || mesh.transform?.matrix || null;
  const worldPositions = applyMatrixToPositions(positions, matrix);

  const data = { positions: worldPositions, indices };
  geometryCache.set(mesh, { geom, data });
  return data;
}

function classifyMeshDraft(mesh, axisVec, thresholdDeg) {
  const geom = captureGeometry(mesh);
  if (!geom) return null;

  const cacheKey = `${makeAxisKey(axisVec)}|${Number(thresholdDeg).toFixed(3)}`;
  let meshCache = meshResultCache.get(mesh);
  if (!meshCache) {
    meshCache = new Map();
    meshResultCache.set(mesh, meshCache);
  }
  if (meshCache.has(cacheKey)) {
    return meshCache.get(cacheKey);
  }

  const { positions, indices } = geom;
  const triCount = (indices.length / 3) | 0;
  if (!triCount) return null;

  const ax = normalizeVec(axisVec);
  const okTris = [];
  const zeroTris = [];
  const underTris = [];

  const v0 = [0,0,0];
  const v1 = [0,0,0];
  const v2 = [0,0,0];
  const e1 = [0,0,0];
  const e2 = [0,0,0];
  const n = [0,0,0];

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;

    v0[0] = positions[i0];     v0[1] = positions[i0 + 1];     v0[2] = positions[i0 + 2];
    v1[0] = positions[i1];     v1[1] = positions[i1 + 1];     v1[2] = positions[i1 + 2];
    v2[0] = positions[i2];     v2[1] = positions[i2 + 1];     v2[2] = positions[i2 + 2];

    e1[0] = v1[0] - v0[0]; e1[1] = v1[1] - v0[1]; e1[2] = v1[2] - v0[2];
    e2[0] = v2[0] - v0[0]; e2[1] = v2[1] - v0[1]; e2[2] = v2[2] - v0[2];
    cross(n, e1, e2);
    normalizeInPlace(n);

    const cosTheta = clamp(dot(n, ax), -1, 1);
    const thetaDeg = Math.acos(cosTheta) * 180 / Math.PI;
    const draftDeg = 90 - thetaDeg;

    if (draftDeg >= thresholdDeg) {
      okTris.push(t);
    } else if (draftDeg >= 0) {
      zeroTris.push(t);
    } else {
      underTris.push(t);
    }
  }

  const result = {
    ok:       { tris: toU32(okTris),       count: okTris.length },
    zero:     { tris: toU32(zeroTris),     count: zeroTris.length },
    undercut: { tris: toU32(underTris),    count: underTris.length },
    totalTriangles: triCount
  };

  meshCache.set(cacheKey, result);
  return result;
}

function normalizeVec(axisVec) {
  const arr = [axisVec.x || 0, axisVec.y || 0, axisVec.z || 0];
  const len = Math.hypot(arr[0], arr[1], arr[2]);
  if (!len) return [0, 0, 1];
  return [arr[0] / len, arr[1] / len, arr[2] / len];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(out, a, b) {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  return out;
}

function normalizeInPlace(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!len) return v;
  v[0] /= len;
  v[1] /= len;
  v[2] /= len;
  return v;
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function toU32(arr) {
  const out = new Uint32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i];
  return out;
}

function computeRawDraft(registry, axisInfo, thresholdDeg) {
  const entries = [];
  const totals = { ok: 0, zero: 0, undercut: 0 };
  let totalFaces = 0;

  const meshes = collectMeshesFromRegistry(registry);
  for (const mesh of meshes) {
    const draft = classifyMeshDraft(mesh, axisInfo.vector, thresholdDeg);
    if (!draft) continue;
    entries.push({ mesh, buckets: draft });
    totals.ok += draft.ok.count;
    totals.zero += draft.zero.count;
    totals.undercut += draft.undercut.count;
    totalFaces += draft.totalTriangles;
  }

  return {
    entries,
    totals: {
      ok: totals.ok,
      zero: totals.zero,
      undercut: totals.undercut,
      other: Math.max(0, totalFaces - (totals.ok + totals.zero + totals.undercut))
    },
    totalFaces
  };
}

function ensureCache(registry) {
  const heatmapState = registry.heatmap || (registry.heatmap = {});
  if (!heatmapState.cache || !(heatmapState.cache instanceof Map)) {
    heatmapState.cache = new Map();
  }
  return heatmapState.cache;
}

function buildDraftState(registry, axisInfo, thresholdDeg) {
  const cacheKey = makeCacheKey(registry.model, axisInfo.vector, thresholdDeg);
  const cache = ensureCache(registry);

  let raw = cache.get(cacheKey);
  if (!raw) {
    raw = computeRawDraft(registry, axisInfo, thresholdDeg);
    cache.set(cacheKey, raw);
  }

  const layer = ensureLayer(registry);
  const state = {
    axis: axisInfo,
    thresholdDeg,
    totals: raw.totals,
    totalFaces: raw.totalFaces,
    entries: raw.entries,
    mode: registry.heatmap?.mode || MODE_OK,
    applyMode: () => MODE_OK
  };

  state.applyMode = (mode) => applyMode({
    layer,
    registry,
    entries: raw.entries,
    axisInfo,
    thresholdDeg,
    requestedMode: mode
  });
  return state;
}

function applyMode({ layer, registry, entries, axisInfo, thresholdDeg, requestedMode }) {
  const mode = VALID_MODES.has(requestedMode) ? requestedMode : MODE_OK;
  layer.renderDraft({
    axis: axisInfo,
    thresholdDeg,
    entries,
    mode
  });
  const heatmapState = registry.heatmap || (registry.heatmap = {});
  heatmapState.mode = mode;
  return mode;
}

export function applyDraftHeatmap({ registry, axis, thresholdDeg } = {}) {
  const reg = ensureRegistry(registry);

  if (!reg?.model) {
    throw new Error("MODEL_MISSING");
  }

  const heatmapState = reg.heatmap || (reg.heatmap = {});
  if (!heatmapState.ready) {
    throw new Error("GEOMETRY_NOT_READY");
  }

  const axisInput = axis ?? reg.axis ?? { z: 1 };
  const axisLetter = (() => {
    if (typeof axisInput === "string") {
      return axisInput;
    }
    if (axisInput && typeof axisInput === "object") {
      if (typeof axisInput.letter === "string") {
        return axisInput.letter;
      }
      const comps = [
        { letter: "X", value: Number(axisInput.x) || 0 },
        { letter: "Y", value: Number(axisInput.y) || 0 },
        { letter: "Z", value: Number(axisInput.z) || 0 }
      ];
      const dominant = comps.reduce((best, cur) => (
        Math.abs(cur.value) > Math.abs(best.value) ? cur : best
      ), comps[0]);
      if (Math.abs(dominant.value) > 0) {
        return dominant.letter;
      }
    }
    return null;
  })();

  if (!["X", "Y", "Z", "x", "y", "z"].includes(axisLetter)) {
    throw new Error("AXIS_INVALID");
  }

  console.info("[heatmap] apply", {
    axis: axisLetter.toUpperCase(),
    thresholdDeg,
    id: reg.modelId || reg.model?.id || reg.model?.modelId || "unknown"
  });

  if (heatmapState && heatmapState.modelRef !== reg.model) {
    heatmapState.cache = new Map();
    heatmapState.modelRef = reg.model;
  }

  const axisInfo = normalizeAxis(axisInput);
  const threshold = Number.isFinite(Number(thresholdDeg)) && Number(thresholdDeg) > 0
    ? Number(thresholdDeg)
    : DEFAULT_THRESHOLD_DEG;

  const state = buildDraftState(reg, axisInfo, threshold);
  const appliedMode = state.applyMode(state.mode);

  heatmapState.state = state;
  heatmapState.mode = appliedMode;
  heatmapState.active = true;
  heatmapState.lastSummary = {
    axis: axisInfo,
    thresholdDeg: threshold,
    totals: state.totals,
    totalFaces: state.totalFaces
  };

  console.log(`[heatmap] apply axis=${axisInfo.letter} threshold=${threshold.toFixed(1)}° (faces=${state.totalFaces}) done`);
  return state;
}

export function clearDraftHeatmap(registry) {
  const reg = ensureRegistry(registry);
  const heatmapState = reg.heatmap || (reg.heatmap = {});
  const layer = heatmapState.layer;
  if (layer) {
    try {
      layer.clear();
    } catch {}
  }
  heatmapState.state = null;
  heatmapState.active = false;
  heatmapState.mode = null;
  heatmapState.lastSummary = null;
  if (heatmapState.cache instanceof Map) {
    heatmapState.cache.clear();
  }
  console.log('[heatmap] cleared');
  return true;
}

export default {
  applyDraftHeatmap,
  clearDraftHeatmap
};
