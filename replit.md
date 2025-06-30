# CADlytics - SaaS d'Analyse DFM et Visualisation 3D

## Vue d'ensemble

CADlytics est une application SaaS basée sur Flask qui permet aux utilisateurs de télécharger des fichiers STEP (.step, .stp), de les analyser pour la manufacturabilité (DFM) en injection plastique, et de les visualiser dans un viewer 3D avancé. L'application convertit les fichiers STEP au format STL en utilisant CadQuery pour la visualisation 3D dans le navigateur avec Three.js et génère des rapports PDF détaillés.

## System Architecture

### Backend Architecture
- **Framework**: Flask (Python web framework)
- **File Processing**: CadQuery for STEP to STL conversion
- **Web Server**: Gunicorn for production deployment
- **CORS**: Flask-CORS for cross-origin resource sharing
- **File Handling**: Werkzeug for secure file uploads

### Frontend Architecture
- **3D Rendering**: Three.js for WebGL-based 3D visualization
- **UI Framework**: Bootstrap 5 with dark theme
- **File Upload**: HTML5 file API with progress tracking
- **Controls**: OrbitControls for 3D navigation

### Key Design Decisions
- **File Format Choice**: STEP files are industry-standard CAD format, converted to STL for web display
- **Client-Side Rendering**: Three.js provides hardware-accelerated 3D rendering without server load
- **Temporary Storage**: Files are stored locally in uploads/ and converted/ directories
- **Security**: File extension validation and secure filename handling

## Key Components

### Core Files
- `main.py`: Application entry point
- `app.py`: Main Flask application with upload and conversion logic
- `templates/index.html`: Single-page application template
- `static/js/viewer.js`: 3D viewer implementation
- `static/css/custom.css`: Custom styling

### Directory Structure
```
/
├── app.py                 # Main Flask application
├── main.py               # Entry point
├── uploads/              # Temporary STEP file storage
├── converted/            # Generated STL files
├── templates/            # HTML templates
└── static/              # CSS, JS, and assets
```

## Data Flow

1. **File Upload**: User selects STEP file through web interface
2. **Validation**: Server validates file extension and size (max 50MB)
3. **Conversion**: CadQuery converts STEP to STL format
4. **Storage**: STL file saved to converted/ directory
5. **Visualization**: Three.js loads and renders STL in browser
6. **Interaction**: User can rotate, zoom, and inspect 3D model

## External Dependencies

### Python Packages
- `flask`: Web framework
- `cadquery`: CAD file processing and conversion
- `flask-cors`: Cross-origin resource sharing
- `gunicorn`: WSGI HTTP server
- `werkzeug`: Web utilities
- `psycopg2-binary`: PostgreSQL adapter (for future database needs)

### Frontend Libraries
- `Three.js`: 3D graphics library
- `Bootstrap 5`: UI framework
- `Bootstrap Icons`: Icon set

### System Dependencies
- OpenCASCADE: CAD kernel for geometry processing
- FreeType: Font rendering
- OpenGL: 3D graphics support

## Deployment Strategy

### Development
- Flask development server with auto-reload
- Debug mode enabled
- Local file storage

### Production
- **Server**: Gunicorn with auto-scaling deployment
- **Port**: 5000 with bind to all interfaces (0.0.0.0)
- **Features**: Process reuse and reload capabilities
- **Platform**: Replit with Nix package management

### Configuration
- Environment-based secret key management
- Configurable upload limits and directories
- CORS enabled for API flexibility

## Changelog

- 30 juin 2025 : Refonte visuelle moderne de l'analyse DFM
  - Interface DFM complètement redessinée avec design cohérent kaki/brun
  - Cartes de métriques interactives avec icônes colorées et animations
  - Score principal dans cercle dégradé avec badge de rating
  - Grille responsive de métriques : dimensions, volume, épaisseur, refroidissement
  - Section surfaces projetées avec cartes dédiées X, Y, Z
  - Problèmes détectés avec codes couleur de sévérité et recommandations
  - Design mobile-first avec animations hover et transitions fluides
  - Boutons d'action modernes pour changer axe et générer PDF
