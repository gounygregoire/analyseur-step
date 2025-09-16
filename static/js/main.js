import { startViewer, loadXKT, onModelLoaded } from './viewer.js';

const state = { file:null, file_id:null };
const $ = id => document.getElementById(id);

function setBtn(el, label, loading=false, disabled=false){ if(!el)return; el.textContent=label; el.disabled=!!disabled; el.dataset.loading=loading?'1':''; }
function setDrop(cls){ const dz=document.querySelector('[data-dropzone]'); if(!dz)return; dz.classList.remove('is-success','is-ready','is-error'); if(cls) dz.classList.add(cls); }

async function uploadAndConvert(btn){
  const tol = $('toleranceSelect')?.value || 'standard';
  const fd = new FormData(); fd.append('file', state.file); fd.append('tolerance', tol);

  setBtn(btn,'Envoi…',true,true);
  const r = await fetch('/upload', { method:'POST', body: fd });
  const j = await r.json().catch(()=>({}));
  if (!r.ok){ setDrop('is-error'); setBtn(btn,'VISUALISER'); throw new Error(j?.detail||j?.error||('HTTP '+r.status)); }

  state.file_id = j.file_id;
  setDrop('is-success');

  const show = async (url)=>{ setBtn(btn,'Affichage…',true,true); await startViewer().catch(()=>{}); await loadXKT(url); setBtn(btn,'Prêt'); };

  if (j.xkt_url) return show(j.xkt_url);

  // Poll convert status
  setBtn(btn,'Conversion…',true,true);
  let tries=0, max=80;
  return new Promise((resolve,reject)=>{
    (async function tick(){
      tries++;
      try{
        const rs = await fetch('/convert/status?file_id='+encodeURIComponent(state.file_id));
        const s = await rs.json();
        if (s.status==='ready' && s.xkt_url){ show(s.xkt_url).then(resolve,reject); return; }
        if (s.status==='failed'){ reject(new Error('conversion failed')); return; }
        if (tries>=max){ reject(new Error('timeout')); return; }
        setTimeout(tick, 1500);
      }catch(e){ reject(e); }
    })();
  });
}

function attachUploadHandlers(){
  const fi=$('fileInput'), btn=$('btnVisualiser');
  if (!fi || !btn){ console.error('[ui] IDs manquants (#fileInput #btnVisualiser)'); return; }
  fi.addEventListener('change', async e=>{
    state.file = e.target.files?.[0]||null; setDrop(null);
    if (state.file){ try{ await uploadAndConvert(btn); }catch(err){ console.error(err); alert('Upload/convert : '+err.message); } }
  });
  btn.addEventListener('click', async e=>{
    e.preventDefault();
    if (!state.file){ alert('Choisis un fichier .stp/.step'); return; }
    try{ await uploadAndConvert(btn); }catch(err){ console.error(err); alert('Upload/convert : '+err.message); }
  });
}

(async ()=>{
  attachUploadHandlers();
  onModelLoaded(()=>{ document.documentElement.classList.add('has-model'); setDrop('is-ready'); });
})();
