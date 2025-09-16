const fi = document.getElementById('fileInput');
const btnView = document.getElementById('btnView');
const btnConvert = document.getElementById('btnConvert');
const statusEl = document.getElementById('status');

btnView.addEventListener('click', async ()=>{
  const f = fi.files?.[0]; if(!f){ statusEl.textContent="Choisis un fichier"; return; }
  statusEl.textContent="Envoi…"; btnView.disabled=true;
  try{
    const fd = new FormData(); fd.append('file', f);
    const r = await fetch('/api/upload?mode=view',{method:'POST',body:fd});
    if(!r.ok) throw new Error(await r.text());
    window.__lastUpload = await r.json();
    statusEl.textContent="Fichier reçu. Lance la conversion.";
  }catch(e){ statusEl.textContent="❌ "+(e.message||'Upload'); }
  finally{ btnView.disabled=false; }
});

btnConvert.addEventListener('click', async ()=>{
  const up = window.__lastUpload; if(!up?.file_id){ statusEl.textContent="Aucun fichier"; return; }
  statusEl.textContent="Conversion…"; btnConvert.disabled=true;
  try{
    const r = await fetch(`/api/convert/${up.file_id}`,{method:'POST'});
    if(!r.ok) throw new Error(await r.text());
    const {xkt_url} = await r.json();
    statusEl.textContent="XKT prêt. Chargement…";
    window.loadXKT && window.loadXKT(xkt_url);
  }catch(e){ statusEl.textContent="❌ "+(e.message||'Conversion'); }
  finally{ btnConvert.disabled=false; }
});
