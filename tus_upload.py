import os
import uuid
import json
import base64
from flask import Blueprint, request, current_app, abort, Response


# Blueprint implementing a minimal tus.io server
# Stores uploads in <UPLOAD_FOLDER>/tus


tus_bp = Blueprint('tus', __name__)
TUS_VERSION = '1.0.0'
MAX_SIZE = 2 * 1024 * 1024 * 1024  # 2GB


def _tus_dir():
    root = os.path.join(current_app.config['UPLOAD_FOLDER'], 'tus')
    os.makedirs(root, exist_ok=True)
    return root


def _info_path(upload_id):
    return os.path.join(_tus_dir(), f"{upload_id}.json")


def _file_path(upload_id):
    return os.path.join(_tus_dir(), upload_id)


def _load_info(upload_id):
    p = _info_path(upload_id)
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def _save_info(upload_id, info):
    with open(_info_path(upload_id), 'w') as f:
        json.dump(info, f)


@tus_bp.route('/files', methods=['OPTIONS'])
@tus_bp.route('/files/<upload_id>', methods=['OPTIONS'])
def tus_options(upload_id=None):
    resp = Response(status=204)
    resp.headers['Tus-Resumable'] = TUS_VERSION
    resp.headers['Tus-Version'] = TUS_VERSION
    resp.headers['Tus-Extension'] = 'creation'
    resp.headers['Access-Control-Allow-Methods'] = 'POST,HEAD,PATCH,OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Tus-Resumable,Upload-Length,Upload-Offset,Content-Type,Upload-Metadata'
    return resp


@tus_bp.route('/files', methods=['POST'])
def tus_create():
    upload_length = request.headers.get('Upload-Length')
    if upload_length is None:
        abort(400)
    upload_length = int(upload_length)
    if upload_length > MAX_SIZE:
        return Response(status=413)

    meta_hdr = request.headers.get('Upload-Metadata', '')
    metadata = {}
    if meta_hdr:
        for kv in meta_hdr.split(','):
            if ' ' in kv:
                k, v = kv.split(' ', 1)
                metadata[k] = base64.b64decode(v).decode('utf-8')
    upload_id = uuid.uuid4().hex
    info = {'upload_length': upload_length, 'offset': 0, 'metadata': metadata}
    _save_info(upload_id, info)
    open(_file_path(upload_id), 'wb').close()
    resp = Response(status=201)
    resp.headers['Location'] = f"/tus/files/{upload_id}"
    resp.headers['Tus-Resumable'] = TUS_VERSION
    resp.headers['Upload-Offset'] = '0'
    return resp


@tus_bp.route('/files/<upload_id>', methods=['HEAD'])
def tus_head(upload_id):
    info = _load_info(upload_id)
    if not info:
        abort(404)
    resp = Response(status=200)
    resp.headers['Tus-Resumable'] = TUS_VERSION
    resp.headers['Upload-Offset'] = str(info['offset'])
    resp.headers['Upload-Length'] = str(info['upload_length'])
    return resp


@tus_bp.route('/files/<upload_id>', methods=['PATCH'])
def tus_patch(upload_id):
    info = _load_info(upload_id)
    if not info:
        abort(404)
    upload_offset = int(request.headers.get('Upload-Offset', 0))
    if upload_offset != info['offset']:
        return Response(status=409)
    chunk = request.get_data()
    file_path = _file_path(upload_id)
    with open(file_path, 'ab') as f:
        f.write(chunk)
    info['offset'] += len(chunk)
    _save_info(upload_id, info)
    resp = Response(status=204)
    resp.headers['Tus-Resumable'] = TUS_VERSION
    resp.headers['Upload-Offset'] = str(info['offset'])
    return resp
