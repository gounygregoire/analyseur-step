// Gestion de l'upload et du suivi de conversion

document.addEventListener('DOMContentLoaded', function () {
    if (typeof Viewer === 'function' && typeof initViewer === 'function') {
        console.log('✅ SDK détecté, initialisation du viewer...');
        initViewer();
    } else {
        console.log('❌ Viewer non disponible, initialisation différée');
        const retry = setInterval(() => {
            if (typeof Viewer === 'function' && typeof initViewer === 'function') {
                console.log('🔁 SDK maintenant disponible, initialisation...');
                initViewer();
                clearInterval(retry);
            }
        }, 500);
    }

    const initialModel = document.body.dataset.model;
    if (initialModel && window.viewer && typeof window.viewer.loadModel === 'function') {
        window.viewer.loadModel('/view/' + initialModel);
        const toolsEl = document.getElementById('viewerToolsPanel');
        if (toolsEl) toolsEl.style.display = 'block';
        const dfmEl = document.getElementById('dfmControls');
        if (dfmEl) dfmEl.style.display = 'flex';
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
    const uploadArea = document.getElementById('uploadArea');

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

    if (uploadArea && fileInput) {
        uploadArea.addEventListener('click', () => {
            fileInput.click();
        });

        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('drag-over');
        });

        uploadArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
            fileInput.files = e.dataTransfer.files;
            fileInput.dispatchEvent(new Event('change'));
            form.dispatchEvent(new Event('submit', { cancelable: true }));
        });
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (progressSection) progressSection.style.display = 'block';
        if (uploadResults) uploadResults.style.display = 'none';
        if (errorAlert) errorAlert.style.display = 'none';

        const formData = new FormData(form);

        convertAndDisplay(formData);
    });

    function convertAndDisplay(formData) {
        fetch('/convert', {
            method: 'POST',
            body: formData
        })
            .then((r) => r.json())
            .then((data) => {
                if (data.success && data.url) {
                    if (progressSection) progressSection.style.display = 'none';
                    if (window.viewer) {
                        window.viewer.loadModel(data.url);
                    }
                    if (viewerToolsPanel) viewerToolsPanel.style.display = 'block';
                    if (dfmControls) dfmControls.style.display = 'flex';
                } else {
                    const msg = data.details
                        ? `${data.error || 'Erreur serveur'}: ${data.details}`
                        : data.error || 'Erreur serveur';
                    if (data.details) {
                        console.error(data.details);
                    }
                    showError(msg);
                }
            })
            .catch(() => showError('Erreur réseau'));
    }

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
            window.viewer.loadModel(url);
        } catch (err) {
            console.error('Erreur chargement modèle:', err);
            showError('Impossible de charger le modèle 3D');
        }
    }

    // La fonction showError est désormais définie globalement dans error-handler.js
});
