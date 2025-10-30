# Tests manuels STEP → STL → XKT

## Pré-requis
- Variables d'environnement S3 (`S3_ENDPOINT`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_FORCE_PATH_STYLE=1`).
- `REDIS_URL` accessible et worker `rq worker -u $REDIS_URL cadlytics` déployé avec Node + `@xeokit/xeokit-convert@1.3.1`.
- Un fichier source `uploads/{file_id}.step|stp|stl` présent sur S3 Scaleway.

## Étapes
1. **Déclencher la conversion**
   ```bash
   curl -X POST https://cadlytics.app/api/reconvert \
     -H "Content-Type: application/json" \
     -d '{"file_id": "<FILE_ID>"}'
   ```
   - Vérifier la réponse `202` contenant `job_id`.

2. **Suivre le job**
   ```bash
   curl https://cadlytics.app/api/reconvert/status/<JOB_ID>
   ```
   - Répéter jusqu'à `"status": "finished"`.

3. **Contrôler la publication locale**
   - SSH Render worker → vérifier l'existence de :
     - `/opt/render/project/src/public/xkt/<FILE_ID>.xkt`
     - `/opt/render/project/src/public/xkt/<FILE_ID>.manifest.json`

4. **Valider l'exposition HTTP**
   ```bash
   curl -I https://cadlytics.app/xkt/<FILE_ID>.xkt
   ```
   - Attendre un statut `200`.

5. **Vérifications fonctionnelles**
   - Ouvrir le manifeste et confirmer :
     - `ok: true`
     - `xkt_size >= 200000`
     - `meshes > 0` et `triangles > 0` si présents.

## Résultat attendu
- Le job termine avec `ok: true`.
- Les fichiers `.xkt` et `.manifest.json` sont présents et servis par HTTPS.
- Les garde-fous sont respectés (`meshes`, `triangles`, `xkt_size`).
