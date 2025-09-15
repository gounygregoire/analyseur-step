import io
import importlib

import viewer_backend


def test_upload_and_status(tmp_path, monkeypatch):
    upload_dir = tmp_path / 'uploads'
    output_dir = tmp_path / 'converted'
    monkeypatch.setenv('UPLOAD_FOLDER', str(upload_dir))
    monkeypatch.setenv('OUTPUT_FOLDER', str(output_dir))

    importlib.reload(viewer_backend)
    client = viewer_backend.app.test_client()

    def fake_run(args, check):
        out_idx = args.index('--output') + 1
        with open(args[out_idx], 'wb') as f:
            f.write(b'xkt')
    monkeypatch.setattr(viewer_backend.subprocess, 'run', fake_run)

    data = {'file': (io.BytesIO(b'data'), 'sample.step')}
    resp = client.post('/upload', data=data)
    assert resp.status_code == 200
    js = resp.get_json()
    assert js['status'] == 'ready'
    fid = js['file_id']
    assert (output_dir / f'{fid}.xkt').exists()

    resp2 = client.get(f'/convert/status?file_id={fid}')
    assert resp2.status_code == 200
    js2 = resp2.get_json()
    assert js2['status'] == 'ready'
    assert js2['xkt_url'].endswith(f'{fid}.xkt')
