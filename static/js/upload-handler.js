// Gestion de l'upload et du suivi de conversion

document.addEventListener('DOMContentLoaded', function () {
    if (typeof initViewer === 'function' && typeof Viewer === 'function') {
        console.log('✅ SDK détecté, initialisation du viewer...');
        initViewer();
    } else {
        console.log('❌ Viewer non disponible, initialisation différée');
    }

    const initialModel = document.body.dataset.model;
    if (initialModel && window.viewer && typeof window.viewer.loadModel === 'function') {
        window.viewer.loadModel('/view/' + initialModel);
        document.getElementById('viewerToolsPanel')?.style.display = 'block';
        document.getElementById('dfmControls')?.style.display = 'flex';
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

    function onUploadSuccess(xktFile) {
        if (window.viewer) {
            window.viewer.loadModel('/uploads/' + xktFile);
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
                        onUploadSuccess(info.xkt_filename);
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

        const xktFile = data.xkt_filename;
        if (!xktFile) {
            console.error('xkt_filename manquant dans les données');
            return;
        }

        if (!window.viewer || typeof window.viewer.loadModel !== 'function') {
            console.error('Viewer non initialisé');
            showError("Viewer non prêt pour l'affichage 3D");
            return;
        }

        const url = '/uploads/' + xktFile;
        console.log('Loading XKT:', url);

        try {
            viewer.loadModel(url);
        } catch (err) {
            console.error('Erreur chargement modèle:', err);
            showError('Impossible de charger le modèle 3D');
        }
    }

    // La fonction showError est désormais définie globalement dans error-handler.js
});
