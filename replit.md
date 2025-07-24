# CADlytitcs - SaaS d'Analyse DFM et Visualisation 3D

## Vue d'ensemble

CADlytitcs est une application SaaS basée sur Flask qui permet aux utilisateurs de télécharger des fichiers STEP (.step, .stp), de les analyser pour la manufacturabilité (DFM) en injection plastique, et de les visualiser dans un viewer 3D avancé. L'application convertit les fichiers STEP au format STL en utilisant CadQuery pour la visualisation 3D dans le navigateur avec Three.js et génère des rapports PDF détaillés.

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
- Gestion des clés secrètes par variables d'environnement
- Limites de téléchargement et dossiers configurables
- CORS activé pour plus de flexibilité API
- Démarrer Redis puis le worker Celery avec la même variable `CELERY_BROKER_URL`
  que le processus web :

```bash
redis-server --daemonize yes
CELERY_BROKER_URL=redis://localhost:6379/0 ./start_worker.sh
```
- Lancer Gunicorn en utilisant la même variable :

```bash
CELERY_BROKER_URL=redis://localhost:6379/0 gunicorn app:app --timeout 600
```
- Pour Nginx, ajouter `client_max_body_size 100M;` et `proxy_read_timeout 600;`

## Changelog

- 7 juillet 2025 : Réactivation du système bilingue français/anglais
  - Réactivation des fonctions get_locale() et inject_translations()
  - Ajout de la route /change-language/<lang> pour changer de langue
  - Sélecteur de langue ajouté dans navigation (dropdown avec drapeaux)
  - Sélecteur présent dans : index.html, landing.html, pricing.html
  - Français reste la langue par défaut
  - Sauvegarde de la préférence de langue pour les utilisateurs connectés
  - Traductions complètes dans translations.py pour FR et EN
- 7 juillet 2025 : Ajout du badge Fazier dans les footers
  - Badge Fazier ajouté dans templates/landing.html
  - Badge Fazier ajouté dans templates/index.html
  - Style avec effet hover (opacité 0.8 → 1.0)
  - Lien vers https://fazier.com avec width=120
- 7 juillet 2025 : Modification du prix de l'abonnement Pro
  - Prix réduit de 23.99€ à 14.99€ dans toute l'interface
  - Templates modifiés : pricing.html, landing.html, auth/profile.html
  - Commentaire mis à jour dans stripe_payment.py
  - Important : nécessite création d'un nouveau prix dans Stripe Dashboard
  - Variable d'environnement STRIPE_PRICE_SUBSCRIPTION doit être mise à jour
- 4 juillet 2025 : Solution complète pour gros fichiers CAD (>1M faces)
  - Viewer 3D: matériau Lambert pour tous les modèles (ombres/éclairage préservés)
  - Analyse DFM adaptative: méthodes simplifiées automatiques pour >1000 faces CadQuery
  - Wall thickness simplifiée: estimation basée dimensions au lieu calculs volume coûteux
  - Geometry analysis simplifiée: vérifications de base sans opérations détaillées
  - Nettoyage mesh conditionnel: désactivé pour >200K faces, split pour >100K faces
  - Timeout viewer 3D: 5 minutes, messages d'erreur différenciés
  - Architecture robuste: analyse DFM fonctionne même sur modèles ultra-complexes
- 4 juillet 2025 : Optimisation performance pour modèles très complexes
  - Optimisation drastique du calcul de surface projetée pour éviter timeouts
  - Modèles >500K faces: approximation bounding box uniquement (très rapide)  
  - Modèles >50K faces: convex hull avec échantillonnage de vertices (5K max)
  - Modèles moyens: convex hull standard
  - Élimination des calculs coûteux de triangulation sur gros modèles
  - Prévention des timeouts worker sur fichiers de 1M+ faces
- 4 juillet 2025 : Correction erreur 502 causée par cookies volumineux
  - Suppression du stockage des données DFM en session pour éviter cookies >4KB
  - Suppression du stockage des recommandations de matériaux en session
  - Configuration session sécurisée (HttpOnly, Secure, SameSite)
  - Données DFM stockées uniquement en base de données et transmises directement au frontend
  - Résolution de l'erreur "The 'session' cookie is too large" (4113 bytes vs limite 4093)
