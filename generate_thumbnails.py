import os
import tempfile
from typing import Dict

import numpy as np

try:
    import trimesh
except Exception:  # pragma: no cover
    trimesh = None


def _load_mesh(path: str | None) -> "trimesh.Trimesh | None":
    if not path or not trimesh or not os.path.exists(path):
        return None
    try:
        mesh = trimesh.load_mesh(path, process=False)
        if isinstance(mesh, trimesh.Scene):
            mesh = next(iter(mesh.geometry.values()))
        return mesh
    except Exception:
        return None


def _export_step_to_stl(step_path: str) -> str | None:
    try:
        import cadquery as cq  # type: ignore
        workplane = cq.importers.importStep(step_path)
        fd, stl_path = tempfile.mkstemp(suffix=".stl")
        os.close(fd)
        cq.exporters.export(workplane, stl_path)
        return stl_path
    except Exception:
        return None


def _render_matplotlib(mesh: "trimesh.Trimesh", out_dir: str) -> Dict[str, str]:
    thumbs: Dict[str, str] = {}
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from mpl_toolkits.mplot3d.art3d import Poly3DCollection

        tri = mesh.vertices[mesh.faces]
        scale = float(max(getattr(mesh, "extents", [1, 1, 1]))) or 1.0

        def render(name: str, elev: float, azim: float) -> None:
            fig = plt.figure(figsize=(2, 2), dpi=150)
            ax = fig.add_subplot(111, projection="3d")
            ax.add_collection3d(
                Poly3DCollection(tri, facecolor="#e0e0e0", edgecolor="#000000", linewidth=0.1)
            )
            ax.set_xlim(-scale / 2, scale / 2)
            ax.set_ylim(-scale / 2, scale / 2)
            ax.set_zlim(-scale / 2, scale / 2)
            ax.set_axis_off()
            ax.view_init(elev=elev, azim=azim)
            path = os.path.join(out_dir, f"thumb_{name}.png")
            fig.savefig(path, bbox_inches="tight", pad_inches=0)
            plt.close(fig)
            thumbs[name] = path

        render("iso", 35, 45)
        render("top", 90, -90)
        render("side", 0, 0)
        return thumbs
    except Exception:
        return {}


def _fallback_image(mesh: "trimesh.Trimesh | None", out_dir: str) -> Dict[str, str]:
    from PIL import Image, ImageDraw  # type: ignore

    size = 200
    img = Image.new("RGB", (size, size), "white")
    draw = ImageDraw.Draw(img)

    if mesh is not None:
        verts = mesh.vertices[:, :2]
        min_xy = verts.min(axis=0)
        max_xy = verts.max(axis=0)
        span = max_xy - min_xy
        span[span == 0] = 1.0
        scaled = (verts - min_xy) / span * (size * 0.8)
        offset = np.array([size * 0.1, size * 0.1])
        scaled += offset
        edges = getattr(mesh, "edges_unique", [])
        for i, j in edges:
            p1 = scaled[i]
            p2 = scaled[j]
            draw.line([p1[0], size - p1[1], p2[0], size - p2[1]], fill="black")
    else:
        draw.rectangle([40, 40, 160, 160], outline="black")

    path = os.path.join(out_dir, "thumb_iso.png")
    img.save(path)
    return {name: path for name in ("iso", "top", "side")}


def generate_thumbnails(step_path: str, out_dir: str) -> Dict[str, str]:
    """Generate thumbnails (iso, top, side) for a STEP/STL file.

    Returns a mapping view->image path. Falls back to simple silhouette on error.
    """
    os.makedirs(out_dir, exist_ok=True)

    stl_path = step_path if step_path.lower().endswith(".stl") else _export_step_to_stl(step_path)
    mesh = _load_mesh(stl_path)
    thumbs = _render_matplotlib(mesh, out_dir) if mesh is not None else {}
    if not thumbs:
        thumbs = _fallback_image(mesh, out_dir)
    if stl_path and stl_path != step_path and os.path.exists(stl_path):
        os.remove(stl_path)
    return thumbs

