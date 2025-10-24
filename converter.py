"""Pipeline STEP → GLB → XKT avec validations fail-fast et logs détaillés."""

from __future__ import annotations

import os
import shlex
import subprocess
import time
from typing import Iterable, Tuple

from observability.logging import get_logger


logger = get_logger("convert")

CONVERT_DIR = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
UPLOAD_DIR = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
MIN_XKT_BYTES = int(os.environ.get("MIN_XKT_BYTES", 100 * 1024))
KNOWN_BAD_XKT_BYTES = int(os.environ.get("KNOWN_BAD_XKT_BYTES", 46204))


def file_size(path: str) -> int:
    return os.path.getsize(path) if os.path.exists(path) else 0


def count_glb_faces(glb_path: str) -> int:
    import trimesh  # type: ignore

    if not os.path.exists(glb_path):
        return -1
    try:
        scene = trimesh.load(glb_path, force="scene")
    except Exception:
        return -1
    if hasattr(scene, "geometry"):
        return sum(getattr(g, "faces", []).shape[0] for g in scene.geometry.values())
    try:
        faces = getattr(scene, "faces", [])
        return int(faces.shape[0]) if hasattr(faces, "shape") else int(len(faces))
    except Exception:
        return -1


def _with_node_path(env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(env or os.environ)
    extra_paths: list[str] = []
    project_root = os.path.dirname(__file__)
    local_bin = os.path.join(project_root, "node_modules", ".bin")
    if os.path.exists(local_bin):
        extra_paths.append(local_bin)
    extra_paths.append("/opt/render/project/nodes/node-20.19.5/bin")
    existing = env.get("PATH", "")
    env["PATH"] = os.pathsep.join([p for p in (*extra_paths, existing) if p])
    return env


def _xeokit_command(input_path: str, output_path: str) -> list[str]:
    exe = (os.environ.get("XEOKIT_CONVERT") or "npx").strip() or "npx"
    extra_args = shlex.split(os.environ.get("XEOKIT_ARGS", ""))
    if extra_args:
        blocked = {"--edges-only", "--lines-only", "--wireframe"}
        filtered: list[str] = []
        removed: list[str] = []
        for token in extra_args:
            lowered = token.lower()
            if lowered in blocked or any(lowered.startswith(f"{flag}=") for flag in blocked):
                removed.append(token)
                continue
            filtered.append(token)
        if removed:
            logger.warning(
                "[convert][xkt] ignoring geometry-filtering args: %s",
                ", ".join(removed),
            )
        extra_args = filtered
    if exe == "npx":
        base = ["npx", "-y", "xeokit-gltf-to-xkt"]
    else:
        base = shlex.split(exe)
    return base + extra_args + [
        "--input",
        input_path,
        "--output",
        output_path,
        "--logLevel",
        "debug",
    ]


def _tessellate_to_glb(
    step_path: str,
    glb_path: str,
    tolerances: Iterable[float],
) -> Tuple[int, int]:
    import cadquery as cq  # type: ignore
    import trimesh  # type: ignore

    if not step_path or not os.path.exists(step_path):
        raise FileNotFoundError(f"STEP introuvable: {step_path}")

    out_dir = os.path.dirname(glb_path or "")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    if os.path.exists(glb_path):
        try:
            os.remove(glb_path)
        except OSError:
            pass

    asm = cq.importers.importStep(step_path)
    shapes = asm if isinstance(asm, (list, tuple)) else [asm]
    shapes = [shape for shape in shapes if shape is not None]

    def _tess(tol: float) -> list[trimesh.Trimesh]:
        meshes: list[trimesh.Trimesh] = []
        for shp in shapes:
            if not hasattr(shp, "tessellate"):
                continue
            try:
                verts, faces = shp.tessellate(tol)
            except Exception as exc:  # pragma: no cover - cadquery runtime errors
                logger.warning("[convert][glb] tessellate failed tol=%s err=%s", tol, exc)
                continue
            if len(faces) == 0:
                continue
            mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
            if not mesh.is_empty:
                meshes.append(mesh)
        return meshes

    for tol in tolerances:
        meshes = _tess(float(tol))
        if not meshes:
            continue
        scene = trimesh.Scene()
        for i, mesh in enumerate(meshes):
            scene.add_geometry(mesh, node_name=f"part_{i}")
        with open(glb_path, "wb") as fh:
            fh.write(scene.export(file_type="glb"))
        faces = count_glb_faces(glb_path)
        logger.info(
            "[convert][glb] tol=%s meshes=%s faces=%s size=%s",
            tol,
            len(meshes),
            faces,
            file_size(glb_path),
        )
        if faces > 0:
            return len(meshes), faces
    raise RuntimeError(
        "No faces after tessellation at tol=" + "/".join(str(t) for t in tolerances)
    )


def step_to_glb(step_path: str, glb_path: str, tol: float = 0.1) -> int:
    meshes, _ = _tessellate_to_glb(step_path, glb_path, (tol,))
    return meshes


def convert_step_to_glb(step_path: str, glb_path: str, *, linear_deflection: float = 0.2) -> int:
    return step_to_glb(step_path, glb_path, tol=linear_deflection)


def glb_to_xkt(glb_path: str, xkt_path: str) -> None:
    if not glb_path or not os.path.exists(glb_path):
        raise FileNotFoundError(f"GLB introuvable: {glb_path}")

    out_dir = os.path.dirname(xkt_path or "")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    if os.path.exists(xkt_path):
        try:
            os.remove(xkt_path)
        except OSError:
            pass

    cmd = _xeokit_command(glb_path, xkt_path)
    cmd_display = " ".join(shlex.quote(c) for c in cmd)
    logger.info("[convert][xkt] cmd=%s", cmd_display)
    t0 = time.time()
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_with_node_path(os.environ),
        check=False,
    )
    duration = time.time() - t0
    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()
    if stdout:
        logger.info("[xkt][stdout]\n%s", stdout)
    if stderr:
        logger.warning("[xkt][stderr]\n%s", stderr)
    if proc.returncode != 0:
        raise RuntimeError(f"xeokit-gltf-to-xkt failed rc={proc.returncode}")
    logger.info("[xkt] done in %.2fs size=%s", duration, file_size(xkt_path))


def convert_glb_to_xkt(glb_path: str, xkt_path: str) -> None:
    glb_to_xkt(glb_path, xkt_path)


def convert_step_to_xkt(file_id: str) -> dict[str, int | str]:
    step_path = os.path.join(UPLOAD_DIR, f"{file_id}.step")
    glb_path = os.path.join(CONVERT_DIR, f"{file_id}.glb")
    xkt_path = os.path.join(CONVERT_DIR, f"{file_id}.xkt")
    os.makedirs(CONVERT_DIR, exist_ok=True)

    _, faces = _tessellate_to_glb(step_path, glb_path, (0.2, 0.1, 0.05))
    if faces <= 0:
        raise RuntimeError("GLB has 0 faces - abort")

    glb_to_xkt(glb_path, xkt_path)
    xkt_bytes = file_size(xkt_path)
    if xkt_bytes < MIN_XKT_BYTES:
        raise RuntimeError(f"XKT too small ({xkt_bytes} B) - abort")
    if xkt_bytes == KNOWN_BAD_XKT_BYTES:
        raise RuntimeError(
            f"Known bad XKT size ({KNOWN_BAD_XKT_BYTES} B): refusing publish"
        )

    return {"glb": glb_path, "xkt": xkt_path, "faces": faces, "xkt_size": xkt_bytes}

