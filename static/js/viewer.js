console.log("✅ viewer.js bien chargé !");
console.log("handleUpload appelé !");
// 3D Viewer Application
class STEPViewer {
    constructor() {
        console.log('🧠 Viewer instancié');
        // Utility function for safe DOM access
        this.safeGetElement = (id) => {
            const element = document.getElementById(id);
            if (!element) {
                console.warn(`Element with id '${id}' not found`);
            }
            return element;
        };
        
        // Utility function for safe style setting
        this.safeSetStyle = (elementId, property, value) => {
            const element = this.safeGetElement(elementId);
            if (element && element.style) {
                element.style[property] = value;
            }
        };
        
        


        
        // Utility function for safe display setting
        this.safeSetDisplay = (elementId, display) => {
            this.safeSetStyle(elementId, 'display', display);
        };
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.currentMesh = null;
        this.isWireframe = false;
        this.axesHelper = null;
        this.axesLabels = [];
        this.showAxes = true;
        this.isDarkMode = true;
        this.measurementMode = false;
        this.measurementPoints = [];
        this.measurementLines = [];
        this.crossSectionMode = false;
        this.crossSectionPlane = null;
        this.clippingPlanes = [];
        this.currentCrossSectionAxis = 'z';
        this.showCrossSectionPlane = true;
        this.selectedDemoldingAxis = 'z'; // Initialize demolding axis
        this.setupDragAndDrop();


        
        // Initialize everything after DOM is ready
        this.initializeViewer();
        if (this.renderer) {
            this.setupEventListeners();
            this.initializeTooltips();
            this.loadConversionHistory();
        }
        this.handleFileSelect = this.handleFileSelect.bind(this);
        this.handleUpload = this.handleUpload.bind(this);
        this.setupDragAndDrop = this.setupDragAndDrop.bind(this);
    }

