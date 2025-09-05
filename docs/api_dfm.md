# API DFM

Ce document décrit les schémas JSON échangés entre le front et le backend pour l'analyse DFM.

## Endpoints

### `POST /api/dfm/start`

Corps :

```json
{
  "file_id": "abc123",
  "demold_axis": [0, 1, 0],
  "material_profile": {
    "family": "PP",
    "fillers": ["GF20"],
    "constraints": ["food_contact"]
  }
}
```

Réponse `202 Accepted` :

```json
{ "job_id": "e7f2a1c4", "status": "queued" }
```

### `GET /api/dfm/status?job_id=...`

Réponses possibles :

```json
{ "status": "queued", "progress": 0 }
{ "status": "running", "progress": 40 }
{ "status": "done", "progress": 100, "result": { /* DFMResult */ } }
{ "status": "error", "progress": 100, "error": "STEP file not found" }
```

## Schéma `DFMResult`

```json
{
  "metrics": {
    "wall_thickness_min": 0.7,
    "wall_thickness_max": 4.2,
    "undercuts": 2,
    "surface_out_of_tolerance_pct": 5.0,
    "missing_fillet_zones": 1
  },
  "issues": [
    { "type": "undercut", "face_id": 12, "severity": "warning" }
  ],
  "heatmaps": {
    "face_scalar": {
      "values": { "12": 0.3, "42": 0.8 },
      "legend": { "min": 0, "max": 1, "units": "" }
    }
  },
  "views": {
    "camera_states": {
      "iso":   { "eye": [10, 10, 10], "look": [0, 0, 0], "up": [0, 0, 1] },
      "top":   { "eye": [0, 0, 10],  "look": [0, 0, 0], "up": [0, 1, 0] },
      "side":  { "eye": [10, 0, 0],  "look": [0, 0, 0], "up": [0, 0, 1] }
    },
    "thumbnails": {
      "iso":  "/static/dfm/abc123/thumb_iso.png",
      "top":  "/static/dfm/abc123/thumb_top.png",
      "side": "/static/dfm/abc123/thumb_side.png"
    }
  },
  "report_paths": {
    "pdf": "/static/dfm/abc123/report.pdf"
  }
}
```

- `metrics` : valeurs agrégées (épaisseurs min/max, sous‑dépouilles, pourcentage de surfaces hors tolérance, zones sans rayon, etc.).
- `camera_states` : format Xeokit `{ "eye": [x,y,z], "look": [x,y,z], "up": [x,y,z] }`.
- `heatmaps.face_scalar` : mapping `face_id → valeur` avec `legend` indiquant l'échelle (0‑1 ou unités réelles).
- `thumbnails` : images générées hors écran, prêtes à l'affichage dans l'UI.
- `report_paths` : chemins des rapports supplémentaires (PDF, CSV...).

## États d'erreur fréquents

- `file_id_missing` : identifiant absent lors de l'appel à `/start`.
- `not_found` : `job_id` inconnu pour `/status`.
- `STEP file not found` : le fichier STEP référencé n'existe plus.
- `demold_axis cannot be the zero vector` : validation d'entrée échouée.
