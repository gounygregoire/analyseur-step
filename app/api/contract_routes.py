from __future__ import annotations
import os
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from flask import Blueprint, current_app, jsonify, request
from werkzeug.utils import secure_filename

from app.storage.storage import Storage
from app.storage import history as History

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
    data = request.get_json(silent=True) or request.form or {}
    file_id = data.get("file_id")
    if not file_id:
        current_app.logger.warning("/convert missing file_id")
        return jsonify({"error": "missing_or_unknown_file_id", "message": "file_id manquant"}), 400

    step_path = Storage.get_step_path(file_id)
    if not step_path or not os.path.isfile(step_path):
        current_app.logger.warning("/convert unknown file_id=%s", file_id)
        return jsonify({"error": "missing_or_unknown_file_id", "message": "file_id inconnu"}), 400

    tolerance_raw = data.get("tolerance", 0.1)
    try:
        tolerance = float(tolerance_raw)
    except (TypeError, ValueError):
        current_app.logger.warning("/convert invalid tolerance=%r", tolerance_raw)
        return jsonify({"error": "invalid_tolerance", "message": "tolerance invalide"}), 422

    os.makedirs(OUTPUT_FOLDER, exist_ok=True)
    xkt_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
    preview_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.png")
    current_app.logger.info("[convert] file_id=%s", file_id)

    cmd = ["python", "xkt_converter.py", step_path, xkt_path]
    current_app.logger.info(
        "conversion start for %s -> %s (tol=%s)", step_path, xkt_path, tolerance
    )
    t0 = time.time()
    try:
        res = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120
        )
    except subprocess.TimeoutExpired:
        duration = time.time() - t0
        current_app.logger.error("conversion timeout for %s after %.1fs", file_id, duration)
        return (
            jsonify({"error": "xkt_convert_failed", "message": "timeout"}),
            502,
        )
    except FileNotFoundError as exc:
        current_app.logger.error("converter missing for %s: %s", file_id, exc)
        return (
            jsonify({"error": "xkt_convert_failed", "message": str(exc)[:200]}),
            502,
        )

    duration = time.time() - t0
    if res.returncode != 0:
        stderr = ((res.stdout or "") + (res.stderr or "")).strip()[:200]
        current_app.logger.error(
            "conversion failed rc=%s for %s: %s", res.returncode, file_id, stderr
        )
        return (
            jsonify({"error": "xkt_convert_failed", "message": stderr}),
            502,
        )

    if not os.path.isfile(xkt_path):
        current_app.logger.error("xkt missing for %s -> %s", file_id, xkt_path)
        return (
            jsonify({"error": "xkt_convert_failed", "message": "xkt missing"}),
            502,
        )
    current_app.logger.info("conversion ok for %s in %.1fs", file_id, duration)
    current_app.logger.info("XKT written -> %s", os.path.abspath(xkt_path))
    try:
        from generate_thumbnails import generate_thumbnails
        thumbs = generate_thumbnails(step_path, OUTPUT_FOLDER)
        preview_path = thumbs.get("iso", preview_path)
    except Exception as exc:  # pragma: no cover
        current_app.logger.warning("thumbnail generation failed for %s: %s", file_id, exc)
        Path(preview_path).write_bytes(b"")

    try:
        History.record_convert(file_id, duration * 1000)
    except Exception as exc:  # fail soft
        current_app.logger.warning("history convert failed for %s: %s", file_id, exc)

    return (
        jsonify({
            "file_id": file_id,
            "xkt_url": f"/static/converted/{file_id}.xkt",
            "preview_png": preview_path,
        }),
        200,
    )


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
