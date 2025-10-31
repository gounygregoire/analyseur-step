"""Job RQ pour reconvertir un fichier en XKT.

# Run: rq worker -u $REDIS_URL cadlytics.
"""

from __future__ import annotations

import logging
import time

from rq import get_current_job

from cadlytics.convert.pipeline import ConversionCommandError, run_conversion


logger = logging.getLogger(__name__)


def reconvert(file_id: str) -> dict[str, object]:
    """Exécute la conversion complète pour ``file_id``."""

    start_ts = time.perf_counter()
    logger.info("[worker][convert] start file_id=%s", file_id)
    job = get_current_job()
    if job:
        job.meta.pop("result", None)
        job.save_meta()
    try:
        result = run_conversion(file_id)
    except ConversionCommandError as exc:
        payload = {
            "status": "error",
            "file_id": file_id,
            "error": str(exc),
            "stdout": getattr(exc, "stdout", ""),
            "stderr": getattr(exc, "stderr", ""),
        }
        if job:
            job.meta["result"] = payload
            job.save_meta()
        elapsed = time.perf_counter() - start_ts
        stderr = (getattr(exc, "stderr", "") or "").strip().replace("\n", " ")
        logger.error(
            "[worker][convert] error file_id=%s duration=%.2fs stderr=%s",
            file_id,
            elapsed,
            stderr or "n/a",
        )
        raise
    except Exception as exc:  # pragma: no cover - log puis propagation
        payload = {
            "status": "error",
            "file_id": file_id,
            "error": str(exc),
        }
        if job:
            job.meta["result"] = payload
            job.save_meta()
        elapsed = time.perf_counter() - start_ts
        logger.exception(
            "[worker][convert] error file_id=%s duration=%.2fs", file_id, elapsed
        )
        raise

    if job:
        job.meta["result"] = result
        job.save_meta()

    elapsed = time.perf_counter() - start_ts
    xkt_size = result.get("xkt_size") if isinstance(result, dict) else None
    logger.info(
        "[worker][convert] done file_id=%s duration=%.2fs xkt_size=%s",
        file_id,
        elapsed,
        f"{xkt_size}B" if xkt_size is not None else "unknown",
    )
    return result


def convert_to_xkt(file_id: str) -> dict[str, object]:
    """Alias explicit pour la conversion XKT depuis RQ."""
    return reconvert(file_id)

