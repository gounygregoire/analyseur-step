# step2glb_ocp.py — STEP -> GLB (un mesh par face)
import sys, numpy as np, trimesh
from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.BRep import BRep_Tool
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Pnt

# cast Face compatible OCP
try:
    from OCP.TopoDS import topods_Face
    def as_face(s): return topods_Face(s)
except Exception:
    from OCP.TopoDS import TopoDS
    def as_face(s): return TopoDS.Face_s(s)

def triangulate_shape_faces(shape, lin_defl=0.05, ang_rad=0.25, unit_scale=1.0):
    # force tessellation
    BRepMesh_IncrementalMesh(shape, float(lin_defl), False, float(ang_rad), True)

    scene = trimesh.Scene()
    exp = TopExp_Explorer(shape, TopAbs_FACE)

    any_geom = False
    face_idx = 0

    while exp.More():
        face = as_face(exp.Current())
        loc  = TopLoc_Location()
        tri  = BRep_Tool.Triangulation_s(face, loc)  # OCP 7.7.x

        if tri is None:
            exp.Next()
            continue

        # transformation locale (si présente)
        trsf = loc.Transformation()

        nb_nodes = int(tri.NbNodes())
        nb_tris  = int(tri.NbTriangles())
        if nb_nodes == 0 or nb_tris == 0:
            exp.Next()
            continue

        # récupère les points
        V = np.zeros((nb_nodes, 3), dtype=float)
        for i in range(1, nb_nodes + 1):  # 1-based
            p = tri.Node(i)               # <-- PAS Nodes()
            q = gp_Pnt(p.X(), p.Y(), p.Z())
            q.Transform(trsf)             # applique la loc
            V[i-1, 0] = q.X() * unit_scale
            V[i-1, 1] = q.Y() * unit_scale
            V[i-1, 2] = q.Z() * unit_scale

        # récupère les triangles
        F = np.zeros((nb_tris, 3), dtype=np.int32)
        for i in range(1, nb_tris + 1):   # 1-based
            t = tri.Triangle(i)           # <-- PAS Triangles()
            a, b, c = t.Get()
            F[i-1] = [a-1, b-1, c-1]

        # construit un mesh par face (pour éviter la fusion)
        mesh = trimesh.Trimesh(vertices=V, faces=F, process=True)
        if not mesh.is_empty:
            face_idx += 1
            scene.add_geometry(mesh, node_name=f"face_{face_idx}")
            any_geom = True

        exp.Next()

    return scene, any_geom

def main():
    if len(sys.argv) < 3:
        print("Usage: python step2glb_ocp.py <in.step> <out.glb>")
        sys.exit(2)

    src, dst = sys.argv[1], sys.argv[2]

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
