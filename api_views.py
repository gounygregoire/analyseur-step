"""Routes API minimales pour l'upload et la conversion XKT (stub)."""

import os
import uuid

from flask import Blueprint, current_app as app, jsonify, request
from werkzeug.utils import secure_filename

api_bp = Blueprint("api", __name__)
ALLOWED = {".stl", ".stp", ".step"}


def _ok(name):
    low = name.lower()
    return any(low.endswith(ext) for ext in ALLOWED)


def _xkt_url(fid):
    return f"/outputs/{fid}.xkt"


@api_bp.route("/upload", methods=["POST"])
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="Aucun fichier"), 400
    if not _ok(f.filename):
        return jsonify(error="Extension non supportée (.stp/.step/.stl)"), 400
    fid = uuid.uuid4().hex
    ext = "." + f.filename.split(".")[-1].lower()
    dest = os.path.join(app.config["UPLOAD_FOLDER"], secure_filename(fid + ext))
    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
    f.save(dest)
    return (
        jsonify(
            file_id=fid,
            step_name=f.filename,
            step_path=dest,
            xkt_url=_xkt_url(fid),
        ),
        200,
    )


@api_bp.route("/convert/<fid>", methods=["POST"])
def convert(fid):
    out = os.path.join(app.config["OUTPUT_FOLDER"], f"{fid}.xkt")
    os.makedirs(app.config["OUTPUT_FOLDER"], exist_ok=True)
    with open(out, "wb") as fh:
        fh.write(b"XKT_DUMMY")
    return jsonify(xkt_url=_xkt_url(fid)), 200
