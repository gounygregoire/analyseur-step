# tasks.py
import json
from rq import get_current_job
from shape_metrics import stats_json

def compute_and_cache_stats(*, file_id: str, axis: str, step_path: str, cache_dir: str) -> dict:
    """
    Calcule les métriques + écrit les caches sur le worker (utile si tu montes S3 ensuite).
    En plus, on pousse le JSON dans Redis (clé éphémère) pour que le web puisse le récupérer,
    car les /tmp ne sont pas partagés entre services sur Render.
    """
    data = stats_json(step_path, axis=axis, cache_dir=cache_dir, file_id=file_id)

    # Publie aussi en Redis pour lecture côté web
    job = get_current_job()
    if job is not None:
        try:
            key = f"shape_stats:{file_id}:{axis}"
            job.connection.setex(key, 600, json.dumps(data))  # 10 minutes
        except Exception:
            pass

    return data
