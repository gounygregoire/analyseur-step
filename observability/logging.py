import logging
import json
import time
from typing import Optional
from flask import g, request

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        model_id = getattr(record, "modelId", None)
        sha256 = getattr(record, "sha256", None)
        if model_id:
            payload["modelId"] = model_id
        if sha256:
            payload["sha256"] = sha256
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def setup_logging(app) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [handler]

    @app.before_request
    def _obs_before_request() -> None:
        g.start_time = time.time()
        g.model_id = request.headers.get("X-Model-Id") or request.args.get("modelId")
        g.sha256 = request.headers.get("X-Sha256") or request.args.get("sha256")

    @app.after_request
    def _obs_after_request(response):
        duration = time.time() - g.get("start_time", time.time())
        logger = get_logger("request", g.get("model_id"), g.get("sha256"))
        logger.info(
            "request",
            extra={
                "path": request.path,
                "method": request.method,
                "status": response.status_code,
                "duration": duration,
            },
        )
        return response


def get_logger(name: str, model_id: Optional[str] = None, sha256: Optional[str] = None) -> logging.LoggerAdapter:
    return logging.LoggerAdapter(logging.getLogger(name), {"modelId": model_id, "sha256": sha256})
