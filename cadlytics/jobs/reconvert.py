"""Tâche RQ pour reconvertir un fichier STEP/STL en XKT.

# Run: rq worker -u $REDIS_URL cadlytics
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from cadlytics.convert.convert_xkt import convert_to_xkt

logger = logging.getLogger(__name__)


def reconvert(file_id: str) -> Dict[str, Any]:
    """Reconvertit le fichier associé à ``file_id`` en XKT via RQ.

    Args:
        file_id: Identifiant du fichier à reconvertir.

    Returns:
        Le manifest détaillant la conversion généré par ``convert_to_xkt``.

    Raises:
        Exception: propage toute exception issue de ``convert_to_xkt`` afin que le job
            soit marqué en échec.
    """
    logger.info("[reconvert] start file_id=%s", file_id)
    try:
        payload = convert_to_xkt(file_id=file_id, force_geometry=True)
    except Exception:
        logger.exception("[reconvert] fail file_id=%s", file_id)
        raise

    logger.info(
        "[reconvert] ok file_id=%s meshes=%s triangles=%s size=%s",
        payload.get("file_id", file_id),
        payload.get("meshes"),
        payload.get("triangles"),
        payload.get("xkt_size") or payload.get("size_bytes"),
    )
    return payload
