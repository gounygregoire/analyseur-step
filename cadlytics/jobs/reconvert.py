"""Job RQ pour reconvertir un fichier en XKT.

# Run: rq worker -u $REDIS_URL cadlytics.
"""

from __future__ import annotations

from cadlytics.convert.pipeline import run_conversion


def reconvert(file_id: str) -> dict[str, object]:
    """Exécute la conversion complète pour ``file_id``."""

    print("[reconvert] start", file_id)
    try:
        result = run_conversion(file_id)
    except Exception as exc:  # pragma: no cover - log puis propagation
        print("[reconvert] fail", file_id, exc)
        raise
    print("[reconvert] ok", file_id)
    return result

