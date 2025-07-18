                          // ===================================================================
                          // 1️⃣ FONCTIONS PRINCIPALES DFM
                          // ===================================================================

                          window.viewer = window.viewer || {};

                          window.viewer.analyzeDFM = function(selectedAxis) {
                            console.log('🎯 Analyse DFM démarrée pour axe:', selectedAxis);

                            const analyzeBtn = document.getElementById('dfmAnalyzeBtn');
                            if (analyzeBtn) {
                              analyzeBtn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Analyse en cours...';
                              analyzeBtn.disabled = true;
                            }

                            setTimeout(() => {
                              const results = {
                                score: 72,
                                potentialScore: 85,
                                axis: selectedAxis,
                                issues: {
                                  thickness: [
                                    {
                                      zone: 'Zone_A',
                                      description: 'Épaisseur trop fine détectée (0.8mm)',
                                      currentThickness: 0.8,
                                      recommendedThickness: 1.2,
                                      severity: 'critical'
                                    }
                                  ],
                                  undercuts: [
                                    {
                                      zone: 'Zone_C',
                                      description: 'Contre-dépouille nécessitant un tiroir',
                                      impact: 'Coût élevé',
                                      complexity: 'Haute',
                                      severity: 'warning'
                                    }
                                  ],
                                  draft: [
                                    {
                                      zone: 'Zone_D',
                                      description: 'Angle de dépouille insuffisant',
                                      currentAngle: 0.5,
                                      recommendedAngle: 1.5,
                                      severity: 'warning'
                                    }
                                  ]
                                }
                              };

                              displayDFMResults(results);
                            }, 2000);
                          };

                          function displayDFMResults(results) {
                            console.log('📊 Affichage résultats DFM:', results);

                            let resultsContainer = document.getElementById('dfmResults');
                            if (!resultsContainer) {
                              resultsContainer = document.createElement('div');
                              resultsContainer.id = 'dfmResults';
                              resultsContainer.className = 'mt-4';

                              const analyzeBtn = document.getElementById('dfmAnalyzeBtn');
                              if (analyzeBtn) {
                                analyzeBtn.parentNode.insertBefore(resultsContainer, analyzeBtn.nextSibling);
                              }
                            }

                            resultsContainer.innerHTML = `
                              <div class="card mb-4">
                                <div class="card-header bg-primary text-white">
                                  <h5 class="mb-0">
                                    <i class="bi bi-clipboard-data me-2"></i>
                                    Résultats de l'analyse DFM - Axe ${results.axis}
                                  </h5>
                                </div>
                                <div class="card-body">
                                  <div class="row text-center">
                                    <div class="col-md-4">
                                      <div class="score-display">
                                        <h2 class="text-primary">${results.score}/100</h2>
                                        <p class="text-muted">Score DFM</p>
                                      </div>
                                    </div>
                                    <div class="col-md-4">
                                      <div class="score-display">
                                        <h2 class="text-success">${results.potentialScore}/100</h2>
                                        <p class="text-muted">Score potentiel</p>
                                      </div>
                                    </div>
                                    <div class="col-md-4">
                                      <div class="score-display">
                                        <h2 class="text-info">+${results.potentialScore - results.score}</h2>
                                        <p class="text-muted">Amélioration</p>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            `;

                            const checklist = generateImprovementChecklist(results);
                            resultsContainer.appendChild(checklist);

                            const analyzeBtn = document.getElementById('dfmAnalyzeBtn');
                            if (analyzeBtn) {
                              analyzeBtn.innerHTML = '<i class="bi bi-gear me-2"></i>Nouvelle analyse';
                              analyzeBtn.disabled = false;
                            }

                            initializeChecklistInteractions();
                          }

                          // ===================================================================
                          // 2️⃣ FONCTIONS CHECKLIST
                          // ===================================================================

                          function generateImprovementChecklist(dfmResults) {
                            const checklistSection = document.createElement('div');
                            checklistSection.id = 'improvementChecklist';
                            checklistSection.className = 'card mt-4';

                            checklistSection.innerHTML = `
                              <div class="card-header bg-warning text-dark">
                                <h5 class="mb-0">
                                  <i class="bi bi-clipboard-check me-2"></i>
                                  Plan d'amélioration DFM
                                  <span class="badge bg-dark ms-2">Score: ${dfmResults.score}/100</span>
                                </h5>
                              </div>
                              <div class="card-body">
                                <div class="row">
                                  <div class="col-md-8">
                                    <div id="checklistItems">
                                      ${generateChecklistItems(dfmResults)}
                                    </div>
                                  </div>
                                  <div class="col-md-4">
                                    <div class="card bg-light">
                                      <div class="card-body">
                                        <h6><i class="bi bi-graph-up me-2"></i>Progression</h6>
                                        <div id="progressOverview">
                                          ${generateProgressSummary(dfmResults)}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <div class="mt-3">
                                  <button class="btn btn-primary me-2" onclick="exportChecklist()">
                                    <i class="bi bi-download me-1"></i>Exporter PDF
                                  </button>
                                  <button class="btn btn-success me-2" onclick="startGuidedMode()">
                                    <i class="bi bi-play-circle me-1"></i>Mode guidé
                                  </button>
                                  <button class="btn btn-info" onclick="scheduleReview()">
                                    <i class="bi bi-calendar me-1"></i>Planifier révision
                                  </button>
                                </div>
                              </div>
                            `;

                            return checklistSection;
                          }

                          function generateChecklistItems(dfmResults) {
                            const issues = dfmResults.issues || {};
                            let html = '<div class="checklist-items">';

                            Object.entries(issues).forEach(([category, categoryIssues]) => {
                              html += `
                                <div class="mb-4">
                                  <h6 class="text-primary text-uppercase fw-bold">${getCategoryName(category)}</h6>
                                  ${categoryIssues.map((issue, index) => `
                                    <div class="form-check mb-2 p-3 border rounded">
                                      <input class="form-check-input" type="checkbox" id="issue_${category}_${index}">
                                      <label class="form-check-label" for="issue_${category}_${index}">
                                        <strong>${issue.zone || 'Zone détectée'}</strong>
                                        <br>
                                        ${issue.description}
                                        <span class="badge bg-${issue.severity === 'critical' ? 'danger' : 'warning'} ms-2">
                                          ${issue.severity}
                                        </span>
                                        ${generateIssueDetails(issue)}
                                      </label>
                                    </div>
                                  `).join('')}
                                </div>
                              `;
                            });

                            html += '</div>';
                            return html;
                          }

                          function getCategoryName(category) {
                            const names = {
                              'thickness': 'Épaisseurs des parois',
                              'undercuts': 'Contre-dépouilles',
                              'draft': 'Angles de dépouille',
                              'ribs': 'Nervures',
                              'fillets': 'Congés'
                            };
                            return names[category] || category;
                          }

                          function generateIssueDetails(issue) {
                            let details = '<br><small class="text-muted">';

                            if (issue.currentThickness && issue.recommendedThickness) {
                              details += `Actuel: ${issue.currentThickness}mm → Recommandé: ${issue.recommendedThickness}mm`;
                            }

                            if (issue.currentAngle && issue.recommendedAngle) {
                              details += `Actuel: ${issue.currentAngle}° → Recommandé: ${issue.recommendedAngle}°`;
                            }

                            if (issue.impact) {
                              details += `Impact: ${issue.impact}`;
                            }

                            details += '</small>';
                            return details;
                          }

                          function generateProgressSummary(dfmResults) {
                            const totalIssues = Object.values(dfmResults.issues || {}).flat().length;
                            const criticalIssues = Object.values(dfmResults.issues || {}).flat().filter(i => i.severity === 'critical').length;

                            return `
                              <div class="progress-summary">
                                <div class="d-flex justify-content-between mb-2">
                                  <span>Problèmes totaux:</span>
                                  <span class="badge bg-secondary">${totalIssues}</span>
                                </div>
                                <div class="d-flex justify-content-between mb-2">
                                  <span>Critiques:</span>
                                  <span class="badge bg-danger">${criticalIssues}</span>
                                </div>
                                <div class="d-flex justify-content-between mb-2">
                                  <span>Score potentiel:</span>
                                  <span class="badge bg-success">${dfmResults.potentialScore || 85}/100</span>
                                </div>

                                <div class="mt-3">
                                  <div class="progress">
                                    <div class="progress-bar" role="progressbar" style="width: ${dfmResults.score}%">
                                      ${dfmResults.score}%
                                    </div>
                                  </div>
                                  <small class="text-muted">Score actuel</small>
                                </div>

                                <div class="mt-3">
                                  <div class="progress">
                                    <div class="progress-bar bg-success" role="progressbar" style="width: 0%" id="improvementProgress">
                                      0%
                                    </div>
                                  </div>
                                  <small class="text-muted">Progression des améliorations</small>
                                </div>
                              </div>
                            `;
                          }

                          function initializeChecklistInteractions() {
                            document.querySelectorAll('#improvementChecklist input[type="checkbox"]').forEach(checkbox => {
                              checkbox.addEventListener('change', function() {
                                updateProgress();
                                if (this.checked) {
                                  this.parentElement.classList.add('text-success');
                                  this.parentElement.style.textDecoration = 'line-through';
                                } else {
                                  this.parentElement.classList.remove('text-success');
                                  this.parentElement.style.textDecoration = 'none';
                                }
                              });
                            });
                          }

                          function updateProgress() {
                            const total = document.querySelectorAll('#improvementChecklist input[type="checkbox"]').length;
                            const completed = document.querySelectorAll('#improvementChecklist input[type="checkbox"]:checked').length;

                            const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

                            const progressBar = document.getElementById('improvementProgress');
                            if (progressBar) {
                              progressBar.style.width = percentage + '%';
                              progressBar.textContent = percentage + '%';
                            }
                          }

                          function exportChecklist() {
                            console.log('📥 Export checklist PDF');
                            alert('Fonctionnalité d\'export en cours de développement');
                          }

                          function startGuidedMode() {
                            console.log('🎯 Mode guidé activé');
                            alert('Mode guidé en cours de développement');
                          }

                          function scheduleReview() {
                            console.log('📅 Planification révision');
                            alert('Planification en cours de développement');
                          }

                          // ===================================================================
                          // 3️⃣ CLASSE STEPVIEWER
                          // ===================================================================

                          class STEPViewer {
                            constructor() {
                              console.log('🎯 STEPViewer instancié');
                              this.scene = null;
                              this.camera = null;
                              this.renderer = null;
                              this.controls = null;
                              this.currentModel = null;
                              this.currentConversionId = null;
                              this.currentDemoldingAxis = null;
                              this.currentMaterialType = null;
                              this.measurementMode = false;
                              this.measurements = [];
                              this.crossSectionMode = false;
                              this.init();
                            }

                            init() {
                              console.log('🚀 Initialisation STEPViewer');
                              this.setupEventListeners();
                              this.setupDragAndDrop();
                            }

                            setupEventListeners() {
                              console.log('🎯 Configuration des event listeners');

                              // Bouton d'analyse DFM principal
                              const analyzeBtn = document.getElementById('dfmAnalyzeBtn');
                              if (analyzeBtn) {
                                analyzeBtn.addEventListener('click', () => {
                                  this.handleAnalyzeClick();
                                });
                              }

                              // Autres boutons
                              const generatePdfBtn = document.getElementById('generatePdfBtn');
                              if (generatePdfBtn) {
                                generatePdfBtn.addEventListener('click', () => this.generatePDFReport());
                              }

                              const resetViewBtn = document.getElementById('resetViewBtn');
                              if (resetViewBtn) {
                                resetViewBtn.addEventListener('click', () => this.resetView());
                              }

                              const toggleWireframeBtn = document.getElementById('toggleWireframeBtn');
                              if (toggleWireframeBtn) {
                                toggleWireframeBtn.addEventListener('click', () => this.toggleWireframe());
                              }
                            }

                            handleAnalyzeClick() {
                              console.log('🎯 Clic sur Analyser');

                              const questionnaireModal = document.getElementById('materialQuestionnaireModal');
                              if (questionnaireModal) {
                                this.cleanupModal();

                                const modal = new bootstrap.Modal(questionnaireModal, {
                                  backdrop: 'static',
                                  keyboard: false
                                });

                                modal.show();

                                questionnaireModal.addEventListener('shown.bs.modal', () => this.handleModalShown(), { once: true });
                                questionnaireModal.addEventListener('hidden.bs.modal', () => this.handleModalHidden(), { once: true });

                                setTimeout(() => {
                                  const submitBtn = document.getElementById('submitQuestionnaire');
                                  if (submitBtn) {
                                    submitBtn.addEventListener('click', () => {
                                      console.log('🎯 Clic sur Analyser et recommander');
                                      modal.hide();
                                      setTimeout(() => {
                                        this.showAxisSelection();
                                      }, 500);
                                    });
                                  }
                                }, 1000);
                              }
                            }

                            showAxisSelection() {
                              console.log('🎯 Affichage sélection axe');

                              const axisModal = document.createElement('div');
                              axisModal.className = 'modal fade';
                              axisModal.id = 'axisSelectionModal';
                              axisModal.innerHTML = `
                                <div class="modal-dialog">
                                  <div class="modal-content">
                                    <div class="modal-header">
                                      <h5 class="modal-title">Sélection de l'axe de démoulage</h5>
                                    </div>
                                    <div class="modal-body">
                                      <p>Choisissez l'axe de démoulage pour l'analyse DFM :</p>
                                      <div class="row">
                                        <div class="col-md-4">
                                          <button type="button" class="btn btn-outline-primary w-100 axis-btn" data-axis="x">
                                            <i class="bi bi-arrow-right me-2"></i>Axe X
                                          </button>
                                        </div>
                                        <div class="col-md-4">
                                          <button type="button" class="btn btn-outline-primary w-100 axis-btn" data-axis="y">
                                            <i class="bi bi-arrow-up me-2"></i>Axe Y
                                          </button>
                                        </div>
                                        <div class="col-md-4">
                                          <button type="button" class="btn btn-outline-primary w-100 axis-btn" data-axis="z">
                                            <i class="bi bi-arrow-up-right me-2"></i>Axe Z
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              `;

                              document.body.appendChild(axisModal);

                              const modal = new bootstrap.Modal(axisModal);
                              modal.show();

                              // Gestionnaires pour les boutons d'axe
                              axisModal.querySelectorAll('.axis-btn').forEach(btn => {
                                btn.addEventListener('click', (e) => {
                                  const selectedAxis = e.target.closest('.axis-btn').dataset.axis;
                                  console.log('🎯 Axe sélectionné:', selectedAxis);

                                  modal.hide();

                                  setTimeout(() => {
                                    if (window.viewer && typeof window.viewer.analyzeDFM === 'function') {
                                      console.log('🚀 Lancement analyse DFM...');
                                      window.viewer.analyzeDFM(selectedAxis);
                                    } else {
                                      console.error('❌ Fonction analyzeDFM introuvable');
                                    }

                                    // Nettoyage
                                    axisModal.remove();
                                  }, 500);
                                });
                              });
                            }

                            setupDragAndDrop() {
                              console.log("🎯 Configuration drag & drop");

                              const dropZone = document.getElementById("uploadArea");
                              const fileInput = document.getElementById("fileInput");

                              if (!dropZone || !fileInput) {
                                console.warn("⚠️ Éléments drag & drop manquants");
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
                                if (files && files.length > 0) {
                                  fileInput.files = files;
                                  this.handleFileSelect({ target: { files } });
                                }
                              });

                              fileInput.addEventListener("change", (e) => {
                                this.handleFileSelect(e);
                              });
                            }

                            handleFileSelect(event) {
                              const file = event.target.files[0];
                              if (!file) return;

                              console.log('📁 Fichier sélectionné:', file.name);

                              const fileNameDisplay = document.getElementById("fileNameDisplay");
                              if (fileNameDisplay) {
                                fileNameDisplay.textContent = file.name;
                              }

                              // Simulation d'upload
                              this.simulateUpload(file);
                            }

                            simulateUpload(file) {
                              console.log('📤 Simulation upload:', file.name);

                              // Afficher une notification de succès
                              const notification = document.createElement('div');
                              notification.className = 'alert alert-success position-fixed';
                              notification.style.cssText = 'top: 20px; right: 20px; z-index: 1050;';
                              notification.innerHTML = `
                                <i class="bi bi-check-circle me-2"></i>
                                Fichier ${file.name} chargé avec succès
                              `;

                              document.body.appendChild(notification);

                              setTimeout(() => {
                                notification.remove();
                              }, 3000);
                            }

                            // Méthodes utilitaires
                            cleanupModal() {
                              document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
                                backdrop.remove();
                              });
                              document.body.classList.remove('modal-open');
                              document.body.style.overflow = '';
                              document.body.style.paddingRight = '';
                            }

                            handleModalShown() {
                              console.log('🎯 Modale questionnaire ouverte');
                              this.initializeMaterialListeners();
                            }

                            handleModalHidden() {
                              console.log('🎯 Modale questionnaire fermée');
                              setTimeout(() => {
                                this.cleanupModal();
                              }, 100);
                            }

                            initializeMaterialListeners() {
                              console.log('🎯 Initialisation listeners matériaux');

                              ['mechanical', 'aesthetic', 'regulatory'].forEach(group => {
                                document.querySelectorAll(`input[name="${group}[]"]`).forEach(cb => {
                                  cb.addEventListener('change', () => {
                                    if (typeof checkCompatibility === 'function') {
                                      checkCompatibility();
                                    }
                                  });
                                });
                              });
                            }

                            resetView() {
                              console.log('🔄 Reset view');
                            }

                            toggleWireframe() {
                              console.log('🔲 Toggle wireframe');
                            }

                            generatePDFReport() {
                              console.log('📄 Génération PDF');
                              alert('Génération PDF en cours de développement');
                            }
                          }

                          // ===================================================================
                          // 4️⃣ FONCTIONS UTILITAIRES
                          // ===================================================================

                          function checkCompatibility() {
                            console.log('🔍 Vérification compatibilité matériaux');
                            // Logique de compatibilité ici
                          }

                          function submitForm() {
                            console.log('📝 Soumission formulaire');
                            alert('Analyse en cours...');
                          }

                          // ===================================================================
                          // 5️⃣ INITIALISATION DOM
                          // ===================================================================

                          document.addEventListener('DOMContentLoaded', function () {
                            console.log('🚀 DOM chargé - Initialisation');

                            // Éviter double instanciation
                            if (!window.viewer) {
                              console.log('🧠 Création nouvelle instance STEPViewer');
                              window.viewer = new STEPViewer();
                            }

                            console.log('✅ Initialisation terminée');
                          });

                          // ===================================================================
                          // 6️⃣ GESTION DES ERREURS
                          // ===================================================================

                          window.addEventListener('error', function(event) {
                            console.error('❌ Erreur JavaScript:', event.error);
                          });

                          console.log('📋 Fichier viewer.js chargé complètement');
