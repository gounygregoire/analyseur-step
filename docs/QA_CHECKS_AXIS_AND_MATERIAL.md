# Vérifications QA axe & matière

## Gating
- [ ] À l'ouverture, le panneau axe est caché.
- [ ] Après `material:selected` avec `fileId` présent, le panneau axe devient visible.
- [ ] Sans matière ou sans `fileId`, le panneau reste masqué.

## Validation axe
- [ ] Cliquer sur « Valider l'axe ».
- [ ] Un événement `axis:validated` est émis avec `{ axis, invert, ts }`.
- [ ] Un feedback visuel confirme la validation.

## Start DFM
- [ ] Tant que la matière ou l'axe sont manquants, le bouton « Analyser » est désactivé.
- [ ] Quand tous les prérequis sont présents, un clic émet `dfm:start { file_id, material_profile_id, axis|null, invert }`.
- [ ] Le bouton se met en état bloqué pendant l'appel.
