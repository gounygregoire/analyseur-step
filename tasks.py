# tasks.py — worker RQ : télécharge le STEP depuis S3 si besoin, logs verbeux
import os, json, redis
from urllib.parse import urlparse
from shape_metrics import stats_json as compute_stats_json
from s3io import get_file

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

def _local_step_path(file_id: str, ext: str | None) -> str | None:
    uploads_dir = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
    if ext:
        p = os.path.join(uploads_dir, f"{file_id}.{ext.lstrip('.').lower()}")
        if os.path.isfile(p):
            return p
    for e in (".step", ".stp"):
        p = os.path.join(uploads_dir, f"{file_id}{e}")
        if os.path.isfile(p):
            return p
    return None

def _download_from_s3(file_id: str, step_ext: str | None) -> tuple[str | None, list]:
    """Tente S3 sur plusieurs clés. Retourne (path, tried_keys)."""
    uploads_dir = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
    os.makedirs(uploads_dir, exist_ok=True)

    exts = [step_ext.lower().lstrip(".")] if step_ext else ["step", "stp"]
    tried = []

    for ext in exts:
        key = f"uploads/{file_id}.{ext}"
        tried.append(key)
        local_path = os.path.join(uploads_dir, f"{file_id}.{ext}")
        try:
            ok = get_file(key, local_path)
            if ok and os.path.isfile(local_path):
                print(f"[worker] S3 download OK: s3://{os.environ.get('S3_BUCKET')}/{key} -> {local_path}")
                return local_path, tried
            else:
                print(f"[worker] S3 download returned False for {key}")
        except Exception as e:
            print(f"[worker] S3 get_file FAILED for {key}: {e}")
    return None, tried

def compute_and_cache_stats(*, file_id: str, axis: str, step_path: str | None = None,
                            cache_dir: str = "/tmp/converted", step_ext: str | None = None) -> dict:
    axis = (axis or "Z").upper()
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    os.makedirs(cache_dir, exist_ok=True)

    # Trouver le STEP
    if not step_path or not os.path.isfile(step_path):
        step_path = _local_step_path(file_id, step_ext)
    if not step_path or not os.path.isfile(step_path):
        step_path, tried = _download_from_s3(file_id, step_ext)
    else:
        tried = []

    if not step_path or not os.path.isfile(step_path):
        raise FileNotFoundError(
            f"STEP introuvable pour file_id={file_id}. "
            f"Chemins locaux testés + clés S3: {tried}"
        )

    print(f"[worker] computing stats file_id={file_id} axis={axis} step={step_path}")
    try:
        data = compute_stats_json(step_path, axis=axis, cache_dir=cache_dir, file_id=file_id)
    except Exception as e:
        # Renvoyer une erreur très explicite
        raise RuntimeError(f"shape_metrics failed: {e}") from e

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

    try:
        r = redis.from_url(REDIS_URL, ssl_cert_reqs=None)
        r.setex(_redis_key(file_id, axis), 3600, json.dumps(out))
    except Exception as e:
        print("[worker] warn: push redis failed:", repr(e))

    print(f"[worker] done stats for {file_id} axis={axis}")
    return out
