"""Pipeline STEP → GLB → XKT avec validations fail-fast et logs détaillés."""

from __future__ import annotations

import os
import shlex
import subprocess
import time
from typing import Iterable, Tuple

try:
    from observability.logging import get_logger  # peut dépendre de Flask côté web
except Exception:
    import logging

    def get_logger(name: str):
        logger = logging.getLogger(name)
        if not logger.handlers:
            logging.basicConfig(
                level=logging.INFO,
                format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
            )
        return logger


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
    exe_env = (os.environ.get("XEOKIT_CONVERT") or "").strip()
    if exe_env:
        base = shlex.split(exe_env)
        cli_label = exe_env
    else:
        base = ["npx", "-y", "@xeokit/xeokit-convert"]
        cli_label = "@xeokit/xeokit-convert"

    logger.info("[convert][xkt] using cli=%s", cli_label)

    extra_args = shlex.split(os.environ.get("XEOKIT_ARGS", ""))

    return base + extra_args + ["--input", input_path, "--output", output_path, "--logLevel", "debug"]

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


def _assert_xeokit_available(cmd_base: list[str]) -> None:
    try:
        test_cmd = cmd_base + ["--version"]
        proc = subprocess.run(
            test_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=_with_node_path(os.environ),
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"xeokit CLI not available rc={proc.returncode}: {proc.stderr.strip()}"
            )
        logger.info(
            "[xkt] cli=%s version=%s",
            " ".join(shlex.quote(c) for c in cmd_base),
            proc.stdout.strip(),
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"xeokit CLI not found: {exc}")


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
    _assert_xeokit_available(
        cmd[:1]
        if len(cmd) == 1
        else (cmd if cmd[0] != "npx" else ["npx", "-y", "@xeokit/xeokit-convert"])
    )

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
    dt = time.time() - t0
    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()
    if stdout:
        logger.info("[xkt][stdout]\n%s", stdout)
    if stderr:
        logger.warning("[xkt][stderr]\n%s", stderr)
    if proc.returncode != 0:
        try:
            os.remove(xkt_path)
        except OSError:
            pass
        raise RuntimeError(f"xeokit convert CLI failed rc={proc.returncode}")

    size = file_size(xkt_path)
    logger.info("[xkt] done in %.2fs size=%s", dt, size)

    if size < MIN_XKT_BYTES or size == KNOWN_BAD_XKT_BYTES:
        try:
            os.remove(xkt_path)
        except OSError:
            pass
        raise RuntimeError(f"XKT too small or known bad size ({size} B) - abort")


def convert_glb_to_xkt(glb_path: str, xkt_path: str) -> None:
    glb_to_xkt(glb_path, xkt_path)


def convert_step_to_xkt(file_id: str) -> dict[str, int | str]:
    step_path = os.path.join(UPLOAD_DIR, f"{file_id}.step")

    try:
        if not os.path.exists(step_path):
            from s3io import get_file

            os.makedirs(UPLOAD_DIR, exist_ok=True)
            got = get_file(f"uploads/{file_id}.step", step_path)
            if not got and not os.path.exists(step_path):
                got = get_file(f"uploads/{file_id}.stp", step_path)
            if not os.path.exists(step_path):
                raise FileNotFoundError(f"STEP introuvable local/S3 pour {file_id}")
            logger.info("[convert][src] pulled STEP from S3 for %s", file_id)

        step_exists = os.path.exists(step_path)
        step_bytes = file_size(step_path)
        logger.info(
            "[convert][step] file=%s path=%s exists=%s size=%s",
            file_id,
            step_path,
            step_exists,
            step_bytes,
        )

        glb_path = os.path.join(CONVERT_DIR, f"{file_id}.glb")
        xkt_path = os.path.join(CONVERT_DIR, f"{file_id}.xkt")
        os.makedirs(CONVERT_DIR, exist_ok=True)

        mesh_count, faces = _tessellate_to_glb(step_path, glb_path, (0.2, 0.1, 0.05))
        glb_bytes = file_size(glb_path)
        logger.info(
            "[convert][glb] file=%s meshes=%s faces=%s size=%s",
            file_id,
            mesh_count,
            faces,
            glb_bytes,
        )
        if faces <= 0:
            raise RuntimeError("GLB has 0 faces - abort")

        t_xkt = time.time()
        glb_to_xkt(glb_path, xkt_path)
        xkt_duration = time.time() - t_xkt
        xkt_bytes = file_size(xkt_path)
        logger.info(
            "[convert][xkt] file=%s duration=%.2fs size=%s path=%s",
            file_id,
            xkt_duration,
            xkt_bytes,
            xkt_path,
        )

        return {
            "glb": glb_path,
            "glb_size": glb_bytes,
            "xkt": xkt_path,
            "xkt_size": xkt_bytes,
            "faces": faces,
        }

    except Exception as exc:
        logger.exception("[convert][error] file=%s err=%s", file_id, exc)
        raise
