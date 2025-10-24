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
