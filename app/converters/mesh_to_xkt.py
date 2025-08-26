"""Mesh -> XKT conversion using xeokit-convert."""

import os
import subprocess


def mesh_to_xkt(mesh_path: str, xkt_path: str, *, timeout: int = 600) -> None:
    """Convert a mesh (STL) to XKT using xeokit-convert."""

    exe = os.getenv("XEOKIT_CONVERT", "npx").strip() or "npx"
    cmd = [exe]
    if exe == "npx":
        cmd += ["@xeokit/xeokit-convert"]
    cmd += ["-s", mesh_path, "-o", xkt_path]

    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)

