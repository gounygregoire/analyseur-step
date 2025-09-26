# tasks.py — worker RQ : télécharge le STEP depuis S3 si besoin
import os, json, tempfile, redis
from urllib.parse import urlparse
from shape_metrics import stats_json as compute_stats_json  # ta lib
from s3io import get_file  # on s'appuie sur ton helper S3 pour rapatrier le fichier

# --- même normalisation que côté web, pour Redis Cloud (TLS/rediss://) ---
def _normalize_redis_url(url: str) -> str:
    if not url:
        return url
    url = url.strip().strip('"').strip("'")
    p = urlparse(url)
    if p.scheme == "redis":
        host = (p.hostname or "")
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

def _local_step_path(file_id: str, ext: str | None, cache_dir: str) -> str | None:
    """Essaie de trouver le STEP en local (utile si web et worker partagent un FS)."""
    uploads_dir = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
    if ext:
        p = os.path.join(uploads_dir, f"{file_id}.{ext.lstrip('.')}")
        if os.path.isfile(p):
            return p
    for e in (".step", ".stp"):
        p = os.path.join(uploads_dir, f"{file_id}{e}")
        if os.path.isfile(p):
            return p
    return None

def _download_from_s3(file_id: str, step_ext: str | None) -> str | None:
    """
    Rapatrie le STEP depuis S3 dans /tmp/uploads et retourne le chemin local.
    Essaie .step puis .stp si step_ext n'est pas fourni.
    """
    uploads_dir = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
    os.makedirs(uploads_dir, exist_ok=True)

    exts = []
    if step_ext:
        exts = [step_ext.lower().lstrip(".")]
    else:
        exts = ["step", "stp"]

    for ext in exts:
        key = f"uploads/{file_id}.{ext}"
        local_path = os.path.join(uploads_dir, f"{file_id}.{ext}")
        try:
            ok = get_file(key, local_path)  # -> True si ok
            if ok and os.path.isfile(local_path):
                return local_path
        except Exception as e:
            print(f"[worker] S3 get_file FAILED for {key}: {e}")
    return None

def compute_and_cache_stats(*, file_id: str, axis: str, step_path: str | None = None,
                            cache_dir: str = "/tmp/converted", step_ext: str | None = None) -> dict:
    """
    Job RQ appelé par le web.
    - step_path : chemin local si connu (peut ne pas exister côté worker)
    - step_ext  : 'step' ou 'stp' si connu (facilite le download S3)
    - cache_dir : dossier où écrire les caches JSON
    Retourne le dict final et le pousse aussi dans Redis.
    """
    axis = (axis or "Z").upper()
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    os.makedirs(cache_dir, exist_ok=True)

    # 0) Si le chemin local reçu n'existe pas, on tente local par convention, sinon S3
    if not step_path or not os.path.isfile(step_path):
        step_path = _local_step_path(file_id, step_ext, cache_dir)
    if not step_path or not os.path.isfile(step_path):
        step_path = _download_from_s3(file_id, step_ext)

    if not step_path or not os.path.isfile(step_path):
        raise FileNotFoundError(f"STEP introuvable pour file_id={file_id} (ni local, ni S3).")

    print(f"[worker] computing stats for {file_id} axis={axis} using {step_path}")
    data = compute_stats_json(step_path, axis=axis, cache_dir=cache_dir, file_id=file_id)

    # Format de sortie attendu par le front
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

    # Push dans Redis pour lecture immédiate par le web
    try:
        r = redis.from_url(REDIS_URL, ssl_cert_reqs=None)
        r.setex(_redis_key(file_id, axis), 3600, json.dumps(out))
    except Exception as e:
        print("[worker] warn: push redis failed:", repr(e))

    print(f"[worker] done stats for {file_id} axis={axis}")
    return out
