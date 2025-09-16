"""Routes publiques : landing marketing, shell viewer et diffusion des exports."""

from __future__ import annotations

from pathlib import Path

from flask import Blueprint, abort, current_app, render_template, send_from_directory

site_bp = Blueprint("site", __name__)


@site_bp.route("/", endpoint="landing")
def marketing_index():
    """Landing marketing principale."""
    return render_template("marketing_index.html")


@site_bp.route("/app", endpoint="app_shell")
def app_shell():
    """Shell du viewer web dédié au viewer Xeokit."""
    return render_template("app_viewer.html")


@site_bp.route("/outputs/<path:fname>")
def outputs(fname: str):
    """Expose les fichiers générés (rapports, XKT…) de manière sécurisée."""
    folder = Path(current_app.config["OUTPUT_FOLDER"]).resolve()
    candidate = (folder / fname).resolve(strict=False)

    try:
        candidate.relative_to(folder)
    except ValueError:
        abort(404)

    if not candidate.is_file():
        abort(404)

    relative_name = str(candidate.relative_to(folder))
    return send_from_directory(folder, relative_name)
