"""
Generate 3D views from STEP file for PDF reports
Uses CadQuery to create orthographic projections as images
"""

import os
import base64
from io import BytesIO
from typing import Dict, Tuple

try:
    import cadquery as cq
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.Graphic3d import Graphic3d_Camera
    from OCP.V3d import V3d_TypeOfOrientation
except ImportError:
    cq = None

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None


def create_orthographic_views(step_file_path: str) -> Dict[str, str]:
    """
    Generate orthographic views (X, Y, Z) from a STEP file
    Returns base64 encoded PNG images
    """
    views = {}
    
    if not cq:
        print("CadQuery not available for 3D view generation")
        return views
        
    try:
        # Load the STEP file
        workplane = cq.importers.importStep(step_file_path)
        
        # Get bounding box for proper scaling
        bbox = workplane.val().BoundingBox()
        width = bbox.xlen
        height = bbox.ylen  
        depth = bbox.zlen
        center = bbox.center
        
        # Define view configurations
        view_configs = {
            'x': {
                'name': 'Vue selon X',
                'camera_dir': (1, 0, 0),
                'camera_up': (0, 0, 1),
                'dims': f'Y: {height:.1f}mm × Z: {depth:.1f}mm'
            },
            'y': {
                'name': 'Vue selon Y', 
                'camera_dir': (0, 1, 0),
                'camera_up': (0, 0, 1),
                'dims': f'X: {width:.1f}mm × Z: {depth:.1f}mm'
            },
            'z': {
                'name': 'Vue selon Z',
                'camera_dir': (0, 0, 1), 
                'camera_up': (0, 1, 0),
                'dims': f'X: {width:.1f}mm × Y: {height:.1f}mm'
            }
        }
        
        # Generate view for each axis
        for axis, config in view_configs.items():
            try:
                # Create image representation
                img = create_model_image(workplane, config, (width, height, depth))
                if img:
                    views[axis] = img
                else:
                    # Fallback to wireframe representation
                    views[axis] = create_wireframe_view(config, (width, height, depth))
                    
            except Exception as e:
                print(f"Error generating {axis} view: {e}")
                views[axis] = create_wireframe_view(config, (width, height, depth))
                
    except Exception as e:
        print(f"Error loading STEP file for views: {e}")
        
    return views


