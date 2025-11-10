import importlib
from types import ModuleType

import pytest

pytest.importorskip("flask")


def _reload_pipeline(monkeypatch, **env) -> ModuleType:
    target_keys = {
        "XKT_STORAGE",
        "XKT_LOCAL_DIR",
        "XKT_BASE_URL",
        "SERVE_XKT_FROM_FLASK",
    }
    module = importlib.import_module("app.xkt_pipeline")
    for key in target_keys:
        if key in env:
            value = env[key]
            if value is None:
                monkeypatch.delenv(key, raising=False)
            else:
                monkeypatch.setenv(key, value)
        else:
            monkeypatch.delenv(key, raising=False)
    return importlib.reload(module)


def test_build_xkt_url_appends_segment(monkeypatch):
    mod = _reload_pipeline(monkeypatch, XKT_BASE_URL="https://cadlytics.app")
    assert (
        mod.build_xkt_url("abc123")
        == "https://cadlytics.app/xkt/abc123.xkt"
    )


@pytest.mark.parametrize(
    "base_url,expected",
    [
        ("", "/xkt/abc123.xkt"),
        ("/xkt/", "/xkt/abc123.xkt"),
        ("https://cdn.example.com/xkt", "https://cdn.example.com/xkt/abc123.xkt"),
        ("https://cdn.example.com", "https://cdn.example.com/xkt/abc123.xkt"),
    ],
)
def test_build_xkt_url_variants(monkeypatch, base_url, expected):
    mod = _reload_pipeline(monkeypatch, XKT_BASE_URL=base_url or None)
    assert mod.build_xkt_url("abc123") == expected


def test_should_serve_xkt_via_flask_default_local(monkeypatch):
    mod = _reload_pipeline(monkeypatch, XKT_STORAGE="local", XKT_BASE_URL="/xkt/")
    assert mod.should_serve_xkt_via_flask() is True


def test_should_serve_xkt_via_flask_abs_url(monkeypatch):
    mod = _reload_pipeline(
        monkeypatch,
        XKT_STORAGE="local",
        XKT_BASE_URL="https://cdn.cadlytics.app/xkt/",
    )
    assert mod.should_serve_xkt_via_flask() is False


@pytest.mark.parametrize("flag,expected", [("1", True), ("0", False), ("true", True)])
def test_should_serve_xkt_via_flask_env_override(monkeypatch, flag, expected):
    mod = _reload_pipeline(
        monkeypatch,
        XKT_STORAGE="s3",
        XKT_BASE_URL="https://cdn.cadlytics.app/xkt/",
        SERVE_XKT_FROM_FLASK=flag,
    )
    assert mod.should_serve_xkt_via_flask() is expected
