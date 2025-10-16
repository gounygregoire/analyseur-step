# step2glb_ocp.py — OCP 7.7.x -> GLB (un mesh par face)
import sys, os
import numpy as np
import trimesh

from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.TopoDS import TopoDS
from OCP.TopLoc import TopLoc_Location
from OCP.BRep import BRep_Tool

def triangulate_shape_to_scene(shape, unit_scale=1.0, mesh_purpose=0):
    """
    Construit un trimesh.Scene avec un mesh par face STEP.
    unit_scale: 1.0 = mm (mets 1000.0 si tes STEP sont en m)
    """
    scene = trimesh.Scene()
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    idx = 0

    while exp.More():
        face = TopoDS.Face_s(exp.Current())              # 👈 downcast correct en OCP
        loc = TopLoc_Location()
        tri_h = BRep_Tool.Triangulation_s(face, loc, mesh_purpose)  # 👈 signature OCP 7.7.x
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
        trsf  = loc.Transformation()

        V = np.empty((npts, 3), dtype=float)
        for i in range(1, npts + 1):
            p = nodes.Value(i).Transformed(trsf)
            V[i-1] = (float(p.X())*unit_scale, float(p.Y())*unit_scale, float(p.Z())*unit_scale)

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

    reader = STEPControl_Reader()
    if reader.ReadFile(inp) != IFSelect_RetDone:
        print("STEP read failed", file=sys.stderr); sys.exit(1)
    if not reader.TransferRoots():
        print("STEP transfer failed", file=sys.stderr); sys.exit(1)
    shape = reader.OneShape()

    # Ajuste unit_scale si besoin (1.0 = mm, 1000.0 = m -> mm)
    scene = triangulate_shape_to_scene(shape, unit_scale=1.0, mesh_purpose=0)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    scene.export(out)
    print(f"[ok] GLB écrit: {out}")

if __name__ == "__main__":
    main()
