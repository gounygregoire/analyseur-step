import logging
import os
import tempfile
import shutil
import io

import cadquery as cq
import trimesh
from PIL import Image
from flask import current_app

from models import db, ModelJob, advance_model_job_status
from worker import celery
from tasks.dfm import run_dfm
from storage.s3 import put_asset

logger = logging.getLogger(__name__)
MAX_RETRIES = 3
PREVIEW_MAX_FACES = 300_000
PREVIEW_RATIO = 0.5


def _notify_status(job: ModelJob) -> None:
    url = os.getenv("MODEL_STATUS_WEBHOOK")
    if url:
        try:
            import requests
            requests.post(url, json={"id": job.id, "status": job.status})
        except Exception:
            logger.exception("status webhook failed")


@celery.task(bind=True, max_retries=MAX_RETRIES, name="tasks.generate_preview")
def generate_preview(self, job_id: str) -> None:
    """Convert STEP to decimated preview GLB."""
    job = ModelJob.query.get(job_id)
    if not job:
        return
    advance_model_job_status(job, "processing")
    db.session.commit()
    step_path = os.path.join(current_app.config["UPLOAD_FOLDER"], f"{job.id}.step")
    tmp_dir = tempfile.mkdtemp(prefix="preview_")
    try:
        shape = cq.importers.importStep(step_path)
        vertices, faces = shape.val().tessellate(1.0)
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
        target = int(min(PREVIEW_MAX_FACES, len(mesh.faces) * PREVIEW_RATIO))
        if len(mesh.faces) > target:
            mesh = mesh.simplify_quadratic_decimation(target)
        out_path = os.path.join(tmp_dir, "preview.glb")
        mesh.export(out_path, file_type="glb")
        key = f"models/{job.sha256}/preview.glb"
        put_asset(out_path, key, "model/gltf-binary")
        # thumbnail
        scene = mesh.scene()
        img_bytes = scene.save_image(resolution=(1024, 1024))
        thumb_path = os.path.join(tmp_dir, "thumb.jpg")
        Image.open(io.BytesIO(img_bytes)).convert("RGB").save(thumb_path, quality=90)
        put_asset(thumb_path, f"models/{job.sha256}/thumb.jpg", "image/jpeg")
        job.preview_url = key
        advance_model_job_status(job, "preview_ready")
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


@celery.task(bind=True, max_retries=MAX_RETRIES, name="tasks.generate_final")
def generate_final(self, job_id: str) -> None:
    """Generate final asset (GLB or XKT) and enqueue DFM."""
    job = ModelJob.query.get(job_id)
    if not job:
        return
    advance_model_job_status(job, "processing")
    db.session.commit()
    step_path = os.path.join(current_app.config["UPLOAD_FOLDER"], f"{job.id}.step")
    tmp_dir = tempfile.mkdtemp(prefix="final_")
    try:
        shape = cq.importers.importStep(step_path)
        solids = shape.solids().toList() if hasattr(shape, "solids") else []
        if len(solids) > 1:
            from xkt_converter import convert_step_to_xkt
            out_path = os.path.join(tmp_dir, "final.xkt")
            convert_step_to_xkt(step_path, out_path)
            key = f"models/{job.sha256}/final.xkt"
            ctype = "application/octet-stream"
        else:
            vertices, faces = shape.val().tessellate(0.2)
            mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
            out_path = os.path.join(tmp_dir, "final.glb")
            mesh.export(out_path, file_type="glb")
            key = f"models/{job.sha256}/final.glb"
            ctype = "model/gltf-binary"
        put_asset(out_path, key, ctype)
        job.final_url = key
        advance_model_job_status(job, "final_ready")
        db.session.commit()
        _notify_status(job)
        run_dfm.delay(job_id)
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
