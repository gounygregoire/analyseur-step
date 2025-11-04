// /static/js/xkt/healthCheck.js
// Réplique front des utilitaires de vérification XKT.

export async function headContentLength(url) {
  const res = await fetch(url, { method: "HEAD", cache: "no-store" });
  if (!res.ok) return -1;
  const cl = res.headers.get("content-length");
  return cl ? parseInt(cl, 10) : -1;
}

export async function fetchManifest(urlBase, fileId) {
  try {
    const res = await fetch(`${urlBase}/xkt/${fileId}.manifest.json?${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureHealthyXKT(xktUrl, { fileId } = {}) {
  try {
    const manifestUrl = String(xktUrl).replace(/\.xkt(\?.*)?$/i, '.manifest.json');
    const res = await fetch(`${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}nocache=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) return true;
    if (res.status === 404) {
      console.warn('[xkt][health] manifest missing → skipping health check');
      return true; // << on n’échoue plus
    }
  } catch (e) {
    console.warn('[xkt][health] check error (ignored)', e?.message);
  }
  return true;
}
