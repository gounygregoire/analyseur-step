"""Gestion des métadonnées de fichiers convertis (STEP -> XKT).

Ce module fournit une couche très légère au-dessus de SQLite pour suivre
l'état des conversions asynchrones : un enregistrement par ``file_id`` avec
le statut courant et les chemins XKT associés.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_DB_PATH = os.environ.get("FILES_DB_PATH")
if not _DB_PATH:
    base = Path(__file__).resolve().parent / "storage"
    base.mkdir(parents=True, exist_ok=True)
    _DB_PATH = str(base / "files.sqlite")
else:
    Path(_DB_PATH).parent.mkdir(parents=True, exist_ok=True)

_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS file_records (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    status TEXT NOT NULL,
    xkt_path TEXT,
    xkt_url TEXT,
    error_message TEXT,
    updated_at TEXT NOT NULL,
    step_path TEXT
)
"""

_ALLOWED_STATUS = {"processing", "ready", "failed"}


@dataclass(slots=True)
class FileRecord:
    """Représente l'état courant d'une conversion."""

    id: str
    original_name: str
    status: str
    xkt_path: Optional[str]
    xkt_url: Optional[str]
    error_message: Optional[str]
    updated_at: str
    step_path: Optional[str]

    def to_payload(self) -> dict[str, Optional[str]]:
        """Retourne un payload API prêt à sérialiser."""

        payload: dict[str, Optional[str]] = {
            "status": self.status,
            "xkt_url": self.xkt_url if self.status == "ready" else None,
            "message": self.error_message if self.status == "failed" else None,
            "updated_at": self.updated_at,
        }
        return payload


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    with closing(conn.cursor()) as cur:
        cur.execute(_TABLE_SQL)
        conn.commit()
    return conn


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_or_update(
    *,
    file_id: str,
    original_name: str,
    step_path: str,
    status: str = "processing",
) -> FileRecord:
    if status not in _ALLOWED_STATUS:
        raise ValueError(f"Statut invalide: {status}")

    updated_at = _utc_now()
    with closing(_connect()) as conn:
        conn.execute(
            """
            INSERT INTO file_records (id, original_name, status, xkt_path, xkt_url, error_message, updated_at, step_path)
            VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                original_name = excluded.original_name,
                status = excluded.status,
                xkt_path = NULL,
                xkt_url = NULL,
                error_message = NULL,
                updated_at = excluded.updated_at,
                step_path = excluded.step_path
            """,
            (file_id, original_name, status, updated_at, step_path),
        )
        conn.commit()

    return get(file_id)


def mark_processing(file_id: str) -> Optional[FileRecord]:
    updated_at = _utc_now()
    with closing(_connect()) as conn:
        res = conn.execute(
            """
            UPDATE file_records
            SET status = 'processing', xkt_path = NULL, xkt_url = NULL, error_message = NULL, updated_at = ?
            WHERE id = ?
            """,
            (updated_at, file_id),
        )
        conn.commit()
        if res.rowcount == 0:
            return None
    return get(file_id)


def mark_ready(file_id: str, *, xkt_path: str, xkt_url: str) -> Optional[FileRecord]:
    updated_at = _utc_now()
    with closing(_connect()) as conn:
        res = conn.execute(
            """
            UPDATE file_records
            SET status = 'ready', xkt_path = ?, xkt_url = ?, error_message = NULL, updated_at = ?
            WHERE id = ?
            """,
            (xkt_path, xkt_url, updated_at, file_id),
        )
        conn.commit()
        if res.rowcount == 0:
            return None
    return get(file_id)


def mark_failed(file_id: str, message: str) -> Optional[FileRecord]:
    updated_at = _utc_now()
    short = (message or "").strip()
    if len(short) > 500:
        short = short[:500]
    with closing(_connect()) as conn:
        res = conn.execute(
            """
            UPDATE file_records
            SET status = 'failed', error_message = ?, updated_at = ?
            WHERE id = ?
            """,
            (short or "Conversion échouée", updated_at, file_id),
        )
        conn.commit()
        if res.rowcount == 0:
            return None
    return get(file_id)


def get(file_id: str) -> Optional[FileRecord]:
    with closing(_connect()) as conn:
        cur = conn.execute(
            "SELECT id, original_name, status, xkt_path, xkt_url, error_message, updated_at, step_path FROM file_records WHERE id = ?",
            (file_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return FileRecord(
        id=row["id"],
        original_name=row["original_name"],
        status=row["status"],
        xkt_path=row["xkt_path"],
        xkt_url=row["xkt_url"],
        error_message=row["error_message"],
        updated_at=row["updated_at"],
        step_path=row["step_path"],
    )


def delete(file_id: str) -> None:
    with closing(_connect()) as conn:
        conn.execute("DELETE FROM file_records WHERE id = ?", (file_id,))
        conn.commit()
