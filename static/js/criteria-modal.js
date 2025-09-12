// Logiciel de sélection des critères matière
// Applique les règles exclusives, conflits et limites puis gère le bouton "Analyser".

// Pas d'inline onclick : tout est câblé en JS

// === Déclaration des règles métiers ===
const RULES = {
  limits: { meca: 3, aesthetic: 2, regulatory: 1 },
  exclusiveGroups: [
    ["rigidite_elevee", "flexibilite"],
    ["transparence", "charge_fibre"],
  ],
  conflicts: [
    {
      a: "transparence",
      b: "retardateur_flamme",
      severity: "hard",
      msg: "Incompatibles : les retardateurs de flamme rendent opaque.",
    },
    {
      a: "transparence",
      b: "texture_possible",
      severity: "soft",
      msg: "La texture forte réduit la transparence perçue.",
    },
  ],
  regulatoryStrong: [
    "contact_alimentaire",
    "qualite_medicale",
    "retardateur_flamme",
    "proprietes_elec",
  ],
};

// Mapping section → critères
const SECTION_MAP = {
  meca: [
    "rigidite_elevee",
    "flexibilite",
    "resistance_chocs",
    "flexion",
    "traction",
    "usure",
    "fatigue",
  ],
  aesthetic: [
    "transparence",
    "qualite_surface",
    "texture_possible",
    "finition_bril",
  ],
  regulatory: [
    "contact_alimentaire",
    "qualite_medicale",
    "retardateur_flamme",
    "proprietes_elec",
  ],
};

// Pré-calculs pour accès rapide
const EXCLUSIVE_LOOKUP = {};
RULES.exclusiveGroups.forEach((group) => {
  group.forEach((id) => {
    EXCLUSIVE_LOOKUP[id] = group.filter((x) => x !== id);
  });
});

const CONFLICT_MAP = {};
RULES.conflicts.forEach(({ a, b, severity, msg }) => {
  (CONFLICT_MAP[a] = CONFLICT_MAP[a] || []).push({ other: b, severity, msg });
  (CONFLICT_MAP[b] = CONFLICT_MAP[b] || []).push({ other: a, severity, msg });
});

const state = {
  warnings: new Set(),
  blockers: new Set(),
};

// === Utilitaires ===
function sectionOf(id) {
  const el = document.getElementById(id);
  return el?.dataset.section ||
    Object.keys(SECTION_MAP).find((k) => SECTION_MAP[k].includes(id));
}

function isChecked(id) {
  return document.getElementById(id)?.checked || false;
}

function setChecked(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = value;
}

