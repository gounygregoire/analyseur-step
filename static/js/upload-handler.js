// Gestion de l'upload et du suivi de conversion

document.addEventListener('DOMContentLoaded', function () {
    if (typeof initViewer === 'function') {
        initViewer();
    }

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

    function onUploadSuccess(jobId) {
        if (window.viewer) {
            window.viewer.loadModel('/view/' + jobId + '.xkt');
        }
        if (viewerToolsPanel) viewerToolsPanel.style.display = 'block';
        if (dfmControls) dfmControls.style.display = 'flex';
    }

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

        fetch('/upload_file', {
            method: 'POST',
            body: formData
        })
            .then((r) => r.json())
            .then((data) => {
                if (data.id) {
                    pollDFMResults(data.id);
                } else {
                    showError(data.error || 'Erreur serveur');
                }
            })
            .catch(() => showError('Erreur réseau'));
    });

    function pollDFMResults(jobId) {
        const interval = setInterval(() => {
            fetch(`/result/${jobId}`)
                .then((r) => r.json())
                .then((info) => {
                    if (info.status === 'dfm_done') {
                        clearInterval(interval);
                        if (progressSection) progressSection.style.display = 'none';
                        if (uploadResults) uploadResults.style.display = 'block';
                        onUploadSuccess(jobId);
                        displayDFMResults(info);
                    } else if (info.status === 'failed') {
                        clearInterval(interval);
                        showError(info.error_message || 'Analyse échouée');
                    }
                })
                .catch(() => {
                    clearInterval(interval);
                    showError('Erreur serveur');
                });
        }, 5000);
    }

    function displayDFMResults(data) {
        const dfmSection = document.getElementById('dfmResultsSection');
        if (dfmSection) dfmSection.style.display = 'block';
        console.log('Résultats DFM:', data);

        const stlFile = data.stl_filename;
        if (!stlFile) {
            console.error('stl_filename manquant dans les données');
            return;
        }

        if (!window.viewer || typeof window.viewer.loadModel !== 'function') {
            console.error('Viewer non initialisé');
            showError("Viewer non prêt pour l'affichage 3D");
            return;
        }

        const url = '/uploads/' + stlFile;
        console.log('Loading STL:', url);

        try {
            viewer.loadModel(url);
        } catch (err) {
            console.error('Erreur chargement modèle:', err);
            showError('Impossible de charger le modèle 3D');
        }
    }

    function showError(msg) {
        if (progressSection) progressSection.style.display = 'none';
        if (errorMessage) errorMessage.textContent = msg;
        if (errorAlert) errorAlert.style.display = 'block';
    }
});
