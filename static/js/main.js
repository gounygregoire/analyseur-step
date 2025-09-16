import { startViewer, loadXKT, onModelLoaded } from './viewer.js';
const state = { file:null, file_id:null };
const $ = (id)=>document.getElementById(id);

function setBtn(el, label, loading=false, disabled=false){ if(!el)return; el.textContent=label; el.disabled=!!disabled; el.dataset.loading=loading?'1':''; }
function setDrop(name){ const dz=document.querySelector('[data-dropzone]'); if(!dz)return; dz.classList.remove('is-success','is-ready','is-error'); if(name)dz.classList.add(name); }

async function uploadAndConvert(btn){
  const tol = $('toleranceSelect')?.value || 'standard';
  const fd = new FormData(); fd.append('file', state.file); fd.append('tolerance', tol);
  setBtn(btn,'Envoi…',true,true);
  const r = await fetch('/upload', { method:'POST', body:fd });
  const j = await r.json().catch(()=>({}));
  if(!r.ok){ setDrop('is-error'); setBtn(btn,'VISUALISER'); throw new Error(j?.detail||j?.error||('HTTP '+r.status)); }
  state.file_id = j.file_id; setDrop('is-success');
  const show = async (url)=>{ setBtn(btn,'Affichage…',true,true); await loadXKT(url).catch(e=>alert('Affichage impossible : '+e.message)); setBtn(btn,'Prêt'); };
  if(j.xkt_url) return show(j.xkt_url);
  setBtn(btn,'Conversion…',true,true);
  let tries=0; const max=80;
  return new Promise((res,rej)=>{ (async function tick(){
    tries++;
    try{
      const r = await fetch('/convert/status?file_id='+encodeURIComponent(state.file_id));
      const s = await r.json();
      if(s.status==='ready' && s.xkt_url){ await show(s.xkt_url); res(); return; }
      if(s.status==='failed'){ rej(new Error('conversion failed')); return; }
      if(tries>=max){ rej(new Error('timeout')); return; }
      setTimeout(tick,1500);
    }catch(e){ rej(e); }
  })(); });
}

function attachUploadHandlers(){
  const fileInput=$('fileInput'), btn=$('btnVisualiser');
  if(!fileInput||!btn){ console.error('[ui] IDs manquants (#fileInput #btnVisualiser)'); return; }
  fileInput.addEventListener('change', async e=>{
    state.file=e.target.files?.[0]||null; setDrop(null);
    if(state.file){ try{ await uploadAndConvert(btn); } catch(err){ console.error(err); alert('Upload/convert : '+err.message); } }
  });
  btn.addEventListener('click', async e=>{
    e.preventDefault(); if(!state.file){ alert('Choisis un fichier .stp/.step'); return; }
    try{ await uploadAndConvert(btn); } catch(err){ console.error(err); alert('Upload/convert : '+err.message); }
  });
}

(async()=>{ try{ await startViewer(); }catch(e){ console.error('[viewer] init error (upload dispo quand même)', e); }
  attachUploadHandlers();
  onModelLoaded(()=>{ document.documentElement.classList.add('has-model'); setDrop('is-ready'); });
})();
