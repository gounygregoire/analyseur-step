const POLL_INTERVAL = 2500;

function collectMaterialForm() {
  const modal = document.getElementById('materialQuestionnaireModal');
  const form = modal?.querySelector('form');
  if (!form) return {};
  const fd = new FormData(form);
  const getAll = (name) => fd.getAll(name).filter(Boolean);

  const mechanical = getAll('mechanical[]');
  if (mechanical.length > 3) throw new Error('Maximum 3 contraintes mécaniques.');
  if (mechanical.includes('stiffness') && mechanical.includes('flexibility')) {
    throw new Error('Rigidité élevée et Flexibilité incompatibles.');
  }

  const aesthetic = getAll('aesthetic[]');
  if (aesthetic.length > 2) throw new Error('Maximum 2 exigences esthétiques.');
  if (aesthetic.includes('transparent') && aesthetic.includes('flame_retardant')) {
    throw new Error('Transparence incompatible avec retardateur de flamme.');
  }

  const regulatory = getAll('regulatory[]');
  const strong = regulatory.filter((v) => ['food_contact', 'medical_grade'].includes(v));
  const conflict = regulatory.filter((v) => ['flame_retardant', 'electrical'].includes(v));
  if (strong.length > 1) throw new Error('Maximum 1 contrainte réglementaire forte.');
  if (strong.length && conflict.length) {
    throw new Error('Contraintes réglementaires incompatibles.');
  }

  return {
    application: fd.get('application') || '',
    cost: fd.get('cost') || 'balanced',
    mechanical,
    aesthetic,
    regulatory
  };
}

async function startAnalysis({ fileId, materialProfile }) {
  const res = await fetch('/api/dfm/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, materialProfile })
  });
  if (!res.ok) throw new Error('Erreur démarrage analyse');
  return res.json();
}

function pollStatus(jobId, onUpdate) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/dfm/status?jobId=${encodeURIComponent(jobId)}`);
        if (!res.ok) throw new Error('Erreur statut analyse');
        const data = await res.json();
        onUpdate?.(data);
        if (data.status === 'completed') {
          clearInterval(timer);
          resolve(data);
        } else if (data.status === 'failed') {
          clearInterval(timer);
          reject(new Error(data.error || 'Analyse échouée'));
        }
      } catch (e) {
        clearInterval(timer);
        reject(e);
      }
    }, POLL_INTERVAL);
  });
}

async function fetchResults(jobId) {
  const res = await fetch(`/api/dfm/results?jobId=${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error('Erreur récupération résultats');
  return res.json();
}

function renderResults(results) {
  const panel = document.getElementById('dfmAnalysisPanel');
  if (!panel) return;
  panel.innerHTML = '';

  const { issues = [], checklist = [], recommendations = [], pdf, heatmap, annotations } = results;

  if (issues.length) {
    const ul = document.createElement('ul');
    ul.className = 'list-group mb-3';
    issues.forEach((i) => {
      const li = document.createElement('li');
      li.className = 'list-group-item';
      li.textContent = i;
      ul.appendChild(li);
    });
    panel.appendChild(ul);
  }

  if (checklist.length) {
    const ul = document.createElement('ul');
    ul.className = 'list-group mb-3';
    checklist.forEach((i) => {
      const li = document.createElement('li');
      li.className = 'list-group-item';
      li.textContent = i;
      ul.appendChild(li);
    });
    panel.appendChild(ul);
  }

  if (recommendations.length) {
    const ul = document.createElement('ul');
    ul.className = 'list-group mb-3';
    recommendations.forEach((i) => {
      const li = document.createElement('li');
      li.className = 'list-group-item';
      li.textContent = i;
      ul.appendChild(li);
    });
    panel.appendChild(ul);
  }

  if (pdf) {
    const a = document.createElement('a');
    a.href = pdf;
    a.textContent = 'Télécharger le rapport PDF';
    a.target = '_blank';
    a.className = 'btn btn-sm btn-outline-secondary';
    panel.appendChild(a);
  }

  const adapter = window.viewerAdapter;
  adapter?.update?.({ heatmap, annotations });
}

function handleError(error) {
  console.error(error);
  const msg = error?.message || 'Erreur inconnue';
  if (window.showError) {
    window.showError(msg);
  } else {
    alert(msg);
  }
}

function setStatus(active, message) {
  const panel = document.getElementById('dfmAnalysisPanel');
  if (!panel) return;
  let box = panel.querySelector('#dfmStatus');
  if (!box) {
    box = document.createElement('div');
    box.id = 'dfmStatus';
    box.className = 'text-center my-3';
    box.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div><span class="msg"></span>';
    panel.appendChild(box);
  }
  const spinner = box.querySelector('.spinner-border');
  const msgEl = box.querySelector('.msg');
  if (msgEl && message) msgEl.textContent = message;
  box.style.display = active ? 'block' : 'none';
  if (spinner) spinner.style.display = active ? 'inline-block' : 'none';
}

function toggleAnalyze(disabled) {
  const btn = document.getElementById('dfmAnalyzeBtn');
  if (btn) btn.disabled = disabled;
}

async function run({ fileId }) {
  const materialProfile = collectMaterialForm();
  if (!fileId) throw new Error('Aucun fichier à analyser.');
  try {
    toggleAnalyze(true);
    setStatus(true, 'Initialisation...');
    const { jobId } = await startAnalysis({ fileId, materialProfile });
    setStatus(true, 'Analyse en cours...');
    await pollStatus(jobId, () => {});
    setStatus(true, 'Récupération des résultats...');
    const results = await fetchResults(jobId);
    setStatus(false);
    renderResults(results);
  } catch (e) {
    handleError(e);
    setStatus(false);
  } finally {
    toggleAnalyze(false);
  }
}

export default {
  run,
  collectMaterialForm,
  startAnalysis,
  pollStatus,
  fetchResults,
  renderResults,
  handleError
};
