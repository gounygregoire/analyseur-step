# tasks.py  (robuste : local path OU téléchargement S3)
import os, json, tempfile, redis
from urllib.parse import urlparse

from shape_metrics import stats_json as compute_stats_json  # ta lib de calcul
from s3io import get_file as s3_get_file  # peut renvoyer False si S3 non configuré

# --- même normalisation que côté web, pour Redis Cloud (TLS/rediss://) ---
def _normalize_redis_url(url: str) -> str:
    if not url:
        return url
    url = url.strip().strip('"').strip("'")
    p = urlparse(url)
    if p.scheme == "redis":
        host = (p.hostname or "")
        # endpoints Redis Cloud -> forcer TLS
        if host.endswith("redis-cloud.com") or host.endswith("redns.redis-cloud.com") or (p.port == 12922):
            url = url.replace("redis://", "rediss://", 1)
    return url

REDIS_URL = _normalize_redis_url(
    os.environ.get("REDIS_URL")
    or os.environ.get("REDIS_TLS_URL")
    or "redis://localhost:6379/0"
)

def _s3_enabled() -> bool:
    return all(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_REGION","S3_BUCKET"))

def _redis_key(file_id: str, axis: str) -> str:
    return f"shape_stats:{file_id}:{axis}"

def compute_and_cache_stats(*, file_id: str, axis: str,
                            step_ext: str | None = None,
                            step_path: str | None = None,
                            cache_dir: str | None = None) -> dict:
    """
    Job RQ appelé par web.py
    - step_path : chemin local du STEP si le worker y a accès (souvent non)
    - step_ext  : 'step' / 'stp' (pour récupérer via S3 si besoin)
    - cache_dir : dossier où écrire les caches JSON (/tmp/converted par défaut)
    Renvoie le dict final et le pousse aussi dans Redis.
    """
    axis = (axis or "Z").upper()
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    upload_dir = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
    cache_dir = cache_dir or os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
    os.makedirs(upload_dir, exist_ok=True)
    os.makedirs(cache_dir, exist_ok=True)

    # 1) Déterminer le STEP localement
    local_path = None
    # a) si step_path fourni et existe
    if step_path and os.path.exists(step_path):
        local_path = step_path
    else:
        # b) sinon, essayer de le retrouver localement par convention
        ext = (step_ext or "step").lstrip(".")
        candidate = os.path.join(upload_dir, f"{file_id}.{ext}")
        if os.path.exists(candidate):
            local_path = candidate
        # c) sinon, essayer de télécharger depuis S3 si dispo
        elif _s3_enabled():
            key = f"uploads/{file_id}.{ext}"
            # télécharger vers candidate
            ok = s3_get_file(key, candidate)
            if not ok:
                # tenter l'extension alternative .stp/.step
                alt = "stp" if ext == "step" else "step"
                key2 = f"uploads/{file_id}.{alt}"
                candidate2 = os.path.join(upload_dir, f"{file_id}.{alt}")
                ok = s3_get_file(key2, candidate2)
                if ok:
                    candidate = candidate2
            if ok and os.path.exists(candidate):
                local_path = candidate

    if not local_path or not os.path.exists(local_path):
        raise RuntimeError("STEP not available for worker (no local file and S3 download failed)")

    # 2) Calcul via ta lib (écrit aussi les caches dans cache_dir si ta lib le fait)
    data = compute_stats_json(local_path, axis=axis, cache_dir=cache_dir, file_id=file_id)

    # 3) Mise au format (assure les champs attendus côté front)
    out = {
        "units": "mm_internal",
        "file_id": file_id,
        "axis": axis,
        "volume_cm3": float(data.get("volume_cm3", 0.0)),
        "projected_area_cm2": float(data.get("projected_area_cm2", 0.0)),
        "thickness_min_mm": float(data.get("thickness_min_mm", 0.0)),
        "thickness_max_mm": float(data.get("thickness_max_mm", 0.0)),
        "bbox_mm": data.get("bbox_mm", [0.0, 0.0, 0.0]),
    }

    # 4) Push dans Redis pour lecture immédiate par le web (fallback si caches non lus)
    try:
        r = redis.from_url(REDIS_URL, ssl_cert_reqs=None)
        r.setex(_redis_key(file_id, axis), 3600, json.dumps(out))
    except Exception as e:
        # ne pas faire échouer le job juste pour Redis
        print("[tasks] warn: push redis failed:", repr(e))

    return out
