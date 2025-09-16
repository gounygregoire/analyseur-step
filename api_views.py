"""Routes API minimales pour l'upload et la conversion XKT (stub)."""

import uuid
from pathlib import Path
from typing import Optional

from flask import Blueprint, current_app as app, jsonify, request
from werkzeug.utils import secure_filename

api_bp = Blueprint("api", __name__)
ALLOWED = {".stl", ".stp", ".step"}


def _safe_ext(filename: str) -> Optional[str]:
    """Retourne l'extension autorisée (en minuscule) ou None."""

    ext = Path(filename).suffix.lower()
    if ext in ALLOWED:
        return ext
    return None


def _xkt_url(fid: str) -> str:
    return f"/outputs/{fid}.xkt"


@api_bp.route("/upload", methods=["POST"])
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="Aucun fichier"), 400

    ext = _safe_ext(f.filename)
    if not ext:
        return jsonify(error="Extension non supportée (.stp/.step/.stl)"), 400

    fid = uuid.uuid4().hex
    upload_dir = Path(app.config["UPLOAD_FOLDER"])
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / secure_filename(f"{fid}{ext}")

    try:
        f.save(dest)
    except OSError:
        app.logger.exception("Échec de sauvegarde du fichier STEP", extra={"file_id": fid})
        if dest.exists():
            dest.unlink(missing_ok=True)
        return jsonify(error="Impossible de sauvegarder le fichier"), 500

    return (
        jsonify(
            file_id=fid,
            step_name=f.filename,
            step_path=str(dest),
            xkt_url=_xkt_url(fid),
        ),
        200,
    )


def _find_step_source(fid: str, upload_dir: Path) -> Optional[Path]:
    for ext in ALLOWED:
        candidate = upload_dir / f"{fid}{ext}"
        if candidate.exists():
            return candidate
    return None


def _is_uuid_hex(value: str) -> bool:
    try:
        uuid.UUID(hex=value)
    except (ValueError, TypeError):
        return False
    return True


@api_bp.route("/convert/<fid>", methods=["POST"])
def convert(fid: str):
    if not _is_uuid_hex(fid):
        return jsonify(error="Identifiant de fichier invalide"), 400

    upload_dir = Path(app.config["UPLOAD_FOLDER"])
    source = _find_step_source(fid, upload_dir)
    if not source:
        return jsonify(error="Fichier source introuvable pour conversion"), 404

    output_dir = Path(app.config["OUTPUT_FOLDER"])
    output_dir.mkdir(parents=True, exist_ok=True)
    out = output_dir / f"{fid}.xkt"

    try:
        with out.open("wb") as fh:
            fh.write(b"XKT_DUMMY")
    except OSError:
        app.logger.exception("Échec de génération du stub XKT", extra={"file_id": fid})
        if out.exists():
            out.unlink(missing_ok=True)
        return jsonify(error="Impossible de créer le fichier XKT"), 500

    return jsonify(file_id=fid, xkt_url=_xkt_url(fid)), 200
