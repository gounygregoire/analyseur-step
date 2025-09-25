# tasks.py  (version hybride, compatible avec web.py)
import os, json, redis
from urllib.parse import urlparse
from shape_metrics import stats_json as compute_stats_json  # ta lib de calcul

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

def _redis_key(file_id: str, axis: str) -> str:
    return f"shape_stats:{file_id}:{axis}"

def compute_and_cache_stats(*, file_id: str, axis: str, step_path: str, cache_dir: str) -> dict:
    """
    Job RQ appelé par web.py
    - step_path : chemin local du STEP (écrit par le web dans /tmp/uploads)
    - cache_dir : dossier où écrire les caches JSON (/tmp/converted)
    Renvoie le dict final et le pousse aussi dans Redis.
    """
    axis = (axis or "Z").upper()
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    os.makedirs(cache_dir, exist_ok=True)

    # 1) calcul via ta lib (écrit aussi les caches dans cache_dir si ta lib le fait)
    data = compute_stats_json(step_path, axis=axis, cache_dir=cache_dir, file_id=file_id)

    # 2) Mise au format (assure les champs attendus côté front)
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

    # 3) Push dans Redis pour lecture immédiate par le web (fallback si caches non lus)
    try:
        r = redis.from_url(REDIS_URL, ssl_cert_reqs=None)
        r.setex(_redis_key(file_id, axis), 3600, json.dumps(out))
    except Exception as e:
        # ne pas faire échouer le job juste pour Redis
        print("[tasks] warn: push redis failed:", repr(e))

    return out
