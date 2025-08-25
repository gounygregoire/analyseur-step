/**
 * Orchestrates the DFM analysis after material modal validation.
 */

const EXCLUSIVE_GROUPS = [
  ["rigidite_elevee", "flexibilite"],
  ["transparence", "charge_fibre"],
];

const SECTION_LIMITS = { meca: 3, aesthetic: 2, regulatory: 1 };

/**
 * Lit les choix du modale matière, vérifie les règles et renvoie un profil.
 */
export function collectMaterialForm() {
  const checked = Array.from(document.querySelectorAll('.criterion:checked'));
  const ids = checked.map(cb => cb.id);

  // exclusivités
  for (const group of EXCLUSIVE_GROUPS) {
    const inGroup = group.filter(id => ids.includes(id));
    if (inGroup.length > 1) {
      throw new Error(`Critères exclusifs: ${inGroup.join(', ')}`);
    }
  }

  // limites par section
  const counts = {};
  for (const cb of checked) {
    const section = cb.dataset.section;
    counts[section] = (counts[section] || 0) + 1;
  }
  for (const [section, limit] of Object.entries(SECTION_LIMITS)) {
    if ((counts[section] || 0) > limit) {
      throw new Error(`Trop de critères dans la section ${section}`);
    }
  }

  return { criteria: ids };
}

/**
 * Lance le job d'analyse DFM.
 */
export async function startAnalysis({ fileId, materialProfile }) {
  const res = await fetch('/api/dfm/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, materialProfile })
  });
  if (!res.ok) throw new Error(`startAnalysis HTTP ${res.status}`);
  const data = await res.json();
  return data.jobId;
}

/**
 * Poll le statut du job.
 */
export async function pollStatus(jobId) {
  while (true) {
    const res = await fetch(`/api/dfm/status?jobId=${encodeURIComponent(jobId)}`);
    if (!res.ok) throw new Error(`pollStatus HTTP ${res.status}`);
    const data = await res.json();
    if (data.status === 'completed') return;
    if (data.status === 'failed') throw new Error(data.error || 'Analyse DFM échouée');
    await new Promise((r) => setTimeout(r, 2500));
  }
}

/**
 * Récupère les résultats finaux.
 */
export async function fetchResults(jobId) {
  const res = await fetch(`/api/dfm/results?jobId=${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`fetchResults HTTP ${res.status}`);
  return await res.json();
}

/**
 * Met à jour l'UI avec les résultats et envoie au viewer.
 */
export function renderResults(results) {
  const section = document.getElementById('dfmResultsSection');
  if (section) section.style.display = 'block';

  const issuesEl = document.getElementById('dfmAnalysisPanel');
  if (issuesEl && Array.isArray(results.issues)) {
    issuesEl.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'table table-sm table-hover';
    const tbody = document.createElement('tbody');
    results.issues.forEach((iss) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${iss.title || ''}</td>` +
                     `<td>${iss.severity || ''}</td>` +
                     `<td>${iss.recommendation || ''}</td>`;
      if (iss.annotationId) {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => {
          const v = window.viewerAdapter;
          v?.focusAnnotation?.(iss.annotationId);
        });
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    issuesEl.appendChild(table);
  }

  const checklistEl = document.getElementById('checklistItems');
  if (checklistEl && Array.isArray(results.checklist)) {
    checklistEl.innerHTML = '';
    results.checklist.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'list-group-item d-flex align-items-center';
      let badge = 'bg-secondary';
      if (item.status === 'pass') badge = 'bg-success';
      else if (item.status === 'warn') badge = 'bg-warning';
      else if (item.status === 'fail') badge = 'bg-danger';
      li.innerHTML = `<span class="badge ${badge} me-2">&nbsp;</span>${item.label || item}`;
      checklistEl.appendChild(li);
    });
    const container = document.getElementById('moldingChecklist');
    if (container) container.style.display = 'block';
  }

  const recEl = document.getElementById('recommendationItems');
  const recContainer = document.getElementById('materialRecommendations');
  if (recEl && Array.isArray(results.recommendations)) {
    recEl.innerHTML = '';
    results.recommendations.forEach((rec) => {
      const li = document.createElement('li');
      li.className = 'list-group-item';
      li.textContent = rec;
      recEl.appendChild(li);
    });
    if (recContainer) recContainer.style.display = 'block';
  }

  const pdfBtn = document.getElementById('generatePdfBtn');
  if (pdfBtn && results.pdfUrl) {
    pdfBtn.style.display = 'inline-block';
    pdfBtn.onclick = () => window.open(results.pdfUrl, '_blank');
  }

  const csvBtn = document.getElementById('downloadCsvBtn');
  if (csvBtn && results.csvUrl) {
    csvBtn.style.display = 'inline-block';
    csvBtn.onclick = () => window.open(results.csvUrl, '_blank');
  }

  const viewer = window.viewerAdapter;
  if (viewer) {
    if (results.heatmap) viewer.applyHeatmap?.(results.heatmap);
    if (results.annotations) viewer.addAnnotations?.(results.annotations);
  }
}

/**
 * Affiche un message d'erreur clair.
 */
export function handleError(error) {
  const msg = error?.message || 'Erreur inconnue';
  if (window.bootstrap?.Toast) {
    let c = document.getElementById('toastContainer');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toastContainer';
      c.className = 'toast-container position-fixed bottom-0 end-0 p-3';
      document.body.appendChild(c);
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<div class="toast-body bg-danger text-white">${msg}</div>`;
    c.appendChild(el);
    const t = new bootstrap.Toast(el);
    t.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  } else {
    alert(msg);
  }
}

// --- Orchestration globale ---------------------------------------------------

let spinnerEl = null;

function showSpinner(message) {
  if (!spinnerEl) {
    spinnerEl = document.createElement('div');
    spinnerEl.id = 'dfmSpinner';
    spinnerEl.style.position = 'fixed';
    spinnerEl.style.top = '1rem';
    spinnerEl.style.right = '1rem';
    spinnerEl.style.zIndex = '1060';
    spinnerEl.style.display = 'flex';
    spinnerEl.style.alignItems = 'center';
    spinnerEl.style.padding = '0.5rem 1rem';
    spinnerEl.style.background = 'rgba(255,255,255,0.9)';
    spinnerEl.style.borderRadius = '0.25rem';
    spinnerEl.innerHTML = `<div class="spinner-border spinner-border-sm me-2" role="status"></div><span id="dfmSpinnerMsg"></span>`;
    document.body.appendChild(spinnerEl);
  }
  spinnerEl.querySelector('#dfmSpinnerMsg').textContent = message || '';
  spinnerEl.style.display = 'flex';
}

function hideSpinner() {
  if (spinnerEl) spinnerEl.style.display = 'none';
}

async function runDFM(materialProfile) {
  const fileId = document.body.dataset.model || document.body.dataset.fileId;
  try {
    showSpinner('Analyse en cours');
    const jobId = await startAnalysis({ fileId, materialProfile });
    await pollStatus(jobId);
    showSpinner('Résultats prêts');
    const results = await fetchResults(jobId);
    hideSpinner();
    renderResults(results);
  } catch (err) {
    console.error(err);
    hideSpinner();
    handleError(new Error('Analyse échouée'));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('dfmAnalyzeBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      showSpinner('Validation matière');
      try {
        const materialProfile = collectMaterialForm();
        await runDFM(materialProfile);
      } catch (err) {
        console.error(err);
        handleError(new Error('Analyse échouée'));
      } finally {
        hideSpinner();
        btn.disabled = false;
      }
    });
  }
});

window.startDFM = runDFM;
