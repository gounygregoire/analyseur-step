"""
Système d'authentification pour CADlytics
Gère la connexion par email/mot de passe et Google OAuth
"""
from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify
from flask_login import login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from models import db, User
import re

auth_bp = Blueprint('auth', __name__)

def validate_email(email):
    """Vérifie que l'email est valide"""
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return re.match(pattern, email) is not None

def validate_password(password):
    """Vérifie que le mot de passe est assez fort (min 8 caractères)"""
    return len(password) >= 8

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    """Page de connexion"""
    if request.method == 'POST':
        email = request.form.get('email', '').lower().strip()
        password = request.form.get('password', '')
        
        # Validation
        if not email or not password:
            flash('Email et mot de passe requis', 'danger')
            return render_template('auth/login.html')
        
        # Chercher l'utilisateur
        user = User.query.filter_by(email=email).first()
        
        if user and user.password_hash and check_password_hash(user.password_hash, password):
            login_user(user, remember=True)
            next_page = request.args.get('next')
            return redirect(next_page) if next_page else redirect(url_for('upload_page'))
        else:
            flash('Email ou mot de passe incorrect', 'danger')
    
    return render_template('auth/login.html')

@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    """Page d'inscription"""
    if request.method == 'POST':
        email = request.form.get('email', '').lower().strip()
        password = request.form.get('password', '')
        password_confirm = request.form.get('password_confirm', '')
        first_name = request.form.get('first_name', '').strip()
        last_name = request.form.get('last_name', '').strip()
        
        # Validations
        errors = []
        if not validate_email(email):
            errors.append('Email invalide')
        if not validate_password(password):
            errors.append('Le mot de passe doit faire au moins 8 caractères')
        if password != password_confirm:
            errors.append('Les mots de passe ne correspondent pas')
        
        # Vérifier si l'email existe déjà
        if User.query.filter_by(email=email).first():
            errors.append('Cet email est déjà utilisé')
        
        if errors:
            for error in errors:
                flash(error, 'danger')
            return render_template('auth/register.html')
        
        # Créer l'utilisateur
        user = User(
            email=email,
            password_hash=generate_password_hash(password),
            first_name=first_name,
            last_name=last_name,
            credits=5  # 5 crédits gratuits à l'inscription
        )
        
        db.session.add(user)
        db.session.commit()
        
        # Connecter automatiquement
        login_user(user, remember=True)
        flash('Compte créé avec succès ! Vous avez 5 analyses gratuites.', 'success')
        return redirect(url_for('upload_page'))
    
    return render_template('auth/register.html')

@auth_bp.route('/logout')
@login_required
def logout():
    """Déconnexion"""
    logout_user()
    flash('Vous êtes déconnecté', 'info')
    return redirect(url_for('landing'))

@auth_bp.route('/profile')
@login_required
def profile():
    """Page de profil utilisateur"""
    return render_template('auth/profile.html', user=current_user)

@auth_bp.route('/api/check-auth')
def check_auth():
    """API pour vérifier si l'utilisateur est connecté"""
    if current_user.is_authenticated:
        return jsonify({
            'authenticated': True,
            'email': current_user.email,
            'credits': current_user.credits,
            'is_premium': current_user.is_premium
        })
    return jsonify({'authenticated': False})