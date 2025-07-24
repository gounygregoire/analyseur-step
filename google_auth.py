"""
Authentification Google OAuth pour CADlytics
"""
import json
import os
import requests
from flask import Blueprint, redirect, request, url_for, flash
from flask_login import login_user
from models import db, User
from log import log_action
from oauthlib.oauth2 import WebApplicationClient

# Configuration Google OAuth
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")
GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"

# URL de redirection pour l'environnement de développement
DEV_REDIRECT_URL = f'https://{os.environ.get("REPLIT_DEV_DOMAIN", "localhost:5000")}/google_login/callback'

# Afficher les instructions de configuration
print(f"""Pour configurer Google OAuth:
1. Allez sur https://console.cloud.google.com/apis/credentials
2. Créez un nouvel ID client OAuth 2.0
3. Ajoutez {DEV_REDIRECT_URL} aux URI de redirection autorisés
4. Copiez l'ID client et le secret dans les variables d'environnement
""")

# Client OAuth
client = WebApplicationClient(GOOGLE_CLIENT_ID) if GOOGLE_CLIENT_ID else None

google_auth_bp = Blueprint("google_auth", __name__)

@google_auth_bp.route("/google_login")
def google_login():
    """Initie la connexion Google"""
    if not GOOGLE_CLIENT_ID:
        flash("Google OAuth n'est pas configuré. Contactez l'administrateur.", "danger")
        return redirect(url_for("auth.login"))
    
    # Obtenir l'URL d'autorisation Google
    google_provider_cfg = requests.get(GOOGLE_DISCOVERY_URL).json()
    authorization_endpoint = google_provider_cfg["authorization_endpoint"]
    
    # Préparer la requête OAuth
    request_uri = client.prepare_request_uri(
        authorization_endpoint,
        redirect_uri=request.base_url.replace("http://", "https://") + "/callback",
        scope=["openid", "email", "profile"],
    )
    return redirect(request_uri)

@google_auth_bp.route("/google_login/callback")
def google_callback():
    """Gère le retour de Google après connexion"""
    if not GOOGLE_CLIENT_ID:
        flash("Google OAuth n'est pas configuré", "danger")
        return redirect(url_for("auth.login"))
    
    # Obtenir le code d'autorisation
    code = request.args.get("code")
    
    # Préparer la requête pour obtenir le token
    google_provider_cfg = requests.get(GOOGLE_DISCOVERY_URL).json()
    token_endpoint = google_provider_cfg["token_endpoint"]
    
    token_url, headers, body = client.prepare_token_request(
        token_endpoint,
        authorization_response=request.url.replace("http://", "https://"),
        redirect_url=request.base_url.replace("http://", "https://"),
        code=code,
    )
    
    # Obtenir le token
    token_response = requests.post(
        token_url,
        headers=headers,
        data=body,
        auth=(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET),
    )
    
    # Parser la réponse
    client.parse_request_body_response(json.dumps(token_response.json()))
    
    # Obtenir les informations utilisateur
    userinfo_endpoint = google_provider_cfg["userinfo_endpoint"]
    uri, headers, body = client.add_token(userinfo_endpoint)
    userinfo_response = requests.get(uri, headers=headers, data=body)
    
    if userinfo_response.json().get("email_verified"):
        google_id = userinfo_response.json()["sub"]
        email = userinfo_response.json()["email"]
        first_name = userinfo_response.json().get("given_name", "")
        last_name = userinfo_response.json().get("family_name", "")
        picture = userinfo_response.json().get("picture", "")
    else:
        flash("Email non vérifié par Google", "danger")
        return redirect(url_for("auth.login"))
    
    # Chercher ou créer l'utilisateur
    user = User.query.filter_by(google_id=google_id).first()
    
    if not user:
        # Vérifier si un utilisateur avec cet email existe déjà
        user = User.query.filter_by(email=email).first()
        
        if user:
            # Lier le compte Google au compte existant
            user.google_id = google_id
            user.profile_image_url = picture
        else:
            # Créer un nouveau compte
            user = User(
                email=email,
                google_id=google_id,
                first_name=first_name,
                last_name=last_name,
                profile_image_url=picture,
                credits=5  # 5 crédits gratuits à l'inscription
            )
            db.session.add(user)
        
        db.session.commit()
    
    # Connecter l'utilisateur
    login_user(user, remember=True)
    
    # Log l'action de connexion
    log_action('login', user_id=user.id, extra={
        'user_email': user.email,
        'login_method': 'google_oauth'
    })
    
    # Message de bienvenue
    if user.credits == 5 and not user.is_premium:
        flash(f"Bienvenue {user.first_name} ! Vous avez 5 analyses gratuites.", "success")
    else:
        flash(f"Bon retour {user.first_name} !", "success")
    
    return redirect(url_for("index"))
