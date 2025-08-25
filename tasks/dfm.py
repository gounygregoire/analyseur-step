import os
import json
import csv
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
from pdf_generator import generate_dfm_pdf_report
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


@celery.task(bind=True, name="tasks.dfm_analysis")
def dfm_analysis(self, file_id: str, material_profile: dict | None = None) -> None:
    """Run DFM analysis and persist artifacts for API consumption."""
    step_path = os.path.join(current_app.config["UPLOAD_FOLDER"], f"{file_id}.step")
    reports_dir = current_app.config.get("REPORTS_FOLDER", "reports")
    os.makedirs(reports_dir, exist_ok=True)
    job_id = self.request.id
    tmp_dir = tempfile.mkdtemp(prefix="dfm_api_")
    try:
        report = analyze_dfm(step_path, material_profile.get("code") if isinstance(material_profile, dict) else "GENERIC")
        report_dict = dataclasses.asdict(report)
        issues = []
        for wi in report_dict.get("wall_thickness_issues", []):
            issues.append({
                "title": "wall_thickness",
                "description": f"Épaisseur {wi['thickness']:.2f}mm",
                "severity": wi["severity"],
                "recommendation": wi["issue_type"],
            })
        for gi in report_dict.get("geometry_issues", []):
            issues.append({
                "title": gi["issue_type"],
                "description": gi["description"],
                "severity": gi["severity"],
                "recommendation": gi.get("recommendation", ""),
            })

        shape = cq.importers.importStep(step_path)
        vertices, faces = shape.val().tessellate(0.5)
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
        stl_path = os.path.join(tmp_dir, "mesh.stl")
        mesh.export(stl_path)
        raw_heat = generate_heatmap(stl_path)
        max_index = max((h["face_index"] for h in raw_heat), default=-1)
        values = [0.0] * (max_index + 1 if max_index >= 0 else 0)
        for h in raw_heat:
            values[h["face_index"]] = h["severity"]
        heatmap = {
            "type": "per-face",
            "values": values,
            "range": [min(values) if values else 0, max(values) if values else 0],
            "legend": [],
        }
        result = {
            "issues": issues,
            "heatmap": heatmap,
            "annotations": [],
            "checklist": [],
            "recommendations": {
                "materials": [],
                "process_notes": report_dict.get("recommendations", []),
            },
            "reportUrls": {},
        }

        json_path = os.path.join(reports_dir, f"dfm_result_{job_id}.json")
        with open(json_path, "w") as fh:
            json.dump(result, fh)

        pdf_name = f"dfm_report_{job_id}.pdf"
        pdf_path = os.path.join(reports_dir, pdf_name)
        try:
            generate_dfm_pdf_report(report_dict, step_path, pdf_path, os.path.basename(step_path))
        except Exception:
            logger.exception("pdf generation failed")

        csv_name = f"dfm_report_{job_id}.csv"
        csv_path = os.path.join(reports_dir, csv_name)
        try:
            with open(csv_path, "w", newline="") as csvfile:
                writer = csv.writer(csvfile)
                writer.writerow(["title", "description", "severity", "recommendation"])
                for iss in issues:
                    writer.writerow([
                        iss.get("title"),
                        iss.get("description"),
                        iss.get("severity"),
                        iss.get("recommendation", ""),
                    ])
        except Exception:
            logger.exception("csv generation failed")

        result["reportUrls"] = {
            "pdf": f"/download-pdf/{pdf_name}",
            "csv": f"/download-csv/{csv_name}",
        }
        with open(json_path, "w") as fh:
            json.dump(result, fh)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
