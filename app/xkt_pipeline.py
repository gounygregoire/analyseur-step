"""Pipeline de conversion STEP -> XKT avec publication locale ou S3.

Ce module centralise la configuration et l'orchestration de la conversion XKT
afin de garantir un nommage strict ``{file_id}.xkt`` et une URL finale
cohérente pour le front-end.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from botocore.config import Config
import boto3

from xkt_converter import convert_step_to_xkt

logger = logging.getLogger("cadlytics.xkt")


def _coerce_bool(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return None


# === Configuration ===
XKT_STORAGE = (os.getenv("XKT_STORAGE") or "local").strip().lower()
XKT_LOCAL_DIR = Path(os.getenv("XKT_LOCAL_DIR", "./public/xkt")).expanduser()
S3_BUCKET_XKT = os.getenv("S3_BUCKET_XKT") or os.getenv("S3_BUCKET")
S3_PREFIX_XKT = os.getenv("S3_PREFIX_XKT", "xkt/")
S3_REGION = os.getenv("S3_REGION") or os.getenv("AWS_REGION") or "us-east-1"
S3_ENDPOINT = os.getenv("S3_ENDPOINT")
S3_FORCE_PATH_STYLE = os.getenv("S3_FORCE_PATH_STYLE", "0") in {"1", "true", "True"}
S3_XKT_ACL = os.getenv("S3_XKT_ACL")
XKT_BASE_URL = os.getenv("XKT_BASE_URL", "/xkt")
SERVE_XKT_FROM_FLASK = os.getenv("SERVE_XKT_FROM_FLASK")
XKT_FAKE_CONVERTER = _coerce_bool(os.getenv("XKT_FAKE_CONVERTER"))

_ALLOWED_STORAGE = {"local", "s3"}
if XKT_STORAGE not in _ALLOWED_STORAGE:
    logger.warning("[convert] XKT_STORAGE inconnu=%s, fallback 'local'", XKT_STORAGE)
    XKT_STORAGE = "local"


@dataclass(frozen=True)
class ConversionResult:
    """Résultat de la conversion et publication XKT."""

    file_id: str
    step_path: str
    local_path: str
    xkt_url: str
    size_bytes: int
    duration_sec: float


def _normalize_base_url(base: Optional[str]) -> str:
    candidate = (base if base is not None else XKT_BASE_URL) or ""
    candidate = candidate.strip()
    if not candidate:
        return "/xkt"
    candidate = candidate.rstrip("/")
    if not candidate:
        return "/xkt"
    return candidate


def build_xkt_url(file_id: str, base: Optional[str] = None) -> str:
    """Construit l'URL publique finale du XKT."""

    base_url = _normalize_base_url(base)
    return f"{base_url}/{file_id}.xkt"


def local_xkt_path(file_id: str) -> Path:
    """Chemin local attendu pour ``file_id`` (même si stockage S3)."""

    return XKT_LOCAL_DIR / f"{file_id}.xkt"


def _ensure_local_dir() -> None:
    try:
        XKT_LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        logger.exception("[convert] impossible de créer %s", XKT_LOCAL_DIR)
        raise


def _s3_client():
    cfg_kwargs = {"signature_version": "s3v4"}
    if S3_FORCE_PATH_STYLE:
        cfg_kwargs["s3"] = {"addressing_style": "path"}
    config = Config(**cfg_kwargs)
    session = boto3.session.Session(region_name=S3_REGION)
    return session.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        config=config,
    )


def _publish_to_s3(tmp_path: Path, file_id: str) -> str:
    if not S3_BUCKET_XKT:
        raise RuntimeError("S3_BUCKET_XKT non configuré pour XKT_STORAGE=s3")

    key_prefix = S3_PREFIX_XKT or ""
    if key_prefix and not key_prefix.endswith("/"):
        key_prefix = f"{key_prefix}/"
    key = f"{key_prefix}{file_id}.xkt"

    extra_args = {"ContentType": "application/octet-stream"}
    if S3_XKT_ACL:
        extra_args["ACL"] = S3_XKT_ACL

    client = _s3_client()
    client.upload_file(str(tmp_path), S3_BUCKET_XKT, key, ExtraArgs=extra_args)
    logger.info(
        "[convert] uploaded file_id=%s storage=s3 bucket=%s key=%s size=%s",
        file_id,
        S3_BUCKET_XKT,
        key,
        tmp_path.stat().st_size,
    )
    return f"s3://{S3_BUCKET_XKT}/{key}"


def _publish_to_local(tmp_path: Path, file_id: str) -> str:
    _ensure_local_dir()
    dest = local_xkt_path(file_id)
    if dest.exists():
        dest.unlink()
    shutil.move(str(tmp_path), dest)
    logger.info(
        "[convert] stored file_id=%s storage=local path=%s size=%s",
        file_id,
        dest,
        dest.stat().st_size,
    )
    return str(dest)


def convert_and_publish_xkt(file_id: str, step_path: str) -> ConversionResult:
    """Convertit ``step_path`` en XKT et publie le résultat.

    Retourne le chemin (local ou S3) et l'URL finale.
    """

    start = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="xkt_", dir="/tmp") as tmp_dir:
        tmp_path = Path(tmp_dir) / f"{file_id}.xkt"
        logger.info(
            "[convert] start file_id=%s storage=%s step=%s",
            file_id,
            XKT_STORAGE,
            step_path,
        )
        if XKT_FAKE_CONVERTER:
            logger.info(
                "[convert] fake_enabled file_id=%s source=%s", file_id, step_path
            )
            tmp_path.write_bytes(b"XKT-FAKE")
        else:
            convert_step_to_xkt(step_path, str(tmp_path))
        if not tmp_path.exists():
            raise RuntimeError("Conversion XKT échouée: fichier temporaire absent")
        size = tmp_path.stat().st_size
        logger.info(
            "[convert] temp_ready file_id=%s path=%s size=%s",
            file_id,
            tmp_path,
            size,
        )

        if XKT_STORAGE == "s3":
            published_path = _publish_to_s3(tmp_path, file_id)
        else:
            published_path = _publish_to_local(tmp_path, file_id)

        duration = time.monotonic() - start
        url = build_xkt_url(file_id)
        logger.info(
            "[convert] done file_id=%s url=%s duration=%.2fs size=%s",
            file_id,
            url,
            duration,
            size,
        )
        return ConversionResult(
            file_id=file_id,
            step_path=step_path,
            local_path=published_path,
            xkt_url=url,
            size_bytes=size,
            duration_sec=duration,
        )


def is_local_storage() -> bool:
    return XKT_STORAGE == "local"


def should_serve_xkt_via_flask() -> bool:
    """Indique si Flask doit exposer ``/xkt/<id>.xkt`` directement."""

    explicit = _coerce_bool(SERVE_XKT_FROM_FLASK)
    if explicit is not None:
        return explicit

    if not is_local_storage():
        return False

    base = (XKT_BASE_URL or "").strip()
    if not base:
        return True

    normalized = _normalize_base_url(base)
    return normalized.startswith("/")

