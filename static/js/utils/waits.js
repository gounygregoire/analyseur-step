// static/js/utils/waits.js
// Polling utilitaire simple pour attendre une condition front-end.
export function waitFor(pred, timeoutMs = 10000, intervalMs = 50) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const timer = setInterval(() => {
      try {
        if (pred()) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (performance.now() - t0 > timeoutMs) {
          clearInterval(timer);
          reject(new Error("WAIT_TIMEOUT"));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, intervalMs);
  });
}
