import logging
import os
import string
import uuid
from typing import Any

from flask import (
    Flask,
    abort,
    g,
    has_request_context,
    jsonify,
    render_template,
    request,
    send_from_directory,
)
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

ALLOWED_EXTENSIONS = {".stl", ".step", ".stp"}


def _ext_ok(filename: str) -> bool:
    name = filename.lower()
    return any(name.endswith(ext) for ext in ALLOWED_EXTENSIONS)


def _public_url_for_output(app: Flask, filename: str) -> str:
    return f"/outputs/{filename}"


class RequestContextFilter(logging.Filter):
    """Injecte les infos de requête dans les logs."""

    def filter(self, record: logging.LogRecord) -> bool:  # type: ignore[override]
        if has_request_context():
            record.request_id = getattr(g, "request_id", "-")
            record.method = request.method
            record.path = request.path
            record.status_code = getattr(g, "response_status", "-")
        else:
            record.request_id = "-"
            record.method = "-"
            record.path = "-"
            record.status_code = "-"
        return True


def _configure_logging() -> None:
    """Configure un logging structuré pour Render/Gunicorn."""

    log_format = (
        "%(asctime)s %(levelname)s %(name)s %(message)s "
        "request_id=%(request_id)s method=%(method)s path=%(path)s status=%(status_code)s"
    )
    root_logger = logging.getLogger()
    for handler in list(root_logger.handlers):
        root_logger.removeHandler(handler)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(log_format))
    handler.addFilter(RequestContextFilter())
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)


