"""Routes API fichier : diagnostic et statut stateless."""

from __future__ import annotations

import os
from typing import Optional

import boto3
from botocore.exceptions import ClientError
import requests
from flask import current_app as app, jsonify

from . import api


@api.get("/_routes")
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


@api.get("/files/<file_id>/status")
def file_status_stateless(file_id: str):
    xkt_url = f"{os.getenv('XKT_BASE_URL', 'https://cadlytics.app/xkt')}/{file_id}.xkt"
    glb_url = f"{os.getenv('GLB_BASE_URL', 'https://cadlytics.app/glb')}/{file_id}.glb"

    storage_backend = os.getenv("STORAGE_BACKEND", "local").lower()
    status = "processing"
    xkt_ready = False

    if storage_backend == "s3":
        bucket = os.getenv("S3_BUCKET")
        prefix = os.getenv("S3_PREFIX_XKT", "xkt/")
        if bucket:
            exists = s3_object_exists(bucket, f"{prefix}{file_id}.xkt")
            xkt_ready = exists is True
        if not xkt_ready:
            xkt_ready = http_exists(xkt_url)
    else:
        xkt_ready = local_file_exists(file_id, "xkt") or http_exists(xkt_url)

    if xkt_ready:
        status = "ready"

    return (
        jsonify(
            {
                "status": status,
                "xkt_url": xkt_url if status == "ready" else None,
                "glb_url": glb_url if status == "ready" else None,
                "message": "",
                "updated_at": None,
            }
        ),
        200,
    )
