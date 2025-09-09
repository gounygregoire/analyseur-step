import logging
import random
import sys
import threading
from pathlib import Path

import numpy as np
import pytest
from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from app.api.dfm_routes import dfm_bp
from app.storage import files
from app.dfm import services

REAL_THREAD = threading.Thread


def pytest_addoption(parser):
    parser.addoption(
        "--update-goldens", action="store_true", help="réécrit les fichiers golden"
    )


@pytest.fixture(scope="session", autouse=True)
def _seed():
    random.seed(0)
    np.random.seed(0)


@pytest.fixture(autouse=True)
def _sync_jobs(monkeypatch):
    class ImmediateThread:
        def __init__(self, target=None, **kwargs):
            self._target = target

        def start(self):
            if self._target:
                self._target()

    monkeypatch.setattr(threading, "Thread", ImmediateThread)


@pytest.fixture
def client(tmp_path):
    files.UPLOAD_DIR = tmp_path / "uploads"
    files.UPLOAD_DIR.mkdir()
    files.DB_PATH = tmp_path / "files.sqlite"
    services.RESULTS_DIR = tmp_path / "results"
    services.RESULTS_DIR.mkdir()
    services.LOG_PATH = tmp_path / "dfm.log"
    for h in list(services._logger.handlers):
        services._logger.removeHandler(h)
    handler = logging.FileHandler(services.LOG_PATH)
    handler.setFormatter(logging.Formatter("%(message)s"))
    services._logger.addHandler(handler)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    app.register_blueprint(dfm_bp)
    return app.test_client()


@pytest.fixture
def sample_step_path():
    base = Path(__file__).parent / "data"

    def _inner(name: str) -> Path:
        return base / name

    return _inner
