import os
import sqlite3
import logging
from contextlib import closing

from . import files as storage_files

logger = logging.getLogger("app.storage.storage")

_db_env = os.environ.get("FILES_DB_PATH")
if _db_env:
    DB_PATH = os.path.abspath(_db_env)
else:
    DB_PATH = str(storage_files.DB_PATH)

UPLOAD_FOLDER = os.path.abspath(os.environ.get("UPLOAD_FOLDER", "/tmp/uploads"))
OUTPUT_FOLDER = os.path.abspath(os.environ.get("OUTPUT_FOLDER", "/tmp/converted"))


class Storage:
    @staticmethod
    def _connect():
        db_dir = os.path.dirname(DB_PATH)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        return sqlite3.connect(DB_PATH)

    @staticmethod
    def get_step_path(file_id: str) -> str | None:
        # 1) SQLite index (table files: file_id, filename, path, size)
        try:
            with closing(Storage._connect()) as con:
                cur = con.cursor()
                cur.execute("CREATE TABLE IF NOT EXISTS files (file_id TEXT PRIMARY KEY, filename TEXT, path TEXT, size INTEGER)")
                cur.execute("SELECT path FROM files WHERE file_id = ?", (file_id,))
                row = cur.fetchone()
                if row and row[0] and os.path.isfile(row[0]):
                    return row[0]
        except Exception:
            pass
        # 2) Fallbacks: chemins dérivés par convention
        for ext in (".step", ".stp"):
            p = os.path.join(UPLOAD_FOLDER, f"{file_id}{ext}")
            if os.path.isfile(p):
                return p
        logger.warning(
            "[Storage] step not found for file_id=%s (db_path=%s, upload_folder=%s)",
            file_id,
            DB_PATH,
            UPLOAD_FOLDER,
        )
        return None

    @staticmethod
    def get_xkt_path(file_id: str) -> str | None:
        p = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
        return p if os.path.isfile(p) else None

    @staticmethod
    def save_step_record(file_id: str, filename: str, path: str, size: int) -> None:
        with closing(Storage._connect()) as con:
            cur = con.cursor()
            cur.execute("CREATE TABLE IF NOT EXISTS files (file_id TEXT PRIMARY KEY, filename TEXT, path TEXT, size INTEGER)")
            cur.execute(
                "INSERT OR REPLACE INTO files (file_id, filename, path, size) VALUES (?, ?, ?, ?)",
                (file_id, filename, path, size),
            )
            con.commit()
