import os
import json
import time
import resource
import logging
from typing import Tuple, Dict, Callable, Optional

try:
    import trimesh
except ImportError:  # pragma: no cover
    trimesh = None

try:
    from heatmap import generate_heatmap
except Exception:  # pragma: no cover
    generate_heatmap = None


def generate_view_data(
    stl_path: str | None,
    file_id: str,
    progress_cb: Callable[[int], None] | None = None,
    fast_mode: bool = False,
) -> Tuple[Dict[str, Dict], Dict[str, float], Optional[str]]:
    """Compute heatmap then camera states for a mesh."""

    out_dir = os.path.join("static", "dfm", file_id)
    os.makedirs(out_dir, exist_ok=True)

    logger = logging.getLogger(__name__)
    t = time.perf_counter()
    heatmap_faces: Dict[str, float] = {}
    heatmap_notice: Optional[str] = None
    if not fast_mode:
        if not stl_path or not os.path.exists(stl_path):
            logger.warning("dfm heatmap skipped: STL path missing (%s)", stl_path)
            heatmap_notice = "Heatmap indisponible : le maillage STL est introuvable."
        elif not generate_heatmap:
            logger.warning("dfm heatmap skipped: generator not available")
            heatmap_notice = "Heatmap indisponible sur cette analyse : module serveur absent."
        else:
            try:
                faces = generate_heatmap(stl_path)
                heatmap_faces = {str(f["face_index"]): float(f["severity"]) for f in faces}
                face_count = len(heatmap_faces)
                logger.info("dfm heatmap faces=%d", face_count)
                if face_count == 0:
                    heatmap_notice = "Heatmap indisponible : aucune surface analysable sur ce modèle."
                    logger.warning("dfm heatmap empty for %s", file_id)
            except Exception:
                logger.exception("dfm heatmap generation failed for %s", file_id)
                heatmap_faces = {}
                heatmap_notice = "Heatmap indisponible : échec du calcul sur ce modèle."
        heat_file = os.path.join(out_dir, "heatmap_faces.json")
        with open(heat_file, "w", encoding="utf-8") as fh:
            json.dump(heatmap_faces, fh)
        if progress_cb:
            progress_cb(70)
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    logger.info("dfm heatmap dt=%.2fs rss=%.1fMB", time.perf_counter() - t, mem)

    t = time.perf_counter()
    size = 1.0
    if stl_path and trimesh and os.path.exists(stl_path):
        try:
            mesh = trimesh.load(stl_path, process=False)
            if isinstance(mesh, trimesh.Scene):
                geom = next(iter(mesh.geometry.values()))
                mesh = geom
            extents = getattr(mesh, "extents", None)
            if extents is not None:
                size = float(max(extents)) or 1.0
        except Exception:
            pass

    camera_states = {
        "iso": {"eye": [size, size, size], "look": [0.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0]},
        "top": {"eye": [0.0, 0.0, size], "look": [0.0, 0.0, 0.0], "up": [0.0, 1.0, 0.0]},
        "right": {"eye": [size, 0.0, 0.0], "look": [0.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0]},
        "front": {"eye": [0.0, -size, 0.0], "look": [0.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0]},
    }
    cam_file = os.path.join(out_dir, "camera_states.json")
    with open(cam_file, "w", encoding="utf-8") as fh:
        json.dump(camera_states, fh)
    if progress_cb:
        progress_cb(85)
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    logger.info("dfm cameras dt=%.2fs rss=%.1fMB", time.perf_counter() - t, mem)

    return camera_states, heatmap_faces, heatmap_notice
