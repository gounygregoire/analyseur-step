"""Gestion centralisée des réponses d'erreur JSON."""
from __future__ import annotations

import uuid
from http import HTTPStatus
from typing import Dict

from flask import jsonify, current_app
from werkzeug.exceptions import HTTPException

# Mapping des codes vers un identifiant d'erreur stable
ERROR_NAMES: Dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "unprocessable_entity",
    429: "too_many_requests",
    502: "bad_gateway",
    504: "gateway_timeout",
}


def register_error_handlers(app) -> None:
    """Enregistre des handlers Flask renvoyant systématiquement du JSON."""

    @app.errorhandler(Exception)
    def handle_exception(exc: Exception):
        if isinstance(exc, HTTPException):
            code = exc.code or 500
            if code == 500:
                trace_id = str(uuid.uuid4())
                current_app.logger.exception("Unhandled 500 %s", trace_id, exc_info=exc)
                return jsonify({"error": "internal_error", "trace_id": trace_id}), 500
            name = ERROR_NAMES.get(code, HTTPStatus(code).name.lower())
            message = exc.description or HTTPStatus(code).phrase
            return jsonify({"error": name, "message": message}), code

        trace_id = str(uuid.uuid4())
        current_app.logger.exception("Unhandled exception %s", trace_id, exc_info=exc)
        return jsonify({"error": "internal_error", "trace_id": trace_id}), 500
