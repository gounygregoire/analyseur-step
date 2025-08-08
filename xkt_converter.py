"""Outil simple pour convertir un fichier STEP en XKT via xeokit-convert.

Ce script requiert l'installation de xeokit-convert (npm).
Exemple d'utilisation :
    python xkt_converter.py input.step output.xkt
"""

import subprocess
import sys
from pathlib import Path


def convert_step_to_xkt(step_path: str, xkt_path: str) -> None:
    step = Path(step_path)
    out = Path(xkt_path)
    if not step.exists():
        raise FileNotFoundError(step)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["npx", "@xeokit/xeokit-convert", "-s", str(step), "-o", str(out)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode, cmd, output=result.stdout, stderr=result.stderr
        )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python xkt_converter.py input.step output.xkt")
        sys.exit(1)
    convert_step_to_xkt(sys.argv[1], sys.argv[2])
