// static/js/main.js
import { startViewer, loadXKT, onModelLoaded } from './viewer.js';

const state = { file: null, file_id: null, polling: null };
const $ = (id) => document.getElementById(id);

onModelLoaded(() => {
  document.documentElement.classList.add('has-model');
});

function setBtn(el, label, loading=false, disabled=false) {
  if (!el) return;
  el.textContent = label;
  el.disabled = !!disabled;
  el.dataset.loading = loading ? '1' : '';
}

async function uploadAndConvert(btn) {
  const tol = $('toleranceSelect')?.value || 'standard';
  const fd = new FormData();
  fd.append('file', state.file);
  fd.append('tolerance', tol);

  setBtn(btn, 'Envoi…', true, true);
  try {
    const r = await fetch('/upload', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    console.info('[upload] /upload →', j);
    if (!r.ok) {
      const msg = j?.detail || j?.error || ('HTTP ' + r.status);
      throw new Error(msg);
    }
    state.file_id = j.file_id;

    if (j.xkt_url) {
      setBtn(btn, 'Affichage…', true, true);
      await loadXKT(j.xkt_url);
      setBtn(btn, 'Prêt', false, false);
      markDropSuccess(true);
      return;
    }

    setBtn(btn, 'Conversion…', true, true);
    await pollStatus(state.file_id, async (xkt_url) => {
      setBtn(btn, 'Affichage…', true, true);
      await loadXKT(xkt_url);
      setBtn(btn, 'Prêt', false, false);
      markDropSuccess(true);
    });
  } catch (err) {
    console.error('[upload] erreur', err);
    alert('Erreur upload/convert : ' + (err?.message || err));
    markDropSuccess(false);
    setBtn(btn, 'VISUALISER', false, false);
    return; // stop flow
  }
}

function markDropSuccess(ok) {
  const dz = document.querySelector('[data-dropzone]');
  if (!dz) return;
  dz.classList.toggle('is-success', !!ok);   // <- ajoute la fameuse "zone verte"
  dz.classList.toggle('is-error', !ok);
}

async function pollStatus(file_id, onReady) {
  let tries = 0, max = 80;
  return new Promise((resolve, reject) => {
    async function tick() {
      tries++;
      try {
        const r = await fetch(`/convert/status?file_id=${encodeURIComponent(file_id)}`);
        const j = await r.json();
        console.info('[convert] statut →', j);
        if (j.status === 'ready' && j.xkt_url) { onReady(j.xkt_url).then(resolve, reject); return; }
        if (j.status === 'failed') { reject(new Error('conversion failed')); return; }
        if (tries >= max) { reject(new Error('timeout')); return; }
        setTimeout(tick, 1500);
      } catch (e) { reject(e); }
    }
    tick();
  });
}

function attachUploadHandlers() {
  const fileInput = $('fileInput');
  const btn = $('btnVisualiser');
  if (!fileInput || !btn) { console.error('[ui] IDs manquants'); return; }

  fileInput.addEventListener('change', async (e) => {
    state.file = e.target.files?.[0] || null;
    console.info('[upload] fichier sélectionné:', state.file?.name);
    markDropSuccess(false);
    // auto-lancement dès sélection
    if (state.file) {
      await uploadAndConvert(btn);
    }
  });

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!state.file) { alert('Choisis un fichier .stp/.step'); return; }
    await uploadAndConvert(btn);
  });
}

(async () => {
  await startViewer();
  attachUploadHandlers();
})();

