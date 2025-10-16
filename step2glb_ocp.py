#!/usr/bin/env python3
# STEP -> GLB : un node par face (pas de fusion) — Compatible OCP 7.7.x

import sys, os, json
import numpy as np
import trimesh

from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRep import BRep_Tool
from OCP.TopoDS import topods_Face
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.TopLoc import TopLoc_Location

def triangulate_shape_to_scene(shape, lin_tol=0.05, ang_rad=0.25, unit_scale=1.0):
    # maille OCC (obligatoire pour avoir une triangulation sur chaque face)
    try:
        BRepMesh_IncrementalMesh(shape, lin_tol * unit_scale, False, ang_rad, True)
    except Exception:
        BRepMesh_IncrementalMesh(shape, max(lin_tol * unit_scale, 0.5), False, max(ang_rad, 0.5), True)

    scene = trimesh.Scene()
exp = TopExp_Explorer(shape, TopAbs_FACE)
idx = 0
while exp.More():
    # ❗ downcast en TopoDS_Face
    face = topods_Face(exp.Current())
    loc = TopLoc_Location()

    # OCP 7.7.x : Triangulation_s(face, loc, meshPurpose=0)
    htri = BRep_Tool.Triangulation_s(face, loc, 0)
    if (not htri) or htri.IsNull():
        exp.Next(); continue

    tri = htri.GetObject()  # Poly_Triangulation
    npts = tri.NbNodes()
    ntri = tri.NbTriangles()
    if npts == 0 or ntri == 0:
        exp.Next(); continue

    nodes = tri.Nodes()
    tris  = tri.Triangles()

    V = np.zeros((npts, 3), dtype=float)
    for i in range(1, npts + 1):
        p = nodes.Value(i)
        V[i-1] = [float(p.X())*unit_scale, float(p.Y())*unit_scale, float(p.Z())*unit_scale]

    F = np.zeros((ntri, 3), dtype=np.int32)
    for i in range(1, ntri + 1):
        a, b, c = tris.Value(i).Get()
        F[i-1] = [a-1, b-1, c-1]

    tm = trimesh.Trimesh(vertices=V, faces=F, process=False)
    if not tm.is_empty:
        scene.add_geometry(tm, node_name=f"face_{idx:06d}")
        idx += 1

    exp.Next()

    if len(scene.geometry) == 0:
        raise RuntimeError("Triangulation vide (aucune face valide)")

    return scene

def main():
    if len(sys.argv) != 3:
        print("usage: python step2glb_ocp.py input.step output.glb", file=sys.stderr)
        sys.exit(2)

    in_step = sys.argv[1]
    out_glb = sys.argv[2]
    os.makedirs(os.path.dirname(out_glb), exist_ok=True)

    # 1) Lire STEP
    reader = STEPControl_Reader()
    if reader.ReadFile(in_step) != IFSelect_RetDone:
        raise RuntimeError("Lecture STEP échouée")
    if not reader.TransferRoots():
        raise RuntimeError("TransferRoots échoué")
    shape = reader.OneShape()

    # 2) Trianguler -> Scene trimesh (un node par face)
    scene = triangulate_shape_to_scene(shape, lin_tol=0.05, ang_rad=0.25, unit_scale=1.0)

    # 3) Export GLB (structure multiparts, pas de merge)
    glb_bytes = scene.export(file_type="glb")
    with open(out_glb, "wb") as f:
        f.write(glb_bytes)

    print(json.dumps({"ok": True, "glb": out_glb, "nodes": len(scene.graph.nodes)}))

if __name__ == "__main__":
    main()
