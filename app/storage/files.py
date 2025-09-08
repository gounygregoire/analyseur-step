import os
import uuid
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from werkzeug.utils import secure_filename

# Répertoire par défaut pour les STEP
UPLOAD_DIR = Path(os.getenv("UPLOAD_FOLDER", "/data/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Base de données pour persister les métadonnées
DB_PATH = Path(os.getenv("FILES_DB", "/data/files.sqlite"))


def _init_db() -> None:
    """Crée la table ``files`` si nécessaire."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS files (
                file_id TEXT PRIMARY KEY,
                filename TEXT,
                path TEXT,
                size INTEGER
            )
            """
        )


def _save_meta_to_db(meta: "FileMeta") -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT INTO files (file_id, filename, path, size) VALUES (?, ?, ?, ?)",
            (meta.file_id, meta.filename, str(meta.path), meta.size),
        )

@dataclass
class FileMeta:
    file_id: str
    filename: str
    path: Path
    size: int

_files: dict[str, FileMeta] = {}

def save_file(file_storage) -> FileMeta:
    """Enregistre un fichier STEP et retourne ses métadonnées."""
    filename = secure_filename(file_storage.filename or "")
    file_id = str(uuid.uuid4())
    ext = Path(filename).suffix or ".step"
    dest = UPLOAD_DIR / f"{file_id}{ext}"
    file_storage.save(dest)
    meta = FileMeta(file_id=file_id, filename=filename, path=dest, size=dest.stat().st_size)
    _files[file_id] = meta
    _init_db()
    _save_meta_to_db(meta)
    return meta

def get(file_id: str) -> Optional[FileMeta]:
    """Récupère les métadonnées d'un fichier via son ID."""
    meta = _files.get(file_id)
    if meta:
        return meta
    _init_db()
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute(
            "SELECT file_id, filename, path, size FROM files WHERE file_id = ?",
            (file_id,),
        )
        row = cur.fetchone()
    if row:
        meta = FileMeta(file_id=row[0], filename=row[1], path=Path(row[2]), size=row[3])
        _files[file_id] = meta
        return meta
    return None
