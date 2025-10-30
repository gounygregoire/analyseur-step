const fi = document.getElementById('fileInput');
const btnView = document.getElementById('btnView');
const btnConvert = document.getElementById('btnConvert');
const statusEl = document.getElementById('status');

btnView.addEventListener('click', async ()=>{
  const f = fi.files?.[0];
  if(!f){ statusEl.textContent="Choisis un fichier"; return; }
  statusEl.textContent="Envoi…"; btnView.disabled=true;
  try{
    const fd = new FormData(); fd.append('file', f);
    const r = await fetch('/api/upload?mode=view', { method:'POST', body: fd });
    if(!r.ok) throw new Error(await r.text());
    window.__lastUpload = await r.json(); // {file_id, ...}
    statusEl.textContent = "Fichier reçu. Lance la conversion.";
  }catch(e){ statusEl.textContent = "❌ "+(e.message||'Upload'); }
  finally{ btnView.disabled=false; }
});

btnConvert.addEventListener('click', async ()=>{
  const up = window.__lastUpload;
  if(!up?.file_id){ statusEl.textContent="Aucun fichier"; return; }
  statusEl.textContent="Conversion…"; btnConvert.disabled=true;
  try{
    const r = await fetch(`/api/convert/${up.file_id}`, { method:'POST' });
    if(!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const fileId = data?.file_id || up.file_id;
    if (!fileId) {
      throw new Error('Réponse conversion invalide (file_id manquant)');
    }

    const url = `/xkt/${fileId}.xkt?nocache=${Date.now()}`;
    statusEl.textContent="XKT prêt. Chargement…";

    try {
      window.CADLYTICS?.xkt?.setFileId?.(fileId);
    } catch {}

    if (typeof window.forceLoadXKT === 'function') {
      window.forceLoadXKT(fileId);
    } else if (typeof window.loadXKT === 'function') {
      window.loadXKT(url);
    }
  }catch(e){ statusEl.textContent="❌ "+(e.message||'Conversion'); }
  finally{ btnConvert.disabled=false; }
});
