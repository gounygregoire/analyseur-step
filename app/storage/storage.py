"""Persistence utilitaire pour les fichiers STEP/XKT."""

import os, sqlite3, logging, shutil
from contextlib import closing


logger = logging.getLogger("app.storage.storage")

DB_PATH = os.environ.get("FILES_DB_PATH") or os.path.join(os.path.dirname(__file__), "files.sqlite")
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
XKT_LOCAL_DIR = os.path.abspath(os.environ.get("XKT_LOCAL_DIR", "./public/xkt"))


class Storage:
    @staticmethod
    def _connect():
        db_dir = os.path.dirname(DB_PATH)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        return sqlite3.connect(DB_PATH)

    @staticmethod
    def save_step_record(file_id: str, filename: str, path: str, size: int) -> None:
        with closing(Storage._connect()) as con:
            cur = con.cursor()
            cur.execute(
                "CREATE TABLE IF NOT EXISTS files (file_id TEXT PRIMARY KEY, filename TEXT, path TEXT, size INTEGER)"
            )
            cur.execute(
                "INSERT OR REPLACE INTO files (file_id, filename, path, size) VALUES (?, ?, ?, ?)",
                (file_id, filename, path, size),
            )
            con.commit()

    @staticmethod
    def get_step_path(file_id: str) -> str | None:
        # 1) DB lookup
        try:
            with closing(Storage._connect()) as con:
                cur = con.cursor()
                cur.execute(
                    "CREATE TABLE IF NOT EXISTS files (file_id TEXT PRIMARY KEY, filename TEXT, path TEXT, size INTEGER)"
                )
                cur.execute("SELECT path FROM files WHERE file_id = ?", (file_id,))
                row = cur.fetchone()
                if row and row[0] and os.path.isfile(row[0]):
                    return row[0]
        except Exception as e:  # pragma: no cover
            logger.warning("[Storage] DB lookup failed: %r", e)

        # 2) Fallback by convention
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
        try:
            from app.file_records import get as get_file_record

            record = get_file_record(file_id)
            if record and record.xkt_path:
                return record.xkt_path
        except Exception:
            pass

        candidate = os.path.join(XKT_LOCAL_DIR, f"{file_id}.xkt")
        if os.path.isfile(candidate):
            return candidate

        fallback = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
        return fallback if os.path.isfile(fallback) else None

    @staticmethod
    def ensure_step_persisted(file_id: str, tmp_step_path: str, original_filename: str) -> str:
        """Copy the uploaded/converted temp STEP into the canonical uploads dir and index it in SQLite if missing."""

        os.makedirs(UPLOAD_FOLDER, exist_ok=True)
        ext = os.path.splitext(original_filename)[1].lower()
        if ext not in (".step", ".stp"):
            ext = ".step"
        canonical = os.path.join(UPLOAD_FOLDER, f"{file_id}{ext}")
        if not os.path.isfile(canonical):
            shutil.copy2(tmp_step_path, canonical)
            Storage.save_step_record(
                file_id, original_filename, canonical, os.path.getsize(canonical)
            )
            logger.info("[Storage] persisted STEP → %s", canonical)
        else:
            logger.info("[Storage] STEP already persisted → %s", canonical)
        return canonical

