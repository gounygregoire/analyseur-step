"""Routes API fichiers STEP -> XKT (MVP conversion sample).

Résumé rapide (scope /api/files/*) :
- Les STEP uploadés sont enregistrés dans ``UPLOAD_FOLDER/{file_id}.step``.
- Les XKT générés/copier-coller sont stockés dans ``XKT_DIR/{file_id}.xkt``
  (soit ``/workspace/analyseur-step/xkt_files/<file_id>.xkt`` en local).
- ``generate_xkt_for_file`` est appelé *synchronement* dans ``POST /api/files``
  pour copier ``static/xkt/sample.xkt`` (ou créer un fichier vide) afin
  d'éviter les timeouts côté viewer.
- ``GET /api/files/<file_id>/status`` regarde uniquement la présence du XKT et
  renvoie ``pending`` tant que le fichier n'est pas sur disque, sinon ``ready``.
- ``GET /api/files/<file_id>/xkt`` et ``GET /api/files/debug/xkt/<file_id>``
  servent respectivement le binaire et un aperçu du dossier ``xkt_files``.

Exemple concret : pour ``file_id=1234-5678`` on obtient :
- STEP : ``/tmp/uploads/1234-5678.step``
- XKT  : ``/workspace/analyseur-step/xkt_files/1234-5678.xkt``
"""

from __future__ import annotations

import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import boto3
from botocore.exceptions import ClientError
import requests
from flask import Blueprint, Response, current_app as app, jsonify, request, send_file
from werkzeug.utils import secure_filename

from ..models import File, db

ALLOWED_EXTENSIONS = {".step", ".stp", ".stl"}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "..", "..", ".."))
XKT_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, "xkt_files"))
SAMPLE_XKT_PATH = os.path.abspath(
    os.path.join(PROJECT_ROOT, "static", "xkt", "sample.xkt")
)
os.makedirs(XKT_DIR, exist_ok=True)
os.makedirs(os.path.dirname(SAMPLE_XKT_PATH), exist_ok=True)


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
        """Upload synchrone d'un STEP suivi du drop XKT sample."""

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
        print(f"[upload] file_id={file_id}, step_path={step_path}", flush=True)

        try:
            xkt_path = generate_xkt_for_file(file_id, str(step_path))
            _persist_file_row(
                file_id,
                original_name,
                status="ready",
                xkt_url=f"/api/files/{file_id}/xkt",
            )
            print(
                f"[upload] XKT generated for file_id={file_id}, xkt_path={xkt_path}",
                flush=True,
            )
        except Exception as exc:
            print(f"[xkt-convert] ERROR for file_id={file_id}: {exc}", flush=True)
            _persist_file_row(
                file_id,
                original_name,
                status="failed",
                error_message=str(exc) or "Conversion échouée",
            )

        return jsonify({"fileId": file_id, "jobId": None}), 200

    @bp.get("/files/<file_id>/status")
    def file_status(file_id: str):
        """Statut simplifié basé uniquement sur la présence du XKT."""

        xkt_path = build_xkt_path_from_file_id(file_id)
        exists = os.path.exists(xkt_path)
        status = "ready" if exists else "pending"
        print(
            f"[xkt-status] file_id={file_id}, xkt_path={xkt_path}, exists={exists}",
            flush=True,
        )
        payload = {
            "fileId": file_id,
            "file_id": file_id,
            "status": status,
            "hasXKT": bool(exists),
            "message": None,
            "xkt_url": f"/api/files/{file_id}/xkt",
            "xktUrl": f"/api/files/{file_id}/xkt",
        }
        return jsonify(payload), 200

    @bp.get("/files/<file_id>/xkt")
    def file_xkt(file_id: str) -> Response:
        """Renvoie le binaire XKT s'il est présent sur disque."""

        xkt_path = build_xkt_path_from_file_id(file_id)
        exists = os.path.exists(xkt_path)
        print(
            f"[xkt-get] file_id={file_id}, xkt_path={xkt_path}, exists={exists}",
            flush=True,
        )
        if not exists:
            return jsonify({"error": "XKT not found"}), 404

        return send_file(xkt_path, mimetype="application/octet-stream")

    @bp.get("/files/debug/xkt/<file_id>")
    def debug_xkt(file_id: str):
        """Debug: expose le répertoire xkt_files et l'état d'un fichier donné."""

        xkt_path = build_xkt_path_from_file_id(file_id)
        dir_path = os.path.dirname(xkt_path)
        try:
            listing = os.listdir(dir_path)
        except Exception as exc:  # pragma: no cover - dépend du FS
            listing = [f"<error listing dir: {exc}>"]

        exists = os.path.exists(xkt_path)

        return (
            jsonify(
                {
                    "fileId": file_id,
                    "xkt_path": xkt_path,
                    "xkt_exists": exists,
                    "dir": dir_path,
                    "dir_listing": listing,
                }
            ),
            200,
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
    """Chemin absolu déterministe dans ``xkt_files`` pour un ``file_id``."""

    os.makedirs(XKT_DIR, exist_ok=True)
    return os.path.join(XKT_DIR, f"{file_id}.xkt")


def generate_xkt_for_file(file_id: str, step_path: str) -> str:
    """MVP: copie ``sample.xkt`` pour débloquer la chaîne upload -> viewer."""

    if not os.path.isfile(step_path):
        raise FileNotFoundError(f"STEP introuvable: {step_path}")

    xkt_path = build_xkt_path_from_file_id(file_id)
    os.makedirs(os.path.dirname(xkt_path), exist_ok=True)

    if os.path.exists(SAMPLE_XKT_PATH):
        shutil.copyfile(SAMPLE_XKT_PATH, xkt_path)
        print(
            f"[xkt-convert] SAMPLE COPY for file_id={file_id}, src={SAMPLE_XKT_PATH}, dst={xkt_path}",
            flush=True,
        )
    else:
        with open(xkt_path, "wb") as handle:
            handle.write(b"")
        print(
            f"[xkt-convert] NO SAMPLE FOUND, created empty XKT for file_id={file_id} at {xkt_path}",
            flush=True,
        )

    return xkt_path


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
