"""Conversion STEP/STL vers XKT avec garde-fous pour les maillages vides."""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Pattern, Tuple

from cadlytics.convert.step_to_stl import StepToStlError, step_or_stp_to_stl
from cadlytics.utils.s3_client import download_to_file, find_first_existing


logger = logging.getLogger(__name__)

PUBLIC_XKT_DIR = Path("/opt/render/project/src/public/xkt")
TMP_UPLOAD_DIR = Path("/tmp/uploads")
MIN_XKT_SIZE = 200_000
CONVERTER_VERSION = "convert2xkt 1.3.1"

__all__ = ["convert_to_xkt", "ConversionError"]

_MESH_PATTERNS: List[Pattern[str]] = [
    re.compile(r"meshes?\D+(\d+)", re.IGNORECASE),
    re.compile(r"meshCount\D+(\d+)", re.IGNORECASE),
    re.compile(r"num\s+meshes\D+(\d+)", re.IGNORECASE),
]
_TRIANGLE_PATTERNS: List[Pattern[str]] = [
    re.compile(r"triangles?\D+(\d+)", re.IGNORECASE),
    re.compile(r"triangleCount\D+(\d+)", re.IGNORECASE),
    re.compile(r"num\s+triangles\D+(\d+)", re.IGNORECASE),
]

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_CONVERTER_RELATIVE = Path("node_modules/@xeokit/xeokit-convert/convert2xkt.js")
_CONVERTER_ABSOLUTE = _PROJECT_ROOT / _CONVERTER_RELATIVE


class ConversionError(RuntimeError):
    """Erreur contrôlée lors de la conversion XKT."""


def _validate_file_id(file_id: str) -> str:
    if not file_id or not re.fullmatch(r"[A-Za-z0-9_-]+", file_id):
        raise ConversionError("file_id invalide")
    return file_id


def _candidate_keys(file_id: str) -> List[str]:
    return [
        f"uploads/{file_id}.step",
        f"uploads/{file_id}.stp",
        f"uploads/{file_id}.stl",
    ]


def _download_source(file_id: str) -> Tuple[str, Path]:
    candidates = _candidate_keys(file_id)
    logger.info("[convert] recherche des sources S3 pour %s", file_id)
    key = find_first_existing(candidates)
    if key is None:
        raise ConversionError("Source introuvable dans le bucket S3")

    extension = Path(key).suffix
    local_path = TMP_UPLOAD_DIR / f"{file_id}{extension}"
    TMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("[convert] téléchargement %s -> %s", key, local_path)
    download_to_file(key, str(local_path))
    return key, local_path


def _ensure_stl(file_id: str, source_path: Path) -> Path:
    if source_path.suffix.lower() == ".stl":
        return source_path

    stl_path = TMP_UPLOAD_DIR / f"{file_id}.stl"
    logger.info("[convert] conversion STEP/STP -> STL %s", source_path)
    try:
        step_or_stp_to_stl(str(source_path), str(stl_path))
    except StepToStlError as exc:  # pragma: no cover - dépendance externe
        raise ConversionError(f"Conversion STEP vers STL échouée: {exc}") from exc
    return stl_path


