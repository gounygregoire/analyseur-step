// Gestion de l'upload et du suivi de conversion

document.addEventListener('DOMContentLoaded', function () {
    const form = document.getElementById('uploadForm');
    if (!form) return;

    const progressSection = document.getElementById('progressSection');
    const uploadResults = document.getElementById('uploadResults');
    const errorAlert = document.getElementById('errorAlert');
    const errorMessage = document.getElementById('errorMessage');
    const viewerToolsPanel = document.getElementById('viewerToolsPanel');
    const dfmControls = document.getElementById('dfmControls');
    const fileInput = document.getElementById('fileInput');
    const fileNameDisplay = document.getElementById('fileNameDisplay');

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            if (fileNameDisplay) {
                const file = fileInput.files[0];
                fileNameDisplay.textContent = file ? file.name : '';
            }
        });
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (progressSection) progressSection.style.display = 'block';
        if (uploadResults) uploadResults.style.display = 'none';
        if (errorAlert) errorAlert.style.display = 'none';

        const formData = new FormData(form);

        fetch('/upload', {
            method: 'POST',
            body: formData
        })
            .then((r) => r.json())
            .then((data) => {
                if (data.success && data.job_id) {
                    pollStatus(data.job_id);
                } else {
                    showError(data.error || 'Erreur serveur');
                }
            })
            .catch(() => showError('Erreur réseau'));
    });

    function pollStatus(jobId) {
        const interval = setInterval(() => {
            fetch(`/api/job-status/${jobId}`)
                .then((r) => r.json())
                .then((info) => {
                    if (info.status === 'completed') {
                        clearInterval(interval);
                        if (progressSection) progressSection.style.display = 'none';
                        if (uploadResults) uploadResults.style.display = 'block';
                        const filename = info.xkt_filename || info.stl_filename;
                        if (window.xeokitApp && filename) {
                            xeokitApp.loadModel('/view/' + filename);
                            if (viewerToolsPanel) viewerToolsPanel.style.display = 'block';
                            if (dfmControls) dfmControls.style.display = 'flex';
                        }
                    } else if (info.status === 'failed') {
                        clearInterval(interval);
                        showError(info.error || 'Conversion échouée');
                    }
                })
                .catch(() => {
                    clearInterval(interval);
                    showError('Erreur serveur');
                });
        }, 3000);
    }

    function showError(msg) {
        if (progressSection) progressSection.style.display = 'none';
        if (errorMessage) errorMessage.textContent = msg;
        if (errorAlert) errorAlert.style.display = 'block';
    }
});
