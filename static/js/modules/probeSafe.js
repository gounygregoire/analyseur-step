const STATE = {
  warnedUnavailable: false,
  installed: false,
};

function logOnceUnavailable() {
  if (STATE.warnedUnavailable) return;
  STATE.warnedUnavailable = true;
  console.info("[probe safe] private hooks unavailable (ok)");
}

function exposeReadOnlyHook(fn) {
  if (STATE.installed) return;
  STATE.installed = true;
  try {
    Object.defineProperty(fn, "__dfmPatch", { value: "soft", configurable: false });
  } catch {}
  try {
    Object.defineProperty(window, "__getFaces", {
      configurable: true,
      get() { return fn; },
      set() {
        console.warn("[probe safe] override __getFaces ignoré");
      },
    });
  } catch (err) {
    try {
      window.__getFaces = fn;
    } catch {}
  }
  console.info("[probe safe] private hook exposed (read-only)");
}

export function installProbeSafe(sceneOrModel) {
  try {
    if (typeof window === "undefined") {
      logOnceUnavailable();
      return;
    }
    const candidate = sceneOrModel || window.viewerAdapter?.viewer || window.viewer;
    const hookSource = candidate && typeof candidate.__getFaces === "function"
      ? candidate
      : (candidate && candidate.scene && typeof candidate.scene.__getFaces === "function"
        ? candidate.scene
        : null);

    if (!hookSource) {
      logOnceUnavailable();
      if (typeof window.__getFaces !== "undefined") {
        try { delete window.__getFaces; } catch {}
      }
      return;
    }

    const bound = hookSource.__getFaces.bind(hookSource);
    exposeReadOnlyHook(bound);
  } catch (e) {
    console.info("[probe safe] installed (soft)", e?.message || e);
  }
}
