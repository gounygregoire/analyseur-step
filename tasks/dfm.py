import os
import json
import tempfile
import shutil
import dataclasses
import time

import cadquery as cq
import trimesh
from flask import current_app

from models import db, ModelJob, advance_model_job_status
from celery_app import celery
from dfm_analyzer import analyze_dfm
from heatmap import generate_heatmap
from storage.s3 import put_asset
from observability.logging import get_logger
from observability.metrics import dfm_seconds

logger = get_logger(__name__)
MAX_RETRIES = 3


def _notify_status(job: ModelJob) -> None:
    url = os.getenv("MODEL_STATUS_WEBHOOK")
    if url:
        try:
            import requests
            requests.post(url, json={"id": job.id, "status": job.status})
        except Exception:
            logger.exception("status webhook failed")


@celery.task(bind=True, max_retries=MAX_RETRIES, name="tasks.run_dfm")
def run_dfm(self, job_id: str) -> None:
    """Analyze STEP and upload DFM report with heatmap."""
    start = time.time()
    job = ModelJob.query.get(job_id)
    logger = get_logger(__name__, getattr(job, "id", None), getattr(job, "sha256", None))
    if not job:
        return
    step_path = os.path.join(current_app.config["UPLOAD_FOLDER"], f"{job.id}.step")
    tmp_dir = tempfile.mkdtemp(prefix="dfm_")
    try:
        report = analyze_dfm(step_path)
        report_dict = dataclasses.asdict(report)
        shape = cq.importers.importStep(step_path)
        vertices, faces = shape.val().tessellate(0.5)
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
        stl_path = os.path.join(tmp_dir, "mesh.stl")
        mesh.export(stl_path)
        report_dict["heatmap"] = generate_heatmap(stl_path)
        out_json = os.path.join(tmp_dir, "dfm.json")
        with open(out_json, "w") as fh:
            json.dump(report_dict, fh)
        key = f"models/{job.sha256}/dfm.json"
        put_asset(out_json, key, "application/json")
        job.dfm_json_url = key
        advance_model_job_status(job, "dfm_ready")
        db.session.commit()
        _notify_status(job)
        dfm_seconds.observe(time.time() - start)
    except Exception as exc:
        db.session.rollback()
        if self.request.retries >= self.max_retries:
            job.error_message = str(exc)
            advance_model_job_status(job, "error")
            db.session.commit()
            _notify_status(job)
            raise
        raise self.retry(exc=exc, countdown=2 ** self.request.retries)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
