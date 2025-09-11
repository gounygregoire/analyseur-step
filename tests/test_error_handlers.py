import uuid
from flask import Flask

from errors import register_error_handlers


def create_app():
    app = Flask(__name__)
    register_error_handlers(app)

    @app.get('/boom')
    def boom():
        raise RuntimeError('boom')

    return app


def test_404_returns_json():
    app = create_app()
    client = app.test_client()
    resp = client.get('/nope')
    assert resp.status_code == 404
    data = resp.get_json()
    assert data['error'] == 'not_found'
    assert isinstance(data['message'], str)


def test_500_returns_trace_id():
    app = create_app()
    client = app.test_client()
    resp = client.get('/boom')
    assert resp.status_code == 500
    data = resp.get_json()
    uuid.UUID(data['trace_id'])
    assert data['error'] == 'internal_error'
