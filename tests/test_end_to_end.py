import os
import time
import requests
import pytest

HOST = os.getenv('HOST', 'http://localhost:5000')
SMALL_STEP = os.getenv('SMALL_STEP', os.path.join(os.path.dirname(__file__), 'sample.step'))
MEDIUM_STEP = os.getenv('MEDIUM_STEP', SMALL_STEP)
LARGE_STEP = os.getenv('LARGE_STEP', SMALL_STEP)
POLL_INTERVAL = 1
PREVIEW_TIMEOUT = int(os.getenv('PREVIEW_TIMEOUT', '30'))
FINAL_TIMEOUT = int(os.getenv('FINAL_TIMEOUT', '300'))


def _upload(path):
    with open(path, 'rb') as f:
        resp = requests.post(f"{HOST}/api/upload", files={'file': f})
    resp.raise_for_status()
    return resp.json()['modelId']


def _poll_assets(model_id):
    resp = requests.get(f"{HOST}/api/models/{model_id}/assets")
    resp.raise_for_status()
    data = resp.json()
    return data['assets'], data.get('status')


def _wait_for(model_id, keys, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        assets, _ = _poll_assets(model_id)
        if all(k in assets for k in keys):
            return assets
        time.sleep(POLL_INTERVAL)
    pytest.fail(f"assets {keys} missing for model {model_id}")


@pytest.mark.skipif(os.getenv('RUN_E2E') != '1', reason='end-to-end test requires RUN_E2E=1')
def test_full_chain():
    ids = []
    for path in [SMALL_STEP, MEDIUM_STEP, LARGE_STEP]:
        model_id = _upload(path)
        start = time.time()
        assets = _wait_for(model_id, ['preview'], PREVIEW_TIMEOUT)
        assert 'final' not in assets and 'dfm_json' not in assets
        assert time.time() - start < PREVIEW_TIMEOUT
        _wait_for(model_id, ['final', 'dfm_json'], FINAL_TIMEOUT)
        ids.append(model_id)
    cached_id = _upload(SMALL_STEP)
    assert cached_id == ids[0]
