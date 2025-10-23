# Rapport final Heatmap dépouille

## Cause racine
- **Mismatch viewer/scène** dû à la coexistence de plusieurs instanciations `Viewer`/`XKTLoaderPlugin` (scripts historiques et entrées Vite). Les modules heatmap/DFM consommaient parfois un viewer global qui n'était pas celui ayant chargé le modèle courant, provoquant `model.scene !== viewer.scene`, absence de géométrie et timeouts.
- **Readiness obsolète** : la détection utilisait uniquement `scene.entities`/`scene.meshes` et des propriétés privées (`numItems`), incompatibles avec Xeokit @latest et incapables de valider les buffers (positions/indices) nécessaires à la heatmap.

## Changements majeurs
1. **Singleton viewer + ModelRegistry** : enregistrement systématique `{ viewer, model }` dès le `load()` XKT; tous les modules (heatmap, orchestrateur, probeSafe) résolvent le viewer via le registre.
2. **Readiness basée sur `model.scene`** : attente des composants Mesh via les API publiques (`scene.iterateComponents`, `scene.getNumComponents`) avec fallback multi-versions, vérification de l'AABB et des buffers `positions`/`indices`.
3. **Diagnostics normalisés** :
   - Log unique `[loader] model set …` + `[loader][diag] model.scene === viewer.scene`.
   - `[heatmap] ready after XX ms` avec échantillon de géométrie (tailles des buffers).
   - Alerte explicite avec pile d'appels si `model.scene !== viewer.scene` est détecté.
   - Avertissement unique quand l'attente dépasse 60 % de `maxWaitMs`.
4. **Séquence UI sûre** : bouton heatmap désactivé tant que la readiness n'est pas validée; toast "Préparation de la géométrie…" si clic anticipé; toggle instantané sans recalcul si axe/modèle inchangés; listeners `loaded` attachés une seule fois.

## Logs avant/après

### Avant (problématique)
```
[loader] model set {id: "partA"}
[heatmap] waiting geometry…
[heatmap][diag] viewer-scene mismatch: model.scene !== viewer.scene
[heatmap][diag] geometry wait nearing timeout {elapsed: 15000, meshesTotal: 0}
[loader] geometry readiness wait failed (dt=15000ms) Error: GEOMETRY_WAIT_TIMEOUT
```

### Après (OK)
```
[loader] model set {id: "partA"}
[loader][diag] model.scene === viewer.scene {id: "partA", modelSceneId: "scene-1", viewerSceneId: "scene-1"}
[heatmap] ready after 732 ms (model=partA) {readySource: "mesh", sample: {positions: 184320, indices: 92160}}
[heatmap] overlay toggled on (axis=+Z)
[heatmap] overlay toggled off (axis=+Z)
```

- Heatmap OK sur modèles A & B < 5 s, aucun doublon `[loader] model set`.
- Pas de régression sur volume/épaisseur/surface : calculs DFM conservés.

## Tests manuels recommandés
- Suivre `docs/QA_CHECKS_HEATMAP.md` pour rejouer les scénarios de readiness, absence de doublons et toggle sans recalcul.
