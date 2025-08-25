/*
 * Orchestrateur DFM : gère le flux d'analyse coté front
 * États : IDLE → MATERIAL_CONFIRMED → AXIS_PICK → RUNNING → RESULTS → ERROR
 * Stocke fileId, materialProfile, demouldAxis
 */

import AxisPicker from "./modules/AxisPicker.js";

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
    console.debug('[DFM] state →', next);
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
    document.getElementById('dfmAxisPanel')?.remove();
    this.setState(DFM_STATES.RUNNING);
    this.startDFM();
  }

  async startDFM() {
    if (!this.fileId) return;
    try {
      await fetch(`/api/dfm/start?fileId=${this.fileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          material: this.materialProfile,
          demouldAxis: this.demouldAxis
        })
      });
    } catch (e) {
      console.error(e);
    }
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

// --- Handler bouton "Analyser & Recommander" -------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('submitQuestionnaire');
  if (!btn) return;

  btn.addEventListener('click', () => {
    btn.disabled = true;
    try {
      const profile = collectMaterialForm();
      dfmOrchestrator.setFileId(document.body.dataset.model || document.body.dataset.fileId || null);
      dfmOrchestrator.setMaterialProfile(profile);
      const modalEl = document.getElementById('materialQuestionnaireModal');
      const modal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
      modal.hide();
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
