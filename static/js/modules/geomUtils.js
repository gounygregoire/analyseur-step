// /static/js/modules/geomUtils.js
export function listMeshes(viewer) {
  try {
    const comps = viewer?.scene?.components;
    if (!comps) return [];
    const out = [];
    for (const id in comps) {
      const c = comps[id];
      if (c && c.type === "Mesh") out.push(c);
    }
    return out;
  } catch (e) {
    console.warn("[geom] listMeshes error:", e);
    return [];
  }
}

export function countMeshes(viewer) {
  return listMeshes(viewer).length;
}
