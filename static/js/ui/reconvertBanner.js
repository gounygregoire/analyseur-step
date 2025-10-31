// static/js/ui/reconvertBanner.js
// Bannière flottante pour informer l'utilisateur lors d'une reconversion XKT.
let el = null;

export function showReconvertBanner(msg = "Reconversion en cours…") {
  if (el) return;
  el = document.createElement("div");
  el.className = "reconvert-banner";
  el.textContent = msg;
  Object.assign(el.style, {
    position: "fixed",
    bottom: "16px",
    left: "16px",
    padding: "8px 12px",
    background: "#222",
    color: "#fff",
    borderRadius: "8px",
    zIndex: 9999,
    opacity: 0.95
  });
  document.body.appendChild(el);
}

export function updateReconvertBanner(msg) {
  if (el) el.textContent = msg;
}

export function hideReconvertBanner() {
  if (el) {
    el.remove();
    el = null;
  }
}
