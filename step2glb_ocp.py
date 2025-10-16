# step2glb_ocp.py — OCC 7.7.x (cadquery-ocp) → GLB par faces
import sys, math
import numpy as np
import trimesh

from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.BRep import BRep_Tool
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Pnt

def triangulate_shape_faces(shape, lin_defl=0.05, ang_rad=0.25, unit_scale=1.0):
    # Tessellation globale (important, sinon Triangulation_s retourne None)
    BRepMesh_IncrementalMesh(shape, float(lin_defl), False, float(ang_rad), True)

    scene = trimesh.Scene()
    exp = TopExp_Explorer(shape, TopAbs_FACE)

    face_idx = 0
    any_geom = False

    while exp.More():
        face = exp.Current()
        loc  = TopLoc_Location()

        # OCC 7.7.x: Triangulation_s(face, loc, meshPurpose=0)
        tri = BRep_Tool.Triangulation_s(face, loc, 0)
        if tri is None:
            exp.Next()
            continue

        nodes = tri.Nodes()
        tris  = tri.Triangles()
        npts  = nodes.Size()
        ntri  = tris.Size()
        if npts == 0 or ntri == 0:
            exp.Next()
            continue

        # Transformation locale -> monde
        trsf = loc.Transformation()

        verts = np.zeros((npts, 3), dtype=np.float64)
        for i in range(1, npts + 1):
            p = nodes.Value(i)           # gp_Pnt
            p = gp_Pnt(p.X(), p.Y(), p.Z())
            p.Transform(trsf)
            verts[i-1, 0] = p.X() * unit_scale
            verts[i-1, 1] = p.Y() * unit_scale
            verts[i-1, 2] = p.Z() * unit_scale

        faces = np.zeros((ntri, 3), dtype=np.int64)
        for i in range(1, ntri + 1):
            t = tris.Value(i)
            a, b, c = t.Get()           # 1-based
            faces[i-1, :] = (a-1, b-1, c-1)

        # Nettoyage & sécurisation trimesh
        mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
        if mesh.is_empty or len(mesh.faces) == 0:
            exp.Next()
            continue

        # Ajoute une géométrie par face (idéal pour la heatmap/entités)
        scene.add_geometry(mesh, node_name=f"face_{face_idx}")
        any_geom = True
        face_idx += 1
        exp.Next()

    return scene, any_geom

def main():
    if len(sys.argv) < 3:
        print("Usage: python step2glb_ocp.py <in.step> <out.glb>")
        sys.exit(2)

    src = sys.argv[1]
    dst = sys.argv[2]

    r = STEPControl_Reader()
    st = r.ReadFile(src)
    if st != IFSelect_RetDone:
        print("STEP read failed")
        sys.exit(2)
    r.TransferRoots()
    shape = r.OneShape()

    scene, ok = triangulate_shape_faces(shape, lin_defl=0.05, ang_rad=0.25, unit_scale=1.0)
    if not ok:
        print("No triangulated faces -> empty scene")
        sys.exit(3)

    scene.export(dst)
    print("GLB written:", dst)

if __name__ == "__main__":
    main()
