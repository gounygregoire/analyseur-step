"""Helpers pour convertir STEP → GLB/XKT avec validations basiques."""

from __future__ import annotations

import os
import shlex
import subprocess

from observability.logging import get_logger


logger = get_logger(__name__)


def count_glb_faces(glb_path: str) -> int:
    import os, trimesh  # type: ignore

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


def file_size(path: str) -> int:
    import os

    return os.path.getsize(path) if os.path.exists(path) else 0


def _with_node_path(env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(env or os.environ)
    extra_paths: list[str] = []
    project_root = os.path.dirname(__file__)
    local_bin = os.path.join(project_root, "node_modules", ".bin")
    if os.path.exists(local_bin):
        extra_paths.append(local_bin)
    # Render Node LTS path (fallback)
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


def step_to_glb(step_path: str, glb_path: str, tol: float = 0.1) -> int:
    import cadquery as cq  # type: ignore
    import trimesh  # type: ignore
    from trimesh import util as tutil  # type: ignore

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

    meshes = []
    for shp in shapes:
        if not hasattr(shp, "tessellate"):
            continue
        try:
            verts, faces = shp.tessellate(tol)
        except Exception as exc:  # pragma: no cover - cadquery runtime errors
            logger.warning("[convert][glb] tessellate failed tol=%s err=%s", tol, exc)
            continue
        if len(faces) > 0:
            mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
            if not mesh.is_empty:
                meshes.append(mesh)

    if not meshes:
        raise RuntimeError(f"No faces after tessellation tol={tol}")

    scene = trimesh.Scene()
    for i, mesh in enumerate(meshes):
        node_name = f"part_{i}"
        if hasattr(tutil, "unique_name"):
            node_name = tutil.unique_name(node_name)
        scene.add_geometry(mesh, node_name=node_name)

    export = scene.export(file_type="glb")
    with open(glb_path, "wb") as f:
        f.write(export)

    return len(meshes)


def convert_step_to_glb(step_path: str, glb_path: str, *, linear_deflection: float = 0.2) -> int:
    """Wrapper conservé pour compatibilité."""

    return step_to_glb(step_path, glb_path, tol=linear_deflection)


def glb_to_xkt(glb_path: str, xkt_path: str) -> None:
    """Appelle le convertisseur CLI Xeokit et journalise stdout/stderr."""

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
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_with_node_path(os.environ),
        check=False,
    )
    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()
    if stdout:
        logger.info("[xkt][stdout] %s", stdout)
    if stderr:
        logger.info("[xkt][stderr] %s", stderr)
    if proc.returncode != 0:
        raise RuntimeError(
            "xeokit-gltf-to-xkt failed rc={}".format(proc.returncode)
        )


def convert_glb_to_xkt(glb_path: str, xkt_path: str) -> None:
    """Alias rétro-compatible vers :func:`glb_to_xkt`."""

    glb_to_xkt(glb_path, xkt_path)

