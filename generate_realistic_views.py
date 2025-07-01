"""
Generate realistic 3D views from STL files using Trimesh
Creates professional-looking renders with proper shading
"""

import os
import io
import base64
from typing import Dict, Tuple
import numpy as np

try:
    import trimesh
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    trimesh = None
    Image = None


def create_realistic_view_from_stl(stl_path: str, axis: str = 'z') -> str:
    """
    Create a realistic 3D view from STL file with shading
    Returns base64 encoded PNG
    """
    if not trimesh or not Image:
        return None
        
    try:
        # Load the STL file
        mesh = trimesh.load_mesh(stl_path)
        if not mesh.is_valid:
            mesh.fix_normals()
        
        # Center the mesh
        mesh.vertices -= mesh.center_mass
        
        # Get bounds for scaling
        bounds = mesh.bounds
        dimensions = bounds[1] - bounds[0]
        max_dim = np.max(dimensions)
        
        # Create rotation matrix based on viewing axis
        if axis.lower() == 'x':
            # View from X axis (YZ plane)
            rotation = trimesh.transformations.rotation_matrix(np.pi/2, [0, 1, 0])
        elif axis.lower() == 'y':
            # View from Y axis (XZ plane)
            rotation = trimesh.transformations.rotation_matrix(-np.pi/2, [1, 0, 0])
        else:  # z
            # View from Z axis (XY plane)
            rotation = np.eye(4)
        
        # Apply rotation
        mesh.apply_transform(rotation)
        
        # Create the rendered image
        img_size = 400
        img = Image.new('RGB', (img_size, img_size), color='#f5f5f5')
        draw = ImageDraw.Draw(img)
        
        # Project vertices to 2D
        vertices_2d = mesh.vertices[:, :2]  # Take X,Y coordinates
        scale = img_size * 0.7 / max_dim if max_dim > 0 else 1
        vertices_2d = vertices_2d * scale + img_size/2
        
        # Sort faces by depth (Z coordinate) for proper rendering
        face_centers = mesh.vertices[mesh.faces].mean(axis=1)
        face_depths = face_centers[:, 2]
        sorted_indices = np.argsort(-face_depths)  # Sort back to front
        
        # Draw faces with shading based on normal direction
        light_direction = np.array([0.3, 0.3, 1.0])
        light_direction = light_direction / np.linalg.norm(light_direction)
        
        for idx in sorted_indices[:5000]:  # Limit faces for performance
            face = mesh.faces[idx]
            face_vertices = vertices_2d[face]
            
            # Calculate shading based on face normal
            face_normal = mesh.face_normals[idx]
            # Simple dot product for Lambertian shading
            brightness = max(0.3, min(1.0, np.dot(face_normal, light_direction)))
            
            # Create gradient effect
            gray_value = int(120 + brightness * 100)
            face_color = f'#{gray_value:02x}{gray_value:02x}{gray_value:02x}'
            edge_color = f'#{max(0, gray_value-40):02x}{max(0, gray_value-40):02x}{max(0, gray_value-40):02x}'
            
            # Draw the face
            points = [(v[0], v[1]) for v in face_vertices]
            if len(points) >= 3:
                draw.polygon(points, fill=face_color, outline=edge_color)
        
        # Add subtle drop shadow
        shadow = Image.new('RGBA', (img_size, img_size), (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow)
        
        # Create shadow shape (slightly offset)
        for idx in sorted_indices[:1000]:
            face = mesh.faces[idx]
            face_vertices = vertices_2d[face]
            points = [(v[0]+5, v[1]+5) for v in face_vertices]
            if len(points) >= 3:
                shadow_draw.polygon(points, fill=(0, 0, 0, 30))
        
        # Blur the shadow
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=3))
        
        # Composite shadow under the main image
        final_img = Image.new('RGB', (img_size, img_size), color='#f5f5f5')
        final_img.paste(shadow, (0, 0), shadow)
        final_img.paste(img, (0, 0))
        
        # Add title
        draw = ImageDraw.Draw(final_img)
        title = f"Vue selon {axis.upper()}"
        draw.text((img_size//2, 15), title, fill='#333333', anchor='mt')
        
        # Add dimensions
        dim_text = f"{dimensions[0]:.1f} × {dimensions[1]:.1f} × {dimensions[2]:.1f} mm"
        draw.text((img_size//2, img_size-15), dim_text, fill='#666666', anchor='mt')
        
        # Convert to base64
        buffer = io.BytesIO()
        final_img.save(buffer, format='PNG', optimize=True)
        buffer.seek(0)
        return base64.b64encode(buffer.getvalue()).decode()
        
    except Exception as e:
        print(f"Error creating realistic view: {e}")
        return None


def create_all_views_from_stl(stl_path: str) -> Dict[str, str]:
    """
    Create realistic views for all three axes
    """
    views = {}
    
    for axis in ['x', 'y', 'z']:
        view = create_realistic_view_from_stl(stl_path, axis)
        if view:
            views[axis] = view
            
    return views