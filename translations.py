"""
Système de traduction pour CADlytitcs
Supporte le français et l'anglais
"""

translations = {
    'fr': {
        # Navigation
        'nav_home': 'Accueil',
        'nav_app': 'Application',
        'nav_pricing': 'Tarifs',
        'nav_profile': 'Profil',
        'nav_logout': 'Déconnexion',
        'nav_login': 'Connexion',
        'nav_register': 'Inscription',
        
        # Landing page
        'hero_title': 'CADlytitcs',
        'hero_subtitle': 'Analyse DFM avancée pour l\'injection plastique',
        'hero_description': 'Optimisez vos pièces plastiques avec notre analyse DFM intelligente. Détectez les problèmes de moulabilité, recevez des recommandations de matériaux et améliorez votre conception.',
        'hero_cta': 'Essayer maintenant',
        'hero_checklist_title': 'Tout ce dont vous avez besoin pour valider vos pièces',
        'hero_checklist_1': 'Analyse DFM complète',
        'hero_checklist_2': 'Rapport PDF professionnel',
        'hero_checklist_3': 'Recommandations de matériaux',
        'hero_checklist_4': 'Visualisation 3D avancée',
        
        # Landing sections
        'section_how_title': 'Comment ça marche ?',
        'section_how_step1_title': 'Téléchargez votre fichier',
        'section_how_step1_desc': 'Importez votre fichier STEP directement depuis votre CAO',
        'section_how_step2_title': 'Analyse automatique',
        'section_how_step2_desc': 'Notre IA analyse votre pièce en quelques secondes',
        'section_how_step3_title': 'Rapport détaillé',
        'section_how_step3_desc': 'Recevez un rapport PDF complet avec recommandations',
        
        'section_why_title': 'Pourquoi CADlytitcs ?',
        'section_why_reliable_title': 'Analyse fiable',
        'section_why_reliable_desc': 'Algorithmes basés sur les meilleures pratiques de l\'industrie',
        'section_why_fast_title': 'Résultats rapides',
        'section_why_fast_desc': 'Obtenez votre analyse en moins de 30 secondes',
        'section_why_expert_title': 'Recommandations expertes',
        'section_why_expert_desc': 'Conseils personnalisés pour optimiser vos pièces',
        
        'section_demo_title': 'Découvrez CADlytitcs en action',
        'section_demo_viewer_title': 'Visualisateur 3D interactif',
        'section_demo_report_title': 'Rapport d\'analyse DFM',
        'section_demo_report_score': 'Score de moulabilité',
        'section_demo_report_materials': 'Matériaux recommandés',
        'section_demo_report_pp': 'Polypropylène (PP)',
        'section_demo_report_abs': 'ABS',
        'section_demo_report_pc': 'Polycarbonate (PC)',
        
        # Application
        'upload_title': 'Télécharger un fichier STEP',
        'upload_button': 'Visualiser',
        'dfm_button': 'Analyser DFM',
        'pdf_button': 'Générer rapport PDF',
        'zip_button': 'Télécharger ZIP',
        
        # DFM Analysis
        'dfm_title': 'Analyse DFM',
        'dfm_score': 'Score DFM',
        'dfm_dimensions': 'Dimensions',
        'dfm_volume': 'Volume',
        'dfm_thickness': 'Épaisseur maximale',
        'dfm_cooling_time': 'Temps de refroidissement',
        'dfm_issues': 'Problèmes détectés',
        'dfm_recommendations': 'Recommandations',
        'dfm_material_recommendations': 'Matériaux recommandés',
        
        # Materials
        'material_advantages': 'Avantages',
        'material_limitations': 'Limitations',
        'material_applications': 'Applications typiques',
        'material_cost': 'Coût',
        'material_processing': 'Notes de transformation',
        
        # Messages
        'msg_upload_success': 'Fichier téléchargé avec succès',
        'msg_upload_error': 'Erreur lors du téléchargement',
        'msg_conversion_progress': 'Conversion en cours...',
        'msg_dfm_analysis_progress': 'Analyse DFM en cours...',
        'msg_no_credits': 'Vous n\'avez plus de crédits. Veuillez acheter un pack ou souscrire à un abonnement.',
        
        # Footer
        'footer_created_by': 'Créé par Grégoire GOUNY',
        'footer_report_bug': 'Signaler un bug',
        'footer_legal': 'Mentions légales',
        'footer_privacy': 'Politique RGPD',
        'footer_terms': 'CGV',
        'footer_cookies': 'Cookies',
        
        # Viewer 3D
        'viewer_measure': 'Mesurer',
        'viewer_section': 'Coupe 3D',
        'viewer_wireframe': 'Mode filaire',
        'viewer_axes': 'Afficher axes',
        'viewer_defects': 'Défauts',
        'viewer_stop_section': 'Arrêter coupe',
        'viewer_measurement': 'Distance',
        'viewer_volume': 'Volume',
        'viewer_dark_mode': 'Mode sombre',
        'viewer_light_mode': 'Mode clair',
        
        # Upload
        'upload_tolerance': 'Tolérance de conversion',
        'upload_high_precision': 'Haute précision (0.01mm)',
        'upload_standard': 'Standard (0.1mm)',
        'upload_fast': 'Rapide (0.5mm)',
        'upload_info': 'Plus précis = meilleure qualité mais plus lent',
        'upload_visualize': 'Visualiser',
        'upload_progress': 'Fichier sélectionné',
        
        # DFM Details
        'dfm_wall_issues': 'Problèmes d\'épaisseur de paroi',
        'dfm_geometry_issues': 'Problèmes de géométrie',
        'dfm_too_thin': 'Trop fin',
        'dfm_too_thick': 'Trop épais',
        'dfm_no_draft': 'Pas de dépouille',
        'dfm_sharp_edges': 'Arêtes vives',
        'dfm_deep_holes': 'Trous profonds',
        'dfm_height_issue': 'Hauteur excessive',
        'dfm_ready_for_injection': 'Prêt pour injection',
        
        # History
        'history_processing': 'En cours',
        'history_completed': 'Terminé',
        'history_failed': 'Échoué',
        
        # Messages
        'msg_select_file': 'Veuillez sélectionner un fichier',
        'msg_conversion_time': 'Temps estimé',
        'msg_per_mb': 'par MB',
        'msg_seconds': 'secondes',
        
        # Pricing
        'pricing_title': 'Tarifs',
        'pricing_pack5': 'Pack 5 analyses',
        'pricing_pro': 'Abonnement Pro',
        'pricing_analyses': 'analyses',
        'pricing_unlimited': 'Analyses illimitées',
        'pricing_buy': 'Acheter',
        'pricing_subscribe': 'S\'abonner',
        
        # Auth
        'auth_email': 'Email',
        'auth_password': 'Mot de passe',
        'auth_password_confirm': 'Confirmer le mot de passe',
        'auth_confirm_password': 'Confirmer le mot de passe',
        'auth_firstname': 'Prénom',
        'auth_lastname': 'Nom',
        'auth_first_name': 'Prénom',
        'auth_last_name': 'Nom',
        'auth_login': 'Se connecter',
        'auth_register': 'S\'inscrire',
        'auth_create_account': 'Créer un compte',
        'auth_google_login': 'Se connecter avec Google',
        'auth_google': 'Continuer avec Google',
        'auth_no_account': 'Pas encore de compte ?',
        'auth_have_account': 'Déjà un compte ?',
        'auth_min_chars': 'Minimum 8 caractères',
        'auth_free_credits': '<strong>🎉 Offre de lancement !</strong> Les 20 premiers inscrits reçoivent <strong>15 analyses gratuites</strong> au lieu de 5.',
    },
    'en': {
        # Navigation
        'nav_home': 'Home',
        'nav_app': 'Application',
        'nav_pricing': 'Pricing',
        'nav_profile': 'Profile',
        'nav_logout': 'Logout',
        'nav_login': 'Login',
        'nav_register': 'Sign up',
        
        # Landing page
        'hero_title': 'CADlytitcs',
        'hero_subtitle': 'Advanced DFM Analysis for Plastic Injection',
        'hero_description': 'Optimize your plastic parts with our intelligent DFM analysis. Detect moldability issues, get material recommendations and improve your design.',
        'hero_cta': 'Try now',
        'hero_checklist_title': 'Everything you need to validate your parts',
        'hero_checklist_1': 'Complete DFM analysis',
        'hero_checklist_2': 'Professional PDF report',
        'hero_checklist_3': 'Material recommendations',
        'hero_checklist_4': 'Advanced 3D visualization',
        
        # Landing sections
        'section_how_title': 'How it works?',
        'section_how_step1_title': 'Upload your file',
        'section_how_step1_desc': 'Import your STEP file directly from your CAD',
        'section_how_step2_title': 'Automatic analysis',
        'section_how_step2_desc': 'Our AI analyzes your part in seconds',
        'section_how_step3_title': 'Detailed report',
        'section_how_step3_desc': 'Get a complete PDF report with recommendations',
        
        'section_why_title': 'Why CADlytitcs?',
        'section_why_reliable_title': 'Reliable analysis',
        'section_why_reliable_desc': 'Algorithms based on industry best practices',
        'section_why_fast_title': 'Fast results',
        'section_why_fast_desc': 'Get your analysis in less than 30 seconds',
        'section_why_expert_title': 'Expert recommendations',
        'section_why_expert_desc': 'Personalized advice to optimize your parts',
        
        'section_demo_title': 'Discover CADlytitcs in action',
        'section_demo_viewer_title': 'Interactive 3D viewer',
        'section_demo_report_title': 'DFM Analysis Report',
        'section_demo_report_score': 'Moldability score',
        'section_demo_report_materials': 'Recommended materials',
        'section_demo_report_pp': 'Polypropylene (PP)',
        'section_demo_report_abs': 'ABS',
        'section_demo_report_pc': 'Polycarbonate (PC)',
        
        # Application
        'upload_title': 'Upload a STEP file',
        'upload_button': 'Visualize',
        'dfm_button': 'Analyze DFM',
        'pdf_button': 'Generate PDF report',
        'zip_button': 'Download ZIP',
        
        # DFM Analysis
        'dfm_title': 'DFM Analysis',
        'dfm_score': 'DFM Score',
        'dfm_dimensions': 'Dimensions',
        'dfm_volume': 'Volume',
        'dfm_thickness': 'Maximum thickness',
        'dfm_cooling_time': 'Cooling time',
        'dfm_issues': 'Issues detected',
        'dfm_recommendations': 'Recommendations',
        'dfm_material_recommendations': 'Recommended materials',
        
        # Materials
        'material_advantages': 'Advantages',
        'material_limitations': 'Limitations',
        'material_applications': 'Typical applications',
        'material_cost': 'Cost',
        'material_processing': 'Processing notes',
        
        # Messages
        'msg_upload_success': 'File uploaded successfully',
        'msg_upload_error': 'Error uploading file',
        'msg_conversion_progress': 'Converting...',
        'msg_dfm_analysis_progress': 'DFM analysis in progress...',
        'msg_no_credits': 'You have no credits left. Please purchase a pack or subscribe.',
        
        # Footer
        'footer_created_by': 'Created by Grégoire GOUNY',
        'footer_report_bug': 'Report a bug',
        'footer_legal': 'Legal notice',
        'footer_privacy': 'Privacy policy',
        'footer_terms': 'Terms of service',
        'footer_cookies': 'Cookies',
        
        # Viewer 3D
        'viewer_measure': 'Measure',
        'viewer_section': '3D Section',
        'viewer_wireframe': 'Wireframe mode',
        'viewer_axes': 'Show axes',
        'viewer_defects': 'Defects',
        'viewer_stop_section': 'Stop section',
        'viewer_measurement': 'Distance',
        'viewer_volume': 'Volume',
        'viewer_dark_mode': 'Dark mode',
        'viewer_light_mode': 'Light mode',
        
        # Upload
        'upload_tolerance': 'Conversion tolerance',
        'upload_high_precision': 'High precision (0.01mm)',
        'upload_standard': 'Standard (0.1mm)',
        'upload_fast': 'Fast (0.5mm)',
        'upload_info': 'More precise = better quality but slower',
        'upload_visualize': 'Visualize',
        'upload_progress': 'File selected',
        
        # DFM Details
        'dfm_wall_issues': 'Wall thickness issues',
        'dfm_geometry_issues': 'Geometry issues',
        'dfm_too_thin': 'Too thin',
        'dfm_too_thick': 'Too thick',
        'dfm_no_draft': 'No draft angle',
        'dfm_sharp_edges': 'Sharp edges',
        'dfm_deep_holes': 'Deep holes',
        'dfm_height_issue': 'Excessive height',
        'dfm_ready_for_injection': 'Ready for injection',
        
        # History
        'history_processing': 'Processing',
        'history_completed': 'Completed',
        'history_failed': 'Failed',
        
        # Messages
        'msg_select_file': 'Please select a file',
        'msg_conversion_time': 'Estimated time',
        'msg_per_mb': 'per MB',
        'msg_seconds': 'seconds',
        
        # Pricing
        'pricing_title': 'Pricing',
        'pricing_pack5': 'Pack 5 analyses',
        'pricing_pro': 'Pro subscription',
        'pricing_analyses': 'analyses',
        'pricing_unlimited': 'Unlimited analyses',
        'pricing_buy': 'Buy',
        'pricing_subscribe': 'Subscribe',
        
        # Auth
        'auth_email': 'Email',
        'auth_password': 'Password',
        'auth_password_confirm': 'Confirm password',
        'auth_confirm_password': 'Confirm password',
        'auth_firstname': 'First name',
        'auth_lastname': 'Last name',
        'auth_first_name': 'First name',
        'auth_last_name': 'Last name',
        'auth_login': 'Login',
        'auth_register': 'Sign up',
        'auth_create_account': 'Create account',
        'auth_google_login': 'Login with Google',
        'auth_google': 'Continue with Google',
        'auth_no_account': 'Don\'t have an account?',
        'auth_have_account': 'Already have an account?',
        'auth_min_chars': 'Minimum 8 characters',
        'auth_free_credits': '<strong>🎉 Launch offer!</strong> The first 20 users get <strong>15 free analyses</strong> instead of 5.',
    }
}

def get_translation(key, lang='fr'):
    """
    Récupère une traduction selon la langue
    
    Args:
        key: Clé de traduction
        lang: Code de langue ('fr' ou 'en')
    
    Returns:
        Texte traduit ou la clé si non trouvée
    """
    if lang not in translations:
        lang = 'fr'
    
    return translations.get(lang, {}).get(key, key)

def get_all_translations(lang='fr'):
    """
    Récupère toutes les traductions pour une langue
    
    Args:
        lang: Code de langue ('fr' ou 'en')
    
    Returns:
        Dictionnaire de toutes les traductions
    """
    if lang not in translations:
        lang = 'fr'
    
    return translations.get(lang, {})