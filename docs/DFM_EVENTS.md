# DFM Events

Ce document standardise les événements émis sur le bus d'événements pour la coordination des modules front.

## `material:selected`

Payload :

```json
{
  "materialProfile": { /* objet profil matière */ }
}
```

Émis lors de la validation de la modale matière.

## `axis:validated`

Payload :

```json
{
  "axis": [x, y, z],
  "invert": bool,
  "ts": 1234567890
}
```

Émis au clic sur le bouton « Valider l'axe ».

## `dfm:start`

Payload :

```json
{
  "file_id": "abc123",
  "material_profile_id": "mat42",
  "axis": [x, y, z] | null,
  "invert": bool
}
```

Émis juste avant l'appel réseau d'analyse DFM.
