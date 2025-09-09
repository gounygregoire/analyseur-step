import sys
import pathlib
from flask import Flask

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from api.dfm import dfm_bp


def test_dfm_start_returns_stub():
    app = Flask(__name__)
    app.register_blueprint(dfm_bp)
    client = app.test_client()
    resp = client.post('/api/dfm/start', json={'file_id': 'f', 'material_profile_id': 'm', 'axis': 'AUTO', 'invert': False})
    assert resp.status_code == 202
    assert resp.get_json() == {'job_id': 'stub', 'status': 'queued'}