def create_model_image(workplane, config: Dict, dimensions: Tuple[float, float, float]) -> str:
    """
    Create a rendered image of the model from a specific viewpoint
    """
    if not Image:
        return None
        
    try:
        # Create high-res image for better quality
        img_size = (800, 800)
        img = Image.new('RGB', img_size, color='#f8f9fa')
        
        # Create layers for different render passes
        shadow_layer = Image.new('RGBA', img_size, (0, 0, 0, 0))
        face_layer = Image.new('RGBA', img_size, (0, 0, 0, 0))
        edge_layer = Image.new('RGBA', img_size, (0, 0, 0, 0))
        
        shadow_draw = ImageDraw.Draw(shadow_layer)
        face_draw = ImageDraw.Draw(face_layer)
        edge_draw = ImageDraw.Draw(edge_layer)
        
        width, height, depth = dimensions
        
        # Calculate scale with padding
        padding = 0.15  # 15% padding
        max_dim = max(width, height, depth)
        scale = (img_size[0] * (1 - 2*padding)) / max_dim if max_dim > 0 else 1
        cx, cy = img_size[0] // 2, img_size[1] // 2
        
        # Get faces for shaded rendering
        try:
            faces = workplane.faces()
            
            # Sort faces by area (draw larger faces first)
            face_data = []
            for face in faces.vals():
                try:
                    center = face.Center()
                    normal = face.normalAt(center)
                    area = face.Area()
                    
                    # Get vertices of face for polygon drawing
                    vertices = []
                    for edge in face.Edges():
                        vertices.extend([edge.startPoint(), edge.endPoint()])
                    
                    # Remove duplicates
                    unique_verts = []
                    for v in vertices:
                        if not any(abs(v.x - u.x) < 0.001 and abs(v.y - u.y) < 0.001 and abs(v.z - u.z) < 0.001 for u in unique_verts):
                            unique_verts.append(v)
                    
                    face_data.append({
                        'center': center,
                        'normal': normal,
                        'area': area,
                        'vertices': unique_verts
                    })
                except:
                    continue
            
            # Sort by distance from camera (painter's algorithm)
            camera_dir = config['camera_dir']
            face_data.sort(key=lambda f: sum(f['center'].toTuple()[i] * camera_dir[i] for i in range(3)), reverse=True)
            
            # Draw faces with shading
            for face_info in face_data:
                # Calculate shading based on normal and light direction
                light_dir = (0.5, 0.5, 0.7)  # Light from top-right
                dot_product = sum(face_info['normal'].toTuple()[i] * light_dir[i] for i in range(3))
                brightness = max(0.3, min(1.0, 0.6 + 0.4 * dot_product))
                
                # Project vertices based on view
                projected_verts = []
                for vert in face_info['vertices']:
                    if config['name'] == 'Vue selon X':
                        px = cx + vert.y * scale
                        py = cy - vert.z * scale
                    elif config['name'] == 'Vue selon Y':
                        px = cx + vert.x * scale
                        py = cy - vert.z * scale
                    else:  # Vue selon Z
                        px = cx + vert.x * scale
                        py = cy - vert.y * scale
                    
                    projected_verts.append((int(px), int(py)))
                
                # Draw filled polygon with shading
                if len(projected_verts) >= 3:
                    gray_val = int(255 * brightness)
                    color = (gray_val, gray_val, gray_val, 255)
                    try:
                        face_draw.polygon(projected_verts, fill=color, outline=None)
                    except:
                        # If polygon fails, draw as lines
                        pass
                    
                    # Add shadow
                    shadow_offset = 5
                    shadow_verts = [(x + shadow_offset, y + shadow_offset) for x, y in projected_verts]
                    try:
                        shadow_draw.polygon(shadow_verts, fill=(0, 0, 0, 30))
                    except:
                        pass
        except Exception as e:
            print(f"Face rendering error: {e}")
        
        # Get edges for clean outlines
        edges = workplane.edges()
        
        # Collect all edge segments
        edge_segments = []
        for edge in edges.vals():
            try:
                # Sample edge more densely for smooth curves
                num_samples = 50
                points = []
                for i in range(num_samples + 1):
                    param = i / num_samples
                    point = edge.positionAt(param)
                    
                    # Project point based on view
                    if config['name'] == 'Vue selon X':
                        px = cx + point.y * scale
                        py = cy - point.z * scale
                    elif config['name'] == 'Vue selon Y':
                        px = cx + point.x * scale
                        py = cy - point.z * scale
                    else:  # Vue selon Z
                        px = cx + point.x * scale
                        py = cy - point.y * scale
                        
                    points.append((int(px), int(py)))
                
                edge_segments.append(points)
                    
            except Exception:
                continue
        
        # Draw edges with anti-aliasing
        for points in edge_segments:
            if len(points) > 1:
                for i in range(len(points) - 1):
                    edge_draw.line([points[i], points[i+1]], fill=(40, 40, 40, 255), width=3)
        
        # Apply Gaussian blur to shadow layer
        from PIL import ImageFilter
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=3))
        
        # Composite layers
        img.paste(shadow_layer, (0, 0), shadow_layer)
        img.paste(face_layer, (0, 0), face_layer)
        img.paste(edge_layer, (0, 0), edge_layer)
        
        # Add title and dimensions
        final_draw = ImageDraw.Draw(img)
        try:
            # Try to use a default font
            font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 40)
            font_dims = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 28)
        except:
            # Use default font if TrueType not available
            font_title = ImageFont.load_default()
            font_dims = ImageFont.load_default()
            
        # Draw title
        final_draw.text((cx, 60), config['name'], font=font_title, anchor='mm', fill='#333')
        
        # Draw dimensions
        final_draw.text((cx, img_size[1] - 60), config['dims'], font=font_dims, anchor='mm', fill='#666')
        
        # Resize to final size (400x400) with antialiasing
        img = img.resize((400, 400), Image.Resampling.LANCZOS)
        
        # Convert to base64
        buffer = BytesIO()
        img.save(buffer, format='PNG', optimize=True)
        img_base64 = base64.b64encode(buffer.getvalue()).decode()
        
        return img_base64
        
    except Exception as e:
        print(f"Error creating model image: {e}")
        return None


def create_wireframe_view(config: Dict, dimensions: Tuple[float, float, float]) -> str:
    """
    Create a simple wireframe representation as fallback
    """
    if not Image:
        return ""
        
    try:
        # Create image
        img_size = (400, 400)
        img = Image.new('RGB', img_size, color='white')
        draw = ImageDraw.Draw(img)
        
        # Draw border
        draw.rectangle([0, 0, img_size[0]-1, img_size[1]-1], outline='#ddd', width=1)
        
        width, height, depth = dimensions
        
        # Draw a simple box representation
        cx, cy = img_size[0] // 2, img_size[1] // 2
        box_width = min(200, width * 2)
        box_height = min(200, height * 2)
        box_depth = min(100, depth)
        
        # Front face
        x1, y1 = cx - box_width//2, cy - box_height//2
        x2, y2 = cx + box_width//2, cy + box_height//2
        draw.rectangle([x1, y1, x2, y2], outline='#0066cc', width=2)
        
        # 3D effect - back face
        offset = box_depth // 3
        draw.rectangle([x1+offset, y1-offset, x2+offset, y2-offset], outline='#0066cc', width=1)
        
        # Connect corners
        draw.line([(x1, y1), (x1+offset, y1-offset)], fill='#0066cc', width=1)
        draw.line([(x2, y1), (x2+offset, y1-offset)], fill='#0066cc', width=1)
        draw.line([(x2, y2), (x2+offset, y2-offset)], fill='#0066cc', width=1)
        draw.line([(x1, y2), (x1+offset, y2-offset)], fill='#0066cc', width=1)
        
        # Add labels
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
        except:
            font = ImageFont.load_default()
            
        draw.text((cx, 30), config['name'], font=font, anchor='mm', fill='black')
        draw.text((cx, img_size[1] - 30), f"{width:.1f} × {height:.1f} × {depth:.1f} mm", 
                 font=font, anchor='mm', fill='#666')
        
        # Convert to base64
        buffer = BytesIO()
        img.save(buffer, format='PNG')
        img_base64 = base64.b64encode(buffer.getvalue()).decode()
        
        return img_base64
        
    except Exception as e:
        print(f"Error creating wireframe view: {e}")
        return ""