    async analyzeDFM(demoldingAxis = null) {
        if (!demoldingAxis) {
            const axisSelect = document.getElementById('demoldingAxisSelect');
            demoldingAxis = axisSelect?.value || 'z';
        }

        if (!this.currentConversionId) {
            alert('Aucun fichier converti disponible pour l\'analyse DFM');
            return;
        }

        this.currentDemoldingAxis = demoldingAxis;
        this.currentMaterialType = 'GENERIC';

        const dfmBtn = document.getElementById('dfmAnalyzeBtn');
        const originalText = dfmBtn.innerHTML;

        try {
            dfmBtn.innerHTML = '<i class="bi bi-gear-fill me-2"></i>Analyse en cours...';
            dfmBtn.disabled = true;

            const response = await fetch(`/api/analyze-dfm/${this.currentConversionId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    demolding_axis: demoldingAxis,
                    material_type: this.currentMaterialType
                })
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Erreur lors de l\'analyse DFM');
            }

            if (result.success && result.dfm_analysis) {
                this.displayDFMAnalysis(result.dfm_analysis);
                this.showChangeDemoldingAxisButton();
                this.enablePDFGeneration();
            }
        } catch (err) {
            const errorDisplay = document.getElementById("dfmErrorMessage");
            if (errorDisplay) {
                errorDisplay.textContent = err.message;
                errorDisplay.classList.remove("d-none");
            } else {
                alert(err.message);
            }
        } finally {
            dfmBtn.innerHTML = originalText;
            dfmBtn.disabled = false;
        }
    }
    
    initializeViewer() {
        const container = this.safeGetElement('viewer3d');
        
        if (!container) {
            console.error('Viewer container not found');
            return;
        }
        
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x2a2a2a); // Dark background with kaki theme
        
        // Camera setup
        this.camera = new THREE.PerspectiveCamera(
            75, 
            container.clientWidth / container.clientHeight, 
            0.1, 
            1000
        );
        this.camera.position.set(10, 10, 10);
        
        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({ 
            antialias: true,
            alpha: true
        });
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setClearColor(0x2a2a2a, 1); // Consistent with kaki theme
        this.renderer.shadowMap.enabled = false; // Désactiver les ombres pour améliorer les performances
        
        // Add the renderer to the container
        container.appendChild(this.renderer.domElement);
        
        // Add axes helper
        this.axesHelper = new THREE.AxesHelper(50);
        this.scene.add(this.axesHelper);
        
        // Add axes labels
        this.createAxesLabels();
        this.setupDemoldingAxisModal();
        
        // Controls setup
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;
        
        // Lighting setup
        this.setupLighting();
        
        // Start render loop
        this.animate();
        
        // Handle window resize
        window.addEventListener('resize', () => this.onWindowResize());
    }
    
    setupLighting() {
        // Ambient light
        const ambientLight = new THREE.AmbientLight(0x404040, 0.4);
        this.scene.add(ambientLight);
        
        // Main directional light (sans ombres)
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(10, 10, 5);
        directionalLight.castShadow = false; // Désactiver les ombres
        this.scene.add(directionalLight);
        
        // Fill light
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
        fillLight.position.set(-10, -10, -5);
        this.scene.add(fillLight);
        
        // Point light for highlights
        const pointLight = new THREE.PointLight(0xffffff, 0.5, 100);
        pointLight.position.set(0, 20, 0);
        this.scene.add(pointLight);
    }
    
    setupEventListeners() {
        // Upload form
        const uploadForm = this.safeGetElement('uploadForm');
        if (uploadForm) {
            uploadForm.addEventListener('submit', (e) => this.handleUpload(e));
        }
        
        // File input change
        const fileInput = this.safeGetElement('fileInput');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        }
        
        // DFM Analysis button
        const dfmAnalyzeBtn = this.safeGetElement('dfmAnalyzeBtn');
        if (dfmAnalyzeBtn) {
            dfmAnalyzeBtn.addEventListener('click', () => {
                const modalElement = document.getElementById('materialQuestionnaireModal');
                if (modalElement) {
                    const modal = new bootstrap.Modal(modalElement);
                    modal.show();
                }
            });
        }


        
        // Change demolding axis button
        const changeDemoldingAxisBtn = this.safeGetElement('changeDemoldingAxisBtn');
        if (changeDemoldingAxisBtn) {
            changeDemoldingAxisBtn.addEventListener('click', () => this.showDemoldingAxisModal());
        }
        
        // PDF Generation button
        const generatePdfBtn = this.safeGetElement('generatePdfBtn');
        if (generatePdfBtn) {
            generatePdfBtn.addEventListener('click', () => this.generatePDFReport());
        }
        
        // Viewer controls
        const resetViewBtn = this.safeGetElement('resetViewBtn');
        if (resetViewBtn) {
            resetViewBtn.addEventListener('click', () => this.resetView());
        }
        
        const toggleWireframeBtn = this.safeGetElement('toggleWireframeBtn');
        if (toggleWireframeBtn) {
            toggleWireframeBtn.addEventListener('click', () => this.toggleWireframe());
        }
        
        const toggleAxesBtn = this.safeGetElement('toggleAxesBtn');
        if (toggleAxesBtn) {
            toggleAxesBtn.addEventListener('click', () => this.toggleAxes());
        }
        
        // Theme toggle
        const themeToggleBtn = this.safeGetElement('themeToggleBtn');
        if (themeToggleBtn) {
            themeToggleBtn.addEventListener('click', () => this.toggleTheme());
        }
        
        // Measurement tools
        const measureBtn = this.safeGetElement('measureBtn');
        if (measureBtn) {
            measureBtn.addEventListener('click', () => this.toggleMeasurementMode());
        }
        
        // Cross-section button (toggle mode)
        const crossSectionBtn = this.safeGetElement('crossSectionBtn');
        if (crossSectionBtn) {
            crossSectionBtn.addEventListener('click', () => this.toggleCrossSectionMode());
        }
        
        // Cross-section dropdown items
        const crossSectionDropdown = document.querySelectorAll('[data-axis]');
        crossSectionDropdown.forEach(item => {
            item.addEventListener('click', (event) => {
                event.preventDefault();
                const axis = event.target.getAttribute('data-axis');
                this.activateCrossSectionMode(axis);
            });
        });
        
        const clearMeasurementsBtn = this.safeGetElement('clearMeasurementsBtn');
        if (clearMeasurementsBtn) {
            clearMeasurementsBtn.addEventListener('click', () => this.clearMeasurements());
        }
        
        // Mouse events for measurements
        if (this.renderer && this.renderer.domElement) {
            this.renderer.domElement.addEventListener('click', (event) => this.onMouseClick(event));
        }
        
        // History refresh button
        const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');
        if (refreshHistoryBtn) {
            refreshHistoryBtn.addEventListener('click', () => this.loadConversionHistory());
        }
    }
    
    setupDragAndDrop() {
        console.log("setupDragAndDrop appelé !");
        const dropZone = this.safeGetElement("uploadArea");
        const fileInput = this.safeGetElement("fileInput");
        const fileNameDisplay = this.safeGetElement("fileNameDisplay");

        if (!dropZone || !fileInput || !fileNameDisplay) {
            console.warn("Éléments manquants pour le drag & drop.");
            return;
        }

        dropZone.addEventListener("dragover", (event) => {
            event.preventDefault();
            dropZone.classList.add("drag-over");
        });

        dropZone.addEventListener("dragleave", () => {
            dropZone.classList.remove("drag-over");
        });

        dropZone.addEventListener("drop", (event) => {
            event.preventDefault();
            dropZone.classList.remove("drag-over");

            const files = event.dataTransfer.files;
            if (!files || files.length === 0) return;

            fileInput.files = files;

            // 🔥 Appelle la méthode de la classe pour gérer l'affichage
            this.handleFileSelect({ target: { files } });
        });

        fileInput.addEventListener("change", (e) => {
            const file = fileInput.files[0];
            if (!file) return;

            this.handleFileSelect(e);
        });
    }

    setupViewerToolsEvents() {
        // This function ensures viewer tool events are attached after the panel becomes visible
        console.log('Setting up viewer tools events...');
        
        // First remove any existing event listeners to prevent duplicates
        const oldResetBtn = this.safeGetElement('resetViewBtn');
        if (oldResetBtn) {
            const newResetBtn = oldResetBtn.cloneNode(true);
            oldResetBtn.parentNode.replaceChild(newResetBtn, oldResetBtn);
            newResetBtn.addEventListener('click', () => this.resetView());
        }
        
        const oldWireframeBtn = this.safeGetElement('toggleWireframeBtn');
        if (oldWireframeBtn) {
            const newWireframeBtn = oldWireframeBtn.cloneNode(true);
            oldWireframeBtn.parentNode.replaceChild(newWireframeBtn, oldWireframeBtn);
            newWireframeBtn.addEventListener('click', () => this.toggleWireframe());
        }
        
        const oldAxesBtn = this.safeGetElement('toggleAxesBtn');
        if (oldAxesBtn) {
            const newAxesBtn = oldAxesBtn.cloneNode(true);
            oldAxesBtn.parentNode.replaceChild(newAxesBtn, oldAxesBtn);
            newAxesBtn.addEventListener('click', () => this.toggleAxes());
        }
        
        const oldThemeBtn = this.safeGetElement('themeToggleBtn');
        if (oldThemeBtn) {
            const newThemeBtn = oldThemeBtn.cloneNode(true);
            oldThemeBtn.parentNode.replaceChild(newThemeBtn, oldThemeBtn);
            newThemeBtn.addEventListener('click', () => this.toggleTheme());
        }
        
        const oldMeasureBtn = this.safeGetElement('measureBtn');
        if (oldMeasureBtn) {
            const newMeasureBtn = oldMeasureBtn.cloneNode(true);
            oldMeasureBtn.parentNode.replaceChild(newMeasureBtn, oldMeasureBtn);
            newMeasureBtn.addEventListener('click', () => this.toggleMeasurementMode());
        }
        
        const oldCrossSectionBtn = this.safeGetElement('crossSectionBtn');
        if (oldCrossSectionBtn) {
            const newCrossSectionBtn = oldCrossSectionBtn.cloneNode(true);
            oldCrossSectionBtn.parentNode.replaceChild(newCrossSectionBtn, oldCrossSectionBtn);
            newCrossSectionBtn.addEventListener('click', () => {
                console.log('Cross-section button clicked!');
                this.toggleCrossSectionMode();
            });
            console.log('Cross-section button event attached');
        }
        
        const oldClearBtn = this.safeGetElement('clearMeasurementsBtn');
        if (oldClearBtn) {
            const newClearBtn = oldClearBtn.cloneNode(true);
            oldClearBtn.parentNode.replaceChild(newClearBtn, oldClearBtn);
            newClearBtn.addEventListener('click', () => this.clearMeasurements());
        }
        
        // Menu déroulant pour l'axe de coupe
        const axisSelect = document.getElementById('crossSectionAxisSelect');
        if (axisSelect) {
            axisSelect.addEventListener('change', (event) => {
                const newAxis = event.target.value;
                if (this.crossSectionMode && this.crossSectionAxis !== newAxis) {
                    this.createSimpleCrossSectionPlane(newAxis);
                    this.showSimpleCrossSectionInstructions();
                }
            });
        }
        
        console.log('Viewer tools events setup complete');
    }
    
    initializeTooltips() {
        // Initialize Bootstrap tooltips
        const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
        tooltipTriggerList.map(function (tooltipTriggerEl) {
            return new bootstrap.Tooltip(tooltipTriggerEl);
        });
    }
    
    handleFileSelect(event) {
        const file = event.target.files[0];
        if (file) {
            const uploadArea = document.getElementById('uploadArea');
            // Préserver l'input file en le déplaçant temporairement
            const fileInput = document.getElementById('fileInput');
            const tempContainer = document.createElement('div');
            tempContainer.appendChild(fileInput);
            
            uploadArea.innerHTML = `
                <i class="bi bi-folder-check" style="font-size: 3rem; color: var(--kaki-dark); margin-bottom: 1rem;"></i>
                <p class="mb-2" style="color: var(--brown-dark); font-weight: 600;">
                    Fichier sélectionné
                </p>
                <p class="mb-3" style="color: var(--brown-medium);">
                    ${file.name}<br>
                    <small>${this.formatFileSize(file.size)}</small>
                </p>
                <button type="button" class="btn btn-secondary btn-sm" id="changeFileBtn">
                    <i class="bi bi-arrow-repeat me-2"></i>Changer de fichier
                </button>
            `;
            
            // Réinsérer l'input file caché
            uploadArea.appendChild(fileInput);
            
            // Ajouter l'événement au nouveau bouton
            const changeFileBtn = document.getElementById('changeFileBtn');
            if (changeFileBtn) {
                changeFileBtn.addEventListener('click', () => fileInput.click());
                
            // 🔥 Ajout clé : auto-submit après sélection
            }
            this.handleUpload();
        }
    }

    formatFileSize(bytes) {
        const sizes = ['octets', 'Ko', 'Mo', 'Go'];
        if (bytes === 0) return '0 octets';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }

    validateFile() {
        const fileInputElement = this.safeGetElement('fileInput');
        
        if (!fileInputElement) {
            this.showError('Élément de sélection de fichier non trouvé');
            return false;
        }
        
        const file = fileInputElement.files[0];
        
        if (!file) {
            this.showError('Veuillez sélectionner un fichier');
            return false;
        }
        
        const fileSize = file.size / (1024 * 1024); // MB
        if (fileSize > 100) {
            this.showError('La taille du fichier dépasse la limite de 100 Mo');
            fileInputElement.value = '';
            return false;
        }
        
        const validExtensions = ['step', 'stp'];
        const fileExtension = file.name.split('.').pop().toLowerCase();
        if (!validExtensions.includes(fileExtension)) {
            this.showError('Type de fichier invalide. Seuls les fichiers STEP (.step, .stp) sont autorisés');
            fileInputElement.value = '';
            return false;
        }
        
        return true;
    }
    
    


    async handleUpload(event) {
        if (event && event.preventDefault) {
        event.preventDefault();
        }
        if (!this.validateFile()) {
            return;
        }
        
        const formData = new FormData();
        const fileInputElement = document.getElementById('fileInput');
        const toleranceInput = document.getElementById('toleranceInput');
        
        if (!fileInputElement || !toleranceInput) {
            this.showError('Éléments du formulaire non trouvés');
            return;
        }
        
        const file = fileInputElement.files[0];
        
        // Adjust tolerance based on file size for better performance
        let tolerance = parseFloat(toleranceInput.value);
        const fileSizeMB = file.size / (1024 * 1024);
        
        // For large files, increase tolerance slightly
        if (fileSizeMB > 20) {
            tolerance = Math.min(0.5, tolerance * 1.5);
        }
        
        formData.append('file', file);
        formData.append('tolerance', tolerance);
        
        this.showProgress();
        
        // Update progress message based on file size
        const progressText = document.querySelector('#progressIndicator p.small');
        if (progressText) {
            if (fileSizeMB > 20) {
                progressText.textContent = `Fichier complexe détecté (${Math.round(fileSizeMB)} Mo). La conversion peut prendre jusqu'à 5 minutes. Merci de patienter...`;
            } else if (fileSizeMB > 10) {
                progressText.textContent = `La conversion peut prendre jusqu'à ${Math.ceil(fileSizeMB * 10)} secondes pour ce fichier de ${Math.round(fileSizeMB)} Mo.`;
            } else {
                progressText.textContent = `Conversion en cours... Cela peut prendre jusqu'à 60 secondes.`;
            }
        }
        
        try {
            // Create AbortController for timeout handling
            const controller = new AbortController();
            // Dynamic timeout based on file size - match server timeout with buffer
            // Server: 15 seconds per MB, minimum 90s, max 15 minutes (900s)
            const timeoutSeconds = Math.max(100, Math.min(920, fileSizeMB * 15 + 20));
            console.log(`Setting client timeout to ${timeoutSeconds} seconds for ${fileSizeMB}MB file`);
            const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
            
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                if (response.status === 413) {
                    throw new Error('Le fichier est trop volumineux (max 100 Mo)');
                } else if (response.status === 504) {
                    throw new Error('La conversion prend trop de temps. Essayez avec un fichier plus simple.');
                } else if (response.status === 403) {
                    // Try to get the error message from the response
                    const errorData = await response.json().catch(() => null);
                    if (errorData && errorData.error) {
                        throw new Error(errorData.error);
                    } else {
                        throw new Error('Vous n\'avez plus de crédits. Achetez des crédits ou souscrivez à un abonnement pour continuer.');
                    }
                }
                throw new Error(`Erreur serveur: ${response.status}`);
            }
            
            const result = await response.json();
            
            if (result.success) {
                this.handleUploadSuccess(result);
            } else {
                this.showError(result.error || 'Upload failed');
            }
        } catch (error) {
            console.error('Upload error:', error);
            if (error.name === 'AbortError') {
                this.showError(`La conversion dépasse le temps alloué (${Math.round(timeoutSeconds / 60)} minutes). Pour les fichiers très complexes, essayez d'augmenter la tolérance à 0.5 ou plus.`);
            } else if (error.message && error.message.includes('500')) {
                this.showError('Erreur serveur lors de la conversion. Essayez d\'augmenter la tolérance (ex: 0.5) pour simplifier le maillage.');
            } else if (error.message === 'Failed to fetch') {
                this.showError('Erreur de connexion au serveur. Veuillez vérifier que vous êtes connecté et réessayer.');
            } else {
                this.showError(error.message || 'Une erreur réseau s\'est produite pendant le téléchargement');
            }
        } finally {
            this.hideProgress();
        }
    }
    
    handleUploadSuccess(result) {
        console.log('Upload successful:', result);
        
        // Store current conversion ID for DFM analysis
        this.currentConversionId = result.file_id;

        // Check if viewer is ready
        if (result.viewer_ready === false) {
            // Hide 3D viewer and show alert message
            this.safeSetDisplay('viewer3d', 'none');
            
            // Create alert message
            const alertHtml = `
                <div class="alert alert-warning alert-dismissible fade show border-2 shadow" role="alert">
                    <h5 class="alert-heading"><i class="bi bi-exclamation-triangle-fill me-2"></i>Visualisation 3D non disponible</h5>
                    <p class="fw-bold">⚠️ Le modèle 3D ne peut pas être affiché dans le visualisateur.</p>
                    ${result.viewer_error ? `<p class="text-muted"><small><strong>Raison :</strong> ${result.viewer_error}</small></p>` : ''}
                    <hr>
                    <p class="mb-2"><strong>✅ Les fonctionnalités suivantes restent disponibles :</strong></p>
                    <ul class="mb-0">
                        <li>🔍 <strong>Analyse DFM complète</strong> (Design for Manufacturing)</li>
                        <li>📊 <strong>Calcul des dimensions et volumes</strong></li>
                        <li>📋 <strong>Recommandations de matériaux</strong></li>
                        <li>📄 <strong>Génération du rapport PDF détaillé</strong></li>
                        <li>💾 <strong>Téléchargement du package complet (ZIP)</strong></li>
                    </ul>
                    <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
                </div>
            `;
            
            // Insert alert before the viewer tools panel
            const viewerSection = document.querySelector('.viewer-section');
            if (viewerSection) {
                viewerSection.insertAdjacentHTML('afterbegin', alertHtml);
            }
            
            // Still show DFM controls and model info
            this.safeSetDisplay('viewerToolsPanel', 'block');
            this.safeSetDisplay('modelInfo', 'block');
            this.safeSetDisplay('volumeDisplay', 'none'); // Hide volume since we can't calculate it
            
            // Hide 3D viewer specific tools
            const viewerTools = ['toggleWireframeBtn', 'toggleAxesBtn', 'toggleThemeBtn', 'resetViewBtn', 
                                'toggleMeasurementBtn', 'toggleCrossSectionBtn'];
            viewerTools.forEach(toolId => {
                const tool = this.safeGetElement(toolId);
                if (tool) tool.style.display = 'none';
            });
            
        } else {
            // Normal flow: show viewer and load model
            this.safeSetDisplay('viewer3d', 'block');
            this.safeSetDisplay('viewerToolsPanel', 'block');
            
            // Re-attach event listeners for viewer tools since they were just made visible
            this.setupViewerToolsEvents();
            
            // Load and display the STL model directly
            this.loadSTLModel(`/view/${result.stl_filename}`);
            
            // Show model info
            this.safeSetDisplay('modelInfo', 'block');
            this.safeSetDisplay('volumeDisplay', 'block');
        }
        
        // Refresh history to show the new conversion
        this.loadConversionHistory();
        
        // Scroll to viewer
        const viewer3d = this.safeGetElement('viewer3d');
        if (viewer3d && result.viewer_ready !== false) {
            viewer3d.scrollIntoView({ behavior: 'smooth' });
        }
    }

    async loadSTLModel(url) {
        try {
            // Remove existing mesh
            if (this.currentMesh) {
                this.scene.remove(this.currentMesh);
            }
            
            // Show loading indicator
            this.showLoadingIndicator('Chargement du modèle 3D...');
            
            // Load STL with progress tracking and timeout handling
            const loader = new THREE.STLLoader();
            
            // Set up timeout for large file loading
            const controller = new AbortController();
            let timeoutId = setTimeout(() => {
                controller.abort();
                this.hideLoadingIndicator();
                this.showError('Timeout de chargement du modèle 3D. Le fichier est trop volumineux pour être chargé dans le navigateur.');
            }, 300000); // 5 minutes timeout for STL loading
            
            // Override the loader's XMLHttpRequest to support abort
            const originalLoad = loader.load.bind(loader);
            
            loader.load(url, (geometry) => {
                clearTimeout(timeoutId);
                // Hide loading indicator
                this.hideLoadingIndicator();
                
                // Check if geometry is too complex
                const vertexCount = geometry.attributes.position.count;
                console.log(`Model loaded with ${vertexCount} vertices`);
                
                // Apply optimizations for large models
                if (vertexCount > 1000000) {
                    console.warn('Very large model detected, applying maximum optimizations...');
                    // For extremely large models, compute normals only if needed
                    if (!geometry.attributes.normal) {
                        geometry.computeVertexNormals();
                    }
                } else if (vertexCount > 500000) {
                    console.warn('Large model detected, applying optimizations...');
                    geometry.computeVertexNormals();
                }
                
                // Center geometry but keep real scale (1:1)
                geometry.computeBoundingBox();
                const center = new THREE.Vector3();
                geometry.boundingBox.getCenter(center);
                geometry.translate(-center.x, -center.y, -center.z);
                
                // Create material - always use Lambert for consistent lighting and shadows
                let material;
                if (vertexCount > 1000000) {
                    // Lambert material for extremely large models (still has lighting/shadows)
                    material = new THREE.MeshLambertMaterial({
                        color: 0x888888,
                        side: THREE.DoubleSide
                    });
                } else if (vertexCount > 500000) {
                    // Lambert material for large models
                    material = new THREE.MeshLambertMaterial({
                        color: 0x888888,
                        side: THREE.DoubleSide
                    });
                } else {
                    // Standard material for normal models
                    material = new THREE.MeshPhysicalMaterial({
                        color: 0x888888,
                        metalness: 0.3,
                        roughness: 0.4,
                        clearcoat: 0.3,
                        clearcoatRoughness: 0.25,
                    });
                }
                
                // Create mesh
                this.currentMesh = new THREE.Mesh(geometry, material);
                this.currentMesh.castShadow = true;
                this.currentMesh.receiveShadow = true;
                
                // Add to scene
                this.scene.add(this.currentMesh);
                
                // Optimize renderer for large models
                if (vertexCount > 1000000) {
                    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
                    console.log('Renderer pixel ratio reduced to 1 for performance');
                } else if (vertexCount > 500000) {
                    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
                    console.log('Renderer pixel ratio limited to 1.5 for performance');
                }
                
                // Calculate and display volume
                this.calculateAndDisplayVolume(geometry);
                
                // Update model info
                if (this.updateModelInfo) {
                    this.updateModelInfo(url);
                }
                
                // Manage axes visibility
                if (this.manageAxesVisibility) {
                    this.manageAxesVisibility();
                }
                
                // Reset camera view
                this.resetView();
                
                console.log('STL model loaded successfully');
                
            }, (progress) => {
                // Progress callback
                if (progress.lengthComputable) {
                    const percentComplete = (progress.loaded / progress.total) * 100;
                    this.updateLoadingProgress(percentComplete);
                }
            }, (error) => {
                // Error callback
                clearTimeout(timeoutId);
                console.error('Error loading STL:', error);
                this.hideLoadingIndicator();
                
                // More specific error messages based on error type
                if (error.name === 'AbortError' || (error.message && error.message.includes('aborted'))) {
                    this.showError('Chargement annulé. Le fichier est trop volumineux pour être chargé dans le navigateur.');
                } else if (error.message && (error.message.includes('NetworkError') || error.message.includes('fetch'))) {
                    this.showError('Erreur réseau lors du chargement. Vérifiez votre connexion internet.');
                } else {
                    this.showError('Échec du chargement du modèle 3D. Le fichier pourrait être trop volumineux ou corrompu.');
                }
            });
            
        } catch (error) {
            console.error('Load STL error:', error);
            this.hideLoadingIndicator();
            this.showError('Erreur lors du chargement du modèle 3D');
        }
    }
    
    showLoadingIndicator(message = 'Chargement...') {
        // Create or update loading indicator
        let loadingDiv = document.getElementById('stlLoadingIndicator');
        if (!loadingDiv) {
            loadingDiv = document.createElement('div');
            loadingDiv.id = 'stlLoadingIndicator';
            loadingDiv.className = 'position-absolute top-50 start-50 translate-middle text-center';
            loadingDiv.style.zIndex = '1000';
            
            const viewerContainer = document.getElementById('viewer3d');
            if (viewerContainer) {
                viewerContainer.appendChild(loadingDiv);
            }
        }
        
        loadingDiv.innerHTML = `
            <div class="spinner-border text-primary mb-3" role="status">
                <span class="visually-hidden">Chargement...</span>
            </div>
            <div class="text-white bg-dark bg-opacity-75 p-2 rounded">
                <p class="mb-0">${message}</p>
                <div class="progress mt-2" style="height: 4px; display: none;" id="loadingProgressBar">
                    <div class="progress-bar" role="progressbar" style="width: 0%"></div>
                </div>
            </div>
        `;
        
        loadingDiv.style.display = 'block';
    }
    
    updateLoadingProgress(percent) {
        const progressBar = document.querySelector('#loadingProgressBar');
        const progressBarInner = document.querySelector('#loadingProgressBar .progress-bar');
        
        if (progressBar && progressBarInner) {
            progressBar.style.display = 'block';
            progressBarInner.style.width = `${percent}%`;
        }
    }
    
    hideLoadingIndicator() {
        const loadingDiv = document.getElementById('stlLoadingIndicator');
        if (loadingDiv) {
            loadingDiv.style.display = 'none';
        }
    }
    
    resetView() {
        if (this.currentMesh) {
            // Calculate bounding box for optimal camera positioning
            const box = new THREE.Box3().setFromObject(this.currentMesh);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            
            // Position camera
            const maxDim = Math.max(size.x, size.y, size.z);
            const fov = this.camera.fov * (Math.PI / 180);
            let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
            cameraZ *= 2; // Add some padding
            
            this.camera.position.set(cameraZ, cameraZ, cameraZ);
            this.camera.lookAt(center);
            this.controls.target.copy(center);
            this.controls.update();
        }
    }
    
    toggleWireframe() {
        if (this.currentMesh) {
            this.isWireframe = !this.isWireframe;
            this.currentMesh.material.wireframe = this.isWireframe;
            
            const btn = this.safeGetElement('toggleWireframeBtn');
            if (btn) {
                if (this.isWireframe) {
                    btn.innerHTML = '<i class="bi bi-square me-1"></i>Solide';
                } else {
                    btn.innerHTML = '<i class="bi bi-grid-3x3 me-1"></i>Filaire';
                }
            }
        }
    }
    
    toggleAxes() {
        if (this.axesHelper) {
            this.showAxes = !this.showAxes;
            this.axesHelper.visible = this.showAxes;
            
            // Also toggle labels visibility
            if (this.axesLabels && Array.isArray(this.axesLabels)) {
                this.axesLabels.forEach(label => {
                    label.visible = this.showAxes;
                });
            }
            
            const btn = this.safeGetElement('toggleAxesBtn');
            if (btn) {
                if (this.showAxes) {
                    btn.innerHTML = '<i class="bi bi-compass me-1"></i>Axes';
                } else {
                    btn.innerHTML = '<i class="bi bi-compass me-1"></i>Masquer axes';
                }
            }
        }
    }
    
    toggleTheme() {
        this.isDarkMode = !this.isDarkMode;
        const btn = this.safeGetElement('themeToggleBtn');
        
        // Ne changer que la couleur du viewer 3D, pas tout le thème de l'interface
        if (this.isDarkMode) {
            // Darker gray background for better contrast with 3D models
            if (this.scene) this.scene.background = new THREE.Color(0x2d2d30);
            if (this.renderer) this.renderer.setClearColor(0x2d2d30, 1);
            if (btn) btn.innerHTML = '<i class="bi bi-sun me-1"></i>Fond clair';
        } else {
            // Light gray background for better contrast with 3D models
            if (this.scene) this.scene.background = new THREE.Color(0xe8e9ea);
            if (this.renderer) this.renderer.setClearColor(0xe8e9ea, 1);
            if (btn) btn.innerHTML = '<i class="bi bi-moon me-1"></i>Fond sombre';
        }
    }
    
    showProgress() {
        this.safeSetDisplay('progressSection', 'block');
        this.safeSetDisplay('uploadResults', 'none');
        this.safeSetDisplay('errorAlert', 'none');
        const uploadBtn = this.safeGetElement('uploadBtn');
        if (uploadBtn) {
            uploadBtn.disabled = true;
        }
    }
    
    hideProgress() {
        this.safeSetDisplay('progressSection', 'none');
        const uploadBtn = this.safeGetElement('uploadBtn');
        if (uploadBtn) {
            uploadBtn.disabled = false;
        }
    }
    
    showError(message) {
        const errorMessage = this.safeGetElement('errorMessage');
        if (errorMessage) {
            errorMessage.textContent = message;
        }
        
        this.safeSetDisplay('errorAlert', 'block');
        this.safeSetDisplay('uploadResults', 'none');
        
        console.error('Error:', message);
    }
    
    formatFileSize(bytes) {
        if (bytes === 0) return '0 octets';
        const k = 1024;
        const sizes = ['octets', 'Ko', 'Mo', 'Go'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
    
    calculateAndDisplayVolume(geometry) {
        // Calculate volume using the divergence theorem (signed volume)
        let volume = 0;
        const position = geometry.attributes.position;
        
        // Iterate through triangles (3 vertices per triangle)
        for (let i = 0; i < position.count; i += 3) {
            const v0 = new THREE.Vector3(
                position.getX(i),
                position.getY(i),
                position.getZ(i)
            );
            const v1 = new THREE.Vector3(
                position.getX(i + 1),
                position.getY(i + 1),
                position.getZ(i + 1)
            );
            const v2 = new THREE.Vector3(
                position.getX(i + 2),
                position.getY(i + 2),
                position.getZ(i + 2)
            );
            
            // Calculate signed volume of tetrahedron formed by origin and triangle
            const signedVolume = v0.x * (v1.y * v2.z - v1.z * v2.y) +
                               v1.x * (v2.y * v0.z - v2.z * v0.y) +
                               v2.x * (v0.y * v1.z - v0.z * v1.y);
            
            volume += signedVolume;
        }
        
        // Divide by 6 and take absolute value
        volume = Math.abs(volume) / 6.0;
        
        // Display volume in the UI
        this.displayVolume(volume);
    }
    
    updateModelInfo(url) {
        // Update model information in the UI
        console.log('Model loaded from:', url);
    }
    
    manageAxesVisibility() {
        // Manage axes visibility based on current state
        if (this.axesHelper && this.currentMesh) {
            const box = new THREE.Box3().setFromObject(this.currentMesh);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const axesScale = maxDim * 0.5;
            
            this.axesHelper.position.copy(center);
            this.axesHelper.scale.set(axesScale, axesScale, axesScale);
            
            // Update axes labels if they exist
            if (this.axesLabels) {
                this.axesLabels.forEach((label, index) => {
                    const offset = axesScale * 1.2;
                    switch(index) {
                        case 0: // X axis
                            label.position.set(center.x + offset, center.y, center.z);
                            break;
                        case 1: // Y axis
                            label.position.set(center.x, center.y + offset, center.z);
                            break;
                        case 2: // Z axis
                            label.position.set(center.x, center.y, center.z + offset);
                            break;
                    }
                    const labelScale = maxDim * 0.1;
                    label.scale.set(labelScale, labelScale, 1);
                });
            }
        }
    }
    
    calculateSurfaceArea(axis) {
        if (!this.currentMesh) return;
        
        const geometry = this.currentMesh.geometry;
        const position = geometry.attributes.position;
        const boundingBox = new THREE.Box3().setFromObject(this.currentMesh);
        const size = boundingBox.getSize(new THREE.Vector3());
        
        let maxProjectedArea = 0;
        const triangleNormals = [];
        
        // First pass: calculate normals and find triangles facing the projection direction
        for (let i = 0; i < position.count; i += 3) {
            const v0 = new THREE.Vector3(
                position.getX(i),
                position.getY(i),
                position.getZ(i)
            );
            const v1 = new THREE.Vector3(
                position.getX(i + 1),
                position.getY(i + 1),
                position.getZ(i + 1)
            );
            const v2 = new THREE.Vector3(
                position.getX(i + 2),
                position.getY(i + 2),
                position.getZ(i + 2)
            );
            
            // Calculate triangle normal
            const edge1 = v1.clone().sub(v0);
            const edge2 = v2.clone().sub(v0);
            const normal = edge1.cross(edge2).normalize();
            
            // Calculate actual triangle area
            const triangleArea = edge1.cross(edge2).length() / 2;
            
            // Determine projection direction
            let projectionDirection;
            switch(axis) {
                case 'x':
                    projectionDirection = new THREE.Vector3(1, 0, 0);
                    break;
                case 'y':
                    projectionDirection = new THREE.Vector3(0, 1, 0);
                    break;
                case 'z':
                default:
                    projectionDirection = new THREE.Vector3(0, 0, 1);
                    break;
            }
            
            // Calculate projected area using dot product with normal
            const dot = Math.abs(normal.dot(projectionDirection));
            const projectedTriangleArea = triangleArea * dot;
            
            maxProjectedArea += projectedTriangleArea;
        }
        
        // Use bounding box dimensions as reference for axis-based surface calculation
        let axisBasedArea;
        switch(axis) {
            case 'x': // YZ plane
                axisBasedArea = size.y * size.z;
                break;
            case 'y': // XZ plane  
                axisBasedArea = size.x * size.z;
                break;
            case 'z': // XY plane
            default:
                axisBasedArea = size.x * size.y;
                break;
        }
        
        // Use the smaller of the two calculations for more accuracy
        const finalArea = Math.min(maxProjectedArea, axisBasedArea);
        
        console.log(`Axis ${axis}: Projected area = ${maxProjectedArea.toFixed(2)}, Bounding box area = ${axisBasedArea.toFixed(2)}, Final = ${finalArea.toFixed(2)}`);
        
        // Display the calculated surface area
        this.displaySurfaceArea(finalArea, axis);
    }
    
    displaySurfaceArea(area, axis) {
        const surfaceElement = document.getElementById('surfaceValue');
        const surfaceBtn = document.getElementById('surfaceBtn');
        
        if (surfaceElement && surfaceBtn) {
            // Convert from mm² to cm² (divide by 100)
            const areaInCm2 = area / 100;
            
            // Format area in cm²
            let displayText;
            if (areaInCm2 >= 10000) {
                displayText = `${(areaInCm2 / 10000).toFixed(2)} m²`;
            } else if (areaInCm2 >= 1) {
                displayText = `${areaInCm2.toFixed(1)} cm²`;
            } else {
                displayText = `${areaInCm2.toFixed(2)} cm²`;
            }
            
            surfaceElement.textContent = displayText;
            surfaceElement.className = 'badge bg-success ms-2';
            surfaceBtn.innerHTML = `Axe ${axis.toUpperCase()}`;
            surfaceBtn.classList.remove('btn-outline-secondary');
            surfaceBtn.classList.add('btn-secondary');
            
            console.log(`Surface area calculated for axis ${axis}: ${displayText}`);
        }
    }
    
    displayVolume(volume) {
        // Convert from mm³ to cm³
        const volumeInCm3 = volume / 1000;
        
        // Create or update volume display element
        let volumeDisplay = document.getElementById('volumeDisplay');
        if (!volumeDisplay) {
            volumeDisplay = document.createElement('div');
            volumeDisplay.id = 'volumeDisplay';
            volumeDisplay.className = 'alert alert-info mt-2';
            volumeDisplay.innerHTML = `
                <i class="bi bi-info-circle me-2"></i>
                <strong>Volume de la pièce :</strong> 
                <span id="volumeValue">${volumeInCm3.toFixed(1)} cm³</span>
            `;
            
            // Insert after viewer controls
            const viewerSection = document.querySelector('.card .card-body');
            viewerSection.appendChild(volumeDisplay);
        } else {
            document.getElementById('volumeValue').textContent = `${volumeInCm3.toFixed(1)} cm³`;
        }
    }
    
    displayDFMAnalysis(dfmData) {
        console.log('Displaying DFM analysis:', dfmData);
        
        // Show the DFM results section
        const dfmResultsSection = document.getElementById('dfmResultsSection');
        if (dfmResultsSection) {
            dfmResultsSection.style.display = 'block';
            console.log('DFM results section shown');
        } else {
            console.error('DFM results section not found');
            return;
        }
        
        // Get the DFM panel container
        const dfmPanel = document.getElementById('dfmAnalysisPanel');
        if (!dfmPanel) {
            console.error('DFM analysis panel not found');
            return;
        }
        console.log('DFM panel found, updating content');
        
        // Clear any existing content
        dfmPanel.innerHTML = '';
        
        // Generate the modern DFM interface
        dfmPanel.innerHTML = this.generateModernDFMInterface(dfmData);
        
        // Initialize Bootstrap tabs after HTML insertion
        setTimeout(() => {
            this.initializeDFMTabs();
        }, 100);
        
        // Show action buttons
        this.showChangeDemoldingAxisButton();
        this.enablePDFGeneration();
        
        // Afficher l'indicateur "Prêt pour injection"
        this.updateInjectionReadyIndicator(dfmData);
        
        // Afficher la checklist interactive
        this.updateMoldingChecklist(dfmData);
        
        // Mettre en évidence les défauts dans le viewer 3D
        this.highlightDefectsIn3D(dfmData);
        
        // Activer le bouton de téléchargement ZIP
        this.enableZipDownload();
        
        console.log('DFM analysis displayed successfully');
    }

    updateInjectionReadyIndicator(dfmData) {
        const indicator = document.getElementById('injectionReadyIndicator');
        const badge = document.getElementById('injectionReadyBadge');
        const icon = document.getElementById('injectionReadyIcon');
        const text = document.getElementById('injectionReadyText');
        
        if (!indicator || !badge || !icon || !text) return;
        
        // Déterminer l'état en fonction du score et des problèmes
        let status = 'green'; // Par défaut vert
        let statusText = 'Prêt pour injection';
        let badgeClass = 'bg-success';
        
        if (dfmData.score < 5 || dfmData.rating === 'critical') {
            status = 'red';
            statusText = 'Non prêt - Corrections majeures';
            badgeClass = 'bg-danger';
        } else if (dfmData.score < 7 || dfmData.rating === 'warning') {
            status = 'yellow';
            statusText = 'Prêt avec réserves';
            badgeClass = 'bg-warning';
        }
        
        // Mettre à jour l'affichage
        indicator.style.display = 'inline-block';
        badge.className = `badge fs-5 ${badgeClass}`;
        text.textContent = statusText;
        
        // Animation d'apparition
        setTimeout(() => {
            indicator.style.opacity = '0';
            indicator.style.transform = 'scale(0.8)';
            setTimeout(() => {
                indicator.style.transition = 'all 0.3s ease';
                indicator.style.opacity = '1';
                indicator.style.transform = 'scale(1)';
            }, 100);
        }, 100);
    }
    
    updateMoldingChecklist(dfmData) {
        const checklist = document.getElementById('moldingChecklist');
        const checklistItems = document.getElementById('checklistItems');
        
        if (!checklist || !checklistItems) return;
        
        // Définir les critères de la checklist
        const criteria = [
            {
                id: 'wall_thickness',
                label: 'Épaisseur de paroi correcte (0.8-4mm)',
                check: () => {
                    const wallIssues = dfmData.wall_thickness_issues || [];
                    return wallIssues.filter(i => i.severity === 'critical').length === 0;
                },
                details: () => {
                    const wallIssues = dfmData.wall_thickness_issues || [];
                    const critical = wallIssues.filter(i => i.severity === 'critical').length;
                    if (critical > 0) return `${critical} zones avec épaisseur critique`;
                    return 'Toutes les épaisseurs sont conformes';
                }
            },
            {
                id: 'draft_angles',
                label: 'Dépouilles présentes sur faces verticales',
                check: () => {
                    const geomIssues = dfmData.geometry_issues || [];
                    return geomIssues.filter(i => i.issue_type === 'no_draft_angle').length === 0;
                },
                details: () => {
                    const draftIssues = (dfmData.geometry_issues || []).filter(i => i.issue_type === 'no_draft_angle');
                    if (draftIssues.length > 0) return `${draftIssues.length} faces sans dépouille`;
                    return 'Toutes les faces ont une dépouille suffisante';
                }
            },
            {
                id: 'sharp_edges',
                label: 'Arêtes vives avec congés',
                check: () => {
                    const geomIssues = dfmData.geometry_issues || [];
                    return geomIssues.filter(i => i.issue_type === 'sharp_edge').length === 0;
                },
                details: () => {
                    const sharpEdges = (dfmData.geometry_issues || []).filter(i => i.issue_type === 'sharp_edge');
                    if (sharpEdges.length > 0) return `${sharpEdges.length} arêtes vives détectées`;
                    return 'Toutes les arêtes ont des congés';
                }
            },
            {
                id: 'undercuts',
                label: 'Absence d\'enclaves complexes',
                check: () => {
                    const geomIssues = dfmData.geometry_issues || [];
                    return geomIssues.filter(i => i.issue_type === 'deep_blind_hole').length === 0;
                },
                details: () => {
                    const undercuts = (dfmData.geometry_issues || []).filter(i => i.issue_type === 'deep_blind_hole');
                    if (undercuts.length > 0) return `${undercuts.length} enclaves détectées`;
                    return 'Aucune enclave complexe';
                }
            },
            {
                id: 'cooling_time',
                label: 'Temps de refroidissement optimal',
                check: () => {
                    const coolingTime = dfmData.dimensions?.cooling_time || 0;
                    return coolingTime < 60; // Moins de 60 secondes
                },
                details: () => {
                    const coolingTime = dfmData.dimensions?.cooling_time || 0;
                    return `Temps estimé : ${coolingTime.toFixed(1)}s`;
                }
            }
        ];
        
        // Générer le HTML de la checklist
        checklistItems.innerHTML = criteria.map(criterion => {
            const isChecked = criterion.check();
            const details = criterion.details();
            const itemClass = isChecked ? 'list-group-item-success' : 'list-group-item-danger';
            const iconClass = isChecked ? 'bi-check-circle-fill text-success' : 'bi-x-circle-fill text-danger';
            
            return `
                <div class="list-group-item list-group-item-action ${itemClass}" 
                     data-criterion="${criterion.id}" style="cursor: pointer;">
                    <div class="d-flex align-items-center">
                        <i class="bi ${iconClass} me-3 fs-4"></i>
                        <div class="flex-grow-1">
                            <div class="fw-bold">${criterion.label}</div>
                            <small class="text-muted">${details}</small>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
        // Afficher la checklist
        checklist.style.display = 'block';
        
        // Ajouter les événements de clic pour afficher plus de détails
        checklistItems.querySelectorAll('.list-group-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const criterionId = e.currentTarget.dataset.criterion;
                // Ici on pourrait ouvrir un modal avec plus de détails
                console.log('Clicked on criterion:', criterionId);
            });
        });
    }
    
    highlightDefectsIn3D(dfmData) {
        if (!this.currentMesh) return;
        
        // Stocker les données DFM pour référence
        this.currentDfmData = dfmData;
        
        // Ne pas créer de marqueurs visuels - désactivé à la demande de l'utilisateur
        // Les défauts sont maintenant uniquement visibles dans l'interface texte
        
        // Note: Le bouton défauts ne sera pas ajouté non plus
    }
    
    addDefectToggleButton() {
        // Vérifier si le bouton existe déjà
        if (document.getElementById('toggleDefectsBtn')) return;
        
        // Créer le bouton
        const toolsContainer = document.querySelector('.viewer-tools');
        if (toolsContainer) {
            const toggleBtn = document.createElement('button');
            toggleBtn.id = 'toggleDefectsBtn';
            toggleBtn.className = 'btn btn-outline-danger btn-sm';
            toggleBtn.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Défauts';
            toggleBtn.title = 'Afficher/Masquer les zones problématiques';
            
            toggleBtn.addEventListener('click', () => {
                const markers = this.scene.getObjectByName('defectMarkers');
                if (markers) {
                    markers.visible = !markers.visible;
                    toggleBtn.classList.toggle('btn-danger');
                    toggleBtn.classList.toggle('btn-outline-danger');
                }
            });
            
            toolsContainer.appendChild(toggleBtn);
        }
    }
    
    enableZipDownload() {
        const downloadBtn = document.getElementById('downloadZipBtn');
        if (downloadBtn) {
            downloadBtn.style.display = 'inline-block';
            downloadBtn.onclick = () => {
                this.downloadZipFile();
            };
        }
    }
    
    async downloadZipFile() {
        if (!this.currentConversionId) {
            alert('Aucune analyse disponible pour le téléchargement');
            return;
        }
        
        try {
            // Créer un lien de téléchargement
            const link = document.createElement('a');
            link.href = `/download/zip/${this.currentConversionId}`;
            link.download = `cadlytics_analysis_${this.currentConversionId}.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (error) {
            console.error('Error downloading ZIP:', error);
            alert('Erreur lors du téléchargement du fichier ZIP');
        }
    }
    
    initializeDFMTabs() {
        // Initialize Bootstrap tabs manually
        const tabElements = document.querySelectorAll('#dfmTabs .nav-link');
        tabElements.forEach(tabElement => {
            if (typeof bootstrap !== 'undefined' && bootstrap.Tab) {
                new bootstrap.Tab(tabElement);
            }
        });
        
        // Add click event listeners as fallback
        tabElements.forEach(tabElement => {
            tabElement.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = tabElement.getAttribute('data-bs-target');
                if (targetId) {
                    // Hide all tab panels
                    document.querySelectorAll('.tab-pane').forEach(panel => {
                        panel.classList.remove('show', 'active');
                    });
                    
                    // Remove active from all tab buttons
                    document.querySelectorAll('#dfmTabs .nav-link').forEach(btn => {
                        btn.classList.remove('active');
                    });
                    
                    // Show target panel
                    const targetPanel = document.querySelector(targetId);
                    if (targetPanel) {
                        targetPanel.classList.add('show', 'active');
                    }
                    
                    // Activate clicked tab
                    tabElement.classList.add('active');
                }
            });
        });
        
        console.log('DFM tabs initialized');
    }
    
    generateModernDFMInterface(dfmData) {
        const scoreColor = this.getScoreColor(dfmData.score);
        const ratingText = this.getDFMRatingText(dfmData.rating);
        const ratingBadgeClass = this.getRatingBadgeClass(dfmData.rating);
        
        return `
            <!-- Carte de score principal -->
            <div class="row mb-4">
                <div class="col-lg-4 mb-3">
                    <div class="dfm-score-card">
                        <div class="dfm-score-circle" style="background: linear-gradient(135deg, ${scoreColor}, ${scoreColor}aa);">
                            <div class="dfm-score-number">${dfmData.score}</div>
                            <div class="dfm-score-max">/10</div>
                        </div>
                        <div class="dfm-rating-badge ${ratingBadgeClass}">${ratingText}</div>
                        <p class="text-muted mb-0">${dfmData.issues_count} problème${dfmData.issues_count > 1 ? 's' : ''} détecté${dfmData.issues_count > 1 ? 's' : ''}</p>
                    </div>
                </div>
                
                <div class="col-lg-8">
                    <!-- Métriques principales -->
                    <div class="dfm-metrics-row">
                        <div class="dfm-metric-card">
                            <div class="dfm-metric-header">
                                <div class="dfm-metric-icon" style="background: linear-gradient(135deg, #6f42c1, #563d7c);">
                                    <i class="bi bi-rulers"></i>
                                </div>
                                <h6 class="dfm-metric-title">Dimensions</h6>
                            </div>
                            <div class="dfm-metric-value">${dfmData.dimensions.x} × ${dfmData.dimensions.y} × ${dfmData.dimensions.z}</div>
                            <div class="dfm-metric-unit">mm</div>
                        </div>
                        
                        <div class="dfm-metric-card">
                            <div class="dfm-metric-header">
                                <div class="dfm-metric-icon" style="background: linear-gradient(135deg, #20c997, #17a2b8);">
                                    <i class="bi bi-box"></i>
                                </div>
                                <h6 class="dfm-metric-title">Volume</h6>
                            </div>
                            <div class="dfm-metric-value">${this.formatVolume(dfmData.dimensions.volume)}</div>
                            <div class="dfm-metric-unit">cm³</div>
                        </div>
                        
                        <div class="dfm-metric-card">
                            <div class="dfm-metric-header">
                                <div class="dfm-metric-icon" style="background: linear-gradient(135deg, #fd7e14, #dc3545);">
                                    <i class="bi bi-layers"></i>
                                </div>
                                <h6 class="dfm-metric-title">Épaisseur max</h6>
                            </div>
                            <div class="dfm-metric-value">${dfmData.dimensions.max_wall_thickness}</div>
                            <div class="dfm-metric-unit">mm</div>
                        </div>
                        
                        <div class="dfm-metric-card">
                            <div class="dfm-metric-header">
                                <div class="dfm-metric-icon" style="background: linear-gradient(135deg, #ffc107, #fd7e14);">
                                    <i class="bi bi-clock"></i>
                                </div>
                                <h6 class="dfm-metric-title">Refroidissement</h6>
                            </div>
                            <div class="dfm-metric-value">${dfmData.dimensions.cooling_time}</div>
                            <div class="dfm-metric-unit">sec</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Surface projetée -->
            <div class="dfm-metrics-row mb-4">
                <div class="dfm-metric-card">
                    <div class="dfm-metric-header">
                        <div class="dfm-metric-icon" style="background: linear-gradient(135deg, #e83e8c, #dc3545);">
                            <i class="bi bi-aspect-ratio"></i>
                        </div>
                        <h6 class="dfm-metric-title">Surface projetée X</h6>
                    </div>
                    <div class="dfm-metric-value">${this.formatArea(dfmData.dimensions.projected_area_x)}</div>
                    <div class="dfm-metric-unit">cm²</div>
                </div>
                
                <div class="dfm-metric-card">
                    <div class="dfm-metric-header">
                        <div class="dfm-metric-icon" style="background: linear-gradient(135deg, #28a745, #20c997);">
                            <i class="bi bi-aspect-ratio-fill"></i>
                        </div>
                        <h6 class="dfm-metric-title">Surface projetée Y</h6>
                    </div>
                    <div class="dfm-metric-value">${this.formatArea(dfmData.dimensions.projected_area_y)}</div>
                    <div class="dfm-metric-unit">cm²</div>
                </div>
                
                <div class="dfm-metric-card">
                    <div class="dfm-metric-header">
                        <div class="dfm-metric-icon" style="background: linear-gradient(135deg, #007bff, #6f42c1);">
                            <i class="bi bi-bounding-box"></i>
                        </div>
                        <h6 class="dfm-metric-title">Surface projetée Z</h6>
                    </div>
                    <div class="dfm-metric-value">${this.formatArea(dfmData.dimensions.projected_area_z)}</div>
                    <div class="dfm-metric-unit">cm²</div>
                </div>
            </div>
            
            <!-- Système d'onglets -->
            <div class="dfm-tabs-container mb-4">
                <ul class="nav nav-tabs dfm-custom-tabs" id="dfmTabs" role="tablist">
                    <li class="nav-item" role="presentation">
                        <button class="nav-link active dfm-tab-btn" id="analysis-tab" data-bs-toggle="tab" data-bs-target="#analysis-panel" type="button" role="tab">
                            <i class="bi bi-gear-fill me-2"></i>Analyse Technique
                        </button>
                    </li>
                    <li class="nav-item" role="presentation">
                        <button class="nav-link dfm-tab-btn" id="materials-tab" data-bs-toggle="tab" data-bs-target="#materials-panel" type="button" role="tab">
                            <i class="bi bi-palette-fill me-2"></i>Recommandations Matériaux
                        </button>
                    </li>
                </ul>
                
                <div class="tab-content dfm-tab-content" id="dfmTabsContent">
                    <!-- Onglet Analyse Technique -->
                    <div class="tab-pane fade show active" id="analysis-panel" role="tabpanel">
                        ${this.generateAnalysisTabContent(dfmData)}
                    </div>
                    
                    <!-- Onglet Recommandations Matériaux -->
                    <div class="tab-pane fade" id="materials-panel" role="tabpanel">
                        ${this.generateMaterialsTabContent()}
                    </div>
                </div>
            </div>
        `;
    }
    
    generateAnalysisTabContent(dfmData) {
        return `
            ${this.generateIssuesSection(dfmData.wall_thickness_issues, dfmData.geometry_issues)}
            ${this.generateRecommendationsSection(dfmData.recommendations)}
        `;
    }
    
    generateMaterialsTabContent() {
        return this.generateMaterialRecommendationsSection();
    }
    
    generateIssuesSection(wallIssues, geometryIssues) {
        if (wallIssues.length === 0 && geometryIssues.length === 0) {
            return `
                <div class="dfm-issues-section">
                    <div class="dfm-issues-header">
                        <i class="bi bi-check-circle-fill text-success me-2"></i>
                        <h5 class="dfm-issues-title">Aucun problème détecté</h5>
                    </div>
                    <p class="text-muted mb-0">Votre pièce respecte les bonnes pratiques d'injection plastique.</p>
                </div>
            `;
        }
        
        let issuesHtml = `
            <div class="dfm-issues-section">
                <div class="dfm-issues-header">
                    <i class="bi bi-exclamation-triangle-fill text-warning me-2"></i>
                    <h5 class="dfm-issues-title">Problèmes détectés</h5>
                </div>
        `;
        
        // Wall thickness issues
        if (wallIssues.length > 0) {
            issuesHtml += `
                <h6 class="mt-3 mb-2"><i class="bi bi-layers me-2"></i>Épaisseur des parois</h6>
            `;
            wallIssues.forEach(issue => {
                issuesHtml += `
                    <div class="dfm-issue-item severity-${issue.severity}">
                        <div class="dfm-issue-header">
                            <span class="dfm-issue-severity">${this.getSeverityText(issue.severity)}</span>
                        </div>
                        <div class="dfm-issue-description">
                            Épaisseur ${issue.thickness}mm - ${this.getIssueTypeText(issue.issue_type)}
                        </div>
                        <div class="dfm-issue-recommendation">
                            ${this.getWallThicknessRecommendation(issue.issue_type, issue.thickness)}
                        </div>
                    </div>
                `;
            });
        }
        
        // Geometry issues
        if (geometryIssues.length > 0) {
            issuesHtml += `
                <h6 class="mt-3 mb-2"><i class="bi bi-shapes me-2"></i>Géométrie</h6>
            `;
            geometryIssues.forEach(issue => {
                issuesHtml += `
                    <div class="dfm-issue-item severity-${issue.severity}">
                        <div class="dfm-issue-header">
                            <span class="dfm-issue-severity">${this.getSeverityText(issue.severity)}</span>
                        </div>
                        <div class="dfm-issue-description">${issue.description}</div>
                        <div class="dfm-issue-recommendation">${issue.recommendation}</div>
                    </div>
                `;
            });
        }
        
        issuesHtml += `</div>`;
        return issuesHtml;
    }
    
    generateMaterialRecommendationsSection() {
        // Check both class property and global variable
        const materials = this.materialRecommendations || window.materialRecommendations || [];
        console.log('Generating material recommendations section, materials:', materials);
        
        if (!materials || materials.length === 0) {
            console.log('No material recommendations available');
            return '';
        }
        
        // Store for later use
        this.materialRecommendations = materials;
        
        return `
            <div class="dfm-materials-section mb-4">
                <div class="dfm-issues-header">
                    <i class="bi bi-palette-fill text-success me-2"></i>
                    <h5 class="dfm-issues-title">Recommandations Matériaux</h5>
                    <span class="badge bg-success ms-2">${materials.length} matériaux suggérés</span>
                </div>
                
                <div class="material-recommendations-grid">
                    ${materials.map((material, index) => `
                        <div class="material-recommendation-card">
                            <div class="material-card-header">
                                <div class="material-rank">#${index + 1}</div>
                                <div class="material-score">${Math.round(material.score)}%</div>
                            </div>
                            
                            <div class="material-name">${material.name}</div>
                            <div class="material-category">${material.category}</div>
                            
                            <div class="material-description">
                                ${material.description}
                            </div>
                            
                            <div class="material-cost-level">
                                <span class="badge ${this.getCostLevelClass(material.cost_level)}">
                                    ${this.getCostLevelText(material.cost_level)}
                                </span>
                            </div>
                            
                            <div class="material-advantages">
                                <strong>Avantages:</strong>
                                <ul>
                                    ${material.advantages.slice(0, 3).map(adv => `<li>${adv}</li>`).join('')}
                                </ul>
                            </div>
                            
                            ${material.limitations && material.limitations.length > 0 ? `
                                <div class="material-limitations">
                                    <strong>Limitations:</strong>
                                    <ul>
                                        ${material.limitations.slice(0, 2).map(lim => `<li>${lim}</li>`).join('')}
                                    </ul>
                                </div>
                            ` : ''}
                            
                            <div class="material-processing-notes">
                                <small class="text-muted">
                                    <i class="bi bi-info-circle me-1"></i>
                                    ${material.processing_notes}
                                </small>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    getCostLevelClass(costLevel) {
        const classes = {
            'economy': 'bg-success',
            'balanced': 'bg-warning text-dark',
            'premium': 'bg-danger'
        };
        return classes[costLevel] || 'bg-secondary';
    }

    getCostLevelText(costLevel) {
        const texts = {
            'economy': 'Économique',
            'balanced': 'Équilibré',
            'premium': 'Premium'
        };
        return texts[costLevel] || costLevel;
    }

    generateRecommendationsSection(recommendations) {
        if (recommendations.length === 0) return '';
        
        return `
            <div class="dfm-recommendations">
                <div class="dfm-issues-header">
                    <i class="bi bi-lightbulb-fill text-primary me-2"></i>
                    <h5 class="dfm-issues-title">Recommandations DFM</h5>
                </div>
                ${recommendations.map(rec => `
                    <div class="dfm-recommendation-item">
                        <i class="bi bi-arrow-right me-2 text-primary"></i>
                        ${rec}
                    </div>
                `).join('')}
            </div>
        `;
    }
    
    formatVolume(volume) {
        // Convert from mm³ to cm³ (divide by 1000)
        const volumeInCm3 = volume / 1000;
        
        if (volumeInCm3 >= 1000) {
            return (volumeInCm3 / 1000).toFixed(1) + 'K';
        } else if (volumeInCm3 >= 1) {
            return volumeInCm3.toFixed(1);
        } else {
            return volumeInCm3.toFixed(2);
        }
    }
    
    formatAreaShort(area) {
        // Convert from mm² to cm² (divide by 100)
        const areaInCm2 = area / 100;
        
        if (areaInCm2 >= 10000) {
            return (areaInCm2 / 10000).toFixed(1) + 'K';
        } else if (areaInCm2 >= 1) {
            return areaInCm2.toFixed(1);
        } else {
            return areaInCm2.toFixed(2);
        }
    }
    
    getSeverityText(severity) {
        const texts = {
            'critical': 'Critique',
            'warning': 'Attention',
            'info': 'Info'
        };
        return texts[severity] || severity;
    }
    
    getIssueTypeText(issueType) {
        const texts = {
            'too_thin': 'trop fine',
            'too_thick': 'trop épaisse',
            'acceptable': 'acceptable'
        };
        return texts[issueType] || issueType;
    }
    
    getWallThicknessRecommendation(issueType, thickness) {
        if (issueType === 'too_thin') {
            return `Augmenter l'épaisseur à minimum 0.8mm pour éviter les problèmes de remplissage`;
        } else if (issueType === 'too_thick') {
            return `Réduire l'épaisseur à maximum 4mm pour éviter les retassures et déformations`;
        }
        return 'Épaisseur optimale pour l\'injection plastique';
    }
    
    showDemoldingAxisModal() {
        // Show material questionnaire first
        this.showMaterialQuestionnaireModal();
    }

    showMaterialQuestionnaireModal() {
        try {
            const modalElement = document.getElementById('materialQuestionnaireModal');
            if (!modalElement) {
                console.error('Material questionnaire modal not found');
                alert('Erreur: Questionnaire matériaux non disponible');
                return;
            }
            
            const modal = new bootstrap.Modal(modalElement);
            modal.show();
            
            // Setup submit button handler
            const submitBtn = document.getElementById('submitQuestionnaire');
            if (submitBtn) {
                submitBtn.onclick = () => {
                    this.submitMaterialQuestionnaire();
                    checkCompatibility(); // ou équivalent si déjà appelé

                        // 🔽 1. Fermer le modal manuellement
                    const modalElement = document.getElementById('materialQuestionnaireModal');
                    if (modalElement) {
                        const modal = bootstrap.Modal.getInstance(modalElement);
                        if (modal) modal.hide();
                    }

                        // 🔽 2. Forcer l'affichage de l'axe si tout est rempli
                        showDemoldingAxisIfQuestionnaireFilled(); // doit déjà être définie globalement

                    document.getElementById('demoldingAxisSelect')?.classList.remove('d-none');
                    document.getElementById('startDFMAnalysis')?.classList.remove('d-none');

                        // 🔽 3. (optionnel) Scroll vers le viewer
                        document.getElementById('dfmViewerSection')?.scrollIntoView({ behavior: 'smooth' });
                    }
                };
        } catch (error) {
            console.error('Error showing material questionnaire:', error);
            // Fallback to demolding axis selection
            this.showDemoldingAxisModalFallback();
        }
    }

    showDemoldingAxisModalFallback() {
        try {
            const modalElement = document.getElementById('demoldingAxisModal');
            if (!modalElement) {
                console.error('Modal element not found');
                alert('Erreur: Interface de sélection non disponible');
                return;
            }
            
            const modal = new bootstrap.Modal(modalElement);
            modal.show();
            
            // Setup event listeners for this instance
            const axisButtons = modalElement.querySelectorAll('[data-axis]');
            axisButtons.forEach(btn => {
                btn.onclick = (e) => {
                    const axis = e.currentTarget.getAttribute('data-axis');
                    viewer.analyzeDFM(axis);
                    modal.hide();
                };
            });
        } catch (error) {
            console.error('Error showing modal:', error);
            // Fallback: direct analysis with default axis
            if (confirm('Erreur d\'interface. Utiliser l\'axe Z par défaut pour l\'analyse DFM?')) {
                viewer.analyzeDFM('z');
            }
        }
    }

    async submitMaterialQuestionnaire() {
        const form = document.getElementById('materialQuestionnaireForm');
        const formData = new FormData(form);
        
        // Validate required fields
        const application = formData.get('application');
        if (!application) {
            alert('Veuillez sélectionner un domaine d\'application');
            return;
        }
        
        // Collect form data
        const questionnaireData = {
            application: application,
            mechanical: formData.getAll('mechanical[]'),
            temperature: formData.get('temperature'),
            exposure: formData.getAll('exposure[]'),
            aesthetic: formData.getAll('aesthetic[]'),
            regulatory: formData.getAll('regulatory[]'),
            volume: formData.get('volume'),
            cost: formData.get('cost'),
            lifespan: formData.get('lifespan')
        };
        
        try {
            // Hide material questionnaire modal
            const materialModal = bootstrap.Modal.getInstance(document.getElementById('materialQuestionnaireModal'));
            materialModal.hide();
            
            // Show demolding axis modal
            this.showDemoldingAxisModalWithMaterials(questionnaireData);
            
        } catch (error) {
            console.error('Material questionnaire error:', error);
            alert(`Erreur lors de l'analyse des matériaux: ${error.message}`);
        }
    }

    showDemoldingAxisModalWithMaterials(questionnaireData) {
        try {
            const modalElement = document.getElementById('demoldingAxisModal');
            if (!modalElement) {
                console.error('Demolding axis modal not found');
                alert('Erreur: Interface de sélection d\'axe non disponible');
                return;
            }
            
            const modal = new bootstrap.Modal(modalElement);
            modal.show();
            
            // Setup event listeners with material data
            const axisButtons = modalElement.querySelectorAll('[data-axis]');
            axisButtons.forEach(btn => {
                btn.onclick = async (e) => {
                    const axis = e.currentTarget.getAttribute('data-axis');
                    modal.hide();
                    
                    // Show loading state
                    this.showDFMAnalysisLoading();
                    
                    try {
                        // Get material recommendations first
                        const response = await fetch('/api/material-recommendations', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                questionnaire: questionnaireData,
                                conversion_id: this.currentConversionId
                            })
                        });
                        
                        const result = await response.json();
                        
                        if (!response.ok) {
                            throw new Error(result.error || 'Erreur lors de l\'analyse des matériaux');
                        }
                        
                        // Store material recommendations globally
                        window.materialRecommendations = result.recommendations;
                        this.materialRecommendations = result.recommendations;
                        console.log('Material recommendations stored:', this.materialRecommendations);
                        
                        // Store the first recommended material type
                        if (result.recommendations && result.recommendations.length > 0) {
                            // Extract material type from the name (e.g., "Polypropylène (PP)" -> "PP")
                            const firstMaterial = result.recommendations[0].name;
                            const match = firstMaterial.match(/\(([^)]+)\)/);
                            if (match) {
                                this.currentMaterialType = match[1];
                            } else {
                                this.currentMaterialType = 'GENERIC';
                            }
                        }
                        
                        // Now run DFM analysis
                        await viewer.analyzeDFM(axis);
                        
                    } catch (error) {
                        console.error('Material analysis error:', error);
                        this.hideDFMAnalysisLoading();
                        alert(`Erreur lors de l'analyse: ${error.message}`);
                    }
                };
            });
        } catch (error) {
            console.error('Error showing demolding axis modal:', error);
            // Fallback: direct analysis with default axis
            if (confirm('Erreur d\'interface. Utiliser l\'axe Z par défaut pour l\'analyse DFM?')) {
                viewer.analyzeDFM('z');
            }
        }
    }

    showDFMAnalysisLoading() {
        const dfmSection = document.getElementById('dfmAnalysisSection');
        if (dfmSection) {
            dfmSection.innerHTML = `
                <div class="text-center py-5">
                    <div class="spinner-border text-primary mb-3" role="status">
                        <span class="visually-hidden">Analyse en cours...</span>
                    </div>
                    <h5>Analyse DFM et recommandations matériaux en cours...</h5>
                    <p class="text-muted">Traitement des données du questionnaire et analyse de la pièce</p>
                </div>
            `;
            dfmSection.style.display = 'block';
        }
    }

    hideDFMAnalysisLoading() {
        const dfmSection = document.getElementById('dfmAnalysisSection');
        if (dfmSection) {
            dfmSection.style.display = 'none';
        }
    }
    
    setupDemoldingAxisModal() {
        // Setup axis selection buttons
        document.addEventListener('DOMContentLoaded', () => {
            const axisButtons = document.querySelectorAll('.axis-btn');
            axisButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const axis = e.currentTarget.getAttribute('data-axis');
                    
                    // Close modal first
                    const modalElement = document.getElementById('demolding-axis-modal');
                    if (modalElement) {
                        const modal = bootstrap.Modal.getInstance(modalElement);
                        if (modal) {
                            modal.hide();
                        }
                    }
                    
                    // Start DFM analysis without creating cross-section
                    viewer.analyzeDFM(axis);
                });
            });
        });
    }
    
    
    
    showChangeDemoldingAxisButton() {
        const btn = document.getElementById('changeDemoldingAxisBtn');
        if (btn) {
            btn.style.display = 'inline-block';
        }
    }
    
    enablePDFGeneration() {
        const generatePdfBtn = document.getElementById('generatePdfBtn');
        if (generatePdfBtn) {
            generatePdfBtn.style.display = 'inline-block';
            generatePdfBtn.disabled = false;
            generatePdfBtn.innerHTML = '<i class="bi bi-file-earmark-pdf me-2"></i>Générer rapport PDF';
        }
    }
    
    getScoreColor(score) {
        if (score >= 8) return '#28a745';
        if (score >= 6) return '#17a2b8';
        if (score >= 4) return '#ffc107';
        return '#dc3545';
    }
    
    getDFMRatingText(rating) {
        switch(rating) {
            case 'excellent': return 'Excellent';
            case 'good': return 'Bon';
            case 'warning': return 'Attention';
            case 'critical': return 'Critique';
            default: return 'Inconnu';
        }
    }
    
    getRatingBadgeClass(rating) {
        switch(rating) {
            case 'excellent': return 'badge bg-success';
            case 'good': return 'badge bg-info';
            case 'warning': return 'badge bg-warning';
            case 'critical': return 'badge bg-danger';
            default: return 'badge bg-secondary';
        }
    }
    
    getSeverityClass(severity) {
        switch(severity.toLowerCase()) {
            case 'critical': return 'dfm-problem-critical';
            case 'warning': return 'dfm-problem-warning';
            default: return 'dfm-problem-info';
        }
    }

    showChangeDemoldingAxisButton() {
        const changeDemoldingAxisBtn = document.getElementById('changeDemoldingAxisBtn');
        if (changeDemoldingAxisBtn) {
            changeDemoldingAxisBtn.style.display = 'inline-block';
        }
    }
    
    enablePDFGeneration() {
        const generatePdfBtn = document.getElementById('generatePdfBtn');
        if (generatePdfBtn) {
            generatePdfBtn.style.display = 'inline-block';
            generatePdfBtn.disabled = false;
            generatePdfBtn.innerHTML = '<i class="bi bi-file-earmark-pdf me-2"></i>Générer rapport PDF';
        }
    }
    
    async generatePDFReport() {
        if (!this.currentConversionId) {
            alert('Aucune analyse DFM disponible pour la génération du rapport');
            return;
        }
        
        const pdfBtn = document.getElementById('generatePdfBtn');
        const originalText = pdfBtn.innerHTML;
        
        try {
            // Show loading state
            pdfBtn.innerHTML = '<i class="bi bi-file-earmark-pdf me-2"></i>Génération en cours...';
            pdfBtn.disabled = true;
            
            const response = await fetch(`/api/generate-pdf/${this.currentConversionId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    demolding_axis: this.currentDemoldingAxis || 'z',
                    material_type: this.currentMaterialType || 'GENERIC'
                })
            });
            
            if (!response.ok) {
                // Try to parse JSON, but handle cases where HTML is returned
                let errorMessage = 'Erreur lors de la génération du PDF';
                try {
                    const result = await response.json();
                    errorMessage = result.error || errorMessage;
                } catch (e) {
                    // If JSON parsing fails, it's probably an HTML error page
                    console.error('Failed to parse error response as JSON:', e);
                    errorMessage = `Erreur serveur (${response.status}): Veuillez réessayer`;
                }
                throw new Error(errorMessage);
            }
            
            const result = await response.json();
            
            if (result.success && result.pdf_filename) {
                // Automatically download the PDF
                const downloadLink = document.createElement('a');
                downloadLink.href = `/download-pdf/${result.pdf_filename}`;
                downloadLink.download = result.pdf_filename;
                document.body.appendChild(downloadLink);
                downloadLink.click();
                document.body.removeChild(downloadLink);
                
                // Show success message
                this.showPDFSuccess(result.message);
            }
            
        } catch (error) {
            console.error('PDF Generation error:', error);
            alert(`Erreur lors de la génération du PDF: ${error.message}`);
        } finally {
            // Restore button state
            pdfBtn.innerHTML = originalText;
            pdfBtn.disabled = false;
        }
    }
    
    showPDFSuccess(message) {
        // Create success notification
        const notification = document.createElement('div');
        notification.className = 'alert alert-success alert-dismissible fade show position-fixed';
        notification.style.cssText = 'top: 20px; right: 20px; z-index: 1050; max-width: 300px;';
        notification.innerHTML = `
            <i class="bi bi-check-circle me-2"></i>
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        
        document.body.appendChild(notification);
        
        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 5000);
    }

    getSeverityBadgeClass(severity) {
        switch(severity.toLowerCase()) {
            case 'critical': return 'bg-danger text-white';
            case 'warning': return 'bg-warning text-dark';
            case 'info': return 'bg-info text-white';
            default: return 'bg-secondary text-white';
        }
    }
    
    getWallThicknessDescription(issue) {
        const thickness = issue.thickness.toFixed(2);
        switch(issue.issue_type) {
            case 'too_thin': return `Paroi trop fine: ${thickness}mm (min. 0.8mm)`;
            case 'too_thick': return `Paroi trop épaisse: ${thickness}mm (max. 4mm)`;
            default: return `Épaisseur: ${thickness}mm`;
        }
    }

    getDFMAlertClass(rating) {
        switch(rating) {
            case 'excellent': return 'alert-success';
            case 'good': return 'alert-info';
            case 'warning': return 'alert-warning';
            case 'critical': return 'alert-danger';
            default: return 'alert-secondary';
        }
    }
    
    getScoreColor(score) {
        if (score >= 8) return '#28a745';
        if (score >= 6) return '#17a2b8';
        if (score >= 4) return '#ffc107';
        return '#dc3545';
    }
    
    getProjectedArea(dimensions) {
        // Calcule la surface projetée selon l'axe de démoulage sélectionné
        const axis = this.selectedDemoldingAxis || 'z';
        switch(axis.toLowerCase()) {
            case 'x':
                return dimensions.projected_area_x || 0;
            case 'y':
                return dimensions.projected_area_y || 0;
            case 'z':
                return dimensions.projected_area_z || 0;
            default:
                return dimensions.projected_area_z || 0;
        }
    }
    
    formatArea(area) {
        // Convert from mm² to cm² (divide by 100)
        const areaInCm2 = area / 100;
        
        // Format the area in cm²
        if (areaInCm2 < 1) {
            return `${areaInCm2.toFixed(2)} cm²`;
        } else if (areaInCm2 < 100) {
            return `${areaInCm2.toFixed(1)} cm²`;
        } else {
            return `${areaInCm2.toFixed(0)} cm²`;
        }
    }
    
    getProgressBarClass(score) {
        if (score >= 8) return 'bg-success';
        if (score >= 6) return 'bg-info';
        if (score >= 4) return 'bg-warning';
        return 'bg-danger';
    }
    
    getDFMRatingText(rating) {
        switch(rating) {
            case 'excellent': return 'Excellent';
            case 'good': return 'Bon';
            case 'warning': return 'Attention';
            case 'critical': return 'Critique';
            default: return 'Inconnu';
        }
    }

    getRatingBadgeClass(rating) {
        switch(rating) {
            case 'excellent': return 'bg-success';
            case 'good': return 'bg-primary';
            case 'warning': return 'bg-warning';
            case 'critical': return 'bg-danger';
            default: return 'bg-secondary';
        }
    }
    
    setupSurfaceCalculationListeners() {
        // Surface calculation dropdown items
        const surfaceDropdown = document.querySelectorAll('[data-surface-axis]');
        surfaceDropdown.forEach(item => {
            item.addEventListener('click', (event) => {
                event.preventDefault();
                const axis = event.target.getAttribute('data-surface-axis');
                this.calculateSurfaceArea(axis);
            });
        });
    }
    
    createAxesLabels() {
        // Create text labels for X, Y, Z axes
        const labels = ['X', 'Y', 'Z'];
        const colors = [0xff0000, 0x00ff00, 0x0000ff]; // Red, Green, Blue
        const positions = [
            new THREE.Vector3(60, 0, 0),  // X axis
            new THREE.Vector3(0, 60, 0),  // Y axis  
            new THREE.Vector3(0, 0, 60)   // Z axis
        ];
        
        labels.forEach((label, index) => {
            // Create canvas for text
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = 64;
            canvas.height = 64;
            
            // Draw text
            context.font = 'Bold 32px Arial';
            context.fillStyle = `#${colors[index].toString(16).padStart(6, '0')}`;
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(label, 32, 32);
            
            // Create texture and material
            const texture = new THREE.CanvasTexture(canvas);
            const material = new THREE.SpriteMaterial({ map: texture });
            
            // Create sprite
            const sprite = new THREE.Sprite(material);
            sprite.position.copy(positions[index]);
            sprite.scale.set(10, 10, 1);
            
            this.axesLabels.push(sprite);
            this.scene.add(sprite);
        });
    }
    
    toggleMeasurementMode() {
        this.measurementMode = !this.measurementMode;
        const btn = document.getElementById('measureBtn');
        
        if (this.measurementMode) {
            btn.classList.remove('btn-outline-primary');
            btn.classList.add('btn-primary');
            btn.innerHTML = '<i class="bi bi-rulers me-1"></i>Mesure ON';
            this.crossSectionMode = false;
            this.updateCrossSectionButton();
            this.showMeasurementInstructions();
        } else {
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-outline-primary');
            btn.innerHTML = '<i class="bi bi-rulers me-1"></i>Mesurer';
            this.hideMeasurementInstructions();
        }
    }
    
    activateCrossSectionMode(axis) {
        // Turn off measurement mode
        this.measurementMode = false;
        this.updateMeasurementButton();
        
        // Activate cross-section mode
        this.crossSectionMode = true;
        this.currentCrossSectionAxis = axis;
        this.updateCrossSectionButton();
        
        this.createCrossSectionPlane(axis);
        this.showCrossSectionInstructions(axis);
    }
    
    toggleCrossSectionMode() {
        console.log('Toggling cross-section mode, current state:', this.crossSectionMode);
        
        this.crossSectionMode = !this.crossSectionMode;
        
        if (this.crossSectionMode) {
            console.log('Activating cross-section mode');
            this.measurementMode = false;
            this.updateMeasurementButton();
            this.createSimpleCrossSectionPlane();
            this.showSimpleCrossSectionInstructions();
        } else {
            console.log('Deactivating cross-section mode');
            this.removeSimpleCrossSectionPlane();
            this.hideInstructions();
        }
        
        this.updateCrossSectionButton();
    }
    
    updateMeasurementButton() {
        const btn = document.getElementById('measureBtn');
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-outline-primary');
        btn.innerHTML = '<i class="bi bi-rulers me-1"></i>Mesurer';
    }
    
    updateCrossSectionButton() {
        const btn = document.getElementById('crossSectionBtn');
        const axisSelect = document.getElementById('crossSectionAxisSelect');
        if (!btn) return;
        
        if (this.crossSectionMode) {
            const axisName = this.crossSectionAxis ? this.crossSectionAxis.toUpperCase() : 'Z';
            btn.classList.remove('btn-outline-secondary');
            btn.classList.add('btn-warning');
            btn.style.fontWeight = 'bold';
            btn.innerHTML = `<i class="bi bi-stop-circle me-1"></i>Arrêter coupe (${axisName})`;
            btn.title = 'Mode coupe actif - Utilisez ↑↓ pour déplacer, menu pour changer d\'axe, Espace pour masquer le plan, Échap pour désactiver';
            
            // Afficher le menu déroulant
            if (axisSelect) {
                axisSelect.classList.remove('d-none');
                axisSelect.value = this.crossSectionAxis || 'z';
            }
        } else {
            btn.classList.remove('btn-warning');
            btn.classList.add('btn-outline-secondary');
            btn.style.fontWeight = 'normal';
            btn.innerHTML = '<i class="bi bi-scissors me-1"></i>Coupe 3D';
            btn.title = 'Activer la coupe transversale pour voir l\'intérieur de la pièce';
            
            // Masquer le menu déroulant
            if (axisSelect) {
                axisSelect.classList.add('d-none');
            }
        }
    }
    
    onMouseClick(event) {
        if (!this.measurementMode || !this.currentMesh) return;
        
        event.preventDefault();
        
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);
        
        // Increase precision by setting raycaster parameters
        raycaster.params.Points.threshold = 0.1;
        raycaster.params.Line.threshold = 0.1;
        
        const intersects = raycaster.intersectObject(this.currentMesh);
        
        if (intersects.length > 0) {
            // Use the closest intersection point for better precision
            const point = intersects[0].point.clone();
            
            // Snap to nearest vertex for even better precision
            const snappedPoint = this.snapToNearestVertex(point, intersects[0].object.geometry);
            this.addMeasurementPoint(snappedPoint || point);
        }
    }
    
    snapToNearestVertex(point, geometry) {
        const position = geometry.attributes.position;
        let minDistance = Infinity;
        let closestVertex = null;
        const snapThreshold = 1.0; // Adjust this value for snap sensitivity
        
        for (let i = 0; i < position.count; i++) {
            const vertex = new THREE.Vector3(
                position.getX(i),
                position.getY(i),
                position.getZ(i)
            );
            
            const distance = point.distanceTo(vertex);
            if (distance < minDistance && distance < snapThreshold) {
                minDistance = distance;
                closestVertex = vertex;
            }
        }
        
        return closestVertex;
    }
    
    addMeasurementPoint(point) {
        // Calculate appropriate point size based on model scale
        const box = new THREE.Box3().setFromObject(this.currentMesh);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const pointSize = maxDim * 0.005; // Much smaller relative size
        
        // Create point marker
        const pointGeometry = new THREE.SphereGeometry(pointSize, 12, 8);
        const pointMaterial = new THREE.MeshBasicMaterial({ 
            color: 0xff3333,
            transparent: true,
            opacity: 0.8
        });
        const pointMesh = new THREE.Mesh(pointGeometry, pointMaterial);
        pointMesh.position.copy(point);
        
        this.scene.add(pointMesh);
        this.measurementPoints.push({ point: point, mesh: pointMesh });
        
        // If we have two points, create measurement line
        if (this.measurementPoints.length === 2) {
            this.createMeasurementLine();
            this.measurementPoints = []; // Reset for next measurement
        }
    }
    
    createMeasurementLine() {
        const point1 = this.measurementPoints[0].point;
        const point2 = this.measurementPoints[1].point;
        const distance = point1.distanceTo(point2);
        
        // Create line geometry with better styling
        const lineGeometry = new THREE.BufferGeometry().setFromPoints([point1, point2]);
        const lineMaterial = new THREE.LineBasicMaterial({ 
            color: 0x00ff88,
            linewidth: 3,
            transparent: true,
            opacity: 0.9
        });
        const line = new THREE.Line(lineGeometry, lineMaterial);
        
        this.scene.add(line);
        
        // Create distance label
        const midPoint = new THREE.Vector3().addVectors(point1, point2).multiplyScalar(0.5);
        const label = this.createDistanceLabel(distance, midPoint);
        
        this.measurementLines.push({ line: line, label: label, distance: distance });
        
        // Update measurements display
        this.updateMeasurementsDisplay();
    }
    
    createDistanceLabel(distance, position) {
        // Always display in mm as requested
        const displayText = `${distance.toFixed(1)} mm`;
        
        // Create canvas for distance text with high contrast styling
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 300;
        canvas.height = 80;
        
        // Clear canvas
        context.clearRect(0, 0, canvas.width, canvas.height);
        
        // Draw bright yellow background for maximum visibility
        context.fillStyle = 'rgba(255, 255, 0, 0.95)';
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw thick black border
        context.strokeStyle = 'black';
        context.lineWidth = 4;
        context.strokeRect(0, 0, canvas.width, canvas.height);
        
        // Draw text with maximum contrast
        context.font = 'Bold 28px Arial';
        context.fillStyle = 'black';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(displayText, canvas.width / 2, canvas.height / 2);
        
        
        // Create sprite with maximum visibility settings
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ 
            map: texture,
            transparent: false,  // No transparency for better visibility
            depthTest: false,    // Always render in front
            depthWrite: false    // Don't write to depth buffer
        });
        const sprite = new THREE.Sprite(material);
        
        // Position label above the measurement line for better visibility
        const cameraDirection = new THREE.Vector3();
        this.camera.getWorldDirection(cameraDirection);
        
        // Calculate appropriate scale based on distance to camera
        const distanceToCamera = position.distanceTo(this.camera.position);
        const scale = Math.max(distanceToCamera * 0.1, 2);
        
        sprite.position.copy(position);
        // Offset label towards camera for better visibility
        sprite.position.add(cameraDirection.multiplyScalar(-scale * 0.5));
        sprite.scale.set(scale, scale * 0.4, 1);
        
        // Set high render order to ensure it's always in front
        sprite.renderOrder = 1000;
        
        this.scene.add(sprite);
        this.measurementLabels.push(sprite);
        
        return sprite;
    }
    
    createCrossSectionPlane(axis = 'z') {
        if (!this.currentMesh) return;
        
        // Remove existing plane if any
        this.removeCrossSectionPlane();
        
        // Define plane normal based on axis
        let normal;
        let rotation = new THREE.Euler(0, 0, 0);
        
        switch(axis) {
            case 'x':
                normal = new THREE.Vector3(1, 0, 0);
                rotation.set(0, Math.PI/2, 0);
                break;
            case 'y':
                normal = new THREE.Vector3(0, 1, 0);
                rotation.set(Math.PI/2, 0, 0);
                break;
            case 'z':
            default:
                normal = new THREE.Vector3(0, 0, 1);
                rotation.set(0, 0, 0);
                break;
        }
        
        // Create clipping plane
        const plane = new THREE.Plane(normal, 0);
        this.clippingPlanes = [plane];
        this.currentCrossSectionAxis = axis;
        
        // Update material to use clipping planes
        if (this.currentMesh.material) {
            this.currentMesh.material.clippingPlanes = this.clippingPlanes;
            this.currentMesh.material.needsUpdate = true;
        }
        
        // Enable local clipping
        this.renderer.localClippingEnabled = true;
        
        // Create visual representation of the plane with better styling
        const box = new THREE.Box3().setFromObject(this.currentMesh);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        
        const planeGeometry = new THREE.PlaneGeometry(maxDim * 1.5, maxDim * 1.5);
        const planeMaterial = new THREE.MeshBasicMaterial({ 
            color: 0x00ff88, 
            transparent: true, 
            opacity: 0.15,
            side: THREE.DoubleSide,
            wireframe: false
        });
        
        // Add a wireframe outline for better visibility when transparent
        const wireframeGeometry = new THREE.EdgesGeometry(planeGeometry);
        const wireframeMaterial = new THREE.LineBasicMaterial({ 
            color: 0x00ff88,
            transparent: true,
            opacity: 0.6
        });
        this.crossSectionWireframe = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
        
        this.crossSectionPlane = new THREE.Mesh(planeGeometry, planeMaterial);
        this.crossSectionPlane.position.copy(box.getCenter(new THREE.Vector3()));
        this.crossSectionPlane.rotation.copy(rotation);
        this.crossSectionPlane.visible = this.showCrossSectionPlane;
        this.scene.add(this.crossSectionPlane);
        
        // Add wireframe outline
        this.crossSectionWireframe.position.copy(this.crossSectionPlane.position);
        this.crossSectionWireframe.rotation.copy(this.crossSectionPlane.rotation);
        this.crossSectionWireframe.visible = this.showCrossSectionPlane;
        this.scene.add(this.crossSectionWireframe);
        
        // Add plane controls
        this.addCrossSectionControls();
    }
    
    addCrossSectionControls() {
        // Add keyboard controls for moving the plane
        const handleKeyDown = (event) => {
            if (!this.crossSectionMode || !this.crossSectionPlane) return;
            
            const moveStep = 1;
            const axis = this.currentCrossSectionAxis || 'z';
            
            switch(event.key) {
                case 'ArrowUp':
                    if (axis === 'x') {
                        this.crossSectionPlane.position.x += moveStep;
                        this.clippingPlanes[0].constant = -this.crossSectionPlane.position.x;
                        if (this.crossSectionWireframe) {
                            this.crossSectionWireframe.position.x = this.crossSectionPlane.position.x;
                        }
                    } else if (axis === 'y') {
                        this.crossSectionPlane.position.y += moveStep;
                        this.clippingPlanes[0].constant = -this.crossSectionPlane.position.y;
                        if (this.crossSectionWireframe) {
                            this.crossSectionWireframe.position.y = this.crossSectionPlane.position.y;
                        }
                    } else {
                        this.crossSectionPlane.position.z += moveStep;
                        this.clippingPlanes[0].constant = -this.crossSectionPlane.position.z;
                        if (this.crossSectionWireframe) {
                            this.crossSectionWireframe.position.z = this.crossSectionPlane.position.z;
                        }
                    }
                    break;
                case 'ArrowDown':
                    if (axis === 'x') {
                        this.crossSectionPlane.position.x -= moveStep;
                        this.clippingPlanes[0].constant = -this.crossSectionPlane.position.x;
                        if (this.crossSectionWireframe) {
                            this.crossSectionWireframe.position.x = this.crossSectionPlane.position.x;
                        }
                    } else if (axis === 'y') {
                        this.crossSectionPlane.position.y -= moveStep;
                        this.clippingPlanes[0].constant = -this.crossSectionPlane.position.y;
                        if (this.crossSectionWireframe) {
                            this.crossSectionWireframe.position.y = this.crossSectionPlane.position.y;
                        }
                    } else {
                        this.crossSectionPlane.position.z -= moveStep;
                        this.clippingPlanes[0].constant = -this.crossSectionPlane.position.z;
                        if (this.crossSectionWireframe) {
                            this.crossSectionWireframe.position.z = this.crossSectionPlane.position.z;
                        }
                    }
                    break;
                case ' ': // Spacebar to toggle plane visibility
                    event.preventDefault();
                    this.toggleCrossSectionPlaneVisibility();
                    break;
            }
            
            if (this.currentMesh.material) {
                this.currentMesh.material.needsUpdate = true;
            }
        };
        
        document.addEventListener('keydown', handleKeyDown);
        this.crossSectionKeyHandler = handleKeyDown;
    }
    
    removeCrossSectionPlane() {
        if (this.crossSectionPlane) {
            this.scene.remove(this.crossSectionPlane);
            this.crossSectionPlane = null;
        }
        
        if (this.crossSectionWireframe) {
            this.scene.remove(this.crossSectionWireframe);
            this.crossSectionWireframe = null;
        }
        
        if (this.currentMesh && this.currentMesh.material) {
            this.currentMesh.material.clippingPlanes = [];
            this.currentMesh.material.needsUpdate = true;
        }
        
        this.renderer.localClippingEnabled = false;
        this.clippingPlanes = [];
        
        if (this.crossSectionKeyHandler) {
            document.removeEventListener('keydown', this.crossSectionKeyHandler);
            this.crossSectionKeyHandler = null;
        }
    }
    
    clearMeasurements() {
        // Remove measurement points (including pending points)
        this.measurementPoints.forEach(point => {
            if (point.mesh) {
                this.scene.remove(point.mesh);
                point.mesh.geometry.dispose();
                point.mesh.material.dispose();
            }
        });
        this.measurementPoints = [];
        
        // Remove measurement lines and labels
        this.measurementLines.forEach(measurement => {
            if (measurement.line) {
                this.scene.remove(measurement.line);
                measurement.line.geometry.dispose();
                measurement.line.material.dispose();
            }
            if (measurement.label) {
                this.scene.remove(measurement.label);
                measurement.label.material.map.dispose();
                measurement.label.material.dispose();
            }
        });
        this.measurementLines = [];
        
        // Update display
        this.updateMeasurementsDisplay();
        
        console.log('Measurements cleared');
    }
    
    updateMeasurementsDisplay() {
        let display = document.getElementById('measurementsDisplay');
        if (!display) {
            display = document.createElement('div');
            display.id = 'measurementsDisplay';
            display.className = 'alert alert-secondary mt-2';
            display.style.display = 'none';
            
            const viewerSection = document.querySelector('.card .card-body');
            viewerSection.appendChild(display);
        }
        
        if (this.measurementLines.length > 0) {
            let html = '<i class="bi bi-rulers me-2"></i><strong>Mesures :</strong><br>';
            this.measurementLines.forEach((measurement, index) => {
                html += `Mesure ${index + 1}: ${measurement.distance.toFixed(2)} cm<br>`;
            });
            display.innerHTML = html;
            display.style.display = 'block';
        } else {
            display.style.display = 'none';
        }
    }
    
    showMeasurementInstructions() {
        this.showInstructions('Cliquez sur deux points de la pièce pour mesurer la distance');
    }
    
    toggleCrossSectionPlaneVisibility() {
        if (this.crossSectionPlane) {
            this.showCrossSectionPlane = !this.showCrossSectionPlane;
            this.crossSectionPlane.visible = this.showCrossSectionPlane;
            
            if (this.crossSectionWireframe) {
                this.crossSectionWireframe.visible = this.showCrossSectionPlane;
            }
            
            // Update instructions
            const axis = this.currentCrossSectionAxis || 'z';
            this.showCrossSectionInstructions(axis);
        }
    }
    
    showCrossSectionInstructions(axis) {
        const axisName = axis === 'x' ? 'X (YZ)' : axis === 'y' ? 'Y (XZ)' : 'Z (XY)';
        const visibilityText = this.showCrossSectionPlane ? 'ESPACE pour masquer le plan' : 'ESPACE pour afficher le plan';
        this.showInstructions(`Plan de coupe ${axisName} actif. Flèches ↑↓ pour déplacer, ${visibilityText}`);
    }
    
    hideMeasurementInstructions() {
        this.hideInstructions();
    }
    
    hideCrossSectionInstructions() {
        this.hideInstructions();
    }
    
    // Nouvelle implémentation simplifiée de la coupe transversale
    createSimpleCrossSectionPlane(axis = 'z') {
        if (!this.currentMesh) {
            console.error('No mesh available for cross-section');
            return;
        }
        
        console.log('Creating simple cross-section plane on axis:', axis);
        
        // Nettoyer les anciens plans
        this.removeSimpleCrossSectionPlane();
        
        // Sauvegarder l'axe actuel
        this.crossSectionAxis = axis || 'z';
        
        // Obtenir les dimensions de la pièce
        const box = new THREE.Box3().setFromObject(this.currentMesh);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        
        console.log('Mesh center:', center, 'Size:', size);
        
        // Créer le plan de coupe selon l'axe choisi
        let normal, planeWidth, planeHeight;
        switch(this.crossSectionAxis) {
            case 'x':
                normal = new THREE.Vector3(1, 0, 0);
                planeWidth = size.y * 1.2;
                planeHeight = size.z * 1.2;
                break;
            case 'y':
                normal = new THREE.Vector3(0, 1, 0);
                planeWidth = size.x * 1.2;
                planeHeight = size.z * 1.2;
                break;
            case 'z':
            default:
                normal = new THREE.Vector3(0, 0, 1);
                planeWidth = size.x * 1.2;
                planeHeight = size.y * 1.2;
                break;
        }
        
        const plane = new THREE.Plane(normal, 0);
        
        // Stocker le plan de coupe
        this.clippingPlanes = [plane];
        this.crossSectionPosition = 0;
        
        // Activer le clipping sur le matériau du mesh
        if (this.currentMesh.material) {
            this.currentMesh.material.clippingPlanes = this.clippingPlanes;
            this.currentMesh.material.needsUpdate = true;
            console.log('Clipping planes applied to material');
        }
        
        // Activer le clipping local dans le renderer
        this.renderer.localClippingEnabled = true;
        console.log('Local clipping enabled');
        
        // Créer une représentation visuelle du plan
        const planeGeometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
        const planeMaterial = new THREE.MeshBasicMaterial({
            color: 0xff6b35,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide
        });
        
        this.crossSectionPlane = new THREE.Mesh(planeGeometry, planeMaterial);
        
        // Orienter le plan selon l'axe
        switch(this.crossSectionAxis) {
            case 'x':
                this.crossSectionPlane.rotation.y = Math.PI / 2;
                this.crossSectionPlane.position.copy(center);
                this.crossSectionPlane.position.x = center.x + this.crossSectionPosition;
                break;
            case 'y':
                this.crossSectionPlane.rotation.x = -Math.PI / 2;
                this.crossSectionPlane.position.copy(center);
                this.crossSectionPlane.position.y = center.y + this.crossSectionPosition;
                break;
            case 'z':
                this.crossSectionPlane.position.copy(center);
                this.crossSectionPlane.position.z = center.z + this.crossSectionPosition;
                break;
        }
        
        this.scene.add(this.crossSectionPlane);
        console.log('Visual plane added to scene');
        
        // Ajouter les contrôles clavier simplifiés
        this.addSimpleCrossSectionControls();
    }
    
    addSimpleCrossSectionControls() {
        console.log('Adding simple cross-section controls');
        
        // Supprimer les anciens gestionnaires d'événements
        if (this.crossSectionKeyHandler) {
            document.removeEventListener('keydown', this.crossSectionKeyHandler);
        }
        
        this.crossSectionKeyHandler = (event) => {
            if (!this.crossSectionMode || !this.crossSectionPlane) return;
            
            const moveStep = 0.5; // Pas de déplacement plus fin
            
            switch(event.key.toLowerCase()) {
                case 'arrowup':
                    event.preventDefault();
                    this.moveCrossSectionPlane(moveStep);
                    break;
                case 'arrowdown':
                    event.preventDefault();
                    this.moveCrossSectionPlane(-moveStep);
                    break;
                case ' ': // Espace pour masquer/afficher le plan
                    event.preventDefault();
                    this.toggleCrossSectionPlaneVisibility();
                    break;

                case 'escape':
                    event.preventDefault();
                    this.toggleCrossSectionMode(); // Désactiver avec Échap
                    break;
            }
        };
        
        document.addEventListener('keydown', this.crossSectionKeyHandler);
        console.log('Keyboard controls attached');
    }
    
    moveCrossSectionPlane(step) {
        if (!this.crossSectionPlane || !this.clippingPlanes[0]) return;
        
        this.crossSectionPosition += step;
        
        // Mettre à jour la position du plan visuel selon l'axe
        const box = new THREE.Box3().setFromObject(this.currentMesh);
        const center = box.getCenter(new THREE.Vector3());
        
        switch(this.crossSectionAxis) {
            case 'x':
                this.crossSectionPlane.position.x = center.x + this.crossSectionPosition;
                break;
            case 'y':
                this.crossSectionPlane.position.y = center.y + this.crossSectionPosition;
                break;
            case 'z':
                this.crossSectionPlane.position.z = center.z + this.crossSectionPosition;
                break;
        }
        
        // Mettre à jour le plan de coupe
        this.clippingPlanes[0].constant = -this.crossSectionPosition;
        
        // Forcer la mise à jour du matériau
        if (this.currentMesh.material) {
            this.currentMesh.material.needsUpdate = true;
        }
        
        console.log('Cross-section moved to position:', this.crossSectionPosition, 'on axis:', this.crossSectionAxis);
    }
    
    removeSimpleCrossSectionPlane() {
        console.log('Removing simple cross-section plane');
        
        // Supprimer le plan visuel
        if (this.crossSectionPlane) {
            this.scene.remove(this.crossSectionPlane);
            if (this.crossSectionPlane.geometry) {
                this.crossSectionPlane.geometry.dispose();
            }
            if (this.crossSectionPlane.material) {
                this.crossSectionPlane.material.dispose();
            }
            this.crossSectionPlane = null;
        }
        
        // Désactiver le clipping
        if (this.currentMesh && this.currentMesh.material) {
            this.currentMesh.material.clippingPlanes = [];
            this.currentMesh.material.needsUpdate = true;
        }
        
        if (this.renderer) {
            this.renderer.localClippingEnabled = false;
        }
        this.clippingPlanes = [];
        
        // Supprimer les gestionnaires d'événements
        if (this.crossSectionKeyHandler) {
            document.removeEventListener('keydown', this.crossSectionKeyHandler);
            this.crossSectionKeyHandler = null;
        }
        
        console.log('Cross-section cleanup completed');
    }
    
    showSimpleCrossSectionInstructions() {
        const axisName = this.crossSectionAxis ? this.crossSectionAxis.toUpperCase() : 'Z';
        const instructionText = `
            <strong>Mode Coupe Activé - Axe ${axisName}</strong><br>
            • <kbd>↑</kbd> <kbd>↓</kbd> : Déplacer le plan de coupe<br>
            • Menu déroulant : Changer l'axe de coupe<br>
            • <kbd>Espace</kbd> : Masquer/Afficher le plan orange<br>
            • <kbd>Échap</kbd> : Désactiver la coupe
        `;
        this.showInstructions(instructionText);
    }
    
    toggleCrossSectionPlaneVisibility() {
        if (this.crossSectionPlane) {
            this.crossSectionPlane.visible = !this.crossSectionPlane.visible;
            console.log('Cross-section plane visibility:', this.crossSectionPlane.visible);
        }
    }
    
    showInstructions(text) {
        let instructions = document.getElementById('toolInstructions');
        if (!instructions) {
            instructions = document.createElement('div');
            instructions.id = 'toolInstructions';
            instructions.className = 'alert alert-primary mt-2';
            
            const viewerSection = document.querySelector('.card .card-body');
            viewerSection.appendChild(instructions);
        }
        
        instructions.innerHTML = `<i class="bi bi-info-circle me-2"></i>${text}`;
        this.safeSetStyle('toolInstructions', 'display', 'block');
    }
    
    hideInstructions() {
        this.safeSetDisplay('toolInstructions', 'none');
    }
    
    onWindowResize() {
        const container = this.safeGetElement('viewer3d');
        
        if (!container || !this.camera || !this.renderer) {
            return;
        }
        
        this.camera.aspect = container.clientWidth / container.clientHeight;
        this.camera.updateProjectionMatrix();
        
        this.renderer.setSize(container.clientWidth, container.clientHeight);
    }
    

    
    async loadConversionHistory() {
        const historyLoading = this.safeGetElement('historyLoading');
        const historyTableBody = this.safeGetElement('historyTableBody');
        
        if (!historyLoading || !historyTableBody) {
            return;
        }
        
        try {
            this.safeSetDisplay('historyLoading', 'block');
            
            const response = await fetch('/api/conversions?per_page=20');
            const data = await response.json();
            
            if (data.conversions && data.conversions.length > 0) {
                historyTableBody.innerHTML = '';
                
                data.conversions.forEach(conversion => {
                    const row = this.createHistoryRow(conversion);
                    historyTableBody.appendChild(row);
                });
            } else {
                historyTableBody.innerHTML = `
                    <tr>
                        <td colspan="6" class="text-center text-muted py-4">
                            Aucun historique de conversion disponible
                        </td>
                    </tr>
                `;
            }
        } catch (error) {
            console.error('Error loading conversion history:', error);
            historyTableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center text-danger py-4">
                        Erreur lors du chargement de l'historique des conversions
                    </td>
                </tr>
            `;
        } finally {
            this.safeSetDisplay('historyLoading', 'none');
        }
    }
    
    createHistoryRow(conversion) {
        const row = document.createElement('tr');
        
        // Status badge with DFM score
        let statusBadge = '';
        if (conversion.status === 'completed') {
            statusBadge = '<span class="badge bg-success">Terminé</span>';
            // Add DFM badge if available
            if (conversion.dfm_overall_rating && conversion.dfm_score) {
                const dfmClass = this.getDFMAlertClass(conversion.dfm_overall_rating).replace('alert-', 'bg-');
                statusBadge += ` <span class="badge ${dfmClass} ms-1">${conversion.dfm_score}/10</span>`;
            }
        } else if (conversion.status === 'failed') {
            statusBadge = '<span class="badge bg-danger">Échec</span>';
        } else {
            statusBadge = '<span class="badge bg-warning">En cours</span>';
        }
        
        // File sizes
        const stepSize = this.formatFileSize(conversion.step_file_size);
        const stlSize = conversion.stl_file_size ? this.formatFileSize(conversion.stl_file_size) : 'N/A';
        const sizeText = `${stepSize} → ${stlSize}`;
        
        // Date formatting
        const date = new Date(conversion.created_at);
        const dateText = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
        
        // Actions
        let actions = '';
        if (conversion.status === 'completed') {
            actions = `
                <button class="btn btn-sm btn-outline-primary" onclick="viewer.loadSTLFromHistory('${conversion.stl_filename}')">
                    <i class="bi bi-eye"></i>
                </button>
            `;
        } else if (conversion.status === 'failed') {
            actions = `
                <button class="btn btn-sm btn-outline-danger" onclick="alert('${conversion.error_message || 'Échec de la conversion'}')">
                    <i class="bi bi-exclamation-triangle"></i>
                </button>
            `;
        }
        
        row.innerHTML = `
            <td>
                <div class="fw-medium">${conversion.original_filename}</div>
                <small class="text-muted">${conversion.id}</small>
            </td>
            <td>${statusBadge}</td>
            <td>${conversion.tolerance}</td>
            <td>${sizeText}</td>
            <td>
                <small>${dateText}</small>
            </td>
            <td>${actions}</td>
        `;
        
        return row;
    }
    
    loadSTLFromHistory(stlFilename) {
        this.loadSTLModel(`/view/${stlFilename}`);
        document.getElementById('viewerControls').style.display = 'block';
        
        // Scroll to viewer
        document.getElementById('viewer3d').scrollIntoView({ behavior: 'smooth' });
    }

    createWallThicknessInsight(issue) {
        const insights = {
            too_thin: {
                title: "Parois trop fines",
                description: `Épaisseur de ${issue.thickness?.toFixed(2) || 'N/A'}mm détectée. Minimum recommandé: 0.8mm.`,
                causes: [
                    "Optimisation excessive du poids",
                    "Contraintes d'espace dans l'assemblage",
                    "Méconnaissance des limites de moulage"
                ],
                solutions: [
                    "Augmenter à 1.2-2.0mm pour injection standard",
                    "Ajouter des nervures de renfort",
                    "Optimiser les points d'injection",
                    "Utiliser un matériau haute fluidité"
                ],
                impact: "Remplissage incomplet, pièces fragiles, rebuts élevés"
            },
            too_thick: {
                title: "Parois trop épaisses", 
                description: `Épaisseur de ${issue.thickness?.toFixed(2) || 'N/A'}mm détectée. Maximum recommandé: 4.0mm.`,
                causes: [
                    "Sur-dimensionnement par sécurité",
                    "Contraintes mécaniques élevées",
                    "Conception issue d'usinage"
                ],
                solutions: [
                    "Réduire à 2-4mm maximum",
                    "Créer des sections creuses",
                    "Utiliser des nervures plutôt qu'épaissir",
                    "Considérer des inserts métalliques"
                ],
                impact: "Temps de cycle longs, retrait important, coûts matière"
            }
        };

        const insight = insights[issue.issue_type];
        if (!insight) return "Conseil non disponible";

        return `
            <div class="insight-tooltip text-start" style="max-width: 350px;">
                <h6 class="text-warning mb-2"><i class="bi bi-lightbulb-fill me-1"></i>${insight.title}</h6>
                <p class="mb-2 small">${insight.description}</p>
                
                <div class="mb-2">
                    <strong class="small text-info">Causes fréquentes:</strong>
                    <ul class="small mb-1 ms-3">
                        ${insight.causes.map(cause => `<li>${cause}</li>`).join('')}
                    </ul>
                </div>
                
                <div class="mb-2">
                    <strong class="small text-success">Solutions:</strong>
                    <ul class="small mb-1 ms-3">
                        ${insight.solutions.map(solution => `<li>${solution}</li>`).join('')}
                    </ul>
                </div>
                
                <div class="alert alert-warning alert-sm mb-0 p-2">
                    <small><strong>Impact:</strong> ${insight.impact}</small>
                </div>
            </div>
        `;
    }

    createGeometryInsight(issue) {
        const insights = {
            sharp_edge: {
                title: "Arêtes vives détectées",
                description: "Les arêtes vives créent des concentrations de contraintes et compliquent le démoulage.",
                solutions: [
                    "Ajouter des congés de 0.3-0.5mm minimum",
                    "Prévoir des congés plus importants sur les arêtes extérieures",
                    "Adapter selon l'épaisseur des parois",
                    "Considérer l'orientation par rapport au plan de joint"
                ],
                impact: "Usure des moules, concentrations de contraintes"
            },
            no_draft: {
                title: "Dépouille insuffisante",
                description: "Les surfaces verticales sans dépouille compliquent l'éjection et usent le moule.",
                solutions: [
                    "Ajouter 0.5-2° de dépouille sur surfaces verticales",
                    "Adapter selon la hauteur (plus haute = plus de dépouille)",
                    "Prévoir des interruptions si nécessaire",
                    "Optimiser l'orientation dans le moule"
                ],
                impact: "Force d'éjection élevée, marquage, usure moule"
            },
            deep_blind_hole: {
                title: "Trous borgnes profonds",
                description: "Rapport profondeur/diamètre > 3:1 difficile à mouler et ventiler.",
                solutions: [
                    "Limiter le rapport à 3:1 maximum",
                    "Prévoir des évents en fond de trou",
                    "Considérer des trous débouchants",
                    "Utiliser des inserts filetés pour fixations"
                ],
                impact: "Problèmes de ventilation, marques de brûlure"
            },
            excessive_height: {
                title: "Hauteur excessive",
                description: "Pièces hautes (>60mm) augmentent les risques de déformation.",
                solutions: [
                    "Diviser en plusieurs pièces plus basses",
                    "Optimiser la géométrie pour réduire la hauteur",
                    "Prévoir des nervures de rigidification",
                    "Adapter les paramètres de moulage"
                ],
                impact: "Déformations, retrait non uniforme"
            }
        };

        const insight = insights[issue.issue_type];
        if (!insight) {
            return `
                <div class="insight-tooltip text-start" style="max-width: 300px;">
                    <h6 class="text-warning mb-2"><i class="bi bi-gear-fill me-1"></i>Problème géométrique</h6>
                    <p class="mb-2 small">${issue.description}</p>
                    <div class="alert alert-info alert-sm mb-0 p-2">
                        <small><strong>Recommandation:</strong> ${issue.recommendation || 'Consulter un expert en injection plastique'}</small>
                    </div>
                </div>
            `;
        }

        return `
            <div class="insight-tooltip text-start" style="max-width: 350px;">
                <h6 class="text-warning mb-2"><i class="bi bi-gear-fill me-1"></i>${insight.title}</h6>
                <p class="mb-2 small">${insight.description}</p>
                
                <div class="mb-2">
                    <strong class="small text-success">Solutions recommandées:</strong>
                    <ul class="small mb-1 ms-3">
                        ${insight.solutions.map(solution => `<li>${solution}</li>`).join('')}
                    </ul>
                </div>
                
                <div class="alert alert-warning alert-sm mb-0 p-2">
                    <small><strong>Impact:</strong> ${insight.impact}</small>
                </div>
            </div>
        `;
    }

    initializeDFMTooltips() {
        // Initialize all tooltips in the DFM panel
        setTimeout(() => {
            const tooltipElements = document.querySelectorAll('.insight-icon[data-bs-toggle="tooltip"]');
            tooltipElements.forEach(element => {
                if (typeof bootstrap !== 'undefined') {
                    new bootstrap.Tooltip(element, {
                        html: true,
                        trigger: 'hover focus',
                        container: 'body'
                    });
                }
            });
        }, 100);
    }
}
console.log("setupDragAndDrop appelé !");
document.getElementById("uploadForm").addEventListener("submit", function(e) {
  e.preventDefault(); // ⚠️ empêche le navigateur de bloquer les effets
});
// Règles de compatibilité
const compatibilityRules = {
    mechanical: {
        stiffness: {
            conflicts: ['flexibility'],
            message: 'Rigidité élevée et flexibilité sont contradictoires'
        },
        flexibility: {
            conflicts: ['stiffness'],
            message: 'Flexibilité et rigidité élevée sont contradictoires'
        }
    },
    temperature: {
        extreme: {
            conflicts: ['flexibility'],
            message: 'Les hautes températures limitent la flexibilité'
        },
        high: {
            warnings: ['flexibility'],
            message: 'Les températures élevées peuvent affecter la flexibilité'
        }
    },
    aesthetic: {
        transparent: {
            conflicts: ['colored'],
            message: 'Transparence et colorabilité peuvent être incompatibles'
        },
        colored: {
            conflicts: ['transparent'],
            message: 'Transparence et colorabilité peuvent être incompatibles'
        }
    },
    regulatory: {
        flame_retardant: {
            conflicts: ['food_contact'],
            message: 'Les retardateurs de flamme ne sont généralement pas compatibles avec le contact alimentaire'
        },
        food_contact: {
            conflicts: ['flame_retardant'],
            message: 'Le contact alimentaire est généralement pas compatible avec les retardateurs de flamme'
        }
    },
    application: {
        medical: {
            requires: ['medical_grade'],
            message: 'Le domaine médical nécessite généralement une qualité médicale'
        },
        aerospace: {
            suggests: ['flame_retardant', 'stiffness'],
            message: 'L\'aéronautique privilégie souvent la rigidité et la résistance au feu'
        },
        toys: {
            requires: ['food_contact'],
            conflicts: ['flame_retardant'],
            message: 'Les jouets nécessitent la sécurité alimentaire et évitent les retardateurs de flamme'
        }
    }
};


// Variables pour stocker l'état
let currentSelections = {
    mechanical: [],
    aesthetic: [],
    regulatory: [],
    temperature: 'ambient',
    application: ''
};

// Fonction pour mettre à jour l'état
function updateSelections() {
    currentSelections.mechanical = Array.from(document.querySelectorAll('input[name="mechanical[]"]:checked')).map(el => el.value);
    currentSelections.aesthetic = Array.from(document.querySelectorAll('input[name="aesthetic[]"]:checked')).map(el => el.value);
    currentSelections.regulatory = Array.from(document.querySelectorAll('input[name="regulatory[]"]:checked')).map(el => el.value);

    const tempEl = document.getElementById('temperature');
    const appEl = document.querySelector('select[name="application"]');

    currentSelections.temperature = tempEl ? tempEl.value : 'ambient';
    currentSelections.application = appEl ? appEl.value : '';
}
    

// ✅ Active/désactive les options
function toggleOption(elementId, disable, reason = '') {
    const element = document.getElementById(elementId);
    if (!element) return;
    const parent = element.closest('.form-check');
    if (!parent) return;

    if (disable) {
        element.disabled = true;
        element.checked = false;
        parent.classList.add('disabled-option');
        if (reason) parent.setAttribute('title', reason);
    } else {
        element.disabled = false;
        parent.classList.remove('disabled-option');
        parent.removeAttribute('title');
    }
}

// ✅ Affiche les avertissements par catégorie
function showWarning(containerId, message) {
    const container = document.getElementById(containerId);
    const textElement = document.getElementById(containerId.replace('Warning', 'WarningText'));
    if (!container || !textElement) return;

    if (message) {
        textElement.textContent = message;
        container.style.display = 'block';
    } else {
        container.style.display = 'none';
    }
}

// Selection limits for DFM analysis
const selectionLimits = {
    mechanical: 3,
    aesthetic: 3,
    regulatory: 2
};

function showDemoldingAxisIfQuestionnaireFilled() {
    const { mechanical, aesthetic, regulatory, temperature } = currentSelections;
    const selectContainer = document.getElementById('demoldingAxisSelectContainer');

    const isFilled = (
        mechanical.length > 0 &&
        aesthetic.length > 0 &&
        regulatory.length > 0 &&
        temperature
    );

    if (selectContainer) {
        selectContainer.classList.toggle('d-none', !isFilled);
    }
}

    // ✅ Vérifie les conflits et recommandations
    function checkCompatibility() {
        updateSelections();

        const warnings = {
            mechanical: [],
            temperature: [],
            aesthetic: [],
            regulatory: [],
            application: []
        };

        const compatibilityMessages = [];

        // 1. Réinitialiser toutes les cases
        document.querySelectorAll('.form-check-input').forEach(input => {
            if (input.type === 'checkbox') {
                toggleOption(input.id, false);
            }
        });

        // 2. Vérification des règles standard
        ['mechanical', 'aesthetic', 'regulatory'].forEach(group => {
            currentSelections[group].forEach(selected => {
                const rule = compatibilityRules[group]?.[selected];
                if (rule?.conflicts) {
                    rule.conflicts.forEach(conflict => toggleOption(conflict, true, rule.message));
                    warnings[group].push(rule.message);
                }
            });

            // ✅ Vérifier le nombre maximum autorisé (par défaut 4 si pas défini)
            const max = selectionLimits[group] || 4;
            if (currentSelections[group].length > max) {
                warnings[group].push(`Trop de critères sélectionnés dans "${group}" (max ${max})`);
            }
        });

        // 3. Température
        const tempRule = compatibilityRules.temperature?.[currentSelections.temperature];
        if (tempRule) {
            if (tempRule.conflicts) {
                tempRule.conflicts.forEach(conflict => toggleOption(conflict, true, tempRule.message));
                warnings.temperature.push(tempRule.message);
            }
            if (tempRule.warnings) {
                tempRule.warnings.forEach(w => {
                    if (currentSelections.mechanical.includes(w)) {
                        warnings.temperature.push(tempRule.message);
                    }
                });
            }
        }

        // 4. Application
        const appRule = compatibilityRules.application?.[currentSelections.application];
        if (appRule) {
            if (appRule.requires) {
                appRule.requires.forEach(req => {
                    if (!currentSelections.regulatory.includes(req)) {
                        compatibilityMessages.push(`${appRule.message} - ${req} recommandé`);
                    }
                });
            }
            if (appRule.suggests) {
                compatibilityMessages.push(`${appRule.message}`);
            }
            if (appRule.conflicts) {
                appRule.conflicts.forEach(conflict => toggleOption(conflict, true, appRule.message));
                warnings.application.push(appRule.message);
            }
        }

        // 5. Affichage des avertissements
        Object.entries(warnings).forEach(([group, msgs]) => {
            const containerId = `${group}Warning`;
            showWarning(containerId, msgs.join('. '));
        });

        // 6. Affichage des suggestions (compatibilityInfo)
        const infoContainer = document.getElementById('compatibilityInfo');
        const infoText = document.getElementById('compatibilityText');
        if (compatibilityMessages.length > 0) {
            infoText.innerHTML = compatibilityMessages.map(msg => `• ${msg}`).join('<br>');
            infoContainer.style.display = 'block';
        } else {
            infoContainer.style.display = 'none';
        }
        showDemoldingAxisIfQuestionnaireFilled();
    }



// Fonction pour réinitialiser le formulaire
function resetForm() {
    document.getElementById('materialQuestionnaireForm').reset();
    document.querySelectorAll('.form-check-input').forEach(input => toggleOption(input.id, false));
    document.querySelectorAll('.warning-message').forEach(w => w.style.display = 'none');
    document.getElementById('compatibilityInfo').style.display = 'none';
}

// ✅ Événements DOM
    document.addEventListener('DOMContentLoaded', function () {
      // Évite double instanciation du viewer
      if (!window.viewer) {
        console.log('🧠 Viewer instancié depuis DOMContentLoaded');
        window.viewer = new STEPViewer();
      }

      // ✅ Écouteur sur bouton "Analyser" initial
      const analyzeBtn = document.getElementById('dfmAnalyzeBtn');
      if (analyzeBtn) {
        analyzeBtn.addEventListener('click', () => {
          // Ici, affiche la modale du questionnaire ou change la vue si tu veux
          const questionnaireModal = document.getElementById('materialQuestionnaireModal');
          if (questionnaireModal) {
            const modal = new bootstrap.Modal(questionnaireModal);
            modal.show();
          } else {
            console.error("❌ Pas de modale questionnaire trouvée.");
          }
        });
      }

      // ✅ Lancement de l’analyse après sélection d’axe
      const launchBtn = document.getElementById('startDFMAnalysis');
      const axisSelect = document.getElementById('demoldingAxisSelect');

      if (launchBtn && axisSelect) {
        launchBtn.addEventListener('click', () => {
          const axis = axisSelect.value || 'z';
          if (window.viewer && typeof window.viewer.analyzeDFM === 'function') {
            window.viewer.analyzeDFM(axis);
          } else {
            console.error("❌ viewer.analyzeDFM non défini");
          }
        });
      }
    });



    // Écouteurs pour chaque groupe de checkboxes
    ['mechanical', 'aesthetic', 'regulatory'].forEach(group => {
        document.querySelectorAll(`input[name="${group}[]"]`).forEach(cb => {
            cb.addEventListener('change', checkCompatibility);
        });
    });

    // Écouteurs pour les sélecteurs simples
    document.getElementById('temperature')?.addEventListener('change', checkCompatibility);
    document.querySelector('select[name="application"]')?.addEventListener('change', checkCompatibility);

    // Drag & drop une seule fois
    checkCompatibility();
    setupDragAndDrop();
}
}

function setupDragAndDrop() {
}

function submitForm() {
    // Votre logique d'analyse existante ici
    alert('Analyse en cours...');
}
    