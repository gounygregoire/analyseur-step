// static/js/main.js
import { startViewer, loadXKT } from './viewer.js';

const state = {
  file: null,
  file_id: null,
  aborter: null,
};

function setBtnState(text, loading = false) {
  const btn = document.getElementById('btnVisualiser');
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status"></span>${text}`;
  } else {
    btn.textContent = text;
  }
}

function attachUploadHandlers() {
  const fileInput = document.getElementById('fileInput');
  const btn = document.getElementById('btnVisualiser');
  const tolerance = document.getElementById('toleranceSelect');
  if (!fileInput || !btn) {
    console.error('[ui] fileInput ou btnVisualiser introuvable');
    return;
  }
  fileInput.addEventListener('change', (e) => {
    state.file = e.target.files?.[0] || null;
    console.info('[upload] fichier sélectionné:', state.file?.name);
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!state.file) {
      alert('Sélectionne un fichier STEP/STP avant de visualiser.');
      return;
    }
    const tol = tolerance?.value || 'standard';
    uploadAndConvert(state.file, tol);
  });
}

async function uploadAndConvert(file, tolerance) {
  console.info('[upload] démarrage', { name: file.name, tolerance });
  const fd = new FormData();
  fd.append('file', file);
  fd.append('tolerance', tolerance);
  setBtnState('Envoi…', true);
  try {
    // Route canonique côté Flask (à adapter si nécessaire)
    const res = await fetch('/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('Upload failed ' + res.status);
    const data = await res.json();
    console.info('[upload] réponse', data);
    const { file_id, xkt_url } = data;
    state.file_id = file_id;
    if (xkt_url) {
      setBtnState('Affichage…', true);
      await loadXKT(xkt_url);
      setBtnState('Prêt');
      return;
    }
    setBtnState('Conversion…', true);
    await pollStatus(file_id);
    setBtnState('Prêt');
  } catch (err) {
    console.error('[upload] erreur', err);
    alert("Erreur réseau ou serveur lors de l'upload ou de la conversion.");
    setBtnState('Prêt');
  }
}

async function pollStatus(file_id) {
  console.info('[convert] polling', { file_id });
  state.aborter?.abort();
  const ac = new AbortController();
  state.aborter = ac;
  let tries = 0;
  const maxTries = 80; // ~2 minutes à 1.5s
  async function tick() {
    tries++;
    let r;
    try {
      r = await fetch(`/convert/status?file_id=${encodeURIComponent(file_id)}`, { signal: ac.signal });
    } catch (e) {
      throw new Error('network');
    }
    if (!r.ok) throw new Error('status http ' + r.status);
    const j = await r.json();
    console.info('[convert] statut', j);
    if (j.status === 'ready' && j.xkt_url) {
      setBtnState('Affichage…', true);
      await loadXKT(j.xkt_url);
      console.info('[viewer] XKT chargé');
      return;
    }
    if (j.status === 'failed') {
      throw new Error('conversion failed');
    }
    if (tries < maxTries) {
      setTimeout(tick, 1500);
    } else {
      throw new Error('timeout conversion');
    }
  }
  return tick();
}

// bootstrap
(async () => {
  await startViewer();          // démarre le canvas et le smoke test
  attachUploadHandlers();       // connecte l’UI d’upload
})();

