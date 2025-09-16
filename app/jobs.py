import importlib
import logging
import os
import time
from functools import lru_cache

from .converters.step_to_mesh import step_to_mesh
from .converters.mesh_simplify import mesh_simplify
from .converters.mesh_to_xkt import mesh_to_xkt


@lru_cache(maxsize=1)
def _trimesh():
    return importlib.import_module("trimesh")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

OUTPUT_FOLDER = os.getenv("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(OUTPUT_FOLDER, exist_ok=True)


def generate_low_preview(step_path: str) -> str:
    """Generate a simplified preview model."""

    base = os.path.splitext(os.path.basename(step_path))[0]
    mesh_path = os.path.join(OUTPUT_FOLDER, f"{base}_low.stl")
    xkt_path = os.path.join(OUTPUT_FOLDER, f"{base}_low.xkt")

    start = time.time()
    tm = _trimesh()

    step_to_mesh(step_path, mesh_path, linear_defl=2.0, angular_defl=0.8)
    before = len(tm.load(mesh_path, force="mesh").faces)
    mesh_simplify(mesh_path, mesh_path, factor=0.2)
    after = len(tm.load(mesh_path, force="mesh").faces)
    mesh_to_xkt(mesh_path, xkt_path)
    duration = time.time() - start
    size = os.path.getsize(xkt_path)
    logger.info(
        "job=%s phase=low duration=%.2fs faces_before=%d faces_after=%d size=%d",
        base,
        duration,
        before,
        after,
        size,
    )
    return xkt_path


def generate_full_model(step_path: str) -> str:
    """Generate the full-resolution model."""

    base = os.path.splitext(os.path.basename(step_path))[0]
    mesh_path = os.path.join(OUTPUT_FOLDER, f"{base}_full.stl")
    xkt_path = os.path.join(OUTPUT_FOLDER, f"{base}_full.xkt")

    start = time.time()
    tm = _trimesh()

    step_to_mesh(step_path, mesh_path, linear_defl=0.2, angular_defl=0.2)
    before = len(tm.load(mesh_path, force="mesh").faces)
    mesh_simplify(mesh_path, mesh_path, factor=0.9)
    after = len(tm.load(mesh_path, force="mesh").faces)
    mesh_to_xkt(mesh_path, xkt_path)
    duration = time.time() - start
    size = os.path.getsize(xkt_path)
    logger.info(
        "job=%s phase=full duration=%.2fs faces_before=%d faces_after=%d size=%d",
        base,
        duration,
        before,
        after,
        size,
    )
    return xkt_path
