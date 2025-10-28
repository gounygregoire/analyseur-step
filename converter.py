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


from shutil import which

def _find_xeokit_exe() -> list[str]:
    # 1) Override explicite par env
    exe_env = (os.environ.get("XEOKIT_CONVERT") or "").strip()
    if exe_env:
        return shlex.split(exe_env)

    # 2) Binaire local du projet (installé à build: npm i xeokit-gltf-to-xkt)
    project_root = os.path.dirname(__file__)
    local_bin = os.path.join(project_root, "node_modules", ".bin", "xeokit-gltf-to-xkt")
    if os.path.exists(local_bin):
        return [local_bin]

    # 3) Global PATH
    global_bin = which("xeokit-gltf-to-xkt")
    if global_bin:
        return [global_bin]

    # 4) Ultime recours: npx (à éviter en prod)
    return ["npx", "-y", "xeokit-gltf-to-xkt"]

def _xeokit_command(input_path: str, output_path: str) -> list[str]:
    base = _find_xeokit_exe()
    extra_args = shlex.split(os.environ.get("XEOKIT_ARGS", ""))

    # filtre les flags qui tuent la géo
    blocked = {"--edges-only", "--lines-only", "--wireframe"}
    filtered, removed = [], []
    for token in extra_args:
        t = token.lower()
        if t in blocked or any(t.startswith(f"{b}=") for b in blocked):
            removed.append(token); continue
        filtered.append(token)
    if removed:
        logger.warning("[convert][xkt] ignoring geometry-filtering args: %s", ", ".join(removed))

    return base + filtered + ["--input", input_path, "--output", output_path, "--logLevel", "debug"]

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

    if not os.path.exists(step_path):
        try:
            from s3io import get_file

            os.makedirs(UPLOAD_DIR, exist_ok=True)
            got = get_file(
                f"uploads/{file_id}.step",
                os.path.join(UPLOAD_DIR, f"{file_id}.step"),
            )
            if not got:
                got = get_file(
                    f"uploads/{file_id}.stp",
                    os.path.join(UPLOAD_DIR, f"{file_id}.step"),
                )
            if not got or not os.path.exists(step_path):
                raise FileNotFoundError("STEP introuvable local/S3")
            logger.info("[convert][src] pulled from S3.")
        except Exception as exc:  # pragma: no cover - dépendances S3 externes
            raise FileNotFoundError(f"S3 fallback fail: {exc}") from exc

    _, faces = _tessellate_to_glb(step_path, glb_path, (0.2, 0.1, 0.05))
    if faces <= 0:
        raise RuntimeError("GLB has 0 faces - abort")

    t_xkt = time.time()
    glb_to_xkt(glb_path, xkt_path)
    xkt_duration = time.time() - t_xkt
    glb_bytes = file_size(glb_path)
    xkt_bytes = file_size(xkt_path)
    if xkt_bytes < MIN_XKT_BYTES:
        raise RuntimeError(f"XKT too small ({xkt_bytes} B) - abort")
    if xkt_bytes == KNOWN_BAD_XKT_BYTES:
        raise RuntimeError(
            f"Known bad XKT size ({KNOWN_BAD_XKT_BYTES} B): refusing publish"
        )

    logger.info(
        "[convert][done] glb_faces=%s glb_size=%s xkt_size=%s xkt_dt=%.2fs xkt_path=%s",
        faces,
        glb_bytes,
        xkt_bytes,
        xkt_duration,
        xkt_path,
    )

    return {
        "glb": glb_path,
        "xkt": xkt_path,
        "faces": faces,
        "xkt_size": xkt_bytes,
    }


_convert_step_to_xkt_impl = convert_step_to_xkt

def _assert_xeokit_available(cmd_base: list[str]) -> None:
    try:
        test_cmd = cmd_base + ["--version"]
        proc = subprocess.run(
            test_cmd,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=_with_node_path(os.environ), check=False
        )
        if proc.returncode != 0:
            raise RuntimeError(f"xeokit CLI not available rc={proc.returncode}: {proc.stderr.strip()}")
        logger.info("[xkt] cli=%s version=%s", " ".join(shlex.quote(c) for c in cmd_base), proc.stdout.strip())
    except FileNotFoundError as e:
        raise RuntimeError(f"xeokit CLI not found: {e}")

def glb_to_xkt(glb_path: str, xkt_path: str) -> None:
    if not glb_path or not os.path.exists(glb_path):
        raise FileNotFoundError(f"GLB introuvable: {glb_path}")

    out_dir = os.path.dirname(xkt_path or "")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    if os.path.exists(xkt_path):
        try: os.remove(xkt_path)
        except OSError: pass

    cmd = _xeokit_command(glb_path, xkt_path)
    _assert_xeokit_available(cmd[:1] if len(cmd)==1 else (cmd if cmd[0]!="npx" else ["npx", "-y", "xeokit-gltf-to-xkt"]))

    cmd_display = " ".join(shlex.quote(c) for c in cmd)
    logger.info("[convert][xkt] cmd=%s", cmd_display)
    t0 = time.time()
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env=_with_node_path(os.environ), check=False
    )
    dt = time.time() - t0
    if proc.stdout.strip(): logger.info("[xkt][stdout]\n%s", proc.stdout.strip())
    if proc.stderr.strip(): logger.warning("[xkt][stderr]\n%s", proc.stderr.strip())
    if proc.returncode != 0:
        # pas de fichier pourri qui traîne
        try: os.remove(xkt_path)
        except OSError: pass
        raise RuntimeError(f"xeokit-gltf-to-xkt failed rc={proc.returncode}")

    size = file_size(xkt_path)
    logger.info("[xkt] done in %.2fs size=%s", dt, size)

    # coupe-circuit “faux XKT”
    if size < MIN_XKT_BYTES or size == KNOWN_BAD_XKT_BYTES:
        try: os.remove(xkt_path)
        except OSError: pass
        raise RuntimeError(f"XKT too small or known bad size ({size} B) - abort")

def convert_step_to_xkt(file_id: str) -> dict[str, int | str]:
    result = dict(_convert_step_to_xkt_impl(file_id))
    result["glb_size"] = file_size(result["glb"])
    result["xkt_size"] = file_size(result["xkt"])
    return result
