# QA checks — heatmap readiness & toggle

## Pré-requis
- Builder le frontend : `npm run build`
- Lancer l'app Render locale (ou environnement équivalent) puis ouvrir `app.html`.
- Ouvrir la console du navigateur (onglet **Console**).

## Test 1 — Modèle A (readiness < 5 s)
1. Charger le modèle A (fichier STEP/XKT de référence).
2. Observer les logs côté console.
3. Vérifier qu'un unique log `[loader] model set {id: ...}` apparaît.
4. Vérifier que le log `[heatmap] ready after XX ms (model=...)` est émis en moins de 5000 ms.

## Test 2 — Modèle B (aucun doublon loader)
1. Réinitialiser le viewer puis charger le modèle B.
2. Vérifier qu'un seul log `[loader] model set {id: ...}` est affiché.
3. Vérifier que `[heatmap] ready after XX ms (model=...)` apparaît (< 5000 ms attendu).
4. Confirmer l'absence de logs supplémentaires `[loader] model set` pour ce chargement.

## Test 3 — Toggle sans recalcul
1. Lorsque la heatmap est affichée et l'axe courant fixé, cliquer sur le bouton **Heatmap** pour masquer l'overlay.
2. Cliquer de nouveau sur **Heatmap** sans changer d'axe.
3. Vérifier que la console n'affiche aucun nouveau log de recalcul (uniquement les logs de toggle/visibilité attendus).

## Surveillance des diagnostics
- Si un log `[heatmap][diag] geometry wait nearing timeout` apparaît, noter le modèle testé et partager les valeurs `elapsed` / `maxWaitMs`.
- Si un log `[heatmap][ALERTE] model.scene !== viewer.scene` apparaît, remonter immédiatement la pile d'appels indiquée pour corriger le mismatch.
