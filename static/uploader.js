const root = document.getElementById('uploader');
if (!root) {
  console.warn('Uploader introuvable dans le DOM.');
} else {
  root.innerHTML = `
  <div class="card">
    <h3>Télécharger un fichier</h3>
    <p>Formats : .stl, .step (≤ 50 MB)</p>
    <div style="display:flex;gap:8px;align-items:center">
      <input type="file" id="fileInput" accept=".stl,.step,.stp"/>
      <button id="btnView">Visualiser</button>
      <span id="status" style="margin-left:8px;color:#666"></span>
    </div>
  </div>
`;

  const fileInput = document.getElementById('fileInput');
  const btnView = document.getElementById('btnView');
  const statusEl = document.getElementById('status');

  const resetStatus = (message, color = '#666') => {
    statusEl.textContent = message;
    statusEl.style.color = color;
  };

  const decodeError = async (res, fallbackLabel) => {
    let raw = '';
    try {
      raw = await res.text();
    } catch (_) {
      raw = '';
    }

    let message = '';
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data && typeof data.error === 'string') {
          message = data.error;
        } else {
          message = raw;
        }
      } catch (_) {
        message = raw;
      }
    }

    if (!message) {
      if (res.status === 413) {
        message = 'Fichier trop volumineux. Réduis la taille ou augmente MAX_UPLOAD_MB.';
      } else if (res.status >= 500) {
        message = 'Erreur serveur. Réessaie dans un instant.';
      } else if (res.statusText) {
        message = res.statusText;
      }
    }

    if (!message) {
      message = `${fallbackLabel} (${res.status})`;
    }

    return message.trim();
  };

  btnView.addEventListener('click', async () => {
    const f = fileInput.files?.[0];
    if (!f) {
      resetStatus("⚠️ Choisis un fichier d'abord", '#b86a00');
      return;
    }
    resetStatus('Envoi en cours…');
    btnView.disabled = true;

    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/upload?mode=view', { method: 'POST', body: fd });
      if (!res.ok) {
        const message = await decodeError(res, 'Upload échoué');
        throw new Error(message);
      }
      const data = await res.json();
      resetStatus('✅ Fichier chargé', '#0a7a0a');
      window.__lastUpload = data; // {file_id, xkt_url, step_name}
      if (window.loadXKT) window.loadXKT(data.xkt_url);
    } catch (e) {
      console.error(e);
      const message = e instanceof Error && e.message ? e.message : 'Erreur réseau';
      resetStatus(`❌ ${message}`, '#b00020');
    } finally {
      btnView.disabled = false;
    }
  });

  const controlsRow = root.querySelector('.card div');
  if (controlsRow) {
    const dbgBtn = document.createElement('button');
    dbgBtn.textContent = 'Forcer conversion (debug)';
    dbgBtn.style.marginLeft = '8px';
    controlsRow.appendChild(dbgBtn);

    dbgBtn.addEventListener('click', async () => {
      const up = window.__lastUpload;
      if (!up?.file_id) {
        resetStatus('⚠️ Aucun fichier à convertir', '#b86a00');
        return;
      }

      dbgBtn.disabled = true;
      try {
        resetStatus('Conversion…');
        const res = await fetch(`/api/convert/${encodeURIComponent(up.file_id)}`, {
          method: 'POST'
        });
        if (!res.ok) {
          const message = await decodeError(res, 'Conversion échouée');
          throw new Error(message);
        }

        const data = await res.json();
        resetStatus('✅ Conversion OK', '#0a7a0a');
        window.__lastUpload = { ...up, ...data };
        if (window.loadXKT) window.loadXKT(data.xkt_url);
      } catch (e) {
        console.error(e);
        const message = e instanceof Error && e.message ? e.message : 'Erreur réseau';
        resetStatus(`❌ ${message}`, '#b00020');
      } finally {
        dbgBtn.disabled = false;
      }
    });
  }
}
