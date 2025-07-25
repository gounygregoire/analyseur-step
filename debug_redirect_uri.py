import os
from flask import Flask
from flask_dance.contrib.google import make_google_blueprint

# Les identifiants doivent être fournis via les variables d'environnement
client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")

app = Flask(__name__)
app.config["SERVER_NAME"] = "cadlytitcs.com"

google_bp = make_google_blueprint(
    client_id=client_id,
    client_secret=client_secret,
    scope=["profile", "email"],  # <-- Virgule ici
    redirect_url="https://cadlytitcs.com/google_login/authorized"
)

app.register_blueprint(google_bp, url_prefix="/google_login")

with app.app_context():
    print("REDIRECT_URI:", google_bp.redirect_url)
