"""
Système de paiement Stripe pour CADlytics
Gère les paiements à l'usage et les abonnements
"""
import os
import stripe
from flask import Blueprint, request, redirect, url_for, flash, jsonify
from flask_login import login_required, current_user
from models import db, User

# Configuration Stripe
stripe.api_key = os.environ.get('STRIPE_SECRET_KEY')
STRIPE_WEBHOOK_SECRET = os.environ.get('STRIPE_WEBHOOK_SECRET')

# Configuration des produits
STRIPE_PRICE_CREDITS = os.environ.get('STRIPE_PRICE_CREDITS', 'price_credits')  # Prix pour 5 crédits
STRIPE_PRICE_SUBSCRIPTION = os.environ.get('STRIPE_PRICE_SUBSCRIPTION', 'price_subscription')  # Prix abonnement

# Domaine pour les URLs de retour
YOUR_DOMAIN = os.environ.get('REPLIT_DEV_DOMAIN', 'localhost:5000')
if not YOUR_DOMAIN.startswith('http'):
    YOUR_DOMAIN = f'https://{YOUR_DOMAIN}'

stripe_bp = Blueprint('stripe', __name__)

@stripe_bp.route('/buy-credits')
@login_required
def buy_credits():
    """Acheter 5 crédits pour 5€"""
    try:
        # Créer ou récupérer le client Stripe
        if not current_user.stripe_customer_id:
            customer = stripe.Customer.create(
                email=current_user.email,
                name=f"{current_user.first_name} {current_user.last_name}".strip(),
                metadata={'user_id': current_user.id}
            )
            current_user.stripe_customer_id = customer.id
            db.session.commit()
        
        # Créer la session de paiement
        session = stripe.checkout.Session.create(
            customer=current_user.stripe_customer_id,
            payment_method_types=['card'],
            line_items=[{
                'price': STRIPE_PRICE_CREDITS,
                'quantity': 1,
            }],
            mode='payment',
            success_url=YOUR_DOMAIN + '/stripe/success?type=credits',
            cancel_url=YOUR_DOMAIN + '/pricing',
            metadata={
                'user_id': current_user.id,
                'type': 'credits'
            }
        )
        
        return redirect(session.url, code=303)
        
    except Exception as e:
        flash(f"Erreur lors de la création du paiement: {str(e)}", "danger")
        return redirect(url_for('pricing'))

@stripe_bp.route('/subscribe')
@login_required
def subscribe():
    """S'abonner pour 23,99€/mois"""
    try:
        # Créer ou récupérer le client Stripe
        if not current_user.stripe_customer_id:
            customer = stripe.Customer.create(
                email=current_user.email,
                name=f"{current_user.first_name} {current_user.last_name}".strip(),
                metadata={'user_id': current_user.id}
            )
            current_user.stripe_customer_id = customer.id
            db.session.commit()
        
        # Créer la session de paiement pour l'abonnement
        session = stripe.checkout.Session.create(
            customer=current_user.stripe_customer_id,
            payment_method_types=['card'],
            line_items=[{
                'price': STRIPE_PRICE_SUBSCRIPTION,
                'quantity': 1,
            }],
            mode='subscription',
            success_url=YOUR_DOMAIN + '/stripe/success?type=subscription',
            cancel_url=YOUR_DOMAIN + '/pricing',
            metadata={
                'user_id': current_user.id,
                'type': 'subscription'
            }
        )
        
        return redirect(session.url, code=303)
        
    except Exception as e:
        flash(f"Erreur lors de la création de l'abonnement: {str(e)}", "danger")
        return redirect(url_for('pricing'))

@stripe_bp.route('/success')
@login_required
def payment_success():
    """Page de succès après paiement"""
    payment_type = request.args.get('type')
    
    if payment_type == 'credits':
        flash('Merci pour votre achat ! Vos 5 crédits ont été ajoutés.', 'success')
    elif payment_type == 'subscription':
        flash('Merci pour votre abonnement ! Vous avez maintenant accès illimité.', 'success')
    
    return redirect(url_for('auth.profile'))

@stripe_bp.route('/cancel-subscription', methods=['POST'])
@login_required
def cancel_subscription():
    """Annuler l'abonnement"""
    if not current_user.stripe_subscription_id:
        flash("Vous n'avez pas d'abonnement actif", "warning")
        return redirect(url_for('auth.profile'))
    
    try:
        # Annuler l'abonnement à la fin de la période
        stripe.Subscription.modify(
            current_user.stripe_subscription_id,
            cancel_at_period_end=True
        )
        flash("Votre abonnement sera annulé à la fin de la période actuelle", "info")
    except Exception as e:
        flash(f"Erreur lors de l'annulation: {str(e)}", "danger")
    
    return redirect(url_for('auth.profile'))

@stripe_bp.route('/webhook', methods=['POST'])
def stripe_webhook():
    """Webhook Stripe pour gérer les événements de paiement"""
    payload = request.get_data(as_text=True)
    sig_header = request.headers.get('Stripe-Signature')
    
    try:
        # Vérifier la signature du webhook
        event = stripe.Webhook.construct_event(
            payload, sig_header, STRIPE_WEBHOOK_SECRET
        )
    except ValueError:
        # Payload invalide
        return 'Invalid payload', 400
    except stripe.error.SignatureVerificationError:
        # Signature invalide
        return 'Invalid signature', 400
    
    # Gérer les différents types d'événements
    if event['type'] == 'checkout.session.completed':
        session = event['data']['object']
        handle_checkout_session(session)
    
    elif event['type'] == 'customer.subscription.created':
        subscription = event['data']['object']
        handle_subscription_created(subscription)
    
    elif event['type'] == 'customer.subscription.deleted':
        subscription = event['data']['object']
        handle_subscription_deleted(subscription)
    
    return jsonify(success=True)

def handle_checkout_session(session):
    """Gérer une session de paiement complétée"""
    user_id = session['metadata'].get('user_id')
    payment_type = session['metadata'].get('type')
    
    if not user_id:
        return
    
    user = User.query.get(user_id)
    if not user:
        return
    
    if payment_type == 'credits':
        # Ajouter 5 crédits
        user.credits += 5
        db.session.commit()
    
def handle_subscription_created(subscription):
    """Gérer la création d'un abonnement"""
    customer_id = subscription['customer']
    subscription_id = subscription['id']
    
    # Trouver l'utilisateur
    user = User.query.filter_by(stripe_customer_id=customer_id).first()
    if user:
        user.stripe_subscription_id = subscription_id
        user.is_premium = True
        db.session.commit()

def handle_subscription_deleted(subscription):
    """Gérer la suppression d'un abonnement"""
    subscription_id = subscription['id']
    
    # Trouver l'utilisateur
    user = User.query.filter_by(stripe_subscription_id=subscription_id).first()
    if user:
        user.stripe_subscription_id = None
        user.is_premium = False
        db.session.commit()