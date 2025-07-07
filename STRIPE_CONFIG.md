# Configuration Stripe pour CADlytitcs

## Étapes pour configurer le nouveau prix d'abonnement à 14.99€

### 1. Créer le prix dans Stripe Dashboard

1. Connectez-vous à votre [Dashboard Stripe](https://dashboard.stripe.com)
2. Allez dans **Produits** > **prod_SdPoz3TKKEyuKT** (votre produit)
3. Cliquez sur **Ajouter un prix**
4. Configurez le nouveau prix :
   - **Prix** : 14.99 EUR
   - **Type de facturation** : Récurrent
   - **Intervalle de facturation** : Mensuel
   - **ID du prix** : Laissez Stripe générer automatiquement (format: price_xxxx)
5. Cliquez sur **Ajouter le prix**

### 2. Récupérer l'ID du nouveau prix

Une fois le prix créé, vous verrez l'ID du prix qui ressemble à : `price_1234567890abcdef`

### 3. Configurer la variable d'environnement

Dans Replit :
1. Allez dans l'onglet **Secrets** (icône cadenas)
2. Ajoutez ou modifiez le secret :
   - **Clé** : `STRIPE_PRICE_SUBSCRIPTION`
   - **Valeur** : `price_xxxx` (l'ID du prix que vous venez de créer)

### 4. Variables d'environnement nécessaires

Assurez-vous d'avoir toutes ces variables configurées :
- `STRIPE_SECRET_KEY` : Votre clé secrète Stripe (déjà configurée)
- `STRIPE_PRICE_SUBSCRIPTION` : ID du prix de l'abonnement à 14.99€
- `STRIPE_PRICE_CREDITS` : ID du prix pour le pack de 5 crédits à 5€
- `STRIPE_WEBHOOK_SECRET` : Secret du webhook (optionnel mais recommandé)

### 5. Test de la configuration

Après avoir configuré les variables :
1. Redémarrez l'application
2. Allez sur la page des tarifs
3. Cliquez sur "Démarrer l'abonnement"
4. Vous devriez être redirigé vers Stripe Checkout avec le prix de 14.99€

## Notes importantes

- Les prix affichés dans l'interface (14.99€) sont maintenant synchronisés
- Le système utilisera automatiquement l'ID du prix configuré dans STRIPE_PRICE_SUBSCRIPTION
- Si vous voulez aussi créer un prix pour le pack de 5 crédits, répétez les étapes avec 5€ et configurez STRIPE_PRICE_CREDITS