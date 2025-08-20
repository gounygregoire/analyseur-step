import os
import json
import tempfile
import shutil
import logging
import dataclasses

import boto3
import cadquery as cq
import trimesh
from flask import current_app

from models import db, ModelJob, advance_model_job_status
from worker import celery
from dfm_analyzer import analyze_dfm
from heatmap import generate_heatmap

logger = logging.getLogger(__name__)
S3_CLIENT = boto3.client("s3")
MAX_RETRIES = 3


def _upload_to_s3(local_path: str, key: str) -> str:
    bucket = current_app.config.get("S3_BUCKET") or os.getenv("S3_BUCKET")
    if not bucket:
        raise RuntimeError("S3_BUCKET not configured")
    S3_CLIENT.upload_file(local_path, bucket, key)
    return key


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
    job = ModelJob.query.get(job_id)
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
        _upload_to_s3(out_json, key)
        job.dfm_json_url = key
        advance_model_job_status(job, "dfm_ready")
        db.session.commit()
        _notify_status(job)
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
