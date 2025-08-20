import os
import sys
import json
import pathlib
import types
import pytest

sys.modules.setdefault('cadquery', types.SimpleNamespace())
sys.modules.setdefault('trimesh', types.SimpleNamespace())
dummy = types.SimpleNamespace()
sys.modules.setdefault('OCP', types.SimpleNamespace(STEPControl=dummy, StlAPI=dummy, Interface=dummy))
sys.modules.setdefault('OCP.STEPControl', types.SimpleNamespace(STEPControl_Reader=dummy))
sys.modules.setdefault('OCP.StlAPI', types.SimpleNamespace(StlAPI_Writer=dummy))
sys.modules.setdefault('OCP.Interface', types.SimpleNamespace(Interface_Static=dummy))
google_stub = types.SimpleNamespace()
flask_dance_google = types.SimpleNamespace(make_google_blueprint=lambda **k: google_stub, google=google_stub)
sys.modules.setdefault('flask_dance', types.SimpleNamespace(contrib=types.SimpleNamespace(google=flask_dance_google)))
sys.modules.setdefault('flask_dance.contrib', types.SimpleNamespace(google=flask_dance_google))
sys.modules.setdefault('flask_dance.contrib.google', flask_dance_google)
class _OAuthConsumerMixin: pass
storage_sqla = types.SimpleNamespace(OAuthConsumerMixin=_OAuthConsumerMixin)
storage_module = types.SimpleNamespace(sqla=storage_sqla)
consumer_module = types.SimpleNamespace(storage=storage_module)
sys.modules.setdefault('flask_dance.consumer', consumer_module)
sys.modules.setdefault('flask_dance.consumer.storage', storage_module)
sys.modules.setdefault('flask_dance.consumer.storage.sqla', storage_sqla)
class _UserMixin: pass
login_module = types.SimpleNamespace(
    UserMixin=_UserMixin,
    LoginManager=lambda: None,
    login_required=lambda f: f,
    current_user=types.SimpleNamespace(is_authenticated=False, id=None)
)
sys.modules.setdefault('flask_login', login_module)

sys.path.append(str(pathlib.Path(__file__).resolve().parents[1]))
from app import app, db, generate_preview, generate_final


def _client(tmp_path):
    app.config['TESTING'] = True
    app.config['UPLOAD_FOLDER'] = str(tmp_path)
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite://'
    with app.app_context():
        db.drop_all()
        db.create_all()
    generate_preview.delay = lambda *a, **k: None
    generate_final.delay = lambda *a, **k: None
    return app.test_client()


def test_resumable_upload_resume(tmp_path):
    client = _client(tmp_path)
    create = client.post('/tus/files', headers={'Upload-Length': '11', 'Tus-Resumable': '1.0.0'})
    assert create.status_code == 201
    upload_id = create.headers['Location'].split('/')[-1]
    r = client.patch(f'/tus/files/{upload_id}', data=b'hello', headers={
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream'
    })
    assert r.status_code == 204
    head = client.head(f'/tus/files/{upload_id}', headers={'Tus-Resumable': '1.0.0'})
    assert head.headers['Upload-Offset'] == '5'
    r = client.patch(f'/tus/files/{upload_id}', data=b' world', headers={
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '5',
        'Content-Type': 'application/offset+octet-stream'
    })
    assert r.status_code == 204
    head = client.head(f'/tus/files/{upload_id}', headers={'Tus-Resumable': '1.0.0'})
    assert head.headers['Upload-Offset'] == '11'
    path = os.path.join(tmp_path, 'tus', upload_id)
    with open(path, 'rb') as f:
        assert f.read() == b'hello world'
    resp = client.post('/api/upload', json={'upload_id': upload_id})
    assert resp.status_code == 201


def test_upload_rejects_large_file(tmp_path):
    client = _client(tmp_path)
    too_big = str(2 * 1024 * 1024 * 1024 + 1)
    resp = client.post('/tus/files', headers={'Upload-Length': too_big, 'Tus-Resumable': '1.0.0'})
    assert resp.status_code == 413
