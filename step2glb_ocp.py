import sys, numpy as np, trimesh
from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.BRep import BRep_Tool
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Pnt

# Cast TopoDS_Shape -> TopoDS_Face (compat bindings)
try:
    from OCP.TopoDS import topods_Face
    def as_face(s): return topods_Face(s)
except Exception:
    from OCP.TopoDS import TopoDS
    def as_face(s): return TopoDS.Face_s(s)

def triangulate_shape_faces(shape, lin_defl=0.05, ang_rad=0.25, unit_scale=1.0):
    # force tessellation (sinon Triangulation_s peut renvoyer None)
    BRepMesh_IncrementalMesh(shape, float(lin_defl), False, float(ang_rad), True)

    scene = trimesh.Scene()
    exp = TopExp_Explorer(shape, TopAbs_FACE)

    idx = 0
    any_geom = False
    while exp.More():
        face = as_face(exp.Current())
        loc  = TopLoc_Location()
        tri  = BRep_Tool.Triangulation_s(face, loc, 0)
        if tri is None:
            exp.Next(); continue

        nodes = tri.Nodes()
        tris  = tri.Triangles()
        npts  = nodes.Size()
        ntri  = tris.Size()
        if npts == 0 or ntri == 0:
            exp.Next(); continue

        trsf = loc.Transformation()

        V = np.zeros((npts, 3), dtype=np.float64)
        for i in range(1, npts + 1):
            p = nodes.Value(i)
            p = gp_Pnt(p.X(), p.Y(), p.Z())
            p.Transform(trsf)
            V[i-1] = [p.X() * unit_scale, p.Y() * unit_scale, p.Z() * unit_scale]

        F = np.zeros((ntri, 3), dtype=np.int64)
        for i in range(1, ntri + 1):
            t = tris.Value(i)
            a, b, c = t.Get()
            F[i-1] = [a-1, b-1, c-1]

        mesh = trimesh.Trimesh(vertices=V, faces=F, process=True)
        if mesh.is_empty or mesh.faces.shape[0] == 0:
            exp.Next(); continue

        scene.add_geometry(mesh, node_name=f"face_{idx}")
        idx += 1
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
PY
