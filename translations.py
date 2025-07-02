"""
Système de traduction pour CADlytics
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
        'hero_title': 'CADlytics',
        'hero_subtitle': 'Analyse DFM avancée pour l\'injection plastique',
        'hero_description': 'Optimisez vos pièces plastiques avec notre analyse DFM intelligente. Détectez les problèmes de moulabilité, recevez des recommandations de matériaux et améliorez votre conception.',
        'hero_cta': 'Essayer maintenant',
        
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
        'auth_firstname': 'Prénom',
        'auth_lastname': 'Nom',
        'auth_login': 'Se connecter',
        'auth_register': 'S\'inscrire',
        'auth_google_login': 'Se connecter avec Google',
        'auth_no_account': 'Pas encore de compte ?',
        'auth_have_account': 'Déjà un compte ?',
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
        'hero_title': 'CADlytics',
        'hero_subtitle': 'Advanced DFM Analysis for Plastic Injection',
        'hero_description': 'Optimize your plastic parts with our intelligent DFM analysis. Detect moldability issues, get material recommendations and improve your design.',
        'hero_cta': 'Try now',
        
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
        'auth_firstname': 'First name',
        'auth_lastname': 'Last name',
        'auth_login': 'Login',
        'auth_register': 'Sign up',
        'auth_google_login': 'Login with Google',
        'auth_no_account': 'Don\'t have an account?',
        'auth_have_account': 'Already have an account?',
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