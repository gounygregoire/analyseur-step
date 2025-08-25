import os
import json
import csv
import tempfile
import shutil
import dataclasses

import cadquery as cq
import trimesh
from flask import current_app

from celery_app import celery
from dfm_analyzer import analyze_dfm
from heatmap import generate_heatmap
from pdf_generator import generate_dfm_pdf_report
from observability.logging import get_logger

logger = get_logger(__name__)


@celery.task(bind=True, name="tasks.dfm_analysis")
def dfm_analysis(self, file_id: str, material_profile: dict | None = None, demould_axis: dict | None = None) -> None:
    """Run DFM analysis and persist artifacts for API consumption."""
    step_path = os.path.join(current_app.config["UPLOAD_FOLDER"], f"{file_id}.step")
    reports_dir = current_app.config.get("REPORTS_FOLDER", "reports")
    os.makedirs(reports_dir, exist_ok=True)
    job_id = self.request.id
    tmp_dir = tempfile.mkdtemp(prefix="dfm_api_")
    try:
        material_code = material_profile.get("code") if isinstance(material_profile, dict) else "GENERIC"
        report = analyze_dfm(step_path, demould_axis or 'z', material_code)
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
            "demouldAxis": demould_axis,
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
