#!/usr/bin/env python3
"""
Test script to verify projected area calculation with Trimesh
"""

import trimesh
import numpy as np

# Create a simple cube mesh for testing
box = trimesh.creation.box(extents=[100, 50, 20])

# Calculate projected areas
projected_area_x = box.area_faces[(box.face_normals[:, 0] > 0)].sum()
projected_area_y = box.area_faces[(box.face_normals[:, 1] > 0)].sum()
projected_area_z = box.area_faces[(box.face_normals[:, 2] > 0)].sum()

print("Test cube dimensions: 100mm x 50mm x 20mm")
print(f"Projected area X (YZ plane): {projected_area_x:.2f} mm² (expected: 1000 mm²)")
print(f"Projected area Y (XZ plane): {projected_area_y:.2f} mm² (expected: 2000 mm²)")
print(f"Projected area Z (XY plane): {projected_area_z:.2f} mm² (expected: 5000 mm²)")

# Verify the calculations
print("\nVerification:")
print(f"Face normals shape: {box.face_normals.shape}")
print(f"Face areas shape: {box.area_faces.shape}")
print(f"Number of faces pointing in +X: {np.sum(box.face_normals[:, 0] > 0)}")
print(f"Number of faces pointing in +Y: {np.sum(box.face_normals[:, 1] > 0)}")
print(f"Number of faces pointing in +Z: {np.sum(box.face_normals[:, 2] > 0)}")