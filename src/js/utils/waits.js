// src/js/utils/waits.js
/**
 * Attente active d'une condition jusqu'à timeout.
 * @param {() => boolean} pred
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
export function waitFor(pred, timeoutMs = 8000, intervalMs = 50) {
  return new Promise((resolve, reject) => {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const i = setInterval(() => {
      try {
        if (pred()) { clearInterval(i); resolve(true); return; }
        const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        if (now - t0 > timeoutMs) { clearInterval(i); reject(new Error("WAIT_TIMEOUT")); }
      } catch (e) { clearInterval(i); reject(e); }
    }, intervalMs);
  });
}