def _run_convert2xkt(stl_path: Path, out_dir: Path) -> subprocess.CompletedProcess[str]:
    if not _CONVERTER_ABSOLUTE.exists():
        raise ConversionError(
            "convert2xkt introuvable — installer Node et la dépendance @xeokit/xeokit-convert@1.3.1"
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        "node",
        str(_CONVERTER_RELATIVE),
        "-s",
        str(stl_path),
        "-o",
        str(out_dir / "model.xkt"),
        "-f",
        "stl",
        "-b",
    ]

    logger.info("[convert] lancement convert2xkt pour %s", stl_path.name)
    try:
        result = subprocess.run(
            cmd,
            cwd=_PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ConversionError(
            "convert2xkt introuvable — installer Node et la dépendance @xeokit/xeokit-convert@1.3.1"
        ) from exc

    if result.returncode != 0:
        raise ConversionError(
            "convert2xkt a échoué (code {}):\nSTDOUT:\n{}\nSTDERR:\n{}".format(
                result.returncode,
                result.stdout.strip() if result.stdout else "",
                result.stderr.strip() if result.stderr else "",
            )
        )

    return result


def _extract_stat(patterns: List[Pattern[str]], payload: str) -> Optional[int]:
    for pattern in patterns:
        matches = pattern.findall(payload)
        if matches:
            try:
                return int(matches[-1])
            except ValueError:
                continue
    return None


def _validate_geometry(xkt_path: Path, meshes: Optional[int], triangles: Optional[int], force_geometry: bool) -> int:
    size_bytes = xkt_path.stat().st_size
    if size_bytes < MIN_XKT_SIZE:
        raise ConversionError(f"Fichier XKT trop petit ({size_bytes} octets)")

    if force_geometry:
        if meshes is not None and meshes <= 0:
            raise ConversionError("Conversion invalide: aucune mesh détectée")
        if triangles is not None and triangles <= 0:
            raise ConversionError("Conversion invalide: aucun triangle détecté")
    else:
        if meshes == 0 or triangles == 0:
            raise ConversionError("Conversion invalide: géométrie vide")

    return size_bytes


def _publish_outputs(file_id: str, xkt_source: Path, meshes: Optional[int], triangles: Optional[int], size_bytes: int) -> Dict[str, object]:
    PUBLIC_XKT_DIR.mkdir(parents=True, exist_ok=True)
    final_xkt = PUBLIC_XKT_DIR / f"{file_id}.xkt"
    final_manifest = PUBLIC_XKT_DIR / f"{file_id}.manifest.json"

    if final_xkt.exists():
        final_xkt.unlink()
    if final_manifest.exists():
        final_manifest.unlink()

    shutil.copyfile(xkt_source, final_xkt)

    manifest = {
        "file_id": file_id,
        "meshes": meshes,
        "triangles": triangles,
        "xkt_size": size_bytes,
        "ok": True,
        "converter": CONVERTER_VERSION,
    }
    with final_manifest.open("w", encoding="utf-8") as manifest_file:
        json.dump(manifest, manifest_file, ensure_ascii=False, separators=(",", ":"))

    manifest["xkt_path"] = str(final_xkt)
    manifest["manifest_path"] = str(final_manifest)
    return manifest


def convert_to_xkt(file_id: str, force_geometry: bool = True) -> Dict[str, object]:
    """Convertit le fichier STEP/STL associé à ``file_id`` en XKT."""

    safe_id = _validate_file_id(file_id)
    source_key, source_path = _download_source(safe_id)
    stl_path = _ensure_stl(safe_id, source_path)

    out_dir = Path(f"/tmp/conv_{safe_id}")
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)

    result = _run_convert2xkt(stl_path, out_dir)
    xkt_path = out_dir / "model.xkt"
    if not xkt_path.exists():
        raise ConversionError("convert2xkt n'a pas produit de fichier XKT")

    stdout = result.stdout or ""
    stderr = result.stderr or ""
    meshes = _extract_stat(_MESH_PATTERNS, stdout)
    triangles = _extract_stat(_TRIANGLE_PATTERNS, stdout)

    size_bytes = _validate_geometry(xkt_path, meshes, triangles, force_geometry)
    logger.info(
        "[convert] conversion réussie file_id=%s meshes=%s triangles=%s size=%s",
        safe_id,
        meshes,
        triangles,
        size_bytes,
    )

    payload = _publish_outputs(safe_id, xkt_path, meshes, triangles, size_bytes)
    payload.update(
        {
            "stdout": stdout,
            "stderr": stderr,
            "force_geometry": force_geometry,
            "size_bytes": size_bytes,
            "source_key": source_key,
        }
    )
    return payload
