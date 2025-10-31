export function getTriangleCount(scene){
  const tri = scene?.stats?.numTriangles ?? scene?.stats?.triangles;
  if (Number.isFinite(tri)) return tri|0;
  let sum = 0;
  const list = scene?.meshes || scene?.objects || [];
  if (Array.isArray(list)) {
    for (const m of list) {
      const g = m?.geometry || m?._geometry;
      const n = (g?.numTriangles != null) ? g.numTriangles : ((g?.indices?.length || 0) / 3);
      sum += (n|0);
    }
  }
  return sum|0;
}
