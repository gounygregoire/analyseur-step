# tasks.py
import os, tempfile, json
from pathlib import Path
from s3io import get_file, put_file
from shape_metrics import stats_json as compute_stats_json

OUTPUT_FOLDER = os.getenv("OUTPUT_FOLDER", "/tmp/converted")

def _cache_paths(file_id: str, axis: str):
    base = os.path.join(OUTPUT_FOLDER, f"{file_id}.stats.json")
    proj = os.path.join(OUTPUT_FOLDER, f"{file_id}.proj.{axis}.json")
    return base, proj

def compute_and_cache_stats(file_id: str, axis: str, *, step_ext: str = "step") -> dict:
    """
    Job RQ: télécharge le STEP depuis S3, calcule les métriques, écrit
    les caches localement ET les uploade dans S3. Renvoie le JSON final.
    """
    axis = (axis or "Z").upper()
    if axis not in ("X","Y","Z"):
        axis = "Z"

    # 1) Télécharger le STEP depuis S3
    s3_step_key = f"uploads/{file_id}.{step_ext.lower().lstrip('.')}"
    tmp_dir = Path(tempfile.mkdtemp(prefix="rq_step_"))
    local_step = tmp_dir / f"{file_id}.{step_ext}"
    ok = get_file(s3_step_key, str(local_step))
    if not ok:
        raise RuntimeError(f"STEP introuvable dans S3: {s3_step_key}")

    # 2) Calculer
    data = compute_stats_json(str(local_step), axis=axis, cache_dir=OUTPUT_FOLDER, file_id=file_id)

    # 3) Uploader caches JSON dans S3
    base_cache, proj_cache = _cache_paths(file_id, axis)
    put_file(base_cache, f"stats/{file_id}.stats.json", content_type="application/json")
    put_file(proj_cache, f"stats/{file_id}.proj.{axis}.json", content_type="application/json")

    # 4) Renvoie le résultat (pour inspection RQ si besoin)
    return {
        "units": "mm_internal",
        "volume_cm3": float(data.get("volume_cm3", 0.0)),
        "projected_area_cm2": float(data.get("projected_area_cm2", 0.0)),
        "thickness_min_mm": float(data.get("thickness_min_mm", 0.0)),
        "thickness_max_mm": float(data.get("thickness_max_mm", 0.0)),
        "bbox_mm": data.get("bbox_mm", [0.0,0.0,0.0]),
        "file_id": file_id,
        "axis": axis,
    }
