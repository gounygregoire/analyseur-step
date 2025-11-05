// /static/js/xkt/healthCheck.js
// Utilitaires de vérification XKT (module ESM).

// --- HEAD content-length ------------------------------------------------------
export async function headContentLength(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (!res.ok) return -1;
    const cl = res.headers.get("content-length") || res.headers.get("Content-Length");
    return cl ? parseInt(cl, 10) : -1;
  } catch {
    return -1;
  }
}

// --- Manifest fetch (télémétrie, non bloquant) --------------------------------
export async function fetchManifest(urlBase, fileId) {
  try {
    const base = String(urlBase || "").replace(/\/$/, "");
    const url = `${base}/xkt/${fileId}.manifest.json?${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- Health check principal (NE BLOQUE PAS si manifest 404) -------------------
export async function ensureHealthyXKT(xktUrl, { fileId } = {}) {
  try {
    const url = String(xktUrl || "");
    const manifestUrl = url.replace(/\.xkt(\?.*)?$/i, ".manifest.json");
    const sep = manifestUrl.includes("?") ? "&" : "?";
    const res = await fetch(`${manifestUrl}${sep}nocache=${Date.now()}`, { cache: "no-store" });
    if (res.ok) return true;
    if (res.status === 404) {
      console.warn("[xkt][health] manifest missing → skipping health check");
      return true;
    }
  } catch (e) {
    console.warn("[xkt][health] check error (ignored)", e?.message);
  }
  return true;
}


// Optionnel : export par défaut pour compat legacy
export default { headContentLength, fetchManifest, ensureHealthyXKT };
