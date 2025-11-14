"""Routes API fichiers STEP -> XKT (pipeline RQ + worker).

Résumé du pipeline réel (scope ``/api/files/*``) :

- ``POST /api/files`` sauvegarde le STEP dans ``UPLOAD_FOLDER/<file_id>.step``
  puis enfile un job RQ via ``converter.convert_step_to_xkt`` (module
  ``converter.py``). Le job vit dans ``RQ_CONVERT_QUEUE`` (ou
  ``RQ_QUEUE_NAME``) sur Redis.
- Le worker RQ lance ``converter.convert_step_to_xkt`` qui :
  * télécharge le STEP depuis S3 si besoin («[convert][src] pulled STEP…»),
  * convertit en GLB/XKT via ``@xeokit/xeokit-convert``,
  * uploade ``xkt/<file_id>.xkt`` et ``glb/<file_id>.glb`` dans ``s3://$S3_BUCKET``
    puis met à jour ``File`` (``status``, ``xkt_url``, ``error_message``).
- Les URL publiques proviennent de ``XKT_BASE_URL`` / ``GLB_BASE_URL``
  (défaut ``https://cadlytics.app/xkt`` & ``https://cadlytics.app/glb``).
- ``GET /api/files/<file_id>/status`` consulte la DB et vérifie l'existence du
  XKT via HTTP HEAD (``http_exists``) ou ``s3_object_exists``.
- ``GET /api/files/<file_id>/xkt`` renvoie l'artefact publié par le worker
  (redirection HTTP ou proxy S3). ``generate_xkt_for_file`` reste un fallback
  local activable via ``DEV_FORCE_SAMPLE_XKT`` pour le dev/offline uniquement.
"""

from __future__ import annotations

import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Generator, Optional

import boto3
from botocore.exceptions import ClientError
import requests
from flask import (
    Blueprint,
    Response,
    current_app as app,
    jsonify,
    redirect,
    request,
    send_file,
    stream_with_context,
)
from redis import Redis
from rq import Queue
from urllib.parse import urlparse, urlunparse
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

_DEV_FORCE_SAMPLE_DEFAULT = (
    str(os.getenv("DEV_FORCE_SAMPLE_XKT", "")).strip().lower() in {"1", "true", "yes", "on"}
)
_REDIS_URL = (
    os.getenv("REDIS_URL")
    or os.getenv("REDIS_TLS_URL")
    or "redis://localhost:6379/0"
)
_RQ_QUEUE_NAME = os.getenv("RQ_CONVERT_QUEUE") or os.getenv("RQ_QUEUE_NAME") or "convert"
_RQ_JOB_TIMEOUT_SEC = int(os.getenv("RQ_JOB_TIMEOUT_SEC", "1200"))
_S3_BUCKET = os.getenv("S3_BUCKET")

