// src/js/xkt/healthCheck.js
// Utilitaires de vérification pour garantir la santé d'un XKT avant chargement.

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

const MAX_ATTEMPTS = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt) {
  return Math.min(1000 + attempt * 40, 3000);
}

async function fetchExists(baseUrl, fileId) {
  const url = `${baseUrl}/exists/xkt/${fileId}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

export async function postReconvert({ baseUrl, fileId }) {
  const res = await fetch(`${baseUrl}/api/reconvert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error || body?.detail || `reconvert: request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body || {};
}

export async function pollConversionStatus({ baseUrl, fileId, maxAttempts = MAX_ATTEMPTS, onStatus }) {
  let jobId = null;
  let lastSignal = null;
  const emit = (signal) => {
    if (!signal || signal === lastSignal) return;
    lastSignal = signal;
    onStatus?.(signal);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let payload = null;
    try {
      payload = await fetchExists(baseUrl, fileId);
    } catch (err) {
      console.warn("[xkt][poll] exists probe failed", err);
    }

    const status = payload?.status;
    if (!jobId && payload?.job_id) jobId = payload.job_id;

    if (payload?.exists || status === "done") {
      emit("reconvert:finished");
      return { status: "done", payload, jobId };
    }
    if (status === "error") {
      emit("reconvert:failed");
      return { status: "error", payload, jobId };
    }

    if (status === "running") emit("reconvert:started");
    else emit("reconvert:queued");

    await sleep(computeDelay(attempt));
  }

  emit("reconvert:failed");
  return { status: "timeout", payload: null, jobId };
}

export async function fetchConversionError({ baseUrl, jobId, payload }) {
  const message = payload?.error || payload?.detail || payload?.message || payload?.reason;
  if (message) return message;
  if (!jobId) return null;
  try {
    const res = await fetch(`${baseUrl}/api/reconvert/status/${jobId}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json();
    const result = body?.result;
    if (result && typeof result === "object") {
      return result.error || result.stderr || result.stdout || null;
    }
  } catch (err) {
    console.warn("[xkt][poll] unable to fetch job error", err);
  }
  return null;
}

export async function ensureHealthyXKT({ baseUrl, fileId, minBytes = 200000, onStatus }) {
  const xktUrl = `${baseUrl}/xkt/${fileId}.xkt`;
  const size = await headContentLength(xktUrl);
  const manifest = await fetchManifest(baseUrl, fileId);
  const notOk = (size > 0 && size < minBytes) || (manifest && manifest.ok === false);
  if (!notOk) return `${xktUrl}?v=${Date.now()}`;

  let initialStatus = null;
  try {
    initialStatus = await fetchExists(baseUrl, fileId);
  } catch (err) {
    console.warn("[xkt][health] exists probe failed", err);
  }

  if (initialStatus?.exists && initialStatus.size >= minBytes) {
    return `${xktUrl}?v=${Date.now()}`;
  }

  let jobId = initialStatus?.job_id || null;

  onStatus?.("reconvert:start");

  if (!initialStatus || [null, undefined, "", "pending"].includes(initialStatus.status)) {
    const queued = await postReconvert({ baseUrl, fileId });
    jobId = queued?.job_id || jobId;
    onStatus?.("reconvert:queued");
  } else if (initialStatus.status === "running") {
    onStatus?.("reconvert:started");
  } else if (initialStatus.status === "error") {
    const errMsg = await fetchConversionError({ baseUrl, jobId, payload: initialStatus });
    const err = new Error(errMsg || "Conversion XKT échouée.");
    err.status = "error";
    err.jobId = jobId;
    throw err;
  }

  const result = await pollConversionStatus({ baseUrl, fileId, onStatus });
  if (result.status === "done") {
    return `${xktUrl}?v=${Date.now()}`;
  }

  const message = await fetchConversionError({ baseUrl, jobId: result.jobId || jobId, payload: result.payload });
  const error = new Error(message || (result.status === "timeout" ? "Conversion XKT trop longue." : "Conversion XKT échouée."));
  error.status = result.status;
  error.jobId = result.jobId || jobId;
  throw error;
}
