"""Blueprint principal de l'API backend."""

from flask import Blueprint

api = Blueprint("api", __name__)

# Import des routes pour l'enregistrement des endpoints.
from . import files  # noqa: E402,F401
