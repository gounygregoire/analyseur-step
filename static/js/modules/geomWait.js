// /static/js/modules/geomWait.js
import { countMeshes } from "./geomUtils.js";

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

export async function waitForGeometryReady(viewer, { maxWaitMs = 60000, checkEvery = 100 } = {}) {
  const t0 = performance.now();
  // 1) petite latence post-"loaded" si nécessaire
  while ((performance.now() - t0) < maxWaitMs) {
    const n = countMeshes(viewer);
    if (n > 0) {
      console.log("[heatmap][diag] meshes detected:", n);
      return true;
    }
    await sleep(checkEvery);
  }
  const err = new Error("GEOMETRY_WAIT_TIMEOUT");
  console.warn("[loader] geometry readiness wait failed (dt="+(performance.now()-t0)+"ms)", err);
  throw err;
}
