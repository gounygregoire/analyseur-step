# step2glb_ocp.py  — OCP 7.7.x -> GLB (un mesh par face)
import sys, os
import numpy as np
import trimesh

from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.TopoDS import topods_Face
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Pnt
from OCP.BRep import BRep_Tool

def triangulate_shape_to_scene(shape, unit_scale=1.0, mesh_purpose=0):
    """
    Construit un trimesh.Scene avec un mesh par face STEP.
    unit_scale: facteur d’échelle (mm=1.0, m=1000, etc.)
    """
    scene = trimesh.Scene()
    exp = TopExp_Explorer(shape, TopAbs_FACE)

    idx = 0
    while exp.More():
        face = topods_Face(exp.Current())           # 👈 downcast
        loc = TopLoc_Location()
        tri_h = BRep_Tool.Triangulation_s(face, loc, mesh_purpose)  # 👈 OCP 7.7.x signature
        if tri_h is None or tri_h.IsNull():
            exp.Next()
            continue

        tri = tri_h.GetObject()
        npts = tri.NbNodes()
        ntri = tri.NbTriangles()
        if npts == 0 or ntri == 0:
            exp.Next()
            continue

        nodes = tri.Nodes()
        tris  = tri.Triangles()

        # Appliquer la transformation de la location (si présente)
        trsf = loc.Transformation()

        V = np.empty((npts, 3), dtype=float)
        for i in range(1, npts + 1):
            p = nodes.Value(i)
            # transformer le point par la location
            P = p.Transformed(trsf) if loc else p
            V[i-1, 0] = float(P.X()) * unit_scale
            V[i-1, 1] = float(P.Y()) * unit_scale
            V[i-1, 2] = float(P.Z()) * unit_scale

        F = np.empty((ntri, 3), dtype=np.int32)
        for i in range(1, ntri + 1):
            a, b, c = tris.Value(i).Get()
            F[i-1] = (a-1, b-1, c-1)

        mesh = trimesh.Trimesh(vertices=V, faces=F, process=False)
        if not mesh.is_empty:
            scene.add_geometry(mesh, node_name=f"face_{idx:06d}")
            idx += 1

        exp.Next()

    return scene

def main():
    if len(sys.argv) < 3:
        print("Usage: python step2glb_ocp.py <in.step> <out.glb>", file=sys.stderr)
        sys.exit(2)

    inp = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2])

    # 1) Lire le STEP
    reader = STEPControl_Reader()
    if reader.ReadFile(inp) != IFSelect_RetDone:
        print("STEP read failed", file=sys.stderr); sys.exit(1)
    if not reader.TransferRoots():
        print("STEP transfer failed", file=sys.stderr); sys.exit(1)
    shape = reader.OneShape()

    # 2) Trianguler toutes les faces -> Scene
    # unit_scale=1.0 pour mm (adapter si besoin)
    scene = triangulate_shape_to_scene(shape, unit_scale=1.0, mesh_purpose=0)

    # 3) Export GLB
    os.makedirs(os.path.dirname(out), exist_ok=True)
    scene.export(out)   # trimesh exporte GLB/GLTF selon extension
    print(f"[ok] GLB écrit: {out}")

if __name__ == "__main__":
    main()
