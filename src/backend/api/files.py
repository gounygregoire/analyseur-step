"""Routes API fichier : upload STEP -> XKT + statut.

Résumé pipeline XKT CADLYTICS (scope /api/files/*) :
- POST /api/files enregistre le STEP dans ``UPLOAD_FOLDER/{file_id}.step`` puis
  appelle ``generate_xkt_for_file`` (wrapper autour de
  ``app.xkt_pipeline.convert_and_publish_xkt``) de manière synchrone.
- Chaque conversion écrit physiquement ``{XKT_LOCAL_DIR}/{file_id}.xkt`` (ex:
  ``/tmp/converted/1234-5678.xkt``) et retourne également l'URL publique.
- GET /api/files/<id>/status vérifie d'abord la présence réelle du XKT sur le
  disque pour renvoyer ``ready|pending|error`` de façon honnête.
- GET /api/files/<id>/xkt renvoie le binaire stocké localement (même chemin que
  la route /status) sans changer l'URL existante.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

import boto3
from botocore.exceptions import ClientError
import requests
from flask import Blueprint, Response, current_app as app, jsonify, request, send_file
from werkzeug.utils import secure_filename

from ..models import File, db
from app.log_utils import mask_db_uri
from app.xkt_pipeline import convert_and_publish_xkt, local_xkt_path, build_xkt_url

ALLOWED_EXTENSIONS = {".step", ".stp", ".stl"}


def register_routes(bp: Blueprint) -> None:
    @bp.get("/_routes")
    def api_routes():
        import urllib

        out = []
        for rule in app.url_map.iter_rules():
            methods = ",".join(sorted(rule.methods - {"HEAD", "OPTIONS"}))
            out.append(
                {
                    "rule": urllib.parse.unquote(str(rule)),
                    "endpoint": rule.endpoint,
                    "methods": methods,
                }
            )
        return {"routes": out}, 200

    @bp.post("/files")
    def create_file():
        """Upload synchrone d'un STEP suivi de la conversion XKT."""

        incoming = request.files.get("file")
        if not incoming or not incoming.filename:
            return jsonify({"error": "no_file"}), 400

        original_name = secure_filename(incoming.filename) or incoming.filename
        if not _allowed_extension(original_name):
            return (
                jsonify({
                    "error": "bad_ext",
                    "detail": "Extensions supportées: .step, .stp, .stl",
                }),
                400,
            )

        file_id = str(uuid.uuid4())
        step_path = _build_step_path(file_id, original_name)
        step_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            incoming.save(step_path)
        except Exception as exc:
            if step_path.exists():
                step_path.unlink(missing_ok=True)
            app.logger.exception("[upload] save_failed file_id=%s", file_id)
            return jsonify({"error": "save_failed", "detail": str(exc)}), 500

        _persist_file_row(file_id, original_name, status="processing")
        app.logger.info("[upload] file_id=%s step_path=%s", file_id, step_path)

        xkt_url = None
        message = None
        status = "pending"
        has_xkt = False

        try:
            xkt_path, xkt_url = generate_xkt_for_file(file_id, str(step_path))
            status = "ready"
            has_xkt = True
            _persist_file_row(file_id, original_name, status="ready", xkt_url=xkt_url)
            app.logger.info(
                "[xkt-convert] SUCCESS for file_id=%s xkt_path=%s", file_id, xkt_path
            )
        except Exception as exc:
            status = "error"
            message = str(exc)
            app.logger.error(
                "[xkt-convert] ERROR for file_id=%s: %s", file_id, exc, exc_info=True
            )
            _persist_file_row(
                file_id,
                original_name,
                status="failed",
                error_message=message or "Conversion échouée",
            )

        payload = {
            "fileId": file_id,
            "file_id": file_id,
            "status": status,
            "hasXKT": has_xkt,
            "xkt_url": xkt_url if has_xkt else None,
            "xktUrl": xkt_url if has_xkt else None,
            "glb_url": None,
            "message": message,
        }
        code = 201 if status == "ready" else 500 if status == "error" else 202
        return jsonify(payload), code

    @bp.get("/files/<file_id>/status")
    def file_status(file_id: str):
        """Retourne le statut JSON d'un fichier connu."""

        file_row = db.session.get(File, file_id)
        if not file_row:
            db_uri = mask_db_uri(app.config.get("SQLALCHEMY_DATABASE_URI"))
            app.logger.info(
                "[status] missing file_id=%s content_type=%s db=%s",
                file_id,
                "application/json",
                db_uri,
            )
            response = jsonify({"error": "unknown file_id"})
            response.status_code = 404
            return response

        raw_status = (file_row.status or "processing").lower()
        if raw_status not in _ALLOWED_STATUSES:
            raw_status = "processing"

        xkt_path = build_xkt_path_from_file_id(file_id)
        exists = os.path.exists(xkt_path)
        message = file_row.error_message or None

        if raw_status == "failed":
            status = "error"
        elif exists:
            status = "ready"
            message = None
        else:
            status = "pending"

        has_xkt = exists and status == "ready"
        xkt_url = None
        glb_url = None
        if has_xkt:
            xkt_url = file_row.xkt_url or _default_xkt_url(file_id)
            glb_url = _default_glb_url(file_id)
        updated_at = file_row.updated_at
        updated_str = updated_at.isoformat() if isinstance(updated_at, datetime) else None

        payload = {
            "fileId": file_id,
            "file_id": file_id,
            "status": status,
            "hasXKT": has_xkt,
            "xkt_url": xkt_url,
            "xktUrl": xkt_url,
            "glb_url": glb_url,
            "message": message,
            "updated_at": updated_str,
            "xktPath": xkt_path,
        }

        response = jsonify(payload)
        db_uri = mask_db_uri(app.config.get("SQLALCHEMY_DATABASE_URI"))
        app.logger.info(
            "[xkt-status] file_id=%s status=%s path=%s exists=%s db=%s",
            file_id,
            status,
            xkt_path,
            exists,
            db_uri,
        )
        return response, 200

    @bp.get("/files/<file_id>/xkt")
    def file_xkt(file_id: str) -> Response:
        """Renvoie le binaire XKT s'il est présent sur disque."""

        xkt_path = build_xkt_path_from_file_id(file_id)
        if not os.path.exists(xkt_path):
            app.logger.info("[xkt-get] missing file_id=%s path=%s", file_id, xkt_path)
            return jsonify({"error": "xkt_not_found", "fileId": file_id}), 404

        app.logger.info("[xkt-get] serve file_id=%s path=%s", file_id, xkt_path)
        return send_file(
            xkt_path,
            mimetype="application/octet-stream",
            as_attachment=False,
            conditional=False,
        )