- 4 juillet 2025 : Amélioration acceptation fichiers 3D complexes
  - Augmentation limite de taille de fichier de 50MB à 100MB
  - Tolérance accrue pour la validation des mesh avec trimesh
  - Seuil de simplification relevé de 100k à 500k faces
  - Simplification uniquement pour fichiers extrêmement complexes (>500k faces)
  - Optimisations viewer 3D : matériaux adaptés selon complexité (basic/lambert/physical)
  - Réduction pixel ratio du renderer pour modèles >1M vertices
  - Gestion d'erreur plus tolérante : viewer peut fonctionner même si trimesh échoue
  - Streaming optimisé pour fichiers STL volumineux avec chunks adaptables
- 4 juillet 2025 : Suppression sélecteur de langue et français par défaut
  - Suppression complète du sélecteur de langue du footer
  - Suppression de la route /change-language/<lang> 
  - Langue française définie par défaut dans toute l'application
  - Simplification des fonctions get_locale() et inject_translations()
  - Interface 100% française sans possibilité de changement de langue
- 3 juillet 2025 : Changement de nom de CADlytics à CADlytitcs
  - Renommage global de toutes les occurrences de "CADlytics" en "CADlytitcs"
  - Mise à jour dans tous les fichiers : templates HTML, traductions, documentation
  - Conservation du domaine cadlytics.replit.app pour Plausible Analytics
- 2 juillet 2025 : Retour à la conversion STL standard
  - Suppression de la tolérance minimale forcée pour permettre à tous les fichiers de se charger
  - Retour à la méthode de conversion simple qui fonctionnait ce matin
  - Suppression des imports OCC non disponibles sur Replit
  - Priorité donnée à la compatibilité maximale plutôt qu'à l'optimisation de taille
- 2 juillet 2025 : Support du mode dégradé pour la visualisation 3D
  - Ajout des champs viewer_ready et viewer_error dans ConversionJob model
  - Détection automatique des fichiers STL incompatibles avec le viewer 3D (trimesh validation)
  - Simplification automatique du mesh pour fichiers avec >50k faces (réduit à 50k triangles)
  - Message d'alerte spécifique "⚠️ La visualisation 3D a échoué, mais l'analyse DFM a bien été effectuée"
  - L'analyse DFM continue de fonctionner même si la visualisation 3D échoue
  - Masquage des outils 3D (wireframe, axes, etc.) quand le viewer n'est pas disponible
  - Interface adaptative qui cache le viewer 3D mais garde les fonctionnalités DFM actives
  - Gestion robuste des erreurs de conversion avec messages utilisateur détaillés
- 2 juillet 2025 : Système de tracking complet et dashboard admin
  - Implémentation de logging JSONL pour toutes les actions (upload, analyze, download, login)
  - Création du module log.py avec fonctions thread-safe log_action() et get_stats()
  - Ajout du logging dans auth.py et google_auth.py pour tracker les connexions
  - Dashboard admin protégé par mot de passe sur /admin avec statistiques complètes
  - Page de login admin sur /admin/login avec mot de passe stocké dans ADMIN_PASSWORD
  - Tableau de bord affichant : utilisateurs totaux, actifs du jour, uploads, analyses, PDF générés
  - Timeline des activités récentes et tableau des top utilisateurs
  - Auto-refresh du dashboard toutes les 30 secondes
  - Design cohérent avec thème kaki/brun de l'application
- 2 juillet 2025 : Système multi-langues et nouvelles fonctionnalités
  - Système de traduction complet français/anglais pour toute l'interface
  - Ajout colonne preferred_language dans base de données utilisateur
  - Endpoint /change-language/<lang> pour changer la langue (fr/en)
  - Contexte de traduction global injecté dans tous les templates
  - Bouton "Signaler un bug" dans le footer avec email pré-formaté
  - Sélecteur de langue dans le footer avec indicateur visuel de langue active
  - 15 crédits gratuits pour les 20 premiers inscrits (au lieu de 5)
  - Message de bienvenue personnalisé après inscription
  - Traductions appliquées à : navigation, hero, footer, formulaires
  - Support prévu pour génération PDF dans la langue choisie
