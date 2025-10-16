# step2glb_ocp.py — STEP -> GLB (1 mesh par solide) avec OCP (CadQuery OCP) + trimesh
import sys, os, numpy as np, trimesh
from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID, TopAbs_FACE
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopLoc import TopLoc_Location

def triangulate(shape, lin_tol=0.05, ang_rad=0.25):
    BRepMesh_IncrementalMesh(shape, float(lin_tol), False, float(ang_rad), True)

def solid_to_trimesh(solid):
    verts, faces = [], []
    v_off = 0
    expF = TopExp_Explorer(solid, TopAbs_FACE)
    while expF.More():
        face = expF.Current()
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation(face, loc)
        if tri:
            nodes = tri.Nodes()
            tris  = tri.Triangles()
            npts  = nodes.Size()
            ntri  = tris.Size()
            # sommets
            for i in range(1, npts + 1):
                p = nodes.Value(i).Transformed(loc.Transformation())
                verts.append([float(p.X()), float(p.Y()), float(p.Z())])
            # triangles
            for i in range(1, ntri + 1):
                a,b,c = tris.Value(i).Get()
                faces.append([v_off + a - 1, v_off + b - 1, v_off + c - 1])
            v_off += npts
        expF.Next()
    if not verts or not faces:
        return None
    m = trimesh.Trimesh(vertices=np.asarray(verts, float), faces=np.asarray(faces, int), process=True)
    try:
        if not m.is_watertight:
            m = m.fill_holes()
    except Exception:
        pass
    return m if (m and not m.is_empty) else None

def main(inp_step, out_glb, lin_tol=0.05, ang_rad=0.25):
    r = STEPControl_Reader()
    if r.ReadFile(inp_step) != IFSelect_RetDone:
        print("STEP read failed", file=sys.stderr); sys.exit(2)
    if not r.TransferRoots():
        print("STEP transfer failed", file=sys.stderr); sys.exit(2)
    shape = r.OneShape()
    triangulate(shape, lin_tol, ang_rad)

    scene = trimesh.Scene()
    count = 0
    expS = TopExp_Explorer(shape, TopAbs_SOLID)
    idx = 0
    while expS.More():
        s = expS.Current()
        m = solid_to_trimesh(s)
        if m:
            scene.add_geometry(m, node_name=f"solid_{idx}")
            count += 1
        idx += 1
        expS.Next()
    if count == 0:
        print("No solids triangulated", file=sys.stderr); sys.exit(3)
    scene.export(out_glb, file_type="glb")
    print(f"[step2glb] OK -> {out_glb} (solids={count})")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python step2glb_ocp.py in.step out.glb [lin_tol_mm] [ang_rad]", file=sys.stderr)
        sys.exit(1)
    inp = sys.argv[1]
    out = sys.argv[2]
    lin = float(sys.argv[3]) if len(sys.argv) > 3 else 0.05
    ang = float(sys.argv[4]) if len(sys.argv) > 4 else 0.25
    main(inp, out, lin, ang)
