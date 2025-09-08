# Guide des tests

## Mise à jour des goldens

Les valeurs de référence sont stockées dans `tests/data/golden_cube.json`.
Pour les régénérer après une modification du calcul DFM :

```bash
pytest tests/test_golden_result.py --update-goldens
```

Le test sera marqué comme *skipped* et le fichier JSON sera écrasé.
Vérifiez le diff avant de committer.

