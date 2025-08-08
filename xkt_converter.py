"""Outil simple pour convertir un fichier STEP en XKT via xeokit-convert.

Ce script requiert l'installation de xeokit-convert (npm).
Exemple d'utilisation :
    python xkt_converter.py input.step output.xkt
"""

import subprocess
import sys
import logging
from pathlib import Path


logger = logging.getLogger(__name__)


def convert_step_to_xkt(step_path: str, xkt_path: str) -> None:
    step = Path(step_path)
    out = Path(xkt_path)
    if not step.exists():
        raise FileNotFoundError(step)
    out.parent.mkdir(parents=True, exist_ok=True)
    node_v = subprocess.run(["node", "-v"], capture_output=True, text=True)
    npm_v = subprocess.run(["npm", "-v"], capture_output=True, text=True)
    logger.info("node -v: %s", node_v.stdout.strip())
    logger.info("npm -v: %s", npm_v.stdout.strip())
    cmd = ["npx", "@xeokit/xeokit-convert", "-s", str(step), "-o", str(out)]
    logger.info("Executing: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error("stdout: %s", result.stdout)
        logger.error("stderr: %s", result.stderr)
        raise subprocess.CalledProcessError(
            result.returncode, cmd, output=result.stdout, stderr=result.stderr
        )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python xkt_converter.py input.step output.xkt")
        sys.exit(1)
    convert_step_to_xkt(sys.argv[1], sys.argv[2])