- 2 juillet 2025 : Amélioration robustesse pour fichiers STEP complexes
  - Gestion des erreurs de connexion PostgreSQL avec reconnexion automatique
  - Timeout dynamique basé sur la taille du fichier : 10s/MB, min 60s, max 10 minutes
  - Messages utilisateur améliorés indiquant temps de conversion estimé
  - 3 méthodes d'export STL en cascade pour meilleure compatibilité
  - Tracking en mémoire si la base de données est indisponible
  - Support garanti pour tout fichier STEP peu importe sa complexité
  - Tolérance adaptative automatique pour gros fichiers (>10MB)
- 2 juillet 2025 : Ajout demo section sur landing page avec exemple de rapport et viewer 3D
  - Nouvelle section "Découvrez CADlytics en action" entre Comment ça marche et Tarifs
  - Viewer 3D intégré avec Three.js affichant un modèle STL en rotation automatique
  - Exemple de rapport DFM statique montrant score 8.5/10 et recommandations matériaux
  - Design responsive avec grille adaptative pour mobile
  - Fichier demo STL créé dans /static/demo_cube.stl
  - Route /static ajoutée pour servir les fichiers statiques
  - Animation 3D avec éclairage réaliste et couleurs kaki cohérentes
- 2 juillet 2025 : Ajout footer complet avec pages légales
  - Footer restructuré en 3 colonnes : Navigation, Légal, Contact
  - Création de 4 pages légales : Mentions légales, RGPD, CGV, Cookies
  - Routes ajoutées dans app.py pour toutes les pages légales
  - Design cohérent avec la palette kaki/brun sur toutes les pages
  - Navigation simplifiée avec retour à l'accueil sur chaque page
- 2 juillet 2025 : Suppression de la visualisation 3D de la landing page
  - Retrait de la section de visualisation 3D interactive dans le dashboard preview
  - Suppression du style CSS .stat-chart associé
  - Nettoyage de la structure HTML pour une présentation plus épurée
  - Le dashboard preview affiche maintenant uniquement les statistiques clés
- 2 juillet 2025 : Refonte visuelle complète de la landing page
  - Design moderne inspiré d'interfaces crypto avec palette kaki/brun (#a8a068, #4a3c28, #d4af37)
  - Suppression définitive des offres "gratuite" et "entreprise", garde uniquement Pack 5 et Pro
  - Nouvelles sections ajoutées : "Pourquoi CADlytics" et "Comment ça marche"
  - Dashboard preview intégré dans la hero section avec statistiques DFM
  - Header minimaliste avec navigation simplifiée
  - Footer épuré avec liens essentiels
  - Suppression des animations complexes pour une expérience plus fluide
- 1er juillet 2025 : Historique personnel et correction génération PDF
  - Ajout colonne user_id dans ConversionJob pour lier l'historique au compte utilisateur
  - Filtrage des conversions par utilisateur connecté dans l'API /api/conversions
  - Correction de l'import manquant Tuple dans pdf_generator.py
  - Génération de vues 3D simplifiées avec wireframe pour éviter les timeouts
  - L'historique est maintenant personnel et lié à chaque compte utilisateur
- 1er juillet 2025 : Refonte complète de la logique d'analyse DFM pour intelligence contextuelle
  - Nouveau système de scoring adaptatif basé sur le type de pièce détecté (plaque, profilé, volumique)
  - Analyse intelligente de l'épaisseur dominante avec ratios d'aspect et volume/surface
  - Intégration de profils matériaux spécifiques (PP, PE, ABS, PC, PA66, POM, PS) avec tolérances adaptées
  - Pondération contextuelle des défauts : ne sanctionne plus excessivement les défauts isolés
  - Système de recommandations proportionnelles avec codes couleur (🔴🟡🟢)
  - Seuils de tolérance pour dépouille et congés (ex: 1-2 congés manquants = acceptable)
  - Adaptation automatique selon le matériau (ex: PC tolère mieux les parois épaisses)
  - Scoring "humainement logique" évitant les notes catastrophiques injustifiées
  - Messages détaillés dans la console pour comprendre la logique de notation
  - Bonus pour les conceptions optimales avec peu ou pas de défauts
