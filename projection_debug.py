#!/usr/bin/env python3
"""
Debug tool for projected area calculations
Generates visual projections for verification
"""

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Polygon
from matplotlib.collections import PolyCollection
import trimesh

def visualize_projections(mesh, output_path="projections_debug.png"):
    """
    Create visual debug output showing 3 orthogonal projections
    """
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    
    # Project mesh onto 3 orthogonal planes
    projections = {
        'YZ (X view)': (mesh.vertices[:, [1, 2]], 0),
        'XZ (Y view)': (mesh.vertices[:, [0, 2]], 1), 
        'XY (Z view)': (mesh.vertices[:, [0, 1]], 2)
    }
    
    for idx, (title, (projected_verts, axis_idx)) in enumerate(projections.items()):
        ax = axes[idx]
        
        # Create 2D triangles from projected vertices
        triangles = []
        for face in mesh.faces:
            triangle = projected_verts[face]
            triangles.append(triangle)
        
        # Plot triangles
        collection = PolyCollection(triangles, alpha=0.7, facecolors='lightblue', edgecolors='black', linewidths=0.5)
        ax.add_collection(collection)
        
        # Set axis limits
        if len(triangles) > 0:
            all_points = np.vstack(triangles)
            margin = 0.1 * (np.max(all_points, axis=0) - np.min(all_points, axis=0))
            ax.set_xlim(np.min(all_points[:, 0]) - margin[0], np.max(all_points[:, 0]) + margin[0])
            ax.set_ylim(np.min(all_points[:, 1]) - margin[1], np.max(all_points[:, 1]) + margin[1])
        
        ax.set_aspect('equal')
        ax.set_title(title)
        ax.grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()
    
    return output_path

def calculate_projected_area_simple(mesh, axis='z'):
    """
    Simple and robust projected area calculation
    Uses convex hull of projected points for cleaner result
    """
    try:
        vertices = mesh.vertices
        
        # Project vertices onto 2D plane
        if axis.lower() == 'x':
            projected = vertices[:, [1, 2]]  # YZ plane
        elif axis.lower() == 'y':
            projected = vertices[:, [0, 2]]  # XZ plane  
        elif axis.lower() == 'z':
            projected = vertices[:, [0, 1]]  # XY plane
        else:
            raise ValueError(f"Invalid axis: {axis}")
        
        # Method 1: Sum of projected triangle areas (can have overlaps)
        total_area_triangles = 0.0
        for face in mesh.faces:
            v0, v1, v2 = projected[face]
            # Triangle area using cross product
            area = 0.5 * abs((v1[0] - v0[0]) * (v2[1] - v0[1]) - (v2[0] - v0[0]) * (v1[1] - v0[1]))
            total_area_triangles += area
        
        # Method 2: Convex hull area (no overlaps, but might be smaller than reality)
        try:
            from scipy.spatial import ConvexHull
            hull = ConvexHull(projected)
            convex_hull_area = hull.volume  # In 2D, volume = area
        except:
            convex_hull_area = 0.0
        
        print(f"Axis {axis.upper()}: Triangle sum = {total_area_triangles:.2f}, Convex hull = {convex_hull_area:.2f}")
        
        # Use triangle sum but validate against hull
        if total_area_triangles > 0 and convex_hull_area > 0:
            ratio = total_area_triangles / convex_hull_area
            if ratio > 3.0:  # If more than 3x, probably has too much overlap
                print(f"Warning: High overlap detected (ratio={ratio:.1f}), using convex hull")
                return convex_hull_area
        
        return total_area_triangles
        
    except Exception as e:
        print(f"Error calculating projected area for axis {axis}: {e}")
        return 0.0

def debug_mesh_stats(mesh):
    """Print detailed mesh statistics for debugging"""
    print("=== MESH DEBUG INFO ===")
    print(f"Vertices: {len(mesh.vertices)}")
    print(f"Faces: {len(mesh.faces)}")
    print(f"Volume: {mesh.volume:.2f} mm³")
    print(f"Surface area: {mesh.area:.2f} mm²")
    print(f"Is watertight: {mesh.is_watertight}")
    print(f"Is winding consistent: {mesh.is_winding_consistent}")
    
    # Bounding box
    bounds = mesh.bounds
    dims = bounds[1] - bounds[0]
    print(f"Bounding box: {dims[0]:.2f} x {dims[1]:.2f} x {dims[2]:.2f} mm")
    print(f"Expected max projected areas: YZ={dims[1]*dims[2]:.2f}, XZ={dims[0]*dims[2]:.2f}, XY={dims[0]*dims[1]:.2f}")
    
    return dims