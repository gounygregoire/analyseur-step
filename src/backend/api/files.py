"""Routes API fichier : diagnostic et statut."""

from __future__ import annotations

import os
from datetime import datetime
from typing import Optional

import boto3
from botocore.exceptions import ClientError
import requests
from flask import Blueprint, current_app as app, jsonify

from ..models import File, db
from app.log_utils import mask_db_uri


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

        status = (file_row.status or "processing").lower()
        if status not in _ALLOWED_STATUSES:
            status = "processing"

        xkt_url = None
        glb_url = None
        if status == "ready":
            xkt_url = file_row.xkt_url or _default_xkt_url(file_id)
            glb_url = _default_glb_url(file_id)

        message = file_row.error_message or ""
        updated_at = file_row.updated_at
        if isinstance(updated_at, datetime):
            updated_str = updated_at.isoformat()
        else:
            updated_str = None

        payload = {
            "status": status,
            "xkt_url": xkt_url,
            "glb_url": glb_url,
            "message": message,
            "updated_at": updated_str,
        }

        response = jsonify(payload)
        db_uri = mask_db_uri(app.config.get("SQLALCHEMY_DATABASE_URI"))
        app.logger.info(
            "[status] file_id=%s status=%s content_type=%s db=%s",
            file_id,
            status,
            response.content_type,
            db_uri,
        )
        return response, 200


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


_ALLOWED_STATUSES = {"enqueued", "processing", "ready", "failed"}


def _default_xkt_url(file_id: str) -> str:
    base = (os.getenv("XKT_BASE_URL") or "https://cadlytics.app/xkt").rstrip("/")
    return f"{base}/{file_id}.xkt"


def _default_glb_url(file_id: str) -> str:
    base = (os.getenv("GLB_BASE_URL") or "https://cadlytics.app/glb").rstrip("/")
    return f"{base}/{file_id}.glb"


__all__ = ["register_routes", "http_exists", "s3_object_exists", "local_file_exists"]