- 30 juin 2025 : Correction définitive du calcul de surface projetée
  - Division par 2 des résultats de surface projetée pour corriger le doublage
  - Implémentation méthode hybride robuste avec détection d'overlaps automatique
  - Nettoyage complet du mesh (dupliqués, faces dégénérées, normales)
  - Validation par convex hull pour éviter les surestimations
  - Outils de débogage visuel avec matplotlib pour vérifier les projections
  - Gestion intelligente des overlaps avec ajustement automatique
- 27 juin 2025 : Calcul précis de la surface projetée avec Trimesh
  - Implémentation du calcul réel de surface projetée utilisant les normales des faces
  - Utilisation de Trimesh pour analyser la géométrie STL exportée
  - Formule : projected_area = mesh.area_faces[(mesh.face_normals[:, axis] > 0)].sum()
  - Calcul précis prenant en compte la vraie géométrie au lieu du bounding box
  - Tests validés avec des résultats corrects sur des géométries simples
- 27 juin 2025 : Attribution créateur et finalisation interface
  - Footer ajouté sur toutes les pages avec "Créé par Grégoire GOUNY"
  - Attribution intégrée dans le design cohérent kaki/brun de l'application
  - Footer stylé avec gradient et typographie harmonieuse
- 27 juin 2025 : Repositionnement de l'analyse DFM sous le visualisateur 3D
  - Section DFM déplacée sous le visualisateur 3D pour occuper toute la largeur
  - Structure en accordéon maintenue avec sections organisées par thématiques
  - Layout pleine largeur optimisé pour une meilleure lisibilité des données
  - CSS adapté pour maximiser l'espace disponible sous le viewer 3D
  - Placement séquentiel logique : upload → visualisation → analyse → historique
  - Interface plus cohérente avec flux de travail naturel
  - Affichage optimisé sur toutes les tailles d'écran
- 27 juin 2025 : Création de la landing page CADlytics et navigation
  - Landing page professionnelle avec thème kaki/brun pour CADlytics
  - Navigation ajoutée sur toutes les pages pour revenir à l'accueil
  - Route "/" pour la landing page et "/app" pour l'application principale
  - Design cohérent avec animations et sections marketing
  - Nom du SaaS "CADlytics" intégré partout
- 27 juin 2025 : Utilisation du fichier STEP pour générer les vues 3D dans les rapports PDF
  - La génération des vues 3D dans les rapports PDF utilise maintenant directement le fichier STEP source
  - Meilleure qualité des représentations 3D grâce à l'accès à la géométrie complète du modèle
  - Cohérence entre l'analyse DFM et les vues générées dans le rapport
- 27 juin 2025 : Système de conseils Design Insights pour analyse DFM
  - Tooltips contextuels avec conseils manufacturabilité pour chaque problème détecté
  - Base de données complète d'insights pour parois trop fines/épaisses
  - Conseils géométriques pour arêtes vives, dépouille, trous profonds, hauteur
  - Tooltips enrichis avec causes, solutions détaillées et impact production
  - Icônes d'ampoule sur chaque problème avec information au survol
  - Conseils généraux d'épaisseur et géométrie dans les en-têtes de section
- 27 juin 2025 : Changement axe démoulage et vues 3D réelles dans PDF
  - Ajout bouton "Changer axe de démoulage" après première analyse DFM
  - Possibilité de refaire analyse DFM avec nouvel axe sélectionné
  - Amélioration génération vues 3D dans PDF avec projections orthographiques
  - Vues basées sur géométrie réelle du modèle (arêtes et faces)
  - Dimensions réelles affichées sur chaque vue selon l'axe choisi
  - Interface utilisateur enrichie avec contrôles DFM regroupés
