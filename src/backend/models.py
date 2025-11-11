"""Proxys des modèles SQLAlchemy utilisés par les blueprints backend."""

from models import File as _File, db as _db

# Ré-export pour éviter la duplication de configuration SQLAlchemy.
db = _db
File = _File

__all__ = ["db", "File"]
