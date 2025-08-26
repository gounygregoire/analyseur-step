"""STEP -> STL mesh conversion utilities."""

from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.StlAPI import StlAPI_Writer


def step_to_mesh(step_path: str, mesh_path: str, *, linear_defl: float, angular_defl: float) -> None:
    """Convert a STEP file to an STL mesh using OpenCascade.

    Parameters
    ----------
    step_path: str
        Input STEP file path.
    mesh_path: str
        Output STL mesh path.
    linear_defl: float
        Linear deflection for tessellation (larger -> coarser mesh).
    angular_defl: float
        Angular deflection for tessellation in radians.
    """

    reader = STEPControl_Reader()
    status = reader.ReadFile(step_path)
    if status != IFSelect_RetDone:
        raise RuntimeError(f"Cannot read STEP file: {step_path}")

    reader.TransferRoots()
    shape = reader.OneShape()

    # Tessellation
    mesh = BRepMesh_IncrementalMesh(shape, linear_defl, False, angular_defl, True)
    mesh.Perform()

    # Export to STL
    writer = StlAPI_Writer()
    if not writer.Write(shape, mesh_path):
        raise RuntimeError(f"Failed to write mesh: {mesh_path}")

