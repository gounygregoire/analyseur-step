import os, uuid, subprocess
from flask import Flask, request, jsonify, send_from_directory, abort

app = Flask(__name__)
UPLOAD_FOLDER = os.environ.get('UPLOAD_FOLDER', '/tmp/uploads')
OUTPUT_FOLDER = os.environ.get('OUTPUT_FOLDER', '/tmp/converted')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

ALLOWED = {'.stp', '.step'}
def allowed(name):
    return os.path.splitext(name.lower())[1] in ALLOWED

@app.post('/upload')
def upload():
    f = request.files.get('file')
    tol = request.form.get('tolerance', 'standard')  # tol unused but kept for API
    if not f or not f.filename:
        return jsonify(error='no_file'), 400
    if not allowed(f.filename):
        return jsonify(error='bad_ext'), 400
    file_id = str(uuid.uuid4())
    step = os.path.join(UPLOAD_FOLDER, f'{file_id}.step')
    xkt = os.path.join(OUTPUT_FOLDER, f'{file_id}.xkt')
    f.save(step)
    try:
        subprocess.run(['xeokit-convert', '--input', step, '--output', xkt], check=True)
    except Exception as e:
        return jsonify(error='convert_fail', detail=str(e)), 500
    xkt_url = f'/xkt/{file_id}.xkt' if os.path.exists(xkt) else None
    return jsonify(file_id=file_id, status=('ready' if xkt_url else 'processing'), xkt_url=xkt_url)

@app.get('/convert/status')
def convert_status():
    file_id = request.args.get('file_id')
    if not file_id:
        return jsonify(error='no_file_id'), 400
    xkt = os.path.join(OUTPUT_FOLDER, f'{file_id}.xkt')
    if os.path.exists(xkt):
        return jsonify(status='ready', xkt_url=f'/xkt/{file_id}.xkt')
    return jsonify(status='processing')

@app.get('/xkt/<path:fname>')
def serve_xkt(fname):
    if not fname.endswith('.xkt'):
        abort(404)
    return send_from_directory(OUTPUT_FOLDER, fname, as_attachment=False)
