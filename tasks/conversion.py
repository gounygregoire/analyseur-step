import os
import tempfile
import shutil
import io
import time
from datetime import datetime
from typing import Optional

import cadquery as cq
import trimesh
from PIL import Image

from models import db, ModelJob, advance_model_job_status
from celery_app import celery
from storage.s3 import put_asset
from observability.logging import get_logger
from observability.metrics import (
    ttfv_seconds,
    convert_preview_seconds,
    convert_final_seconds,
    preview_size_bytes,
    final_size_bytes,
)
from app.storage.storage import Storage
from converter import (
    glb_to_xkt,
    count_glb_faces,
    file_size,
    step_to_glb,
)
logger = get_logger(__name__)
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
    start = time.time()
    job = ModelJob.query.get(job_id)
    logger = get_logger(__name__, getattr(job, "id", None), getattr(job, "sha256", None))
    if not job:
        return
    advance_model_job_status(job, "processing")
    db.session.commit()
    step_path = Storage.get_step_path(job.id)
    if not step_path:
        logger.error("step file missing: file_id=%s", job.id)
        return
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
        preview_size_bytes.set(os.path.getsize(out_path))
        ttfv_seconds.observe((datetime.utcnow() - job.created_at).total_seconds())
        convert_preview_seconds.observe(time.time() - start)
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
    start = time.time()
    job = ModelJob.query.get(job_id)
    logger = get_logger(__name__, getattr(job, "id", None), getattr(job, "sha256", None))
    if not job:
        return
    advance_model_job_status(job, "processing")
    db.session.commit()
    step_path = Storage.get_step_path(job.id)
    if not step_path:
        logger.error("step file missing: file_id=%s", job.id)
        return
    output_dir = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
    os.makedirs(output_dir, exist_ok=True)

    glb_path = os.path.join(output_dir, f"{job.id}.glb")
    xkt_path = os.path.join(output_dir, f"{job.id}.xkt")

    try:
        faces = -1
        size_glb = 0
        mesh_count = 0
        last_exc: Optional[Exception] = None
        for tol in (0.2, 0.1, 0.05):
            try:
                mesh_count = step_to_glb(step_path, glb_path, tol=tol)
            except Exception as exc:  # pragma: no cover - cadquery runtime errors
                last_exc = exc
                logger.warning(
                    "[convert][glb] tessellation attempt failed tol=%s err=%s",
                    tol,
                    exc,
                )
                continue
            faces = count_glb_faces(glb_path)
            size_glb = file_size(glb_path)
            logger.info(
                "[convert][glb] tol=%s meshes=%s faces=%s size=%s",
                tol,
                mesh_count,
                faces,
                size_glb,
            )
            if faces > 0:
                break
        if faces <= 0:
            raise RuntimeError("GLB has 0 faces - triangulation failed") from last_exc

        out_path = glb_path
        key = f"models/{job.sha256}/final.glb"
        ctype = "model/gltf-binary"

        if mesh_count > 1:
            glb_to_xkt(glb_path, xkt_path)
            size_xkt = file_size(xkt_path)
            logger.info("[convert][xkt] size=%s", size_xkt)
            if size_xkt < 100 * 1024:
                raise RuntimeError("XKT too small (<100KB) - likely empty")
            out_path = xkt_path
            key = f"models/{job.sha256}/final.xkt"
            ctype = "application/octet-stream"

        put_asset(out_path, key, ctype)
        job.final_url = key
        advance_model_job_status(job, "final_ready")
        db.session.commit()
        _notify_status(job)
        final_size_bytes.set(os.path.getsize(out_path))
        convert_final_seconds.observe(time.time() - start)
    except Exception as exc:
        db.session.rollback()
        if self.request.retries >= self.max_retries:
            job.error_message = str(exc)
            advance_model_job_status(job, "error")
            db.session.commit()
            _notify_status(job)
            raise
        raise self.retry(exc=exc, countdown=2 ** self.request.retries)
