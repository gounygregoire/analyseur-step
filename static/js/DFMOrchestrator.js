/*
 * Orchestrateur DFM : gère le flux d'analyse coté front
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 * Stocke fileId, materialProfile, demouldAxis
 */

import AxisPicker from "./modules/AxisPicker.js";

const DEBUG_DFM = window.DEBUG_DFM === true;
const dbg = (...args) => { if (DEBUG_DFM) console.debug('[DFM]', ...args); };

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

  setFileId(id) { this.fileId = id; }
  setMaterialProfile(profile) { this.materialProfile = profile; }
  setDemouldAxis(axis) { this.demouldAxis = axis; }

  renderAxisPanel() {
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
            this.axisPicker.setValue({ axis: data.axis, direction: data.direction });
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
    if (!fileId || !materialProfile) {
      console.log({ fileLoaded: state.fileLoaded, materialProfile: state.materialProfile });
      console.trace('DFM blocked here');
      alert('Fichier ou profil matière manquant');
      this.handleError('Paramètres manquants');
      return;
    }
    if (!demouldAxis) {
      alert("Veuillez valider l'axe de démoulage");
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
    section.style.display = 'block';
    const panel = document.getElementById('dfmAnalysisPanel');
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
    checklistItems.innerHTML = '';
    if (Array.isArray(results.checklist) && results.checklist.length) {
      checklistWrap.style.display = 'block';
      results.checklist.forEach(it => {
        const div = document.createElement('div');
        const cls = it.status === 'pass' ? 'success' : it.status === 'warn' ? 'warning' : 'danger';
        div.className = `list-group-item list-group-item-${cls}`;
        div.textContent = it.label || '';
        checklistItems.appendChild(div);
      });
    }

    // Recommandations matiere ----------------------------------------------
    const recWrap = document.getElementById('materialRecommendations');
    const recList = document.getElementById('recommendationItems');
    recList.innerHTML = '';
    if (Array.isArray(results.materialRecommendations) && results.materialRecommendations.length) {
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
      pdf.style.display = 'inline-block';
      csv.style.display = 'inline-block';
      pdf.href = results.reportUrls.pdf;
      csv.href = results.reportUrls.csv;
    }

    // Heatmap / annotations -------------------------------------------------
    window.viewerAdapter?.applyHeatmap(results.heatmap);
    window.viewerAdapter?.addAnnotations(results.annotations);
  }

  // --- 5) Error management -------------------------------------------------
  handleError(message) {
    this.setState(DFM_STATES.ERROR);
    const section = document.getElementById('dfmResultsSection');
    section.style.display = 'block';
    const panel = document.getElementById('dfmAnalysisPanel');
    panel.innerHTML = `<div class="alert alert-danger">${message} <a href="#" id="retryDFM" class="alert-link">Relancer</a></div>`;
    document.getElementById('retryDFM')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.setState(DFM_STATES.AXIS_PICK);
    });
  }

  // Utilitaires -------------------------------------------------------------
  _renderLoading() {
    const section = document.getElementById('dfmResultsSection');
    section.style.display = 'block';
    const panel = document.getElementById('dfmAnalysisPanel');
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

  const mech = Array.isArray(data.mechanical) ? data.mechanical : data.mechanical ? [data.mechanical] : [];
  const aest = Array.isArray(data.aesthetic) ? data.aesthetic : data.aesthetic ? [data.aesthetic] : [];
  const reg  = Array.isArray(data.regulatory) ? data.regulatory : data.regulatory ? [data.regulatory] : [];

  if (mech.length > SECTION_LIMITS.mechanical) {
    throw new Error('Maximum 3 contraintes mécaniques');
  }
  if (aest.length > SECTION_LIMITS.aesthetic) {
    throw new Error('Maximum 2 exigences esthétiques');
  }
  const strongCount = reg.filter(id => document.getElementById(id)?.dataset.strong === 'true').length;
  if (strongCount > SECTION_LIMITS.regulatoryStrong) {
    throw new Error('Maximum 1 contrainte réglementaire forte');
  }

  const ids = [...mech, ...aest, ...reg];
  for (const group of EXCLUSIVE_GROUPS) {
    const selected = group.filter(id => ids.includes(id));
    if (selected.length > 1) {
      throw new Error(`Critères exclusifs : ${selected.join(', ')}`);
    }
  }

  return data;
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
    btn.disabled = true;
    try {
      const profile = collectMaterialForm();
      dfmOrchestrator.setFileId(
        document.body.dataset.model ||
        document.body.dataset.fileId ||
        document.body.dataset.modelId ||
        null
      );
      dfmOrchestrator.setMaterialProfile(profile);
      modal?.hide();
      dfmOrchestrator.setState(DFM_STATES.MATERIAL_CONFIRMED);
      dfmOrchestrator.setState(DFM_STATES.AXIS_PICK);
    } catch (err) {
      console.error(err);
      alert(err.message || 'Formulaire invalide');
    } finally {
      btn.disabled = false;
    }
  });
});
