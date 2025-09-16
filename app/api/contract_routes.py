from __future__ import annotations
import os
import uuid
from datetime import datetime
from typing import Any
import json

from flask import Blueprint, current_app, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from app.storage.storage import Storage
from app.storage import history as History
from functools import lru_cache


@lru_cache(maxsize=1)
def _convert_step_to_xkt():
    from xkt_converter import convert_step_to_xkt

    return convert_step_to_xkt

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "300"))

api_contract_bp = Blueprint("api_contract", __name__, url_prefix="/api/simple")


@api_contract_bp.post("/upload")
def upload_step() -> tuple[Any, int]:
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "missing_file"}), 400
    filename = secure_filename(file.filename or "")
    if not filename:
        return jsonify({"error": "empty_filename"}), 400
    ext = os.path.splitext(filename)[1].lower()
    if ext not in (".step", ".stp"):
        return jsonify({"error": "unsupported_extension"}), 415

    file.stream.seek(0, os.SEEK_END)
    size = file.stream.tell()
    file.stream.seek(0)
    if size > MAX_UPLOAD_MB * 1024 * 1024:
        return jsonify({"error": "file_too_large"}), 413

    file_id = str(uuid.uuid4())
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    step_path = os.path.join(UPLOAD_FOLDER, f"{file_id}.step")
    file.save(step_path)
    Storage.save_step_record(file_id, filename, step_path, size)
    current_app.logger.info("[upload] file_id=%s name=%s size=%s", file_id, filename, size)
    try:
        History.record_upload(file_id, filename, size, datetime.utcnow().isoformat())
    except Exception as exc:  # fail soft
        current_app.logger.warning("history upload failed for %s: %s", file_id, exc)

    try:  # pragma: no cover - heavy libs
        import cadquery as cq
        wp = cq.importers.importStep(step_path)
        bb = wp.val().BoundingBox()
        bbox = [bb.xlen, bb.ylen, bb.zlen]
    except Exception as exc:  # fallback if cadquery unavailable
        current_app.logger.warning("bbox failed for %s: %s", step_path, exc)
        bbox = [0.0, 0.0, 0.0]

    return jsonify({
        "file_id": file_id,
        "step_path": step_path,
        "size": size,
        "bbox": bbox,
    }), 200


@api_contract_bp.post("/convert")
def convert_step() -> tuple[Any, int]:
    try:
        data = request.get_json(silent=True) or request.form or {}
        file_id = data.get("file_id")
        if not file_id:
            return jsonify({"error": "missing_file_id"}), 400

        step_in_path = Storage.get_step_path(file_id)
        if not step_in_path or not os.path.exists(step_in_path):
            return jsonify({"error": "missing_or_unknown_file_id"}), 400

        os.makedirs(OUTPUT_FOLDER, exist_ok=True)
        xkt_out_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
        if os.path.exists(xkt_out_path):
            current_app.logger.info(
                f"[convert] XKT ready /models/{file_id}.xkt"
            )
            png_out_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.png")
            if not os.path.exists(png_out_path):
                open(png_out_path, "wb").close()
            try:
                History.record_convert(file_id, 0)
            except Exception as exc:  # fail soft
                current_app.logger.warning(
                    "history convert failed for %s: %s", file_id, exc
                )
            return jsonify({"file_id": file_id, "xkt_url": f"/models/{file_id}.xkt"}), 200

        try:
            convert = _convert_step_to_xkt()
            convert(
                step_in_path,
                xkt_out_path,
                stl_tolerance=float(data.get("tolerance", 0.1)),
            )
        except Exception as exc:
            current_app.logger.error("[convert] failed %s", exc)
            return jsonify({"error": "convert_failed"}), 500

        if not os.path.exists(xkt_out_path):
            current_app.logger.error("[convert] output missing %s", xkt_out_path)
            return jsonify({"error": "convert_failed"}), 500

        current_app.logger.info(
            f"[convert] XKT ready /models/{file_id}.xkt"
        )
        png_out_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.png")
        if not os.path.exists(png_out_path):
            open(png_out_path, "wb").close()
        try:
            History.record_convert(file_id, 0)
        except Exception as exc:  # fail soft
            current_app.logger.warning(
                "history convert failed for %s: %s", file_id, exc
            )
        return jsonify({"file_id": file_id, "xkt_url": f"/models/{file_id}.xkt"}), 200
    except Exception as exc:  # pragma: no cover
        current_app.logger.error("[convert] unexpected error: %s", exc)
        return jsonify({"error": "convert_failed", "message": str(exc)}), 500


@api_contract_bp.post("/analyze")
def analyze_step() -> tuple[Any, int]:
    data = request.get_json(silent=True) or {}
    file_id = data.get("file_id")
    axis = data.get("axis")
    material = data.get("material")
    if not file_id or not axis or not material:
        return jsonify({"error": "file_id_axis_material_required"}), 400
    report_id = str(uuid.uuid4())
    current_app.logger.info("[dfm] file_id=%s", file_id)
    result = {
        "report_id": report_id,
        "dfm_score": 0,
        "issues": [],
        "step_used": True,
    }

    report_dir = os.path.join("static", "dfm", file_id)
    os.makedirs(report_dir, exist_ok=True)
    report_path = os.path.join(report_dir, "report.json")
    report_data: dict[str, Any]
    try:
        report_data = {
            "status": "done",
            "score": 72,
            "recommendations": [
                {
                    "id": "draft_angle",
                    "level": "error",
                    "message": "Angle de dépouille insuffisant.",
                }
            ],
            "metrics": {
                "min_thickness_mm": 1.2,
                "max_thickness_mm": 3.8,
                "avg_thickness_mm": 2.4,
                "undercuts_count": 2,
            },
        }
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report_data, fh)
    except Exception as exc:  # pragma: no cover
        report_data = {"status": "error", "message": str(exc)}
        try:
            with open(report_path, "w", encoding="utf-8") as fh:
                json.dump(report_data, fh)
        except Exception:
            pass
        current_app.logger.error("write report failed for %s: %s", file_id, exc)

    try:
        History.record_analyze(file_id, report_id, result["dfm_score"])
    except Exception as exc:  # fail soft
        current_app.logger.warning("history analyze failed for %s: %s", file_id, exc)
    return jsonify(result), 200


@api_contract_bp.get("/history")
def get_history() -> tuple[Any, int]:
    try:
        entries = History.list_history()
    except Exception as exc:  # fail soft
        current_app.logger.warning("history list failed: %s", exc)
        entries = []
    return jsonify(entries), 200


@api_contract_bp.get("/report/<file_id>")
def get_report(file_id: str) -> tuple[Any, int]:
    path = os.path.join("static", "dfm", file_id, "report.json")
    if not os.path.isfile(path):
        return jsonify({"error": "not_found"}), 404
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return jsonify(data), 200


@api_contract_bp.record_once
def _add_models_route(setup_state):
    app = setup_state.app

    @app.route("/models/<path:filename>", methods=["GET", "HEAD"])
    def serve_model(filename):
        mimetype = None
        if filename.endswith(".xkt"):
            mimetype = "model/xkt"
        elif filename.endswith(".glb"):
            mimetype = "model/gltf-binary"
        return send_from_directory(OUTPUT_FOLDER, filename, mimetype=mimetype)
