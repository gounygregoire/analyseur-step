// static/js/main.js
import { startViewer, loadXKT } from './viewer.js';

const state = { file: null, file_id: null, polling: null };

function $(id) { return document.getElementById(id); }

function attachUploadHandlers() {
  const fileInput = $('fileInput');
  const btn = $('btnVisualiser');
  const tolSelect = $('toleranceSelect');

  if (!fileInput || !btn) {
    console.error('[ui] IDs manquants (#fileInput ou #btnVisualiser)');
    return;
  }

  fileInput.addEventListener('change', e => {
    state.file = e.target.files?.[0] || null;
    console.info('[upload] fichier sélectionné:', state.file?.name);
  });

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!state.file) { alert('Choisis un fichier .stp/.step'); return; }
    btn.disabled = true; btn.textContent = 'Envoi…';

    try {
      const tol = tolSelect?.value || 'standard';
      const fd = new FormData();
      fd.append('file', state.file);
      fd.append('tolerance', tol);

      console.info('[upload] POST /upload');
      const r = await fetch('/upload', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      console.info('[upload] réponse', j);

      if (!r.ok) throw new Error(j?.error || ('HTTP ' + r.status));
      state.file_id = j.file_id;

      if (j.xkt_url) {
        btn.textContent = 'Affichage…';
        await loadXKT(j.xkt_url);
        btn.textContent = 'Prêt';
        return;
      }

      btn.textContent = 'Conversion…';
      await pollStatus(state.file_id, async (xkt_url) => {
        btn.textContent = 'Affichage…';
        await loadXKT(xkt_url);
        btn.textContent = 'Prêt';
      });

    } catch (err) {
      console.error('[upload] erreur', err);
      alert('Erreur upload/convert : ' + err.message);
    } finally {
      btn.disabled = false;
      if (btn.textContent !== 'Prêt') btn.textContent = 'VISUALISER';
    }
  });
}

async function pollStatus(file_id, onReady) {
  return new Promise((resolve, reject) => {
    let tries = 0, max = 80;
    async function tick() {
      tries++;
      try {
        const r = await fetch(`/convert/status?file_id=${encodeURIComponent(file_id)}`);
        const j = await r.json();
        console.info('[convert] statut', j);
        if (j.status === 'ready' && j.xkt_url) {
          onReady(j.xkt_url).then(resolve, reject);
          return;
        }
        if (j.status === 'failed') { reject(new Error('conversion failed')); return; }
        if (tries >= max) { reject(new Error('timeout')); return; }
        setTimeout(tick, 1500);
      } catch (e) { reject(e); }
    }
    tick();
  });
}

// bootstrap
(async () => {
  await startViewer();
  attachUploadHandlers();
})();

