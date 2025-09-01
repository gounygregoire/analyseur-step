/*
 * Orchestrateur DFM : gère le flux d'analyse coté front
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 * Stocke fileId, materialProfile, demouldAxis
 */

import AxisPicker from "./modules/AxisPicker.js";

const DEBUG_DFM = window.DEBUG_DFM === true;
const dbg = (...args) => { if (DEBUG_DFM) console.debug('[DFM]', ...args); };

// ------------ Helpers UI ------------
const UI = {
  toastInfo(msg)  { if (window.showToast) showToast(msg, {type:'info'});  else alert(msg); },
  toastWarn(msg)  { if (window.showToast) showToast(msg, {type:'warn'});  else alert(msg); },
  toastError(msg) { if (window.showToast) showToast(msg, {type:'error'}); else alert(msg); },
  setLoading(on)  {
    const btn = document.getElementById('submitQuestionnaire');
    if (btn) btn.disabled = !!on;
  }
};

export const DFM_STATES = {
  IDLE: 'IDLE',
  MATERIAL_CONFIRMED: 'MATERIAL_CONFIRMED',
  AXIS_PICK: 'AXIS_PICK',
  RUNNING: 'RUNNING',
  RESULTS: 'RESULTS',
  ERROR: 'ERROR'
};

class DFMOrchestrator {
  constructor() {
    this.state = DFM_STATES.IDLE;
    this.fileId = null;
    this.materialProfile = null;
    this.demouldAxis = null;
    this.axisPicker = null;
    this._autoSuggestion = null;
  }

  setState(next) {
    this.state = next;
    dbg('state →', next);
    if (next === DFM_STATES.AXIS_PICK) {
      this.renderAxisPanel();
    }
  }

  setFileId(id) { this.fileId = id || null; }
  setMaterialProfile(profile) { this.materialProfile = profile || null; }
  setDemouldAxis(axis) { this.demouldAxis = axis || null; }

  renderAxisPanel() {
    // Ne rend l’UI d’axe que si les prérequis sont OK
    if (!this.fileId || !this.materialProfile) {
      UI.toastInfo("Veuillez d’abord choisir un matériau et charger un fichier.");
      return;
    }

    let panel = document.getElementById('dfmAxisPanel');
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'dfmAxisPanel';
    panel.className = 'card mt-3';
    panel.innerHTML = `<div class="card-body" id="axisPickerContainer"></div>`;
    const viewer = document.getElementById('viewer');
    viewer?.insertAdjacentElement('afterend', panel);

    const container = panel.querySelector('#axisPickerContainer');
    this.axisPicker = new AxisPicker(container);

    this.axisPicker.addEventListener('preview', (e) => this.previewAxis(e.detail));
    this.axisPicker.addEventListener('clear', () => window.viewerAdapter?.clearAxisPreview());
    this.axisPicker.addEventListener('confirm', (e) => this.confirmAxis(e.detail));
  }

  async previewAxis(sel) {
    dbg('previewAxis', sel);
    if (sel.axis === 'AUTO') {
      try {
        const res = await fetch(`/api/dfm/axes/suggest?fileId=${this.fileId}`);
        if (res.ok) {
          const data = await res.json();
          this._autoSuggestion = data;
          window.viewerAdapter?.previewDemouldAxis(data);
          if (data.axis && data.axis !== 'VECTOR') {
            this.axisPicker?.setValue({ axis: data.axis, direction: data.direction });
          }
        }
      } catch (e) {
        console.error(e);
      }
    } else {
      this._autoSuggestion = sel;
      window.viewerAdapter?.previewDemouldAxis(sel);
    }
  }

  confirmAxis(sel) {
    const chosen = sel.axis === 'AUTO' && this._autoSuggestion ? this._autoSuggestion : sel;
    this.setDemouldAxis(chosen);
    dbg('confirmAxis', chosen);
    document.getElementById('dfmAxisPanel')?.remove();
    this.axisPicker = null;
    this.startAnalysis();
  }

