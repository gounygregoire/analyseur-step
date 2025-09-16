"""Routes publiques : landing marketing, viewer Xeokit et exports statiques."""

import os

from flask import Blueprint, abort, current_app as app, render_template, send_from_directory
from werkzeug.utils import safe_join

site_bp = Blueprint("site", __name__)


@site_bp.route("/")
def index():
    """Landing marketing principale."""
    return render_template("marketing_index.html")


@site_bp.route("/app")
def app_page():
    """Page dédiée au viewer Xeokit."""
    return render_template("app_viewer.html")


@site_bp.route("/outputs/<path:fname>")
def public_outputs(fname: str):
    """Expose les fichiers générés (rapports, XKT…) en lecture seule."""
    base_dir = app.config["OUTPUT_FOLDER"]
    target = safe_join(base_dir, fname)
    if target is None:
        abort(404)

    if not os.path.isfile(target):
        abort(404)

    relative_name = os.path.relpath(target, base_dir)
    return send_from_directory(base_dir, relative_name)