def create_app() -> Flask:
    _configure_logging()

    app = Flask(
        __name__,
        static_folder="static",
        static_url_path="/static",
        template_folder="templates",
    )

    app.config["UPLOAD_FOLDER"] = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
    app.config["OUTPUT_FOLDER"] = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
    raw_limit = os.environ.get("MAX_UPLOAD_MB", "50")
    try:
        max_upload_mb = float(raw_limit)
    except ValueError:
        max_upload_mb = 50.0

    app.config["MAX_UPLOAD_MB"] = max_upload_mb
    app.config["MAX_CONTENT_LENGTH"] = int(max_upload_mb * 1024 * 1024)

    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
    os.makedirs(app.config["OUTPUT_FOLDER"], exist_ok=True)

    app.logger.info(
        "event=app.start upload_folder=%s output_folder=%s",
        app.config["UPLOAD_FOLDER"],
        app.config["OUTPUT_FOLDER"],
    )

    @app.before_request
    def _attach_request_id() -> None:
        g.request_id = request.headers.get("X-Request-ID", uuid.uuid4().hex)
        g.response_status = "-"
        app.logger.info("event=request.start")

    @app.after_request
    def _log_response(response: Any):
        g.response_status = response.status_code
        response.headers["X-Request-ID"] = g.request_id
        app.logger.info("event=request.complete")
        return response

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.get("/healthz")
    def healthz():
        return jsonify(status="ok")

    def _handle_request_too_large(error: RequestEntityTooLarge):
        g.response_status = 413
        limit_mb = app.config.get("MAX_UPLOAD_MB", 0)
        limit_msg = f"{limit_mb:g}" if isinstance(limit_mb, (int, float)) else str(limit_mb)
        message = "Fichier trop volumineux. Réduis la taille ou augmente MAX_UPLOAD_MB."
        app.logger.warning("event=upload.too_large limit_mb=%s", limit_msg)
        if request.path.startswith("/api/"):
            return jsonify(error=message), 413
        return message, 413

    app.register_error_handler(RequestEntityTooLarge, _handle_request_too_large)
    app.register_error_handler(413, _handle_request_too_large)

    @app.errorhandler(404)
    def handle_404(error: Exception):  # type: ignore[override]
        g.response_status = 404
        app.logger.warning("event=request.not_found path=%s", request.path)
        if request.path.startswith("/api/"):
            return jsonify(error="Ressource API introuvable"), 404
        return render_template("500.html"), 404

    @app.errorhandler(400)
    def handle_400(error: Exception):  # type: ignore[override]
        g.response_status = 400
        app.logger.warning("event=request.bad_request path=%s", request.path)
        if request.path.startswith("/api/"):
            return jsonify(error="Requête invalide"), 400
        return render_template("500.html"), 400

    @app.route("/api/upload", methods=["POST"])
    def api_upload():
        mode = request.args.get("mode", "view")
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            app.logger.info("event=upload.missing_file")
            return jsonify(error="Aucun fichier reçu"), 400
        if not _ext_ok(uploaded.filename):
            app.logger.info("event=upload.invalid_extension filename=%s", uploaded.filename)
            return (
                jsonify(error="Extension non supportée. Utilise .stl, .step, .stp"),
                400,
            )

        _, ext = os.path.splitext(uploaded.filename)
        ext = ext.lower()
        if ext not in ALLOWED_EXTENSIONS:
            # Double check in cas d'extensions exotiques
            return (
                jsonify(error="Extension non supportée. Utilise .stl, .step, .stp"),
                400,
            )

        file_id = uuid.uuid4().hex
        safe_name = secure_filename(f"{file_id}{ext}")
        dest_path = os.path.join(app.config["UPLOAD_FOLDER"], safe_name)

        try:
            uploaded.save(dest_path)
        except Exception:
            app.logger.exception("event=upload.save_failed filename=%s", uploaded.filename)
            return jsonify(error="Impossible de sauvegarder le fichier"), 500

        xkt_name = f"{file_id}.xkt"
        xkt_url = _public_url_for_output(app, xkt_name)
        app.logger.info(
            "event=upload.saved file_id=%s source=%s dest=%s mode=%s",
            file_id,
            uploaded.filename,
            dest_path,
            mode,
        )

        return (
            jsonify(
                file_id=file_id,
                step_name=uploaded.filename,
                step_path=dest_path,
                xkt_url=xkt_url,
                mode=mode,
            ),
            200,
        )

    @app.route("/api/convert/<file_id>", methods=["POST"])
    def api_convert(file_id: str):
        if not file_id or any(ch not in string.hexdigits for ch in file_id):
            g.response_status = 400
            app.logger.warning("event=convert.invalid_id file_id=%s", file_id)
            return jsonify(error="Identifiant de fichier invalide"), 400

        normalized_id = file_id.lower()
        upload_folder = app.config["UPLOAD_FOLDER"]
        try:
            sources = [
                name
                for name in os.listdir(upload_folder)
                if name.startswith(normalized_id)
                and os.path.isfile(os.path.join(upload_folder, name))
            ]
        except FileNotFoundError:
            sources = []

        if not sources:
            g.response_status = 404
            app.logger.warning("event=convert.source_missing file_id=%s", normalized_id)
            return jsonify(error="Fichier source introuvable pour conversion"), 404

        out_folder = app.config["OUTPUT_FOLDER"]
        os.makedirs(out_folder, exist_ok=True)
        xkt_path = os.path.join(out_folder, f"{normalized_id}.xkt")

        try:
            with open(xkt_path, "wb") as handle:
                handle.write(b"XKT_DUMMY")
        except Exception:
            g.response_status = 500
            app.logger.exception("event=convert.write_failed file_id=%s", normalized_id)
            return jsonify(error="Impossible de préparer le XKT"), 500

        g.response_status = 200
        url = _public_url_for_output(app, os.path.basename(xkt_path))
        app.logger.info(
            "event=convert.stub_ready file_id=%s source=%s dest=%s",
            normalized_id,
            sources[0],
            xkt_path,
        )
        return jsonify(file_id=normalized_id, xkt_url=url), 200

    @app.route("/outputs/<path:fname>")
    def outputs(fname: str):
        folder = app.config["OUTPUT_FOLDER"]
        safe_name = os.path.normpath(fname)
        if os.path.isabs(safe_name) or safe_name.startswith(".."):
            abort(404)
        if ".." in fname.replace("\\", "/").split("/"):
            abort(404)
        path = os.path.join(folder, safe_name)
        if not os.path.isfile(path):
            abort(404)
        return send_from_directory(folder, safe_name)

    @app.errorhandler(500)
    def handle_500(error: Exception):  # type: ignore[override]
        g.response_status = 500
        app.logger.exception("event=error.internal")
        if request.path.startswith("/api/"):
            return jsonify(error="Erreur interne du serveur"), 500
        return render_template("500.html"), 500

    return app


app = create_app()
