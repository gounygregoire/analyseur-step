"""Pipeline STEP → GLB → XKT avec validations fail-fast et logs détaillés."""

from __future__ import annotations

import math
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


class ConversionError(RuntimeError):
    """Erreur contrôlée pendant la conversion STEP → GLB/XKT."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code)

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

def _log_step_mesh_diagnostics(step_path: str, tolerances: Iterable[float]) -> None:
    """Log detailed diagnostics about STEP tessellation using OCP if available."""

    try:
        from OCP.STEPControl import STEPControl_Reader  # type: ignore
        from OCP.IFSelect import IFSelect_RetDone  # type: ignore
        from OCP.BRepMesh import BRepMesh_IncrementalMesh  # type: ignore
        from OCP.BRepBndLib import BRepBndLib  # type: ignore
        from OCP.Bnd import Bnd_Box  # type: ignore
        from OCP.TopExp import TopExp_Explorer  # type: ignore
        from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID  # type: ignore
        from OCP.BRep import BRep_Tool  # type: ignore
        from OCP.TopLoc import TopLoc_Location  # type: ignore
        from OCP.BRepTools import BRepTools  # type: ignore
        try:
            from OCP.TopoDS import topods_Face, topods_Solid  # type: ignore
        except Exception:  # pragma: no cover - fallback for different OCP builds
            from OCP.TopoDS import TopoDS  # type: ignore

            def topods_Face(shape):  # type: ignore
                return TopoDS.Face_s(shape)

            def topods_Solid(shape):  # type: ignore
                return TopoDS.Solid_s(shape)

        try:
            from OCP.Interface import Interface_Static  # type: ignore
        except Exception:  # pragma: no cover - Interface module not available
            Interface_Static = None  # type: ignore

        try:
            from OCP.STEPCAFControl import STEPCAFControl_Reader  # type: ignore
        except Exception:  # pragma: no cover - STEPCAF optional
            STEPCAFControl_Reader = None  # type: ignore

    except Exception as exc:  # pragma: no cover - optional dependency missing
        logger.debug("[mesh][diag] OCP unavailable for diagnostics: %s", exc)
        return

    def _units(reader: STEPControl_Reader) -> str | None:
        try:
            seq = reader.Reader().FileUnits()  # type: ignore[attr-defined]
        except Exception:
            return None
        units: list[str] = []
        try:
            length = seq.Length()  # type: ignore[attr-defined]
            for idx in range(1, length + 1):
                units.append(str(seq.Value(idx)))
        except Exception:
            try:
                lower = seq.Lower()  # type: ignore[attr-defined]
                upper = seq.Upper()  # type: ignore[attr-defined]
                for idx in range(lower, upper + 1):
                    units.append(str(seq.Value(idx)))
            except Exception:
                try:
                    units.append(str(seq))
                except Exception:
                    return None
        return ",".join(u for u in units if u)

    def _units_via_interface() -> str | None:
        if Interface_Static is None:
            return None
        try:
            value = Interface_Static.CVal("xstep.cascade.unit")
        except Exception:
            return None
        if not value:
            return None
        return str(value)

    def _units_via_caf(path: str) -> str | None:
        if STEPCAFControl_Reader is None:
            return None
        try:
            caf_reader = STEPCAFControl_Reader()
        except Exception:
            return None
        try:
            caf_status = caf_reader.ReadFile(path)
        except Exception:
            return None
        try:
            if caf_status == IFSelect_RetDone:
                doc_label = caf_reader.UnitName()
                if doc_label:
                    return str(doc_label)
        except Exception:
            return None
        return None

    logger.info("[mesh][reader] init STEPControl_Reader for %s", step_path)
    reader = STEPControl_Reader()
    status = reader.ReadFile(step_path)
    unit_str = _units(reader)
    primary_unit = _units_via_interface() or _units_via_caf(step_path) or unit_str
    unit_display = primary_unit or unit_str
    try:
        n_roots = reader.NbRootsForTransfer()
    except Exception:
        n_roots = None
    logger.info(
        "[mesh][reader] read status=%s roots=%s units=%s",
        status,
        n_roots,
        unit_str or "unknown",
    )
    if primary_unit:
        logger.info("[mesh][units] primary=%s", primary_unit)
    else:
        logger.info("[mesh][units] primary=unknown (interface/caf unavailable)")
    if status != IFSelect_RetDone:
        return

    try:
        reader.TransferRoots()
    except Exception as exc:
        logger.warning("[mesh][reader] TransferRoots failed: %s", exc)
        return

    try:
        shape = reader.OneShape()
    except Exception as exc:
        logger.warning("[mesh][reader] OneShape failed: %s", exc)
        return

    bbox = Bnd_Box()
    try:
        bbox.SetGap(0.0)
    except Exception:
        pass
    try:
        BRepBndLib.Add(shape, bbox, True)
        xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
        diag = math.sqrt(
            max(0.0, (xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2)
        )
        logger.info(
            "[mesh][bbox] min=(%.6f, %.6f, %.6f) max=(%.6f, %.6f, %.6f) diag=%.6f",
            xmin,
            ymin,
            zmin,
            xmax,
            ymax,
            zmax,
            diag,
        )
    except Exception as exc:
        logger.warning("[mesh][bbox] failed to compute: %s", exc)
        xmin = ymin = zmin = xmax = ymax = zmax = diag = float("nan")

    if math.isfinite(diag):
        if diag < 1e-3:
            logger.warning(
                "[mesh][units] bbox diag=%.6f -> suspect micrometre scale (µm)", diag
            )
        elif diag > 10000:
            logger.warning(
                "[mesh][units] bbox diag=%.6f -> suspect metre scale (m)", diag
            )

    if not math.isfinite(diag) or diag <= 0.0:
        logger.warning("[mesh][bbox] invalid diag=%s, forcing to 1.0", diag)
        diag = 1.0

    lin_defls = [float(t) for t in tolerances]
    tries = (
        (0.002, 0.25),
        (0.005, 0.35),
        (0.01, 0.5),
    )
    logger.info(
        "[mesh][mesher] tolerances=%s diag=%.6f tries=%s",
        "/".join(f"{d:.6f}" for d in lin_defls) if lin_defls else "(none)",
        diag,
        ", ".join(f"{rel:.4f}@{ang:.2f}" for rel, ang in tries),
    )

    def _count_topo_faces(target_shape) -> int:
        exp = TopExp_Explorer(target_shape, TopAbs_FACE)
        total = 0
        while exp.More():
            total += 1
            exp.Next()
        return total

    def _count_faces(target_shape) -> tuple[int, int, list[str]]:
        exp = TopExp_Explorer(target_shape, TopAbs_FACE)
        total = 0
        tri = 0
        sizes: list[str] = []
        while exp.More():
            total += 1
            face = topods_Face(exp.Current())
            loc = TopLoc_Location()
            triangulation = BRep_Tool.Triangulation(face, loc)
            if triangulation is not None:
                tri += 1
                try:
                    nb_nodes = int(triangulation.NbNodes())
                    nb_tris = int(triangulation.NbTriangles())
                    sizes.append(f"{nb_nodes}v/{nb_tris}t")
                except Exception:
                    sizes.append("unknown")
            exp.Next()
        return total, tri, sizes

    shapes_to_mesh = [shape]
    topo_faces = _count_topo_faces(shape)
    if topo_faces == 0:
        sub_shapes = []
        solid_exp = TopExp_Explorer(shape, TopAbs_SOLID)
        while solid_exp.More():
            solid = topods_Solid(solid_exp.Current())
            if _count_topo_faces(solid) > 0:
                sub_shapes.append(solid)
            solid_exp.Next()
        if not sub_shapes:
            face_exp = TopExp_Explorer(shape, TopAbs_FACE)
            while face_exp.More():
                sub_shapes.append(topods_Face(face_exp.Current()))
                face_exp.Next()
        if sub_shapes:
            shapes_to_mesh = sub_shapes
            logger.info(
                "[mesh][mesher] decomposed compound into %s sub-shapes", len(shapes_to_mesh)
            )

    last_total = 0
    last_tri = 0
    last_shapes_with_tri = 0
    last_sizes: list[str] = []

    for idx, (defl_rel, ang) in enumerate(tries, start=1):
        defl_abs = defl_rel * diag
        logger.info(
            "[mesh][mesher] try=%s defl_rel=%.4f defl_abs=%.6f ang=%.2f", idx, defl_rel, defl_abs, ang
        )
        total_faces = 0
        total_tri = 0
        shapes_with_tri = 0
        size_samples: list[str] = []

        try:
            BRepTools.Clean(shape)
        except Exception as exc:
            logger.debug("[mesh][mesher] cleanup failed before try %s: %s", idx, exc)

        for shp_idx, target_shape in enumerate(shapes_to_mesh, start=1):
            try:
                BRepTools.Clean(target_shape)
            except Exception as exc:
                logger.debug(
                    "[mesh][mesher] cleanup failed for sub-shape %s on try %s: %s",
                    shp_idx,
                    idx,
                    exc,
                )
            try:
                mesher = BRepMesh_IncrementalMesh(
                    target_shape, float(defl_rel), True, float(ang), True
                )
                perform = getattr(mesher, "Perform", None)
                if callable(perform):
                    perform()
            except Exception as exc:
                logger.warning(
                    "[mesh][mesher] incremental mesh failed try=%s shape=%s defl_rel=%.4f ang=%.2f err=%s",
                    idx,
                    shp_idx,
                    defl_rel,
                    ang,
                    exc,
                )
                continue

            shape_total, shape_tri, shape_sizes = _count_faces(target_shape)
            total_faces += shape_total
            total_tri += shape_tri
            if shape_tri > 0:
                shapes_with_tri += 1
            if len(size_samples) < 10 and shape_sizes:
                remaining = 10 - len(size_samples)
                size_samples.extend(shape_sizes[:remaining])

        last_total = total_faces
        last_tri = total_tri
        last_shapes_with_tri = shapes_with_tri
        last_sizes = size_samples

        logger.info(
            "[mesh][faces] try=%s shapes=%s triangulated_shapes=%s total_faces=%s triangulated=%s samples=%s",
            idx,
            len(shapes_to_mesh),
            shapes_with_tri,
            total_faces,
            total_tri,
            size_samples,
        )
        if total_tri > 0:
            break
        logger.warning(
            "[mesh] zero triangulated faces try=%s (diag=%.6f, unit=%s, defl_rel=%.4f shapes=%s)",
            idx,
            diag,
            unit_display or "unknown",
            defl_rel,
            len(shapes_to_mesh),
        )

    if last_tri == 0:
        logger.error(
            "[mesh][mesher] FAILED_ALL_TRIES diag=%.6f unit=%s tries=%s shapes=%s tri_shapes=%s",
            diag,
            unit_display or "unknown",
            ", ".join(f"{rel:.4f}@{ang:.2f}" for rel, ang in tries),
            len(shapes_to_mesh),
            last_shapes_with_tri,
        )
        raise RuntimeError("BRepMesh incremental mesh produced zero triangulated faces")


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

    try:
        _log_step_mesh_diagnostics(step_path, tolerances)
    except Exception:  # pragma: no cover - diagnostics must not break conversion
        logger.exception("[mesh][diag] unexpected failure during diagnostics")

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
        glb_faces_total = count_glb_faces(glb_path)
        logger.info(
            "[convert][glb][validate] file=%s glb_faces_total=%s glb_size=%s",
            file_id,
            glb_faces_total,
            glb_bytes,
        )
        if glb_faces_total <= 0:
            logger.error(
                "[convert][glb] zero faces detected after meshing file=%s meshes=%s size=%s",
                file_id,
                mesh_count,
                glb_bytes,
            )
            raise ConversionError("no_faces_after_meshing")
        faces = glb_faces_total

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

    except ConversionError as exc:
        logger.error(
            "[convert][error] file=%s code=%s message=%s",
            file_id,
            getattr(exc, "code", "unknown"),
            exc,
        )
        raise
    except Exception as exc:
        logger.exception("[convert][error] file=%s err=%s", file_id, exc)
        raise