- 1er juillet 2025 : Optimisation pour gros fichiers STL et amélioration des performances
  - Tolérance adaptative pour conversion STEP→STL : augmente automatiquement pour fichiers >10MB
  - Streaming par chunks pour servir les gros fichiers STL (>10MB) évitant les timeouts
  - Optimisation viewer 3D : matériaux simplifiés pour modèles >500k vertices
  - Indicateur de chargement avec barre de progression pour STL
  - Réduction pixel ratio automatique pour gros modèles (performance GPU)
  - Gestion d'erreur améliorée avec messages spécifiques selon le problème
- 1er juillet 2025 : Refonte complète fonction de coupe 3D pour ergonomie optimale
  - Réécriture complète avec implémentation simplifiée et intuitive
  - Nouvelle fonction createSimpleCrossSectionPlane() avec clipping planes fonctionnel
  - Interface ergonomique : bouton "Coupe 3D" → "Arrêter coupe" avec couleur warning
  - Plan de coupe orange visible avec contrôles clavier intuitifs (↑↓ déplacer, Espace masquer, Échap quitter)
  - Instructions contextuelles claires affichées pendant l'utilisation
  - Gestion propre des événements et nettoyage automatique des ressources
- 1er juillet 2025 : Amélioration fonction coupe 3D et thème viewer
  - Mode clair/sombre n'affecte que le viewer 3D (pas toute l'interface)
  - Menu déroulant pour choisir l'axe de coupe (X, Y, Z) remplaçant les touches clavier
  - Bouton de coupe affiche l'axe actuel : "Arrêter coupe (X)" par exemple
  - Menu déroulant apparaît automatiquement quand mode coupe activé
  - Instructions mises à jour pour refléter les nouveaux contrôles ergonomiques
- 1er juillet 2025 : Nouvelles fonctionnalités d'analyse avancée
  - Indicateur "Prêt pour injection" avec feu vert/jaune/rouge selon qualité DFM
  - Check-list interactive de préparation au moulage avec validation automatique
  - Viewer 3D avec surbrillance des défauts (sphères rouges/oranges pour problèmes)
  - Téléchargement ZIP complet avec fichier STEP, rapport PDF et données JSON
  - Stockage des données DFM complètes en session pour export
  - Bouton "Défauts" pour afficher/masquer les zones problématiques en 3D
- 30 juin 2025 : Correction système de crédits et authentification Google
  - Résolution erreur Google OAuth : colonnes manquantes ajoutées à la base de données
  - Système de crédits corrigé : décompte automatique après analyse DFM
  - Vérification des crédits avant analyse DFM avec messages d'erreur appropriés
  - Logs détaillés pour suivi de l'utilisation des crédits
  - Base de données mise à jour avec toutes les colonnes utilisateur nécessaires
- 30 juin 2025 : Correction finale de l'interface d'authentification et page tarifs
  - Champs de saisie avec fond blanc et texte noir pour visibilité maximale
  - Titres H2 en blanc avec ombre portée sur pages login/register
  - Labels en blanc avec police agrandie et ombre
  - Bordures dorées épaisses sur les champs de saisie
  - Page tarifs : suppression mention "IA", cartes avec texte noir lisible
  - Design cohérent kaki/brun avec contraste optimal pour l'accessibilité
- 30 juin 2025 : Réorganisation ergonomique de l'interface utilisateur
  - Outils 3D (mesure, coupe, filaire, axes) intégrés directement au visualisateur
  - Analyse DFM repositionnée juste sous le visualisateur pour flux logique
  - Boutons d'action compacts et organisés par thématiques
  - Suppression de la sidebar redondante pour l'analyse DFM
  - Interface plus fluide avec contrôles groupés par contexte d'usage
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