/**
 * Design Insights Tooltip System for DFM Analysis
 * Provides contextual manufacturing guidance and explanations
 */

class DesignInsights {
    constructor() {
        this.insights = {
            // Wall thickness insights
            wall_thickness: {
                too_thin: {
                    title: "Parois trop fines",
                    description: "L'épaisseur de paroi est inférieure à 0.8mm, ce qui peut causer des problèmes de remplissage et de résistance mécanique.",
                    causes: [
                        "Conception optimisée pour réduire le poids",
                        "Contraintes d'espace dans l'assemblage",
                        "Sous-estimation des contraintes de moulage"
                    ],
                    solutions: [
                        "Augmenter l'épaisseur à minimum 0.8-1.2mm",
                        "Ajouter des nervures de renfort si nécessaire",
                        "Optimiser les points d'injection pour améliorer le remplissage",
                        "Considérer un matériau à meilleure fluidité"
                    ],
                    impact: "Risque élevé de défauts de remplissage, pièces fragiles, coûts de rebut"
                },
                too_thick: {
                    title: "Parois trop épaisses",
                    description: "L'épaisseur de paroi dépasse 4-6mm, créant des risques de retrait et d'augmentation des temps de cycle.",
                    causes: [
                        "Sur-dimensionnement par sécurité",
                        "Contraintes mécaniques élevées",
                        "Conception issue d'autres procédés de fabrication"
                    ],
                    solutions: [
                        "Réduire l'épaisseur à 2-4mm maximum",
                        "Créer des sections creuses avec parois fines",
                        "Ajouter des nervures plutôt qu'augmenter l'épaisseur",
                        "Utiliser des insert métalliques si nécessaire"
                    ],
                    impact: "Temps de cycle élevés, retrait important, coûts matière"
                }
            },

            // Geometry insights
            geometry: {
                sharp_edges: {
                    title: "Arêtes vives détectées",
                    description: "Les arêtes vives créent des concentrations de contraintes et compliquent le démoulage.",
                    causes: [
                        "Transition directe entre surfaces",
                        "Conception CAO sans considération du moulage",
                        "Besoin esthétique d'arêtes marquées"
                    ],
                    solutions: [
                        "Ajouter des congés de 0.3-0.5mm minimum",
                        "Prévoir des congés plus importants sur les arêtes extérieures",
                        "Adapter les congés selon l'épaisseur des parois",
                        "Considérer l'orientation des arêtes par rapport au plan de joint"
                    ],
                    impact: "Usure des moules, concentrations de contraintes, difficultés de démoulage"
                },
                no_draft: {
                    title: "Dépouille insuffisante",
                    description: "Les surfaces verticales sans dépouille compliquent l'éjection et usent le moule.",
                    causes: [
                        "Contraintes d'assemblage",
                        "Fonctions d'étanchéité",
                        "Méconnaissance des exigences de moulage"
                    ],
                    solutions: [
                        "Ajouter 0.5-2° de dépouille sur toutes les surfaces verticales",
                        "Adapter la dépouille selon la hauteur (plus haute = plus de dépouille)",
                        "Prévoir des interruptions de dépouille si nécessaire",
                        "Optimiser l'orientation de la pièce dans le moule"
                    ],
                    impact: "Force d'éjection élevée, marquage des pièces, usure du moule"
                },
                deep_holes: {
                    title: "Trous borgnes profonds",
                    description: "Les trous avec un rapport profondeur/diamètre > 3:1 sont difficiles à mouler et ventiler.",
                    causes: [
                        "Fonctions de fixation",
                        "Contraintes d'assemblage",
                        "Optimisation de l'espace"
                    ],
                    solutions: [
                        "Limiter le rapport profondeur/diamètre à 3:1",
                        "Prévoir des évents en fond de trou",
                        "Considérer des trous débouchants si possible",
                        "Utiliser des inserts filetés pour les fixations"
                    ],
                    impact: "Problèmes de ventilation, marques de brûlure, usure des noyaux"
                },
                excessive_height: {
                    title: "Hauteur excessive",
                    description: "Les pièces hautes (>60mm) augmentent les risques de déformation et les temps de cycle.",
                    causes: [
                        "Fonctions mécaniques imposées",
                        "Contraintes d'assemblage",
                        "Optimisation du nombre de pièces"
                    ],
                    solutions: [
                        "Diviser en plusieurs pièces plus basses",
                        "Optimiser la géométrie pour réduire la hauteur",
                        "Prévoir des nervures de rigidification",
                        "Adapter les paramètres de moulage (pression, température)"
                    ],
                    impact: "Déformations, retrait non uniforme, difficultés de remplissage"
                }
            },

            // General DFM insights
            general: {
                critical: {
                    title: "Score critique (1-3/10)",
                    description: "La pièce présente des défis majeurs pour l'injection plastique nécessitant des modifications importantes.",
                    recommendations: [
                        "Réviser la conception en priorité avant prototypage",
                        "Consulter un expert en injection plastique",
                        "Prévoir des tests de faisabilité sur géométries simplifiées",
                        "Évaluer des procédés alternatifs si nécessaire"
                    ]
                },
                warning: {
                    title: "Score d'attention (4-6/10)",
                    description: "La pièce est moulable mais avec des risques ou coûts élevés. Des optimisations sont recommandées.",
                    recommendations: [
                        "Optimiser les points identifiés avant industrialisation",
                        "Prévoir des essais moule sur les zones critiques",
                        "Adapter les paramètres de moulage",
                        "Considérer un suivi qualité renforcé"
                    ]
                },
                good: {
                    title: "Score satisfaisant (7-8/10)",
                    description: "La pièce est bien conçue pour l'injection avec seulement des améliorations mineures possibles.",
                    recommendations: [
                        "Finaliser les détails de conception",
                        "Valider les matériaux et paramètres",
                        "Procéder au développement du moule",
                        "Prévoir des tests de validation"
                    ]
                },
                excellent: {
                    title: "Score excellent (9-10/10)",
                    description: "La pièce est optimalement conçue pour l'injection plastique.",
                    recommendations: [
                        "Conception prête pour l'industrialisation",
                        "Procéder au développement du moule",
                        "Optimiser les paramètres de production",
                        "Planifier la production série"
                    ]
                }
            }
        };

        this.initializeTooltips();
    }

