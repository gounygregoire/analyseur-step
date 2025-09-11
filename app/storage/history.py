"""Simple JSON history store for upload/convert/analyze events."""
import json
import os
import threading
from datetime import datetime
from typing import Any, Dict, List
import logging

logger = logging.getLogger(__name__)
_lock = threading.Lock()


def _path() -> str:
    base = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
    return os.environ.get("HISTORY_FILE", os.path.join(base, "history.json"))


def _load() -> List[Dict[str, Any]]:
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save(entries: List[Dict[str, Any]]) -> None:
    try:
        p = _path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entries, f)
        os.replace(tmp, p)
    except Exception as e:  # pragma: no cover - fail soft
        logger.warning("history save failed: %s", e)


def record_upload(file_id: str, filename: str, size: int, created_at: str | None = None) -> None:
    created_at = created_at or datetime.utcnow().isoformat()
    with _lock:
        entries = [e for e in _load() if e.get("file_id") != file_id]
        entries.append(
            {
                "file_id": file_id,
                "filename": filename,
                "size": size,
                "created_at": created_at,
            }
        )
        _save(entries)


def record_convert(file_id: str, convert_ms: float) -> None:
    with _lock:
        entries = _load()
        found = False
        for e in entries:
            if e.get("file_id") == file_id:
                e["xkt_ready"] = True
                e["convert_ms"] = int(convert_ms)
                found = True
                break
        if not found:
            entries.append(
                {
                    "file_id": file_id,
                    "created_at": datetime.utcnow().isoformat(),
                    "xkt_ready": True,
                    "convert_ms": int(convert_ms),
                }
            )
        _save(entries)


def record_analyze(file_id: str, report_id: str, dfm_score: float) -> None:
    with _lock:
        entries = _load()
        found = False
        for e in entries:
            if e.get("file_id") == file_id:
                e["report_id"] = report_id
                e["dfm_score"] = dfm_score
                found = True
                break
        if not found:
            entries.append(
                {
                    "file_id": file_id,
                    "created_at": datetime.utcnow().isoformat(),
                    "report_id": report_id,
                    "dfm_score": dfm_score,
                }
            )
        _save(entries)


def list_history() -> List[Dict[str, Any]]:
    entries = _load()
    try:
        entries.sort(key=lambda e: e.get("created_at", ""), reverse=True)
    except Exception:
        pass
    return entries
