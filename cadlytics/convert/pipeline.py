"""Pipeline de conversion STEP/STL vers XKT.

Ce module centralise l'ensemble des étapes nécessaires pour télécharger une
source depuis S3, la convertir en STL via pythonocc-core, la transformer en XKT
et publier le résultat localement avec un manifeste décrivant le statut.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from botocore.client import BaseClient
import trimesh
from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.STEPControl import STEPControl_Reader
from OCC.Core.StlAPI import StlAPI_Writer


UPLOAD_ROOT = Path("/tmp/uploads")
XKT_PUBLISH_DIR = Path("/opt/render/project/src/public/xkt")


@dataclass
class ConvertStats:
    """Statistiques de conversion XKT."""

    meshes: Optional[int]
    triangles: Optional[int]
    xkt_size: int
    stdout: str = ""
    stderr: str = ""


class ConversionCommandError(RuntimeError):
    """Erreur lors de l'exécution de ``@xeokit/xeokit-convert``."""

    def __init__(self, message: str, *, stdout: str = "", stderr: str = "") -> None:
        super().__init__(message)
        self.stdout = stdout
        self.stderr = stderr


def _s3_client() -> BaseClient:
    """Construit un client S3 compatible Scaleway avec configuration explicite."""

    endpoint_url = os.getenv("S3_ENDPOINT")
    region_name = os.getenv("AWS_REGION")
    force_path_style = os.getenv("S3_FORCE_PATH_STYLE") in {"1", "true", "True"}

    config_kwargs: dict[str, object] = {"signature_version": "s3v4"}
    if force_path_style:
        config_kwargs["s3"] = {"addressing_style": "path"}

    config = Config(**config_kwargs)

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        region_name=region_name,
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
        config=config,
    )


def download_source_from_s3(file_id: str) -> Path:
    """Télécharge un fichier source depuis S3 vers ``/tmp/uploads``.

    Recherche successivement les extensions STL, STEP puis STP et renvoie le
    chemin local correspondant.
    """

    bucket = os.getenv("S3_BUCKET")
    if not bucket:
        raise RuntimeError("S3_BUCKET non défini")

    client = _s3_client()
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)

    last_error: Optional[Exception] = None
    for ext in ("stl", "step", "stp"):
        key = f"uploads/{file_id}.{ext}"
        local_path = UPLOAD_ROOT / f"{file_id}.{ext}"
        try:
            print("[convert] download", key)
            client.download_file(bucket, key, str(local_path))
            if not local_path.exists():
                raise FileNotFoundError(f"Téléchargement manqué pour {key}")
            return local_path
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code") if hasattr(exc, "response") else None
            if code not in {"404", "NoSuchKey", "NotFound"}:
                last_error = exc
                break
            last_error = exc
            continue
    raise FileNotFoundError(f"Aucune source trouvée sur S3 pour {file_id}: {last_error}")


def step_to_stl(
    src_path: Path,
    dst_stl: Path,
    *,
    linear_deflection: float = 0.05,
    angular_deflection_deg: float = 15.0,
) -> None:
    """Convertit un fichier STEP/STP en STL via pythonocc-core."""

    if not src_path.exists():
        raise FileNotFoundError(f"STEP source introuvable: {src_path}")
    if src_path.stat().st_size < 1024:
        raise ValueError(f"Fichier STEP trop petit ({src_path.stat().st_size} B)")

    reader = STEPControl_Reader()
    status = reader.ReadFile(str(src_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"Lecture STEP échouée (code={status})")

    if reader.TransferRoots() == 0:
        raise RuntimeError("Aucune entité transférée depuis le STEP")

    shape = reader.OneShape()

    lin = float(linear_deflection)
    ang_rad = math.radians(float(angular_deflection_deg))
    mesh = BRepMesh_IncrementalMesh(shape, lin, False, ang_rad, True)
    mesh.Perform()
    if not mesh.IsDone():
        raise RuntimeError("Génération du maillage OCC échouée")

    dst_stl.parent.mkdir(parents=True, exist_ok=True)
    writer = StlAPI_Writer()
    writer.SetASCIIMode(False)
    if not writer.Write(shape, str(dst_stl)):
        raise RuntimeError(f"Export STL échoué vers {dst_stl}")

    print("[convert] step_to_stl", src_path, "->", dst_stl)


def validate_stl_triangles(stl_path: Path) -> int:
    """Valide qu'un STL contient au moins un triangle."""

    if not stl_path.exists():
        raise FileNotFoundError(f"STL introuvable: {stl_path}")

    mesh = trimesh.load_mesh(str(stl_path), file_type="stl", force="mesh")
    if isinstance(mesh, trimesh.Scene):  # type: ignore[attr-defined]
        mesh = trimesh.util.concatenate(mesh.dump())  # type: ignore[attr-defined]

    faces = getattr(mesh, "faces", None)
    triangles = int(faces.shape[0]) if faces is not None else 0
    if triangles <= 0:
        raise ValueError("STL sans triangles")

    print("[convert] validate_stl", stl_path, "triangles=", triangles)
    return triangles


def stl_to_xkt(src_stl: Path, dst_xkt: Path) -> ConvertStats:
    """Convertit un STL en XKT via le binaire ``@xeokit/xeokit-convert``."""

    project_root = Path(__file__).resolve().parents[2]
    dst_xkt.parent.mkdir(parents=True, exist_ok=True)
    if dst_xkt.exists():
        dst_xkt.unlink()

    cmd = [
        "npx",
        "--yes",
        "@xeokit/xeokit-convert",
        "--input",
        str(src_stl),
        "--output",
        str(dst_xkt),
        "--format",
        "xkt",
        "--withGeometry",
        "true",
        "--withMetaModel",
        "true",
        "--triangulate",
        "true",
        "--stats",
        "true",
        "--logLevel",
        "error",
    ]

    print("[convert] stl_to_xkt cmd=", " ".join(cmd))
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            cwd=project_root,
        )
    except FileNotFoundError as exc:
        raise FileNotFoundError("npx introuvable pour la conversion XKT") from exc

    stdout = result.stdout or ""
    stderr = result.stderr or ""
    if result.returncode != 0:
        message = stderr.strip() or stdout.strip() or "conversion inconnue"
        raise ConversionCommandError(
            f"Conversion XKT échouée (code={result.returncode}): {message}",
            stdout=stdout,
            stderr=stderr,
        )

    combined = f"{stdout}\n{stderr}"
    meshes = _parse_stat(combined, ("meshes", "numMeshes"))
    triangles = _parse_stat(combined, ("triangles", "numTriangles"))

    if not dst_xkt.exists():
        raise ConversionCommandError("Fichier XKT non généré", stdout=stdout, stderr=stderr)

    size = dst_xkt.stat().st_size
    print("[convert] stl_to_xkt done size=", size, "meshes=", meshes, "triangles=", triangles)

    return ConvertStats(meshes=meshes, triangles=triangles, xkt_size=size, stdout=stdout, stderr=stderr)


