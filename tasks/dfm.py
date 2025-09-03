import os
import json
import csv
import tempfile
import shutil
import dataclasses
import time
import logging
import hashlib

import cadquery as cq
import trimesh
import redis
from flask import current_app

from celery_app import celery
from dfm_analyzer import analyze_dfm
from heatmap import generate_heatmap
from pdf_generator import generate_dfm_pdf_report
from observability.logging import get_logger

logger = get_logger(__name__)


@celery.task(bind=True, name="tasks.dfm_run")
def dfm_run(self, file_id: str, material_profile: dict | None = None, demould_axis: dict | None = None):
    """Run DFM analysis and persist artifacts for API consumption."""
    step_path = os.path.join(current_app.config["UPLOAD_FOLDER"], f"{file_id}.step")
    reports_dir = current_app.config.get("REPORTS_FOLDER", "reports")
    os.makedirs(reports_dir, exist_ok=True)

    with open(step_path, "rb") as fh:
        step_bytes = fh.read()
    file_hash = hashlib.sha256(step_bytes).hexdigest()
    redis_url = os.getenv("REDIS_URL") or os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    r = redis.Redis.from_url(redis_url, decode_responses=True)
    cache_key = f"dfm_cache:{file_hash}"
    cached = r.get(cache_key)
    if cached:
        return {"ok": True, "summary": json.loads(cached)}

    job_id = self.request.id
    tmp_dir = tempfile.mkdtemp(prefix="dfm_api_")
    try:
        t0 = time.time()
        self.update_state(state="PROGRESS", meta={"step": "prepare", "progress": 5})
        material_code = material_profile.get("code") if isinstance(material_profile, dict) else "GENERIC"
        report = analyze_dfm(step_path, demould_axis or 'z', material_code)
        logging.info("prepare=%.2fs", time.time() - t0)

        t0 = time.time()
        report_dict = dataclasses.asdict(report)
        self.update_state(state="PROGRESS", meta={"step": "thickness", "progress": 35})
        issues = []
        for wi in report_dict.get("wall_thickness_issues", []):
            issues.append({
                "title": "wall_thickness",
                "description": f"Épaisseur {wi['thickness']:.2f}mm",
                "severity": wi["severity"],
                "recommendation": wi["issue_type"],
            })
        logging.info("thickness=%.2fs", time.time() - t0)

        t0 = time.time()
        self.update_state(state="PROGRESS", meta={"step": "undercuts", "progress": 70})
        for gi in report_dict.get("geometry_issues", []):
            issues.append({
                "title": gi["issue_type"],
                "description": gi["description"],
                "severity": gi["severity"],
                "recommendation": gi.get("recommendation", ""),
            })
        logging.info("undercuts=%.2fs", time.time() - t0)

        t0 = time.time()
        shape = cq.importers.importStep(step_path)
        vertices, faces = shape.val().tessellate(1.0, 0.5)
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
            "demouldAxis": demould_axis,
        }
        self.update_state(state="PROGRESS", meta={"step": "summary", "progress": 90})
        logging.info("summary=%.2fs", time.time() - t0)

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
        r.set(cache_key, json.dumps(result))
        return {"ok": True, "summary": result}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
