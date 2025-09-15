// static/js/main.js
import { startViewer, loadXKT, onModelLoaded } from './viewer.js';

const state = { file: null, file_id: null };
const $ = (id) => document.getElementById(id);

function setBtn(el, label, loading = false, disabled = false) {
  if (!el) return;
  el.textContent = label;
  el.disabled = !!disabled;
  el.dataset.loading = loading ? '1' : '';
}

// ⬇️ Gestion visuelle de la dropzone
function setDropState(stateName) {
  const dz = document.querySelector('[data-dropzone]');
  if (!dz) return;
  dz.classList.remove('is-success', 'is-ready', 'is-error');
  if (stateName) dz.classList.add(stateName);
}

async function displayModel(btn, url) {
  if (!url) return;
  setBtn(btn, 'Affichage…', true, true);
  try {
    await loadXKT(url);
  } catch (err) {
    console.error(err);
    alert('Affichage impossible : ' + err.message);
  } finally {
    setBtn(btn, 'Prêt', false, false);
  }
}

async function uploadAndConvert(btn) {
  if (!state.file) throw new Error('Aucun fichier à envoyer');
  setDropState('is-ready');
  const tol = $('toleranceSelect')?.value || 'standard';
  const fd = new FormData();
  fd.append('file', state.file);
  fd.append('tolerance', tol);

  setBtn(btn, 'Envoi…', true, true);
  const r = await fetch('/upload', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  console.info('[upload] /upload →', j);

  if (!r.ok) {
    const msg = j?.detail || j?.error || 'HTTP ' + r.status;
    setDropState('is-error');
    setBtn(btn, 'VISUALISER', false, false);
    throw new Error(msg);
  }

  state.file_id = j.file_id;

  // ✅ Upload ok → passe la dropzone en vert directement
  setDropState('is-success');

  if (j.xkt_url) {
    await displayModel(btn, j.xkt_url);
    return;
  }

  setBtn(btn, 'Conversion…', true, true);
  await pollStatus(state.file_id, (xkt_url) => displayModel(btn, xkt_url));
}

async function pollStatus(file_id, onReady) {
  let tries = 0,
    max = 80;
  return new Promise((resolve, reject) => {
    async function tick() {
      tries++;
      try {
        const r = await fetch(`/convert/status?file_id=${encodeURIComponent(file_id)}`);
        const j = await r.json();
        console.info('[convert] statut →', j);
        if (j.status === 'ready' && j.xkt_url) {
          onReady(j.xkt_url).then(resolve, reject);
          return;
        }
        if (j.status === 'failed') {
          reject(new Error('conversion failed'));
          return;
        }
        if (tries >= max) {
          reject(new Error('timeout'));
          return;
        }
        setTimeout(tick, 1500);
      } catch (e) {
        reject(e);
      }
    }
    tick();
  });
}

function attachUploadHandlers() {
  const fileInput = $('fileInput');
  const btn = $('btnVisualiser');
  if (!fileInput || !btn) {
    console.error('[ui] IDs manquants');
    return;
  }

  fileInput.addEventListener('change', async (e) => {
    state.file = e.target.files?.[0] || null;
    console.info('[upload] fichier sélectionné:', state.file?.name);
    if (!state.file) {
      setDropState(null);
      return;
    }
    try {
      await uploadAndConvert(btn);
    } catch (err) {
      setDropState('is-error');
      console.error(err);
      alert('Upload/convert : ' + err.message);
    }
  });

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!state.file) {
      alert('Choisis un fichier .stp/.step');
      return;
    }
    try {
      await uploadAndConvert(btn);
    } catch (err) {
      setDropState('is-error');
      console.error(err);
      alert('Upload/convert : ' + err.message);
    }
  });
}

(async () => {
  try {
    await startViewer(); // ⬅️ si ça plante, on passe quand même à la suite
  } catch (e) {
    console.error('[viewer] init error (upload restera fonctionnel)', e);
  }
  attachUploadHandlers();

  // Quand le modèle est affiché → état "ready"
  onModelLoaded(() => {
    document.documentElement.classList.add('has-model');
    setDropState('is-ready'); // option : surlignage différent quand le rendu est visible
  });
})();