- 27 juin 2025 : Amélioration génération PDF et suppression tableau de bord performances
  - Correction méthode generate_3d_views manquante dans le générateur PDF
  - Ajout d'images 3D vectorielles avec représentation schématique dans les rapports
  - Suppression complète du tableau de bord des performances et bouton associé
  - Nettoyage du code JavaScript pour retirer toutes références au monitoring
  - Rapports PDF maintenant fonctionnels avec vues 3D selon axes X, Y, Z
- 27 juin 2025 : Optimisation des performances et expérience utilisateur
  - Changement du bouton "Convertir et visualiser" en "Visualiser" avec icône œil
  - Ajout d'un timeout de 30 secondes côté serveur pour éviter les blocages
  - Timeout côté client aligné à 35 secondes avec AbortController
  - Messages d'erreur spécifiques selon le type de problème (413, 504, réseau)
  - Barre de progression améliorée avec spinner et message informatif
  - Indication claire que la conversion peut prendre jusqu'à 30 secondes
  - Gestion robuste des erreurs réseau et timeouts
- 26 juin 2025 : Correction du calcul d'épaisseur de paroi
  - Remplacement du calcul erroné (dimension complète) par estimation réaliste
  - Épaisseur basée sur la plus petite dimension avec contraintes d'injection
  - Limite maximale à 10mm, estimation intelligente pour pièces fines
  - Score DFM adapté aux vraies épaisseurs de paroi (0.8-4mm optimal)
  - Messages d'interface clarifiés "épaisseur paroi" vs "dimension"
- 26 juin 2025 : Correction du calcul d'épaisseur de paroi
  - Remplacement du calcul erroné (dimension complète) par estimation réaliste
  - Épaisseur basée sur la plus petite dimension avec contraintes d'injection
  - Limite maximale à 10mm, estimation intelligente pour pièces fines
  - Score DFM adapté aux vraies épaisseurs de paroi (0.8-4mm optimal)
  - Messages d'interface clarifiés "épaisseur paroi" vs "dimension"
- 26 juin 2025 : Sélection de l'axe de démoulage pour analyse DFM
  - Modal de sélection avec 3 axes (X, Y, Z) avant analyse DFM
  - Calculs adaptés selon la direction de démoulage choisie
  - Épaisseur maximale basée sur l'axe de démoulage sélectionné
  - Détection des faces perpendiculaires à l'axe choisi
  - Interface intuitive avec descriptions des directions
- 26 juin 2025 : Génération de rapports PDF DFM
  - Nouveau module PDF avec ReportLab pour rapports professionnels
  - Bouton "Générer rapport PDF" après analyse DFM
  - Rapport complet avec vues 3D, analyse détaillée et recommandations
  - Téléchargement automatique du PDF généré
  - Section résumé exécutif et métriques clés
- 26 juin 2025 : Utilisation épaisseur maximale au lieu du rapport de finesse
  - Calcul direct de l'épaisseur maximale des parois pour évaluation DFM
  - Indicateurs de risque basés sur épaisseur (critique >6mm, optimal 1-4mm)
  - Recommandations adaptées aux problèmes d'épaisseur spécifiques
  - Interface mise à jour pour afficher l'épaisseur maximale
- 26 juin 2025 : Indicateurs visuels de risque DFM
  - Codes couleur pour différents niveaux de risque (critique, attention, optimal)
  - Cartes visuelles avec icônes et descriptions pour chaque problème
  - Badges de sévérité colorés pour les problèmes spécifiques
  - Détails des problèmes d'épaisseur et géométriques
  - Interface enrichie avec indicateurs contextuels
- 26 juin 2025 : Séparation conversion et analyse DFM
  - Bouton "Convertir et visualiser" pour conversion rapide STEP→STL
  - Bouton "Analyser DFM" séparé pour éviter les timeouts
  - Endpoint dédié `/api/analyze-dfm/<id>` pour l'analyse DFM
  - Interface utilisateur adaptée avec deux étapes distinctes
  - Optimisation des performances pour gros fichiers