_rq_queue: Queue | None = None


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
        """Upload d'un STEP + enqueue du job RQ (fallback local optionnel)."""

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

        _persist_file_row(file_id, original_name, status="enqueued")
        app.logger.info("[upload] file_id=%s step_path=%s", file_id, step_path)

        job_id: Optional[str] = None
        enqueue_error: Optional[str] = None
        force_sample = _should_force_sample_mode()

        if not force_sample:
            try:
                job_id = _enqueue_conversion_job(file_id)
                app.logger.info("[upload] enqueued file_id=%s job_id=%s", file_id, job_id)
            except Exception as exc:
                enqueue_error = str(exc)
                app.logger.exception("[upload] enqueue_failed file_id=%s", file_id)

        if job_id:
            payload = {
                "fileId": file_id,
                "file_id": file_id,
                "jobId": job_id,
                "status": "enqueued",
                "hasXKT": False,
                "xkt_url": None,
                "xktUrl": None,
                "glb_url": None,
                "message": None,
            }
            return jsonify(payload), 202

        if enqueue_error and not force_sample:
            app.logger.warning(
                "[upload] fallback_sample file_id=%s reason=%s", file_id, enqueue_error
            )

        try:
            xkt_path = generate_xkt_for_file(file_id, str(step_path))
        except Exception as exc:  # pragma: no cover - unexpected fallback failure
            app.logger.exception("[upload] sample_generation_failed file_id=%s", file_id)
            _persist_file_row(
                file_id,
                original_name,
                status="failed",
                error_message=str(exc) or "Conversion échouée",
            )
            return (
                jsonify(
                    {
                        "error": "conversion_failed",
                        "detail": str(exc) or "Conversion échouée",
                        "fileId": file_id,
                    }
                ),
                500,
            )

        _persist_file_row(
            file_id,
            original_name,
            status="ready",
            xkt_url=f"/api/files/{file_id}/xkt",
        )
        payload = {
            "fileId": file_id,
            "file_id": file_id,
            "jobId": None,
            "status": "ready",
            "hasXKT": True,
            "xkt_url": f"/api/files/{file_id}/xkt",
            "xktUrl": f"/api/files/{file_id}/xkt",
            "glb_url": None,
            "message": None,
            "xkt_path": xkt_path,
        }
        return jsonify(payload), 201

    @bp.get("/files/<file_id>/status")
    def file_status(file_id: str):
        """
        Statut basé sur :
        - la DB (File.status, File.error_message, File.xkt_url)
        - l'existence réelle du XKT (HEAD HTTP + /tmp/converted)
        """

        file_row = db.session.get(File, file_id)

        db_status = (file_row.status if file_row else None) or "pending"
        error_message = file_row.error_message if file_row else None

        xkt_url = (file_row.xkt_url if file_row and file_row.xkt_url else None) or _default_xkt_url(
            file_id
        )

        http_ok = False
        if xkt_url and xkt_url.startswith("http"):
            http_ok = http_exists(xkt_url)

        local_ok = local_file_exists(file_id, "xkt")

        xkt_exists = bool(http_ok or local_ok)

        if error_message:
            status = "error"
            has_xkt = False
        elif db_status.lower() in {"failed", "error"}:
            status = "error"
            has_xkt = False
        elif xkt_exists:
            status = "ready"
            has_xkt = True
        elif db_status.lower() in {"enqueued", "processing", "pending"}:
            status = "pending"
            has_xkt = False
        else:
            status = "pending"
            has_xkt = False

        app.logger.info(
            "[xkt-status] file_id=%s db_status=%s http_ok=%s local_ok=%s xkt_exists=%s final_status=%s",
            file_id,
            db_status,
            http_ok,
            local_ok,
            xkt_exists,
            status,
        )

        payload = {
            "fileId": file_id,
            "file_id": file_id,
            "status": status,
            "hasXKT": has_xkt,
            "message": error_message,
            "xkt_url": xkt_url,
            "xktUrl": xkt_url,
        }
        return jsonify(payload), 200

    @bp.get("/files/<file_id>/xkt")
    def file_xkt(file_id: str) -> Response:
        """Renvoie le XKT réel (redirection HTTP, proxy S3 ou fallback local)."""

        file_row = db.session.get(File, file_id)
        if not file_row:
            return jsonify({"error": "file_not_found", "fileId": file_id}), 404

        xkt_url = file_row.xkt_url or _default_xkt_url(file_id)
        if xkt_url and xkt_url.lower().startswith(("http://", "https://")):
            app.logger.info("[xkt-get] redirect file_id=%s url=%s", file_id, xkt_url)
            return redirect(xkt_url, code=302)

        s3_key = f"xkt/{file_id}.xkt"
        if _S3_BUCKET:
            s3_response = _proxy_s3_xkt(_S3_BUCKET, s3_key)
            if s3_response is not None:
                return s3_response

        xkt_path = build_xkt_path_from_file_id(file_id)
        if os.path.exists(xkt_path):
            app.logger.info("[xkt-get] serve-local file_id=%s path=%s", file_id, xkt_path)
            return send_file(xkt_path, mimetype="application/octet-stream")

        app.logger.info("[xkt-get] missing file_id=%s", file_id)
        return jsonify({"error": "xkt_not_found", "fileId": file_id}), 404

    @bp.get("/files/debug/xkt/<file_id>")
    def debug_xkt(file_id: str):
        """
        Debug: montre ce que la DB et le HTTP disent sur un XKT donné.
        """

        file_row = db.session.get(File, file_id)

        xkt_url = None
        db_status = None
        db_error = None

        if file_row:
            db_status = file_row.status
            db_error = file_row.error_message
            xkt_url = file_row.xkt_url or _default_xkt_url(file_id)
        else:
            xkt_url = _default_xkt_url(file_id)

        http_ok = http_exists(xkt_url) if xkt_url and xkt_url.startswith("http") else None
        local_ok = local_file_exists(file_id, "xkt")

        return (
            jsonify(
                {
                    "fileId": file_id,
                    "db_status": db_status,
                    "db_error_message": db_error,
                    "xkt_url": xkt_url,
                    "http_head_ok": http_ok,
                    "local_file_ok": local_ok,
                }
            ),
            200,
        )


def _normalize_redis_url(url: str) -> str:
    if not url:
        return url
    parsed = urlparse(str(url).strip().strip('"').strip("'"))
    host = parsed.hostname or ""
    needs_tls = host.endswith("redis-cloud.com") or host.endswith("redns.redis-cloud.com") or (parsed.port == 12922)
    if needs_tls and (parsed.scheme or "").lower() == "redis":
        parsed = parsed._replace(scheme="rediss")
    return urlunparse(parsed)


def _should_force_sample_mode() -> bool:
    cfg = app.config.get("DEV_FORCE_SAMPLE_XKT")
    if cfg is None:
        app.config["DEV_FORCE_SAMPLE_XKT"] = _DEV_FORCE_SAMPLE_DEFAULT
        cfg = _DEV_FORCE_SAMPLE_DEFAULT
    return bool(cfg)


def _get_rq_queue() -> Queue:
    global _rq_queue
    if _rq_queue is not None:
        return _rq_queue
    redis_url = _normalize_redis_url(_REDIS_URL)
    conn = Redis.from_url(redis_url, ssl_cert_reqs=None, socket_timeout=5)
    _rq_queue = Queue(_RQ_QUEUE_NAME, connection=conn)
    return _rq_queue


def _enqueue_conversion_job(file_id: str) -> str:
    queue = _get_rq_queue()
    job = queue.enqueue(
        "converter.convert_step_to_xkt",
        file_id,
        job_timeout=_RQ_JOB_TIMEOUT_SEC,
        result_ttl=3600,
        failure_ttl=3600,
        ttl=_RQ_JOB_TIMEOUT_SEC,
    )
    return job.id


def _proxy_s3_xkt(bucket: str, key: str) -> Optional[Response]:
    client = boto3.client("s3")
    try:
        obj = client.get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code") if hasattr(exc, "response") else None
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        app.logger.warning("[xkt-get] s3_get_failed key=%s err=%s", key, exc)
        return None

    body = obj.get("Body")
    if body is None:
        return None

    content_length = obj.get("ContentLength")

    def _generate() -> Generator[bytes, None, None]:
        try:
            for chunk in body.iter_chunks(64 * 1024):
                if chunk:
                    yield chunk
        finally:
            body.close()

    response = Response(stream_with_context(_generate()), mimetype="application/octet-stream")
    if content_length is not None:
        response.content_length = int(content_length)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return response


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
