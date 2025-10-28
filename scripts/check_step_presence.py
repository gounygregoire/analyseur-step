#!/usr/bin/env python3
"""Script de diagnostic pour vérifier la disponibilité d'un STEP via FILE_ID."""
import os
import sys
from pathlib import Path

FILE_ID = os.environ.get("FILE_ID")

if not FILE_ID:
    print("FILE_ID manquant dans l'environnement.")
    sys.exit(1)

STEP_PATH = Path("/tmp/uploads") / f"{FILE_ID}.step"
GLB_PATH = Path("/tmp/converted") / f"{FILE_ID}.glb"
XKT_PATH = Path("/tmp/converted") / f"{FILE_ID}.xkt"

TARGETS = {
    "step": STEP_PATH,
    "glb": GLB_PATH,
    "xkt": XKT_PATH,
}


def describe(path: Path) -> str:
    exists = path.exists()
    size = path.stat().st_size if exists and path.is_file() else None
    size_part = f", size={size}" if size is not None else ""
    return f"{path}: exists={str(exists).lower()}{size_part}"


def report_state(header: str) -> None:
    print(header)
    for label, path in TARGETS.items():
        print(f"- {label}: {describe(path)}")


def main() -> int:
    report_state("Avant fallback :")

    if not STEP_PATH.exists():
        print("STEP absent localement, tentative de téléchargement depuis S3...")
        try:
            from s3io import get_file
        except ImportError as exc:
            print(f"ImportError sur s3io.get_file : {exc}")
            return 1

        key = f"uploads/{FILE_ID}.step"
        if get_file(key, str(STEP_PATH)):
            print("Téléchargement S3 OK.")
        else:
            print("S3 key missing")

    report_state("Après fallback :")
    return 0


if __name__ == "__main__":
    sys.exit(main())