def _parse_stat(text: str, labels: tuple[str, ...]) -> Optional[int]:
    """Extrait une statistique numérique de la sortie du converter."""

    pattern = re.compile(
        rf"(?:{'|'.join(re.escape(label) for label in labels)})\s*[:=]\s*(\d+)",
        re.IGNORECASE,
    )
    match = pattern.search(text)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return None
    return None


def write_manifest(file_id: str, stats: ConvertStats, ok: bool) -> Path:
    """Écrit le manifeste JSON de conversion."""

    XKT_PUBLISH_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = XKT_PUBLISH_DIR / f"{file_id}.manifest.json"
    payload = {
        "file_id": file_id,
        "ok": ok,
        "meshes": stats.meshes,
        "triangles": stats.triangles,
        "xkt_size": stats.xkt_size,
    }
    manifest_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print("[convert] manifest", manifest_path)
    return manifest_path


def publish_xkt(file_id: str, xkt_path: Path) -> Path:
    """Publie le XKT généré dans le dossier public attendu."""

    # CODENAME: ATOMIC-XKT
    start_ts = time.perf_counter()

    if not xkt_path.exists():
        raise FileNotFoundError(f"XKT introuvable: {xkt_path}")

    XKT_PUBLISH_DIR.mkdir(parents=True, exist_ok=True)
    dst = XKT_PUBLISH_DIR / f"{file_id}.xkt"
    os.replace(xkt_path, dst)

    size = dst.stat().st_size
    elapsed_ms = int((time.perf_counter() - start_ts) * 1000)
    log_payload = {
        "event": "publish_xkt",
        "file_id": file_id,
        "ok": True,
        "size": size,
        "ms": elapsed_ms,
    }
    print(json.dumps(log_payload, ensure_ascii=False))
    return dst


def run_conversion(file_id: str) -> dict[str, object]:
    """Chaîne complète de conversion pour un ``file_id`` donné."""

    print("[convert] run_conversion start file_id=", file_id)
    src_path = download_source_from_s3(file_id)

    if src_path.suffix.lower() == ".stl":
        stl_path = src_path
    else:
        stl_path = UPLOAD_ROOT / f"{file_id}.stl"
        step_to_stl(src_path, stl_path)

    triangle_count = validate_stl_triangles(stl_path)

    xkt_tmp = XKT_PUBLISH_DIR / f"{file_id}.xkt.tmp"

    stats = stl_to_xkt(stl_path, xkt_tmp)
    if stats.triangles is None:
        stats.triangles = triangle_count

    guard_errors = []
    if stats.meshes is not None and stats.meshes <= 0:
        guard_errors.append("meshes==0")
    if triangle_count <= 0:
        guard_errors.append("triangles==0 (validation)")
    if stats.triangles is not None and stats.triangles <= 0:
        guard_errors.append("triangles==0 (xkt)")
    if stats.xkt_size < 200_000:
        guard_errors.append(f"xkt_size<{200_000}")

    if guard_errors:
        print("[convert] guard_fail", ", ".join(guard_errors))
        write_manifest(file_id, stats, ok=False)
        raise RuntimeError(f"Garde-fous échoués: {', '.join(guard_errors)}")

    published_path = publish_xkt(file_id, xkt_tmp)
    try:
        stats.xkt_size = published_path.stat().st_size
    except OSError:
        pass
    write_manifest(file_id, stats, ok=True)

    result = {
        "status": "done",
        "ok": True,
        "file_id": file_id,
        "meshes": stats.meshes,
        "triangles": stats.triangles,
        "xkt_size": stats.xkt_size,
        "stdout": stats.stdout,
        "stderr": stats.stderr,
    }

    print("[convert] run_conversion ok", result)
    return result

