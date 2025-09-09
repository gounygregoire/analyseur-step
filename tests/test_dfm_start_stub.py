import sys
import pathlib
import time
from flask import Flask

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from api.dfm import dfm_bp


def test_dfm_start_and_status_transition():
    app = Flask(__name__)
    app.register_blueprint(dfm_bp)
    client = app.test_client()

    resp = client.post(
        '/api/dfm/start',
        json={'file_id': 'f', 'material_profile_id': 'm', 'axis': 'AUTO', 'invert': False},
    )
    assert resp.status_code == 202
    data = resp.get_json()
    assert data['status'] == 'queued'
    job_id = data['job_id']

    first = client.get('/api/dfm/status', query_string={'job_id': job_id})
    assert first.status_code == 200
    assert first.get_json()['status'] in {'queued', 'running'}

    time.sleep(1.5)
    final = client.get('/api/dfm/status', query_string={'job_id': job_id})
    assert final.get_json()['status'] == 'done'

    res = client.get('/api/dfm/result', query_string={'job_id': job_id})
    assert res.status_code == 200