function toast(message) {
  if (window.bootstrap?.Toast) {
    let c = document.getElementById("toastContainer");
    if (!c) {
      c = document.createElement("div");
      c.id = "toastContainer";
      c.className = "toast-container position-fixed bottom-0 end-0 p-3";
      document.body.appendChild(c);
    }
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<div class="toast-body">${message}</div>`;
    c.appendChild(el);
    const t = new bootstrap.Toast(el);
    t.show();
    el.addEventListener("hidden.bs.toast", () => el.remove());
  } else {
    alert(message);
  }
}

function shake(el) {
  if (!el) return;
  el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), 400);
}

function updateSummary() {
  const checked = Array.from(
    document.querySelectorAll(".criterion:checked")
  ).map((cb) => cb.id);
  const valids = checked.filter(
    (id) => !state.warnings.has(id) && !state.blockers.has(id)
  );
  const summary = document.getElementById("criteriaSummary");
  if (summary) {
    summary.textContent = `✅ Valides: ${valids.length} | ⚠️ Avertissements: ${state.warnings.size} | ⛔ Blocants: ${state.blockers.size}`;
  }
  const btn = document.getElementById("materialConfirmBtn");
  if (btn) btn.disabled = state.blockers.size > 0;
}

// === Règles ===
function enforceExclusives(id) {
  const others = EXCLUSIVE_LOOKUP[id] || [];
  others.forEach((oid) => {
    const el = document.getElementById(oid);
    if (!el) return;
    if (isChecked(id)) {
      setChecked(oid, false);
      el.disabled = true;
      el.classList.add("temp-disabled");
      setTimeout(() => {
        el.disabled = false;
        el.classList.remove("temp-disabled");
      }, 2000);
    }
  });
}

function checkLimits(cb) {
  const section = sectionOf(cb.id);
  const limit = RULES.limits[section];
  if (!limit) return true;
  const checked = document.querySelectorAll(
    `.criterion[data-section="${section}"]:checked`
  );
  if (checked.length > limit) {
    toast("Maximum atteint dans cette section");
    return false;
  }
  if (
    section === "regulatory" &&
    RULES.regulatoryStrong.includes(cb.id)
  ) {
    const strong = Array.from(checked).filter((x) =>
      RULES.regulatoryStrong.includes(x.id)
    );
    if (strong.length > RULES.limits.regulatory) {
      toast("Maximum atteint dans cette section");
      return false;
    }
  }
  return true;
}

function checkHardConflicts(id) {
  const conflicts = CONFLICT_MAP[id] || [];
  for (const { other, severity, msg } of conflicts) {
    if (severity === "hard" && isChecked(other)) {
      toast(msg);
      shake(document.getElementById(id));
      return false;
    }
  }
  return true;
}

function evaluate() {
  state.warnings.clear();
  state.blockers.clear();
  document
    .querySelectorAll("label[for]")
    .forEach((l) => l.classList.remove("text-warning"));

  const checked = Array.from(
    document.querySelectorAll(".criterion:checked")
  ).map((cb) => cb.id);

  checked.forEach((id) => {
    (CONFLICT_MAP[id] || []).forEach(({ other, severity }) => {
      if (checked.includes(other)) {
        if (severity === "hard") {
          state.blockers.add(id);
          state.blockers.add(other);
        } else {
          state.warnings.add(id);
          state.warnings.add(other);
        }
      }
    });
  });

  state.warnings.forEach((id) => {
    document
      .querySelector(`label[for="${id}"]`)
      ?.classList.add("text-warning");
  });

  updateSummary();
}

// === Validation et lancement DFM ===
function validateForm() {
  evaluate();
  const payload = Array.from(
    document.querySelectorAll(".criterion:checked")
  ).map((cb) => cb.id);
  return {
    ok: state.blockers.size === 0,
    hardErrors: Array.from(state.blockers),
    softWarnings: Array.from(state.warnings),
    payload,
  };
}

// Récupère toutes les valeurs du questionnaire (sans choix de résine)
function collectQuestionnaire() {
  const form = document.getElementById("materialQuestionnaireForm");
  if (!form) return {};
  const fd = new FormData(form);
  const obj = {};
  fd.forEach((v, k) => {
    const key = k.endsWith('[]') ? k.slice(0, -2) : k;
    if (obj[key]) {
      if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
      obj[key].push(v);
    } else {
      obj[key] = v;
    }
  });
  return obj;
}

async function fetchRecommendations(questionnaire) {
  const res = await fetch('/api/material-recommendations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionnaire })
  });
  if (!res.ok) throw new Error('recommandations échouées');
  const data = await res.json();
  return data.recommendations || [];
}

  function renderRecommendations(recs) {
    const container = document.getElementById('materialOptions');
  if (!container) return;
  container.innerHTML = '';
  recs.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'form-check';
    div.innerHTML = `
      <input class="form-check-input" type="radio" name="material_choice" id="rec_${i}" value="${r.id}">
      <label class="form-check-label" for="rec_${i}">${r.name} - ${r.score}%</label>`;
    container.appendChild(div);
  });
  container.classList.remove('d-none');
}

// === Initialisation ===
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("materialModal");
  if (el && window.bootstrap?.Modal) {
    // instancie la modale sans conserver de référence
    bootstrap.Modal.getOrCreateInstance(el, { backdrop: "static" });
  }

  let recommendations = null;

  document
    .getElementById("materialConfirmBtn")
    ?.addEventListener("click", async (e) => {
      const questionnaire = collectQuestionnaire();
      if (!recommendations) {
        try {
          recommendations = await fetchRecommendations(questionnaire);
          if (!recommendations.length) {
            toast('Aucune recommandation trouvée');
            return;
          }
          renderRecommendations(recommendations);
          e.target.innerHTML = '<i class="bi bi-check-circle me-2"></i>Valider';
          return;
        } catch (err) {
          console.error(err);
          toast('Erreur lors de la recommandation');
          return;
        }
      }

      const selected = document.querySelector('input[name="material_choice"]:checked');
      if (!selected) {
        toast('Choisis une matière recommandée');
        return;
      }

      const materialProfile = {
        id: selected.value,
        draft_min_deg: 1.0,
        criteria: questionnaire
      };
      console.debug('[DFM] material:selected emit', materialProfile);
      window.dispatchEvent(new CustomEvent('material:selected', { detail: { materialProfile }}));
      bootstrap.Modal.getOrCreateInstance(document.getElementById('materialModal'))?.hide();
      recommendations = null;
      const container = document.getElementById('materialOptions');
      if (container) { container.innerHTML=''; container.classList.add('d-none'); }
      e.target.innerHTML = '<i class="bi bi-check-circle me-2"></i>Analyser et recommander';
    });

  evaluate();
});

