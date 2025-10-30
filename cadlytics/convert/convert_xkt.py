"""Conversion STEP -> XKT en s'appuyant sur xeokit-convert."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Dict, Optional, Tuple

from cadlytics.utils import s3_client


class ConversionError(RuntimeError):
    """Erreur contrôlée lors de la conversion XKT."""


_MESH_REGEXES = (
    re.compile(r"meshes?\D+(\d+)", re.IGNORECASE),
    re.compile(r"meshCount\D+(\d+)", re.IGNORECASE),
    re.compile(r"num\s*meshes\D+(\d+)", re.IGNORECASE),
)
_TRIANGLE_REGEXES = (
    re.compile(r"triangles?\D+(\d+)", re.IGNORECASE),
    re.compile(r"triangleCount\D+(\d+)", re.IGNORECASE),
    re.compile(r"num\s*triangles\D+(\d+)", re.IGNORECASE),
)

_PUBLIC_XKT_DIR = Path("/opt/render/project/src/public/xkt")
_UPLOAD_DIR = Path(os.environ.get("UPLOAD_FOLDER", "/tmp/uploads"))


def _safe_file_id(file_id: str) -> str:
    if not file_id or not re.fullmatch(r"[a-zA-Z0-9_-]+", file_id):
        raise ConversionError("file_id invalide")
    return file_id


def _candidate_keys(file_id: str) -> Dict[str, str]:
    return {
        f"uploads/{file_id}.step": ".step",
        f"uploads/{file_id}.stp": ".stp",
        f"uploads/{file_id}.stl": ".stl",
    }


def _download_source(file_id: str) -> Path:
    candidates = _candidate_keys(file_id)
    print(f"[convert] recherche STEP pour {file_id}")
    key = s3_client.find_first_existing(list(candidates.keys()))
    if key is None:
        raise ConversionError("Fichier source introuvable sur S3")

    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest_path = _UPLOAD_DIR / f"{file_id}{candidates[key]}"
    print(f"[convert] téléchargement S3 {key} -> {dest_path}")
    try:
        s3_client.download_to_file(key, str(dest_path))
    except Exception as exc:  # pragma: no cover - protection supplémentaire
        raise ConversionError(f"Téléchargement S3 échoué pour {key}: {exc}") from exc
    return dest_path


def _parse_stats(log_output: str) -> Tuple[Optional[int], Optional[int]]:
    meshes: Optional[int] = None
    triangles: Optional[int] = None
    for pattern in _MESH_REGEXES:
        matches = pattern.findall(log_output)
        if matches:
            meshes = int(matches[-1])
    for pattern in _TRIANGLE_REGEXES:
        matches = pattern.findall(log_output)
        if matches:
            triangles = int(matches[-1])
    return meshes, triangles


def _write_manifest(manifest_path: Path, payload: Dict[str, object]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError as exc:  # pragma: no cover - best effort
        print(f"[convert] impossible de supprimer {path}: {exc}")


def convert_to_xkt(file_id: str, force_geometry: bool = True) -> Dict[str, object]:
    """Convertit un fichier STEP en XKT et retourne un manifest détaillé."""

    file_id = _safe_file_id(file_id)
    source_path = _download_source(file_id)

    out_dir = Path(f"/tmp/conv_{file_id}")
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    xkt_tmp = out_dir / "model.xkt"

    cmd = [
        "npx",
        "-y",
        "@xeokit/xeokit-convert@1.3.1",
        "--input",
        str(source_path),
        "--output",
        str(xkt_tmp),
        "--format",
        "xkt",
        "--withGeometry",
        "true" if force_geometry else "false",
        "--withMetaModel",
        "true",
        "--triangulate",
        "true",
        "--stats",
        "true",
        "--logLevel",
        "debug",
    ]

    print(f"[convert] lancement xeokit-convert: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ConversionError(
            "npx introuvable sur ce worker – installe Node ou utilise l’autre worker"
        ) from exc

    combined_logs = f"{result.stdout or ''}\n{result.stderr or ''}".strip()
    if combined_logs:
        print(f"[convert] logs xeokit:\n{combined_logs}")

    if result.returncode != 0:
        raise ConversionError(
            f"xeokit-convert a échoué (code {result.returncode}): {result.stderr.strip()}"
        )

    if not xkt_tmp.exists():
        raise ConversionError("Fichier XKT introuvable après conversion")

    size_bytes = xkt_tmp.stat().st_size
    meshes, triangles = _parse_stats(combined_logs)

    if meshes == 0 or triangles == 0:
        raise ConversionError("Conversion invalide: aucune géométrie détectée")
    if size_bytes < 200_000:
        raise ConversionError("Conversion invalide: fichier XKT trop petit")

    final_dir = _PUBLIC_XKT_DIR
    final_dir.mkdir(parents=True, exist_ok=True)
    final_xkt = final_dir / f"{file_id}.xkt"
    final_manifest = final_dir / f"{file_id}.manifest.json"

    _safe_unlink(final_xkt)
    _safe_unlink(final_manifest)

    shutil.copyfile(xkt_tmp, final_xkt)

    manifest_payload: Dict[str, object] = {
        "file_id": file_id,
        "meshes": meshes,
        "triangles": triangles,
        "ok": True,
        "converter": "xeokit-convert 1.3.1",
    }
    _write_manifest(final_manifest, manifest_payload)

    print(
        f"[convert] conversion ok file_id={file_id} meshes={meshes} triangles={triangles} size={size_bytes}"
    )

    return {
        "ok": True,
        "file_id": file_id,
        "meshes": meshes,
        "triangles": triangles,
        "xkt_size": size_bytes,
        "size_bytes": size_bytes,
        "out": str(out_dir),
    }