    initializeTooltips() {
        // Initialize Bootstrap tooltips
        if (typeof bootstrap !== 'undefined') {
            const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
            tooltipTriggerList.map(function (tooltipTriggerEl) {
                return new bootstrap.Tooltip(tooltipTriggerEl);
            });
        }
    }

    getInsight(category, type) {
        return this.insights[category] && this.insights[category][type] || null;
    }

    createInsightTooltip(category, type, additionalData = {}) {
        const insight = this.getInsight(category, type);
        if (!insight) return '';

        let tooltipContent = `
            <div class="insight-tooltip">
                <h6 class="mb-2">${insight.title}</h6>
                <p class="mb-2 small">${insight.description}</p>
        `;

        if (insight.causes) {
            tooltipContent += `
                <div class="mb-2">
                    <strong class="small">Causes fréquentes:</strong>
                    <ul class="small mb-0">
                        ${insight.causes.map(cause => `<li>${cause}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        if (insight.solutions) {
            tooltipContent += `
                <div class="mb-2">
                    <strong class="small">Solutions recommandées:</strong>
                    <ul class="small mb-0">
                        ${insight.solutions.map(solution => `<li>${solution}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        if (insight.recommendations) {
            tooltipContent += `
                <div class="mb-2">
                    <strong class="small">Recommandations:</strong>
                    <ul class="small mb-0">
                        ${insight.recommendations.map(rec => `<li>${rec}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        if (insight.impact) {
            tooltipContent += `
                <div class="alert alert-warning alert-sm mb-0">
                    <small><strong>Impact:</strong> ${insight.impact}</small>
                </div>
            `;
        }

        tooltipContent += '</div>';

        return tooltipContent;
    }

    addInsightIcon(element, category, type, additionalData = {}) {
        const insight = this.getInsight(category, type);
        if (!insight) return;

        const tooltipContent = this.createInsightTooltip(category, type, additionalData);
        
        const insightIcon = document.createElement('i');
        insightIcon.className = 'bi bi-info-circle-fill text-info ms-1 insight-icon';
        insightIcon.style.cursor = 'help';
        insightIcon.setAttribute('data-bs-toggle', 'tooltip');
        insightIcon.setAttribute('data-bs-placement', 'top');
        insightIcon.setAttribute('data-bs-html', 'true');
        insightIcon.setAttribute('data-bs-title', tooltipContent);
        
        element.appendChild(insightIcon);
        
        // Initialize the tooltip
        if (typeof bootstrap !== 'undefined') {
            new bootstrap.Tooltip(insightIcon);
        }
    }

    createExpandedInsightCard(category, type, additionalData = {}) {
        const insight = this.getInsight(category, type);
        if (!insight) return null;

        const card = document.createElement('div');
        card.className = 'card border-info mb-3';
        
        let cardContent = `
            <div class="card-header bg-info bg-opacity-10">
                <h6 class="mb-0">
                    <i class="bi bi-lightbulb me-2"></i>${insight.title}
                </h6>
            </div>
            <div class="card-body">
                <p class="card-text">${insight.description}</p>
        `;

        if (insight.causes) {
            cardContent += `
                <div class="mb-3">
                    <h6 class="text-warning">Causes fréquentes</h6>
                    <ul class="small">
                        ${insight.causes.map(cause => `<li>${cause}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        if (insight.solutions) {
            cardContent += `
                <div class="mb-3">
                    <h6 class="text-success">Solutions recommandées</h6>
                    <ul class="small">
                        ${insight.solutions.map(solution => `<li>${solution}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        if (insight.recommendations) {
            cardContent += `
                <div class="mb-3">
                    <h6 class="text-primary">Recommandations</h6>
                    <ul class="small">
                        ${insight.recommendations.map(rec => `<li>${rec}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        if (insight.impact) {
            cardContent += `
                <div class="alert alert-warning">
                    <h6 class="alert-heading">Impact sur la production</h6>
                    <p class="mb-0">${insight.impact}</p>
                </div>
            `;
        }

        cardContent += '</div>';
        card.innerHTML = cardContent;
        
        return card;
    }

    // Helper method to get insight based on DFM data
    getInsightForIssue(issue) {
        if (issue.issue_type === 'too_thin' || issue.issue_type === 'too_thick') {
            return this.getInsight('wall_thickness', issue.issue_type);
        } else {
            // Map geometry issues to insights
            const geometryMap = {
                'sharp_edge': 'sharp_edges',
                'no_draft': 'no_draft',
                'deep_hole': 'deep_holes',
                'excessive_height': 'excessive_height'
            };
            return this.getInsight('geometry', geometryMap[issue.issue_type]);
        }
    }

    getInsightForRating(rating) {
        const ratingMap = {
            'critical': 'critical',
            'warning': 'warning',
            'good': 'good',
            'excellent': 'excellent'
        };
        return this.getInsight('general', ratingMap[rating]);
    }
}

// Global instance
window.designInsights = new DesignInsights();