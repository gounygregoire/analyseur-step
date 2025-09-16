"""Routes API minimales pour l'upload et la conversion XKT (stub)."""

import os
import string
import uuid
from pathlib import Path

from flask import Blueprint, current_app as app, jsonify, request
from werkzeug.utils import secure_filename

api_bp = Blueprint("api", __name__)
ALLOWED_EXTENSIONS = {".stl", ".stp", ".step"}


def _ext_ok(name: str) -> bool:
    low = name.lower()
    return any(low.endswith(ext) for ext in ALLOWED_EXTENSIONS)


def _out_url(fname: str) -> str:
    return f"/outputs/{fname}"


def _find_source(upload_dir: Path, file_id: str) -> Path | None:
    for candidate in upload_dir.glob(f"{file_id}.*"):
        if candidate.is_file():
            return candidate
    return None


@api_bp.route("/upload", methods=["POST"])
def upload():
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify(error="Aucun fichier"), 400
    if not _ext_ok(uploaded.filename):
        return jsonify(error="Extension non supportée (.stp/.step/.stl)"), 400

    file_id = uuid.uuid4().hex
    _, ext = os.path.splitext(uploaded.filename)
    ext = ext.lower()
    dest_dir = Path(app.config["UPLOAD_FOLDER"])
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_name = secure_filename(f"{file_id}{ext}")
    dest_path = dest_dir / dest_name

    try:
        uploaded.save(dest_path)
    except Exception:
        app.logger.exception("event=upload.save_failed filename=%s", uploaded.filename)
        return jsonify(error="Impossible de sauvegarder le fichier"), 500

    xkt_name = f"{file_id}.xkt"
    return (
        jsonify(
            file_id=file_id,
            step_name=uploaded.filename,
            step_path=str(dest_path),
            xkt_url=_out_url(xkt_name),
        ),
        200,
    )


@api_bp.route("/convert/<file_id>", methods=["POST"])
def convert(file_id: str):
    if not file_id or any(ch not in string.hexdigits for ch in file_id):
        return jsonify(error="Identifiant de fichier invalide"), 400

    normalized_id = file_id.lower()
    upload_dir = Path(app.config["UPLOAD_FOLDER"])
    source = _find_source(upload_dir, normalized_id)
    if source is None:
        return jsonify(error="Fichier source introuvable pour conversion"), 404

    output_dir = Path(app.config["OUTPUT_FOLDER"])
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / f"{normalized_id}.xkt"

    try:
        with open(out_path, "wb") as handle:
            handle.write(b"XKT_DUMMY")
    except Exception:
        app.logger.exception("event=convert.write_failed file_id=%s", normalized_id)
        return jsonify(error="Impossible de préparer le XKT"), 500

    return jsonify(file_id=normalized_id, xkt_url=_out_url(out_path.name)), 200


@api_bp.app_errorhandler(413)
def too_large(error):  # type: ignore[override]
    return jsonify(error="Fichier trop volumineux"), 413
