import os
from flask import Flask
from flask_dance.contrib.google import make_google_blueprint

# Simule l'environnement
os.environ["GOOGLE_OAUTH_CLIENT_ID"] = "1089845484563-e76fjph8rr39t33o47v8p5t76erlmt36.apps.googleusercontent.com"
os.environ["GOOGLE_OAUTH_CLIENT_SECRET"] = "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"

app = Flask(__name__)
app.config["SERVER_NAME"] = "cadlytitcs.com"

google_bp = make_google_blueprint(
    client_id="test",
    client_secret="test",
    scope=["profile", "email"],  # <-- Virgule ici
    redirect_url="https://cadlytitcs.com/google_login/authorized"
)

app.register_blueprint(google_bp, url_prefix="/google_login")

with app.app_context():
    print("REDIRECT_URI:", google_bp.redirect_url)