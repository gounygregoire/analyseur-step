/**
 * Audit utilitaires pour analyser la scène Xeokit.
 * Fournit un histogramme de types de composants et un garde-fou mesh.
 */
export function sceneTypeHistogram(viewer) {
  const comps = viewer?.scene?.components || {};
  const hist = {};
  for (const id in comps) {
    const t = comps[id]?.type || "Unknown";
    hist[t] = (hist[t] || 0) + 1;
  }
  return hist;
}

export function hasMeshes(viewer) {
  const comps = viewer?.scene?.components || {};
  for (const id in comps) {
    if (comps[id]?.type === "Mesh") return true;
  }
  return false;
}

export function sceneVisibilityStats(viewer, { sampleLimit = 5 } = {}) {
  const objects = viewer?.scene?.objects || {};
  const limit = Number.isFinite(sampleLimit) ? Math.max(0, sampleLimit) : 0;
  const stats = {
    total: 0,
    visible: 0,
    hidden: 0,
    culled: 0,
    sampleHidden: [],
    sampleCulled: []
  };

  for (const id in objects) {
    const obj = objects[id];
    if (!obj) continue;
    stats.total++;
    if (obj.culled) {
      stats.culled++;
      if (stats.sampleCulled.length < limit) {
        stats.sampleCulled.push(id);
      }
    }
    if (obj.visible === false) {
      stats.hidden++;
      if (stats.sampleHidden.length < limit) {
        stats.sampleHidden.push(id);
      }
    } else {
      stats.visible++;
    }
  }

  return stats;
}

export function sceneThemeState(viewer, { sampleLimit = 5 } = {}) {
  const objects = viewer?.scene?.objects || {};
  const limit = Number.isFinite(sampleLimit) ? Math.max(0, sampleLimit) : 0;
  const state = {
    xrayedCount: 0,
    ghostedCount: 0,
    sampleXrayed: [],
    sampleGhosted: []
  };

  for (const id in objects) {
    const obj = objects[id];
    if (!obj) continue;
    if (obj.xrayed) {
      state.xrayedCount++;
      if (state.sampleXrayed.length < limit) {
        state.sampleXrayed.push(id);
      }
    }
    if (obj.ghosted) {
      state.ghostedCount++;
      if (state.sampleGhosted.length < limit) {
        state.sampleGhosted.push(id);
      }
    }
  }

  return state;
}

function normalizeOpacity(value) {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

export function sceneOpacitySample(viewer, { sampleLimit = 5, lowOpacityThreshold = 0.2 } = {}) {
  const objects = viewer?.scene?.objects || {};
  const materials = viewer?.scene?.materials || {};
  const components = viewer?.scene?.components || {};
  const limit = Number.isFinite(sampleLimit) ? Math.max(0, sampleLimit) : 0;
  const threshold = Number.isFinite(lowOpacityThreshold) ? Math.max(0, lowOpacityThreshold) : 0.2;

  const sample = [];
  const summary = {
    total: 0,
    withOpacity: 0,
    zeroOpacity: 0,
    lowOpacity: 0,
    minOpacity: null,
    maxOpacity: null,
    avgOpacity: null
  };

  let opacitySum = 0;

  for (const id in objects) {
    const obj = objects[id];
    if (!obj) continue;
    summary.total++;

    const objectOpacity = normalizeOpacity(obj.opacity);
    const materialId = obj.material || obj.materialId || null;
    const materialComponent = materialId ? (materials?.[materialId] || components?.[materialId] || null) : null;
    const materialOpacity = normalizeOpacity(materialComponent?.opacity);
    const effectiveOpacity = objectOpacity ?? materialOpacity ?? null;

    if (effectiveOpacity !== null) {
      summary.withOpacity++;
      opacitySum += effectiveOpacity;
      summary.minOpacity = summary.minOpacity === null ? effectiveOpacity : Math.min(summary.minOpacity, effectiveOpacity);
      summary.maxOpacity = summary.maxOpacity === null ? effectiveOpacity : Math.max(summary.maxOpacity, effectiveOpacity);
      if (effectiveOpacity <= 0) {
        summary.zeroOpacity++;
      } else if (effectiveOpacity < threshold) {
        summary.lowOpacity++;
      }
    }

    if (sample.length < limit) {
      const materialType = materialComponent?.type || materialComponent?.constructor?.name || null;
      sample.push({
        id,
        objectOpacity: objectOpacity ?? null,
        materialId: materialId || null,
        materialOpacity: materialOpacity ?? null,
        effectiveOpacity: effectiveOpacity ?? null,
        materialType
      });
    }
  }

  if (summary.withOpacity > 0) {
    summary.avgOpacity = opacitySum / summary.withOpacity;
  }

  return { sample, summary };
}
