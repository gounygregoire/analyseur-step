const fi = document.getElementById('fileInput');
const btnView = document.getElementById('btnView');
const btnConvert = document.getElementById('btnConvert');
const statusEl = document.getElementById('status');

function setStatus(message) {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

if (btnView) {
  btnView.addEventListener('click', async () => {
    const file = fi?.files?.[0];
    if (!file) {
      setStatus('Choisis un fichier');
      return;
    }
    setStatus('Envoi…');
    btnView.disabled = true;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload?mode=view', { method: 'POST', body: fd });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      window.__lastUpload = data;
      setStatus('Fichier reçu. Lance la conversion.');
    } catch (err) {
      console.error(err);
      setStatus(`❌ ${err.message || 'Erreur upload'}`);
    } finally {
      btnView.disabled = false;
    }
  });
}

if (btnConvert) {
  btnConvert.addEventListener('click', async () => {
    const upload = window.__lastUpload;
    if (!upload?.file_id) {
      setStatus('Aucun fichier à convertir');
      return;
    }
    setStatus('Conversion…');
    btnConvert.disabled = true;
    try {
      const res = await fetch(`/api/convert/${upload.file_id}`, { method: 'POST' });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      setStatus('XKT prêt. Chargement…');
      if (typeof window.loadXKT === 'function') {
        window.loadXKT(data.xkt_url);
      }
    } catch (err) {
      console.error(err);
      setStatus(`❌ ${err.message || 'Erreur conversion'}`);
    } finally {
      btnConvert.disabled = false;
    }
  });
}