  // --- 1) startAnalysis -----------------------------------------------------
  async startAnalysis({ fileId = this.fileId, materialProfile = this.materialProfile, demouldAxis = this.demouldAxis } = {}) {
    // Garde-fous sans dépendre d’un "state" global
    if (!fileId) {
      UI.toastInfo("Aucun fichier chargé/converti. Importez et visualisez une pièce 3D avant d’analyser.");
      this.handleError('Fichier manquant');
      return;
    }
    if (!materialProfile) {
      UI.toastInfo("Sélectionnez un matériau (questionnaire) avant d’analyser.");
      this.handleError('Profil matière manquant');
      return;
    }
    if (!demouldAxis) {
      UI.toastInfo("Veuillez valider l’axe de démoulage.");
      this.handleError('Axe de démoulage manquant');
      return;
    }

    dbg('startAnalysis', { fileId, materialProfile, demouldAxis });
    this.setState(DFM_STATES.RUNNING);
    this._renderLoading();

    try {
      const res = await fetch('/api/dfm/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, materialProfile, demouldAxis })
      });
      if (!res.ok) throw new Error('start_failed');
      const data = await res.json();
      this.pollStatus(data.jobId);
    } catch (e) {
      console.error(e);
      this.handleError('Démarrage analyse impossible');
    }
  }

  // --- 2) pollStatus -------------------------------------------------------
  async pollStatus(jobId) {
    dbg('pollStatus', jobId);
    try {
      const res = await fetch(`/api/dfm/status?jobId=${jobId}`);
      if (!res.ok) throw new Error('status_failed');
      const data = await res.json();
      if (data.progress !== undefined) {
        const bar = document.getElementById('dfmProgressBar');
        if (bar) bar.style.width = `${data.progress}%`;
      }
      if (data.status === 'completed') {
        this.fetchResults(jobId);
      } else if (data.status === 'failed') {
        this.handleError('Analyse échouée');
      } else {
        setTimeout(() => this.pollStatus(jobId), 2500);
      }
    } catch (e) {
      console.error(e);
      this.handleError('Erreur de suivi d’analyse');
    }
  }

  // --- 3) fetchResults -----------------------------------------------------
  async fetchResults(jobId) {
    dbg('fetchResults', jobId);
    try {
      const res = await fetch(`/api/dfm/results?jobId=${jobId}`);
      if (!res.ok) throw new Error('results_failed');
      const data = await res.json();
      this.renderResults(data);
    } catch (e) {
      console.error(e);
      this.handleError('Récupération résultats impossible');
    }
  }

  // --- 4) renderResults ----------------------------------------------------
  renderResults(results = {}) {
    this.setState(DFM_STATES.RESULTS);
    const section = document.getElementById('dfmResultsSection');
    if (section) section.style.display = 'block';
    const panel = document.getElementById('dfmAnalysisPanel');
    if (!panel) return;
    panel.innerHTML = '';

    // Table des issues ------------------------------------------------------
    if (Array.isArray(results.issues) && results.issues.length) {
      const table = document.createElement('table');
      table.className = 'table table-sm';
      table.innerHTML = `<thead><tr>
        <th data-sort="severity">Severité</th>
        <th data-sort="type">Type</th>
        <th>Description</th></tr></thead>`;
      const tbody = document.createElement('tbody');
      results.issues.forEach(issue => {
        const tr = document.createElement('tr');
        tr.dataset.severity = issue.severity || '';
        tr.dataset.type = issue.type || '';
        tr.innerHTML = `<td>${issue.severity || ''}</td><td>${issue.type || ''}</td><td>${issue.message || ''}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      this._makeSortable(table);
      panel.appendChild(table);
    } else {
      panel.textContent = 'Aucune anomalie détectée';
    }

    // Checklist -------------------------------------------------------------
    const checklistWrap = document.getElementById('moldingChecklist');
    const checklistItems = document.getElementById('checklistItems');
    if (checklistItems) checklistItems.innerHTML = '';
    if (checklistWrap && Array.isArray(results.checklist) && results.checklist.length) {
      checklistWrap.style.display = 'block';
      results.checklist.forEach(it => {
        const div = document.createElement('div');
        const cls = it.status === 'pass' ? 'success' : it.status === 'warn' ? 'warning' : 'danger';
        div.className = `list-group-item list-group-item-${cls}`;
        div.textContent = it.label || '';
        checklistItems.appendChild(div);
      });
    }

    // Recommandations matière ----------------------------------------------
    const recWrap = document.getElementById('materialRecommendations');
    const recList = document.getElementById('recommendationItems');
    if (recList) recList.innerHTML = '';
    if (recWrap && Array.isArray(results.materialRecommendations) && results.materialRecommendations.length) {
      recWrap.style.display = 'block';
      results.materialRecommendations.forEach(r => {
        const li = document.createElement('li');
        li.className = 'list-group-item';
        li.textContent = r;
        recList.appendChild(li);
      });
    }

    // Liens rapports -------------------------------------------------------
    if (results.reportUrls) {
      const pdf = document.getElementById('generatePdfBtn');
      const csv = document.getElementById('downloadCsvBtn');
      if (pdf && csv) {
        pdf.style.display = 'inline-block';
        csv.style.display = 'inline-block';
        pdf.href = results.reportUrls.pdf;
        csv.href = results.reportUrls.csv;
      }
    }

    // Heatmap / annotations -------------------------------------------------
    window.viewerAdapter?.applyHeatmap(results.heatmap);
    window.viewerAdapter?.addAnnotations(results.annotations);
  }

  // --- 5) Error management -------------------------------------------------
  handleError(message) {
    this.setState(DFM_STATES.ERROR);
    const section = document.getElementById('dfmResultsSection');
    if (section) section.style.display = 'block';
    const panel = document.getElementById('dfmAnalysisPanel');
    if (!panel) return;
    panel.innerHTML = `<div class="alert alert-danger">${message} <a href="#" id="retryDFM" class="alert-link">Relancer</a></div>`;
    document.getElementById('retryDFM')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.setState(DFM_STATES.AXIS_PICK);
    });
  }

  // Utilitaires -------------------------------------------------------------
  _renderLoading() {
    const section = document.getElementById('dfmResultsSection');
    if (section) section.style.display = 'block';
    const panel = document.getElementById('dfmAnalysisPanel');
    if (!panel) return;
    panel.innerHTML = `<div id="dfmLoading" class="text-center my-3">
      <div class="spinner-border" role="status"></div>
      <div id="dfmProgressText" class="mt-2">Analyse DFM en cours...</div>
      <div class="progress mt-2">
        <div id="dfmProgressBar" class="progress-bar progress-bar-striped" style="width:0%"></div>
      </div>
    </div>`;
  }

  _makeSortable(table) {
    const headers = table.querySelectorAll('th[data-sort]');
    headers.forEach(h => {
      h.style.cursor = 'pointer';
      h.addEventListener('click', () => {
        const key = h.dataset.sort;
        const tbody = table.tBodies[0];
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const asc = h.classList.toggle('asc');
        rows.sort((a, b) => {
          const av = a.dataset[key] || '';
          const bv = b.dataset[key] || '';
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
        rows.forEach(r => tbody.appendChild(r));
      });
    });
  }
}

export const dfmOrchestrator = new DFMOrchestrator();

// --- Validation formulaire matière -----------------------------------------
const EXCLUSIVE_GROUPS = [
  ['stiffness', 'flexibility'],
  ['transparent', 'flame_retardant']
];
const SECTION_LIMITS = { mechanical: 3, aesthetic: 2, regulatoryStrong: 1 };

// Normalise une valeur (string ou array) vers array
function arr(v) { return Array.isArray(v) ? v : (v ? [v] : []); }

export function collectMaterialForm() {
  const form = document.getElementById('materialQuestionnaireForm');
  const fd = new FormData(form);
  const data = {};
  for (const [key, value] of fd.entries()) {
    const clean = key.replace('[]', '');
    if (data[clean]) {
      if (Array.isArray(data[clean])) data[clean].push(value);
      else data[clean] = [data[clean], value];
    } else {
      data[clean] = value;
    }
  }

  const mech = arr(data.mechanical);
  const aest = arr(data.aesthetic);
  const reg  = arr(data.regulatory);
  const warnings = [];

  // Capper au lieu de jeter des erreurs
  if (mech.length > SECTION_LIMITS.mechanical) {
    warnings.push('Maximum 3 contraintes mécaniques. Les 3 premières ont été conservées.');
    mech.length = SECTION_LIMITS.mechanical;
  }
  if (aest.length > SECTION_LIMITS.aesthetic) {
    warnings.push('Maximum 2 exigences esthétiques. Les 2 premières ont été conservées.');
    aest.length = SECTION_LIMITS.aesthetic;
  }
  const strongCount = reg.filter(id => document.getElementById(id)?.dataset.strong === 'true').length;
  if (strongCount > SECTION_LIMITS.regulatoryStrong) {
    // garde la première "forte", supprime les autres
    let kept = false;
    data.regulatory = reg.filter(id => {
      const strong = document.getElementById(id)?.dataset.strong === 'true';
      if (strong) {
        if (!kept) { kept = true; return true; }
        return false;
      }
      return true;
    });
    warnings.push('Maximum 1 contrainte réglementaire forte. Seule la première a été conservée.');
  }

  // Exclusivités (rigidité vs flexibilité…)
  const ids = [...mech, ...aest, ...(data.regulatory || reg)];
  for (const group of EXCLUSIVE_GROUPS) {
    const selected = group.filter(id => ids.includes(id));
    if (selected.length > 1) {
      // on garde la première sélectionnée
      const keep = selected[0];
      const drop = selected.slice(1);
      warnings.push(`Critères exclusifs : ${selected.join(', ')}. Seul « ${keep} » a été conservé.`);
      drop.forEach(x => {
        const ixM = mech.indexOf(x); if (ixM >= 0) mech.splice(ixM, 1);
        const ixA = aest.indexOf(x); if (ixA >= 0) aest.splice(ixA, 1);
        if (Array.isArray(data.regulatory)) {
          const ixR = data.regulatory.indexOf(x); if (ixR >= 0) data.regulatory.splice(ixR, 1);
        }
      });
    }
  }

  // Reconstruire data propre
  const profile = {
    ...data,
    mechanical: mech,
    aesthetic: aest,
    regulatory: Array.isArray(data.regulatory) ? data.regulatory : reg
  };

  return { ok: true, data: profile, warnings };
}

// --- Handler boutons "Analyser" et "Analyser & Recommander" ---------------
document.addEventListener('DOMContentLoaded', () => {
  const modalEl = document.getElementById('materialQuestionnaireModal');
  const modal = modalEl ? new bootstrap.Modal(modalEl) : null;

  // exclusivité des cases à cocher (flexibilité vs rigidité, etc.)
  EXCLUSIVE_GROUPS.forEach(group => {
    const inputs = group.map(id => document.getElementById(id)).filter(Boolean);
    inputs.forEach(input => {
      input.addEventListener('change', () => {
        if (input.checked) {
          inputs.forEach(other => {
            if (other !== input) other.checked = false;
          });
        }
      });
    });
  });

  // Bouton principal d'analyse : ouvre le modal
  document.getElementById('dfmAnalyzeBtn')?.addEventListener('click', () => {
    modal?.show();
  });

  // Bouton de soumission du questionnaire
  const btn = document.getElementById('submitQuestionnaire');
  if (!btn) return;

  btn.addEventListener('click', () => {
    UI.setLoading(true);
    try {
      const result = collectMaterialForm();
      const profile = result.data;

      // Avertissements éventuels
      if (result.warnings && result.warnings.length) {
        UI.toastWarn(result.warnings.join('\n'));
      }

      // FileId depuis des data-* posées côté serveur
      dfmOrchestrator.setFileId(
        document.body.dataset.model ||
        document.body.dataset.fileId ||
        document.body.dataset.modelId ||
        null
      );
      dfmOrchestrator.setMaterialProfile(profile);

      if (!dfmOrchestrator.fileId) {
        UI.toastInfo("Aucun fichier à analyser. Importez/convertissez une pièce puis recommencez.");
        return;
      }

      modal?.hide();
      dfmOrchestrator.setState(DFM_STATES.MATERIAL_CONFIRMED);
      dfmOrchestrator.setState(DFM_STATES.AXIS_PICK);
    } catch (err) {
      console.error(err);
      UI.toastError(err?.message || 'Formulaire invalide');
    } finally {
      UI.setLoading(false);
    }
  });
});
