import io
import os
import types
import sys

os.environ.setdefault('SESSION_SECRET', 'test-secret')
os.environ.setdefault('DATABASE_URL', 'sqlite://')

sys.modules['cadquery'] = types.SimpleNamespace(
    importers=types.SimpleNamespace(importStep=lambda *a, **k: None),
    exporters=types.SimpleNamespace(export=lambda *a, **k: None),
)
sys.modules['trimesh'] = types.SimpleNamespace(load=lambda *a, **k: types.SimpleNamespace(is_empty=False, faces=[1]))
sys.modules['xkt_converter'] = types.SimpleNamespace(convert_step_to_xkt=lambda *a, **k: None)
ocp = types.SimpleNamespace(
    STEPControl=types.SimpleNamespace(STEPControl_Reader=object),
    StlAPI=types.SimpleNamespace(StlAPI_Writer=object),
    Interface=types.SimpleNamespace(Interface_Static=object),
)
sys.modules['OCP'] = ocp
sys.modules['OCP.STEPControl'] = ocp.STEPControl
sys.modules['OCP.StlAPI'] = ocp.StlAPI
sys.modules['OCP.Interface'] = ocp.Interface

from web import app
import web


def test_upload_and_status(tmp_path, monkeypatch):
    upload_dir = tmp_path / 'uploads'
    output_dir = tmp_path / 'converted'
    upload_dir.mkdir()
    output_dir.mkdir()
    monkeypatch.setattr(web, 'UPLOAD_FOLDER', str(upload_dir))
    monkeypatch.setattr(web, 'OUTPUT_FOLDER', str(output_dir))

    def fake_convert(step_path, xkt_path, tolerance):
        with open(xkt_path, 'wb') as f:
            f.write(b'xkt')
    monkeypatch.setattr(web, 'run_sync_conversion', fake_convert)

    client = app.test_client()
    data = {'file': (io.BytesIO(b'data'), 'sample.step')}
    resp = client.post('/upload', data=data)
    assert resp.status_code == 200
    js = resp.get_json()
    assert js['status'] == 'ready'
    fid = js['file_id']
    assert (output_dir / f"{fid}.xkt").exists()

    resp2 = client.get(f'/convert/status?file_id={fid}')
    assert resp2.status_code == 200
    js2 = resp2.get_json()
    assert js2['status'] == 'ready'
    assert js2['xkt_url'].endswith(f'{fid}.xkt')
