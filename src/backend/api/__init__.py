"""Blueprint principal de l'API backend."""

from flask import Blueprint

from . import files


def create_api_blueprint() -> Blueprint:
    api = Blueprint("cadlytics_api", __name__)
    files.register_routes(api)
    return api


__all__ = ["create_api_blueprint"]
