// /static/js/modules/DraftHeatmap.js — UTF-8 (NO BOM)
// API de heatmap dépouille basée sur le registry CAD (single source of truth).
// Calcule la dépouille par triangle à partir du modèle Xeokit courant et gère
// les overlays via HeatmapLayer sans modifier les matériaux d'origine.

import HeatmapLayer from "../HeatmapLayer.js";
import { listMeshes, countMeshes } from "./geomUtils.js";
import { waitForGeometryReady } from "./geomWait.js";

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function safeAccess(getter) {
  if (typeof getter !== "function") return undefined;
  try {
    return getter();
  } catch (err) {
    return undefined;
  }
}

// Attente robuste de la géométrie, sans API privée Xeokit
// Usage:
//   await ensureModelGeometryReady({ model, viewer, maxWaitMs: 60000 });
export async function ensureModelGeometryReady({ model, viewer, maxWaitMs = 60000 }) {
  if (!model) {
    throw new Error("GEOMETRY_WAIT_INVALID_MODEL");
  }

  const scene = model?.scene || viewer?.scene;
  if (!scene) {
    throw new Error("NO_SCENE_BOUND_TO_MODEL");
  }

  const start = nowMs();

  if (viewer && scene !== viewer.scene) {
    const mismatchErr = new Error("[heatmap][ALERTE] viewer-scene mismatch");
    console.error("[heatmap][ALERTE] model.scene !== viewer.scene", {
      modelId: model?.id || null,
      viewerSceneId: viewer?.scene?.id || null,
      modelSceneId: scene?.id || null,
      callerStack: mismatchErr.stack
    });
  }

  const raf = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 16);

  await new Promise((resolve) => {
    if (model?.loaded === true || model?.isLoaded === true) return resolve();
    if (typeof model?.once === "function") {
      try {
        model.once("loaded", () => resolve());
        return;
      } catch {
        /* noop */
      }
    }
    raf(() => resolve());
  });

  const resolveViewer = () => viewer || model?.viewer || (typeof window !== "undefined" ? window?.CAD?.viewer : null);
  const activeViewer = resolveViewer() || { scene };
  const waitBudget = typeof maxWaitMs === "number" && isFinite(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : 60000;

  await waitForGeometryReady(activeViewer, { maxWaitMs: Math.max(waitBudget, 60000), checkEvery: 100 });

  const dt = Math.round(nowMs() - start);
  console.log(`[heatmap] ready after ${dt} ms (model=${model?.id})`, {
    modelId: model?.id,
    meshTotal: countMeshes(activeViewer)
  });
}

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
  if (typeof heatmapState.ready !== "boolean") {
    heatmapState.ready = false;
  }
  if (typeof heatmapState.waiting !== "boolean") {
    heatmapState.waiting = false;
  }
  if (heatmapState.layer && heatmapState.layer.viewer !== registry.viewer) {
    try { heatmapState.layer.clear(); } catch {}
    heatmapState.layer = null;
  }
  if (!heatmapState.layer) {
    heatmapState.layer = new HeatmapLayer(registry);
  }
  if (typeof heatmapState.layer.setReadyState === "function") {
    try { heatmapState.layer.setReadyState(heatmapState.ready); } catch {}
  } else {
    heatmapState.layer.isReady = !!heatmapState.ready;
  }
  if (typeof heatmapState.layer.setWaiting === "function") {
    try { heatmapState.layer.setWaiting(heatmapState.waiting); } catch {}
  }
  return heatmapState.layer;
}

