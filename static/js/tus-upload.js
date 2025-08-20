// Gestion de l'upload résumable via tus-js-client

(function() {
  const form = document.getElementById('uploadForm');
  if (!form) return;
  const fileInput = document.getElementById('fileInput');
  const progressSection = document.getElementById('progressSection');
  const uploadPercent = document.getElementById('uploadPercent');
  const uploadBar = document.getElementById('uploadBar');
  const uploadStats = document.getElementById('uploadStats');
  const cancelBtn = document.getElementById('cancelUpload');
  const uploadResults = document.getElementById('uploadResults');
  const errorAlert = document.getElementById('errorAlert');
  const errorMessage = document.getElementById('errorMessage');

  let currentUpload = null;
  let lastTime = 0;
  let lastUploaded = 0;

  function resetProgress() {
    progressSection.style.display = 'none';
    uploadBar.style.width = '0%';
    uploadPercent.textContent = '0%';
    uploadStats.textContent = '';
  }

  function showError(msg) {
    if (errorMessage) errorMessage.textContent = msg;
    if (errorAlert) errorAlert.style.display = 'block';
    resetProgress();
  }

  cancelBtn.addEventListener('click', function() {
    if (currentUpload) {
      currentUpload.abort();
    }
    resetProgress();
  });

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    const file = fileInput.files[0];
    if (!file) return;
    errorAlert.style.display = 'none';
    uploadResults.style.display = 'none';
    progressSection.style.display = 'block';
    lastTime = Date.now();
    lastUploaded = 0;

    const upload = new tus.Upload(file, {
      endpoint: '/tus/files',
      retryDelays: [0, 1000, 3000, 5000],
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        filename: file.name,
        filetype: file.type
      },
      onError: function(error) {
        showError(error.message);
      },
      onProgress: function(bytesUploaded, bytesTotal) {
        const pct = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
        uploadBar.style.width = pct + '%';
        uploadPercent.textContent = pct + '%';
        const now = Date.now();
        const delta = now - lastTime;
        if (delta > 0) {
          const speed = (bytesUploaded - lastUploaded) / (delta / 1000); // B/s
          const remaining = bytesTotal - bytesUploaded;
          const eta = speed > 0 ? remaining / speed : 0;
          uploadStats.textContent = `${(speed / 1024 / 1024).toFixed(2)} MB/s, ETA ${eta.toFixed(1)} s`;
          lastTime = now;
          lastUploaded = bytesUploaded;
        }
      },
      onSuccess: function() {
        const url = upload.url;
        const id = url.split('/').pop();
        fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upload_id: id })
        })
          .then(r => r.json())
          .then(data => {
            if (data && data.modelId) {
              uploadResults.style.display = 'block';
            } else {
              showError(data.error || 'Erreur serveur');
            }
          })
          .catch(() => showError('Erreur réseau'));
      }
    });

    currentUpload = upload;
    upload.start();
  });
})();
