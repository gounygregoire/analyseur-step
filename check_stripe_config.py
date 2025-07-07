#!/usr/bin/env python3
"""
Script de vérification de la configuration Stripe
Aide à vérifier que les variables d'environnement sont correctement configurées
"""
import os
import stripe

# Configuration
stripe.api_key = os.environ.get('STRIPE_SECRET_KEY')

def check_stripe_config():
    """Vérifie la configuration Stripe et affiche les informations"""
    print("=== Vérification de la configuration Stripe ===\n")
    
    # Vérifier la clé API
    api_key = os.environ.get('STRIPE_SECRET_KEY')
    if not api_key:
        print("❌ STRIPE_SECRET_KEY n'est pas configurée")
        return
    print(f"✅ STRIPE_SECRET_KEY configurée: {api_key[:7]}...{api_key[-4:]}")
    
    # Vérifier les IDs de prix
    price_subscription = os.environ.get('STRIPE_PRICE_SUBSCRIPTION')
    price_credits = os.environ.get('STRIPE_PRICE_CREDITS')
    webhook_secret = os.environ.get('STRIPE_WEBHOOK_SECRET')
    
    print(f"\n📦 Variables de prix:")
    print(f"   STRIPE_PRICE_SUBSCRIPTION: {'✅ ' + price_subscription if price_subscription else '❌ Non configurée'}")
    print(f"   STRIPE_PRICE_CREDITS: {'✅ ' + price_credits if price_credits else '❌ Non configurée'}")
    print(f"   STRIPE_WEBHOOK_SECRET: {'✅ Configuré' if webhook_secret else '⚠️  Non configuré (optionnel)'}")
    
    # Essayer de récupérer les informations du produit
    try:
        print(f"\n🔍 Vérification du produit prod_SdPoz3TKKEyuKT...")
        product = stripe.Product.retrieve('prod_SdPoz3TKKEyuKT')
        print(f"   Nom: {product.name}")
        print(f"   Actif: {'✅ Oui' if product.active else '❌ Non'}")
        
        # Lister les prix du produit
        prices = stripe.Price.list(product='prod_SdPoz3TKKEyuKT', active=True)
        print(f"\n💰 Prix actifs pour ce produit:")
        for price in prices.data:
            currency = price.currency.upper()
            amount = price.unit_amount / 100
            interval = price.recurring.interval if price.recurring else 'unique'
            print(f"   - {price.id}: {amount} {currency}/{interval}")
            
            # Vérifier si c'est le prix de 14.99€
            if amount == 14.99 and currency == 'EUR' and interval == 'month':
                print(f"     ⭐ Prix de 14.99€/mois trouvé! Utilisez cet ID: {price.id}")
                
    except stripe.error.AuthenticationError:
        print("❌ Erreur d'authentification - vérifiez votre clé API")
    except stripe.error.PermissionError:
        print("❌ Erreur de permission - vérifiez les droits de votre clé API")
    except Exception as e:
        print(f"❌ Erreur: {e}")

if __name__ == "__main__":
    check_stripe_config()