export function ensureHeatmapLayer(registry) {
  const reg = ensureRegistry(registry);
  if (!reg?.viewer) {
    throw new Error("MODEL_NOT_READY");
  }
  return ensureLayer(reg);
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
  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  push(safeAccess(() => geom?.[type]));
  push(safeAccess(() => geom?.arrays?.[type]));
  push(safeAccess(() => geom?.arrays?.[type]?.data));
  push(safeAccess(() => geom?.arrays?.[type]?.array));
  push(safeAccess(() => geom?.geometry?.[type]));
  push(safeAccess(() => geom?.geometry?.arrays?.[type]));
  push(safeAccess(() => geom?.geometry?.arrays?.[type]?.data));

  const publicMeshGeom = safeAccess(() => mesh?.geometry);
  push(safeAccess(() => publicMeshGeom?.[type]));
  push(safeAccess(() => publicMeshGeom?.arrays?.[type]));
  push(safeAccess(() => publicMeshGeom?.arrays?.[type]?.data));

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
  const geom = mesh.geometry
    || (typeof mesh.getGeometry === "function" ? safeAccess(() => mesh.getGeometry()) : null)
    || null;
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

  const viewer = registry?.viewer || registry?.model?.viewer || (typeof window !== "undefined" ? window?.CAD?.viewer : null);
  const targetModelId = registry?.model?.id || null;
  const meshes = listMeshes(viewer).filter((mesh) => {
    if (!targetModelId) return true;
    const meshModelId = mesh?.model?.id;
    return !meshModelId || meshModelId === targetModelId;
  });

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
  // Anti-race: attendre que la scène soit prête (meshes + camera proj)
  const scene = layer?.scene || registry?.viewer?.scene || registry?.model?.scene || null;
  if (scene) {
    const meshCount = Number(scene.stats?.numMeshes ?? scene.numMeshes ?? 0);
    const hasMeshes = Number.isFinite(meshCount) && meshCount > 0;
    const cam = scene.camera;
    const projOk = !!(cam && cam.projection === "perspective" && cam.perspective &&
      Number.isFinite(cam.perspective.near) && Number.isFinite(cam.perspective.far));

    if (!hasMeshes || !projOk) {
      const scheduler = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
      scheduler(() => {
        try {
          applyMode({ layer, registry, entries, axisInfo, thresholdDeg, requestedMode });
        } catch (err) {
          console.warn("[heatmap] deferred render skipped", err);
        }
      });
      return registry?.heatmap?.mode || MODE_OK;
    }
  }

  const mode = VALID_MODES.has(requestedMode) ? requestedMode : MODE_OK;
  const axisLetter = String(axisInfo?.letter || "Z").toUpperCase();
  const modelCandidate = registry?.modelId
    || registry?.model?.id
    || registry?.model?.modelId
    || "unknown";
  const modelLabel = typeof modelCandidate === "string" ? modelCandidate : String(modelCandidate);
  const start = nowMs();
  console.info(`[heatmap] render start (axis = ${axisLetter}, model = ${modelLabel})`);
  let success = false;
  try {
    layer.renderDraft({
      axis: axisInfo,
      thresholdDeg,
      entries,
      mode
    });
    success = true;
  } finally {
    if (success) {
      const duration = Math.round(nowMs() - start);
      console.info(`[heatmap] render done (duration = ${duration} ms)`);
    }
  }
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

  return state;
}

export function clearDraftHeatmap(registry) {
  const reg = ensureRegistry(registry);
  const heatmapState = reg.heatmap || (reg.heatmap = {});
  const suppressLog = !!heatmapState.suppressNextClearLog;
  heatmapState.suppressNextClearLog = false;
  const layer = heatmapState.layer;
  let hadOverlays = false;
  if (layer && typeof layer.getHandles === "function") {
    try {
      const handles = layer.getHandles();
      hadOverlays = Array.isArray(handles) && handles.length > 0;
    } catch {}
  }
  if (layer) {
    try {
      layer.clear();
    } catch {}
  }
  const wasActive = !!heatmapState.active;
  heatmapState.state = null;
  heatmapState.active = false;
  heatmapState.mode = null;
  heatmapState.lastSummary = null;
  if (heatmapState.cache instanceof Map) {
    heatmapState.cache.clear();
  }
  if (!suppressLog && (wasActive || hadOverlays)) {
    console.info('[heatmap] cleared');
  }
  return true;
}

export default {
  applyDraftHeatmap,
  clearDraftHeatmap,
  ensureModelGeometryReady,
  ensureHeatmapLayer
};
