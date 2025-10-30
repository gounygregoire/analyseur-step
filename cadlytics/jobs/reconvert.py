"""Tâches RQ pour reconvertir des STEP en XKT.

Lancer un worker dédié avec::

    rq worker -u "$REDIS_URL" cadlytics
"""
from __future__ import annotations

import logging
from typing import Dict

from cadlytics.convert.convert_xkt import ConversionError, convert_to_xkt

logger = logging.getLogger(__name__)


def reconvert(file_id: str) -> Dict[str, object]:
    """Reconvertit le STEP associé à ``file_id`` en XKT via le worker RQ."""
    logger.info("[reconvert] start file_id=%s", file_id)
    try:
        manifest = convert_to_xkt(file_id=file_id, force_geometry=True)
    except ConversionError:
        logger.exception("[reconvert] fail conversion_error file_id=%s", file_id)
        raise
    except Exception:  # pragma: no cover - garde-fou
        logger.exception("[reconvert] fail unexpected_error file_id=%s", file_id)
        raise

    logger.info(
        "[reconvert] ok file_id=%s meshes=%s triangles=%s size=%s",
        manifest.get("file_id"),
        manifest.get("meshes"),
        manifest.get("triangles"),
        manifest.get("xkt_size") or manifest.get("size_bytes"),
    )
    return manifest