- 26 juin 2025 : Analyse DFM (Design for Manufacturing) complète
  - Calcul automatique des dimensions globales (X, Y, Z) en mm
  - Analyse du rapport de finesse (épaisseur/plus grande dimension)
  - Détection des problèmes d'injection plastique :
    * Parois trop fines (< 0.8mm) ou épaisses (> 4mm)
    * Absence de dépouille sur faces verticales
    * Arêtes vives sans congés
    * Trous borgnes profonds
    * Hauteur excessive (> 60mm)
  - Score de moulabilité 1-10 avec recommandations
  - Affichage intégré dans l'interface 3D
  - Historique avec scores DFM visibles
- 26 juin 2025 : Amélioration contraste fond visualisateur 3D
  - Fond gris foncé (#2d2d30) en mode sombre pour meilleur contraste
  - Fond gris clair (#e8e9ea) en mode clair pour meilleur contraste
  - Adaptation automatique selon le thème choisi
  - Meilleure visibilité des pièces 3D dans les deux modes
- 26 juin 2025 : Amélioration affichage mesures et suppression surface projetée
  - Mesures affichées exclusivement en mm avec texte plus gros
  - Étiquettes de mesure au premier plan avec fond jaune contrasté
  - Suppression complète de la fonction calcul de surface projetée
  - Interface volume simplifiée sans options de surface
  - Meilleure visibilité des mesures avec bordure et taille augmentée
- 26 juin 2025 : Plan de coupe masquable et calcul de surface
  - Plan de coupe masquable avec barre ESPACE pour meilleure visibilité
  - Contour filaire pour délimiter le plan de coupe
  - Volume affiché en mm³ pour plus de précision
  - Calcul de surface projetée selon l'axe choisi (X, Y, Z)
  - Affichage adaptatif des surfaces en mm², cm² ou m²
- 26 juin 2025 : Amélioration échelle et mesures
  - Conservation de l'échelle réelle 1:1 lors de la conversion STEP→STL
  - Points de mesure plus petits et proportionnels au modèle
  - Étiquettes de mesure améliorées avec formatage adaptatif
  - Affichage automatique en mètres ou centimètres selon la taille
  - Volume affiché en mm³ pour plus de précision
- 26 juin 2025 : Outils avancés de visualisation 3D
  - Mode mesure : clic sur deux points pour mesurer la distance
  - Mode coupe transversale avec plan de coupe interactif
  - Contrôles clavier pour manipuler le plan de coupe (flèches, X/Y/Z)
  - Affichage des mesures avec étiquettes visuelles
  - Instructions contextuelles pour chaque outil
- 26 juin 2025 : Calcul et affichage du volume
  - Calcul automatique du volume des pièces en cm³
  - Affichage du volume dans l'interface utilisateur
  - Méthode basée sur la géométrie du maillage triangulaire
- 26 juin 2025 : Améliorations visuelles et UX
  - Ajout du basculement mode sombre/clair
  - Axes XYZ attachés à la pièce 3D avec étiquettes colorées
  - Contrôles visuels améliorés
  - Transitions fluides entre thèmes
- 26 juin 2025 : Amélioration du flux UX - visualisation directe
  - Suppression de l'étape intermédiaire avec message de succès
  - Affichage direct du modèle 3D après conversion
  - Interface plus fluide et immédiate
- 26 juin 2025 : Suppression de la fonctionnalité de téléchargement
  - Retrait du bouton de téléchargement STL pour les utilisateurs
  - Suppression de l'endpoint /download/<filename>
  - Visualisation uniquement en ligne maintenant
- 25 juin 2025 : Traduction complète en français
  - Interface utilisateur entièrement traduite
  - Messages d'erreur et de succès en français
  - API et logs conservés en anglais pour les développeurs
- 25 juin 2025 : Intégration de la base de données
  - Base de données PostgreSQL avec suivi des jobs de conversion
  - Historique des conversions avec suivi du statut
  - Points d'API pour la gestion des conversions
  - Gestion d'erreurs et logging améliorés
- 25 juin 2025 : Configuration initiale

## Préférences utilisateur

Style de communication préféré : Langue simple et quotidienne.
Langue de l'interface : Français complet pour l'utilisateur final.