def http_exists(url: str) -> bool:
    """Retourne True si un HEAD HTTP 200 est obtenu."""

    try:
        response = requests.head(url, timeout=5, allow_redirects=True)
    except Exception:
        return False
    return response.status_code == 200


def s3_object_exists(bucket: str, key: str) -> Optional[bool]:
    """Vérifie l'existence d'un objet S3. Retourne None si l'appel échoue."""

    client = boto3.client("s3")
    try:
        client.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as exc:
        error_code = exc.response.get("Error", {}).get("Code")
        if error_code in {"404", "NoSuchKey"}:
            return False
        return None


def local_file_exists(file_id: str, extension: str) -> bool:
    base_dir = os.getenv("OUTPUT_FOLDER", "/tmp/converted")
    candidate = os.path.join(base_dir, f"{file_id}.{extension}")
    return os.path.exists(candidate)


_ALLOWED_STATUSES = {"enqueued", "processing", "ready", "failed", "pending", "error"}


def _allowed_extension(filename: str) -> bool:
    return Path(filename or "").suffix.lower() in ALLOWED_EXTENSIONS


def _build_step_path(file_id: str, original_name: str) -> Path:
    ext = Path(original_name or "").suffix.lower() or ".step"
    if ext == ".stp":
        ext = ".step"
    if ext not in ALLOWED_EXTENSIONS:
        ext = ".step"
    upload_dir = Path(app.config.get("UPLOAD_FOLDER") or os.getenv("UPLOAD_FOLDER", "/tmp/uploads"))
    return upload_dir / f"{file_id}{ext}"


def build_xkt_path_from_file_id(file_id: str) -> str:
    candidate = local_xkt_path(file_id)
    path = candidate if isinstance(candidate, Path) else Path(str(candidate))
    if not path.is_absolute():
        base_dir = Path(app.config.get("OUTPUT_FOLDER") or os.getenv("OUTPUT_FOLDER", "/tmp/converted"))
        path = base_dir / f"{file_id}.xkt"
    path.parent.mkdir(parents=True, exist_ok=True)
    return str(path)


def generate_xkt_for_file(file_id: str, step_path: str) -> Tuple[str, str]:
    """Convertit un STEP en XKT et retourne (xkt_path, xkt_url)."""

    if not os.path.isfile(step_path):
        raise FileNotFoundError(f"STEP introuvable: {step_path}")

    app.logger.info("[xkt-convert] START for file_id=%s", file_id)
    result = convert_and_publish_xkt(file_id, step_path)
    xkt_path = result.local_path or build_xkt_path_from_file_id(file_id)
    if not os.path.exists(xkt_path):
        raise RuntimeError("Conversion XKT échouée: fichier introuvable")
    return xkt_path, result.xkt_url or build_xkt_url(file_id)


def _persist_file_row(
    file_id: str,
    original_name: str,
    *,
    status: str,
    xkt_url: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    now = datetime.now(timezone.utc)
    file_row = db.session.get(File, file_id)
    if not file_row:
        file_row = File(id=file_id, original_name=original_name)
        db.session.add(file_row)
    file_row.status = status
    file_row.xkt_url = xkt_url
    file_row.error_message = error_message
    file_row.updated_at = now
    db.session.commit()


def _default_xkt_url(file_id: str) -> str:
    base = (os.getenv("XKT_BASE_URL") or "https://cadlytics.app/xkt").rstrip("/")
    return f"{base}/{file_id}.xkt"


def _default_glb_url(file_id: str) -> str:
    base = (os.getenv("GLB_BASE_URL") or "https://cadlytics.app/glb").rstrip("/")
    return f"{base}/{file_id}.glb"


__all__ = ["register_routes", "http_exists", "s3_object_exists", "local_file_exists"]
