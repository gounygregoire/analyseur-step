// ==== Uploader init (idempotent) ====
(function initUploader(){
  const uploadArea = document.getElementById('uploadArea') || document.querySelector('.upload-area');
  if (!uploadArea) return;

  // Empêche toute double initialisation
  if (uploadArea.dataset.bound === '1') return;
  uploadArea.dataset.bound = '1';

  const fileInput = document.getElementById('fileInput') || uploadArea.querySelector('input[type="file"]');
  const dropzone  = uploadArea; // notre zone d'upload fait office de dropzone
  const pickBtn   = document.getElementById('pickBtn') || uploadArea.querySelector('[data-action="pick"]');
  const fileLabel = uploadArea.querySelector('label[for="fileInput"]');
  const form      = document.getElementById('uploadForm') || document.querySelector('form#uploadForm');

  // --- Stratégie: contrôle 100% JS (recommandé)
  // Si un label existe et doit rester visible, on neutralise son comportement par défaut
  if (fileLabel) {
    fileLabel.addEventListener('click', (e) => {
      e.preventDefault();           // bloque l’ouverture implicite du picker par le label
      e.stopPropagation();
      if (fileInput) fileInput.click();
    }, { passive: false });
  }

  let dialogOpen = false;

  // Bouton "Choisir un fichier"
  if (pickBtn && fileInput) {
    pickBtn.addEventListener('click', () => {
      if (dialogOpen) return;
      dialogOpen = true;
      fileInput.click();
      setTimeout(() => dialogOpen = false, 500);
    });
  }

  // Clic dans la zone: ouvre le picker, sauf si clic sur l'input/label
  if (uploadArea && fileInput) {
    uploadArea.addEventListener('click', (e) => {
      const clickedInsideLabel = e.target && e.target.closest && e.target.closest('label[for="fileInput"]');
      if (e.target === fileInput || clickedInsideLabel) return;
      if (dialogOpen) return;
      dialogOpen = true;
      fileInput.click();
      setTimeout(() => dialogOpen = false, 500);
    });
  }

  // Réception via ouvrir fichier
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length) {
        handleFiles(fileInput.files);
      }
    });
  }

  // Drag & drop robuste
  if (dropzone) {
    ['dragenter','dragover'].forEach(ev =>
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.add('drag-over');
      }, { passive: false })
    );

    ['dragleave','drop'].forEach(ev =>
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.remove('drag-over');
      }, { passive: false })
    );

    dropzone.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFiles(files);
    }, { passive: false });
  }

  // Upload handler — conserve l’endpoint existant si déjà défini côté back
  async function handleFiles(files){
    try {
      const fd = new FormData(form || document.createElement('form'));
      [...files].forEach(f => fd.append('file', f));

      const res = await fetch('/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        const txt = await res.text().catch(()=> '');
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      const data = await res.json().catch(()=> ({}));
      console.log('Upload OK', data);
      // TODO: déclencher ta suite (affichage, redirection, analyse, etc.)
    } catch (err) {
      console.error('Upload failed', err);
      // TODO: afficher un message propre à l’utilisateur
    }
  }

  // Détection visuelle d’overlays bloquants (optionnel : log et suggestion)
  // NOTE: à activer si suspicion d’overlay
  // const rect = dropzone?.getBoundingClientRect();
  // const el = document.elementFromPoint(rect.left + 5, rect.top + 5);
  // if (el && el !== dropzone && !dropzone.contains(el)) {
  //   console.warn('Un overlay semble capter les events au-dessus de la dropzone:', el);
  // }
})();

