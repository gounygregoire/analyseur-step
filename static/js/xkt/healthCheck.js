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

export async function ensureHealthyXKT({ baseUrl, fileId, minBytes = 200000, onStatus }) {
  const xktUrl = `${baseUrl}/xkt/${fileId}.xkt`;
  const size = await headContentLength(xktUrl);
  const manifest = await fetchManifest(baseUrl, fileId);
  const notOk = (size > 0 && size < minBytes) || (manifest && manifest.ok === false);
  if (!notOk) return `${xktUrl}?v=${Date.now()}`;

  onStatus?.("reconvert:start");
  const r = await fetch(`${baseUrl}/api/reconvert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  if (!r.ok) throw new Error("reconvert: request failed");
  const { job_id } = await r.json();
  // poll status
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60 * 1000) { // 10 min
    await new Promise((r) => setTimeout(r, 2000));
    const s = await fetch(`${baseUrl}/api/reconvert/status/${job_id}`, { cache: "no-store" });
    if (!s.ok) continue;
    const j = await s.json();
    onStatus?.(`reconvert:${j.status}`);
    if (j.status === "finished") {
      // recheck
      const size2 = await headContentLength(xktUrl);
      if (size2 >= minBytes) return `${xktUrl}?v=${Date.now()}`;
      const m2 = await fetchManifest(baseUrl, fileId);
      if (m2 && m2.ok && m2.xkt_size >= minBytes) return `${xktUrl}?v=${Date.now()}`;
      // else continue loop (CDN propagation)
    }
    if (j.status === "failed") throw new Error("reconvert: failed");
  }
  throw new Error("reconvert: timeout");
}
