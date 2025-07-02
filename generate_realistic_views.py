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
    Create a realistic 3D view from STL file with professional shading
    Returns base64 encoded PNG
    """
    if not trimesh or not Image:
        return ""
        
    try:
        # Load the STL file with process=False to avoid expensive operations
        mesh = trimesh.load_mesh(stl_path, process=False)
        
        # Center the mesh manually to avoid cache operations
        center = np.mean(mesh.vertices, axis=0)
        mesh.vertices -= center
        
        # Get bounds for scaling
        bounds = mesh.bounds
        dimensions = bounds[1] - bounds[0]
        max_dim = np.max(dimensions)
        
        # Apply isometric rotation for better 3D effect
        iso_angle = np.pi / 6  # 30 degrees
        
        # Create rotation matrix based on viewing axis with isometric perspective
        if axis.lower() == 'x':
            # View from X axis with isometric angle
            rotation1 = trimesh.transformations.rotation_matrix(np.pi/2, [0, 1, 0])
            rotation2 = trimesh.transformations.rotation_matrix(iso_angle, [0, 0, 1])
            rotation3 = trimesh.transformations.rotation_matrix(-iso_angle/2, [1, 0, 0])
            rotation = rotation3.dot(rotation2.dot(rotation1))
        elif axis.lower() == 'y':
            # View from Y axis with isometric angle
            rotation1 = trimesh.transformations.rotation_matrix(-np.pi/2, [1, 0, 0])
            rotation2 = trimesh.transformations.rotation_matrix(iso_angle, [0, 0, 1])
            rotation3 = trimesh.transformations.rotation_matrix(iso_angle/2, [0, 1, 0])
            rotation = rotation3.dot(rotation2.dot(rotation1))
        else:  # z
            # View from Z axis with isometric angle
            rotation1 = trimesh.transformations.rotation_matrix(iso_angle, [1, 0, 0])
            rotation2 = trimesh.transformations.rotation_matrix(-iso_angle, [0, 1, 0])
            rotation = rotation2.dot(rotation1)
        
        # Apply rotation
        mesh.apply_transform(rotation)
        
        # Reduce mesh complexity to avoid memory issues
        if len(mesh.faces) > 5000:
            # Simplify the mesh for rendering
            import gc
            gc.collect()
            step = max(1, len(mesh.faces) // 5000)
            faces_to_use = mesh.faces[::step]
            mesh = trimesh.Trimesh(vertices=mesh.vertices, faces=faces_to_use, process=False)
        
        # Create smaller image to reduce memory usage
        img_size = 600
        render_size = img_size  # No anti-aliasing to save memory
        img = Image.new('RGB', (render_size, render_size), color='#ffffff')
        draw = ImageDraw.Draw(img)
        
        # Project vertices to 2D
        vertices_2d = mesh.vertices[:, :2]  # Take X,Y coordinates
        scale = render_size * 0.6 / max_dim if max_dim > 0 else 1
        vertices_2d = vertices_2d * scale + render_size/2
        
        # Sort faces by depth (Z coordinate) for proper rendering
        face_centers = mesh.vertices[mesh.faces].mean(axis=1)
        face_depths = face_centers[:, 2]
        sorted_indices = np.argsort(-face_depths)  # Sort back to front
        
        # Multiple light sources for better shading
        light1 = np.array([0.5, 0.5, 1.0])
        light1 = light1 / np.linalg.norm(light1)
        light2 = np.array([-0.3, 0.3, 0.8])
        light2 = light2 / np.linalg.norm(light2)
        ambient = 0.4
        
        # Draw faces with professional shading
        max_faces = min(len(sorted_indices), 10000)  # Limit for performance
        for i, idx in enumerate(sorted_indices[:max_faces]):
            face = mesh.faces[idx]
            face_vertices = vertices_2d[face]
            
            # Calculate face normal manually to avoid cache issues
            v0 = mesh.vertices[face[0]]
            v1 = mesh.vertices[face[1]]
            v2 = mesh.vertices[face[2]]
            face_normal = np.cross(v1 - v0, v2 - v0)
            norm = np.linalg.norm(face_normal)
            if norm > 0:
                face_normal = face_normal / norm
            else:
                face_normal = np.array([0, 0, 1])
            
            # Multi-light shading
            diffuse1 = max(0, np.dot(face_normal, light1))
            diffuse2 = max(0, np.dot(face_normal, light2)) * 0.5
            brightness = min(1.0, ambient + diffuse1 + diffuse2)
            
            # Create gradient shading
            base_gray = 40
            gray_range = 180
            gray_value = int(base_gray + brightness * gray_range)
            
            # Add slight color variation for more realistic look
            r = gray_value
            g = gray_value
            b = min(255, gray_value + 5)  # Slight blue tint
            
            face_color = f'#{r:02x}{g:02x}{b:02x}'
            
            # Darker edges for definition
            edge_factor = 0.7
            edge_r = int(r * edge_factor)
            edge_g = int(g * edge_factor)
            edge_b = int(b * edge_factor)
            edge_color = f'#{edge_r:02x}{edge_g:02x}{edge_b:02x}'
            
            # Draw the face
            points = [(v[0], v[1]) for v in face_vertices]
            if len(points) >= 3:
                draw.polygon(points, fill=face_color, outline=edge_color, width=1)
        
        # Downscale for anti-aliasing
        img = img.resize((img_size, img_size), Image.Resampling.LANCZOS)
        
        # Add soft drop shadow
        shadow = Image.new('RGBA', (img_size, img_size), (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow)
        
        # Create shadow ellipse
        shadow_offset = 20
        shadow_size = int(max_dim * scale / 2 * 0.8)
        shadow_center = (img_size//2 + shadow_offset, img_size//2 + shadow_offset)
        shadow_bbox = [
            shadow_center[0] - shadow_size,
            shadow_center[1] - shadow_size//3,
            shadow_center[0] + shadow_size,
            shadow_center[1] + shadow_size//3
        ]
        shadow_draw.ellipse(shadow_bbox, fill=(0, 0, 0, 40))
        
        # Blur the shadow
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=15))
        
        # Create final image with white background
        final_img = Image.new('RGB', (img_size, img_size), color='#ffffff')
        final_img.paste(shadow, (0, 0), shadow)
        final_img.paste(img, (0, 0))
        
        # Add title with better positioning
        draw = ImageDraw.Draw(final_img)
        title = f"Vue selon {axis.upper()}"
        draw.text((img_size//2, 25), title, fill='#000000', anchor='mt')
        
        # Add dimensions at the bottom
        dim_text = f"{dimensions[0]:.1f} × {dimensions[1]:.1f} × {dimensions[2]:.1f} mm"
        draw.text((img_size//2, img_size-25), dim_text, fill='#666666', anchor='mt')
        
        # Convert to base64
        buffer = io.BytesIO()
        final_img.save(buffer, format='PNG', optimize=True, quality=95)
        buffer.seek(0)
        return base64.b64encode(buffer.getvalue()).decode()
        
    except Exception as e:
        print(f"Error creating realistic view: {e}")
        import traceback
        traceback.print_exc()
        return ""


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