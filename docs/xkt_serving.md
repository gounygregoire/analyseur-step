# Distribution des fichiers XKT

Cette note décrit comment exposer les artefacts XKT générés par la pipeline de conversion Cadlytics en fonction de l'environnement cible.

## Configuration commune

Les conversions utilisent `app.xkt_pipeline`. Les variables d'environnement suivantes pilotent le déploiement :

| Variable | Rôle | Valeur par défaut |
| --- | --- | --- |
| `XKT_STORAGE` | `local` ou `s3` | `local` |
| `XKT_LOCAL_DIR` | dossier local où les XKT sont publiés | `./public/xkt` |
| `XKT_BASE_URL` | base publique (domaine ou chemin) | `/xkt/` |
| `SERVE_XKT_FROM_FLASK` | force l'exposition de `/xkt/<id>.xkt` par Flask (`1`/`0`) | non défini |
| `XKT_FAKE_CONVERTER` | `1` en dev pour générer un XKT factice sans lancer le binaire | `0` |

L'URL retournée par l'API suit **toujours** le motif `<XKT_BASE_URL>/xkt/{file_id}.xkt`. Définissez `XKT_BASE_URL` sur le domaine public (ex : `https://cadlytics.app`) pour obtenir `https://cadlytics.app/xkt/<id>.xkt`.

## Cas 1 : stockage local + Nginx

1. Construire les XKT localement (`XKT_STORAGE=local`) dans `XKT_LOCAL_DIR`.
2. Servir `/xkt/` directement depuis Nginx sans repasser par Flask :

```nginx
location /xkt/ {
    root /var/www/cadlytics/public;
    autoindex off;
    add_header Cache-Control "public, max-age=31536000";
}
```

3. Désactiver la route Flask pour éviter les doublons : `SERVE_XKT_FROM_FLASK=0` (ou laisser non défini si `XKT_BASE_URL` pointe déjà vers le domaine absolu).
4. Vérifier : `curl -I https://cadlytics.app/xkt/<file_id>.xkt` retourne `200 OK` avec la latence attendue (< 500 ms).

## Cas 2 : S3 + CloudFront

1. Publier avec `XKT_STORAGE=s3`. Le pipeline téléverse `xkt/{file_id}.xkt` dans le bucket configuré (`S3_BUCKET_XKT` + `S3_PREFIX_XKT`).
2. Configurer une distribution CloudFront (ou CDN équivalent) pointant sur ce préfixe `xkt/`.
3. Définir `XKT_BASE_URL` sur le domaine CloudFront (ex : `https://cdn.cadlytics.app`). L'API exposera automatiquement `https://cdn.cadlytics.app/xkt/<file_id>.xkt`.
4. Invalider `xkt/{file_id}.xkt` après reconversion si nécessaire (sinon, utiliser un TTL court côté CDN pendant la phase de test).
5. Laisser `SERVE_XKT_FROM_FLASK` non défini ou à `0` pour ne pas exposer de route Flask.
6. Vérifier l'accès public en GET (HEAD optionnel, non utilisé par le front) et l'absence de querystring forcée côté backend.

## Contrôles rapides

- `curl -I <URL>` doit retourner `200` ou un `30x` suivi d'un `200` depuis le CDN.
- Le fichier doit être téléchargeable en < 500 ms dans les conditions nominales.
- Les en-têtes de réponse doivent inclure `Cache-Control: public, max-age=31536000` (via Nginx ou CDN).
