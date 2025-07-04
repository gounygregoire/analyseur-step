"""
PDF Report Generator for DFM Analysis
Generates comprehensive PDF reports with 3D model views and DFM analysis results.
"""

import os
import io
import base64
from datetime import datetime
from typing import Dict, Any, List, Tuple

try:
    import cadquery as cq
except ImportError:
    cq = None

from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch, mm
from reportlab.lib.colors import HexColor, black, white, red, orange, green
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak
from reportlab.platypus.frames import Frame
from reportlab.platypus.doctemplate import PageTemplate, BaseDocTemplate
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.piecharts import Pie
from reportlab.graphics import renderPDF
from translations import get_translation

class DFMReportGenerator:
    """Generate PDF reports for DFM analysis"""
    
    def __init__(self, language='fr'):
        self.styles = getSampleStyleSheet()
        self.setup_custom_styles()
        self.lang = language
        
    def setup_custom_styles(self):
        """Setup custom paragraph styles"""
        self.styles.add(ParagraphStyle(
            name='CustomTitle',
            parent=self.styles['Heading1'],
            fontSize=24,
            spaceAfter=30,
            textColor=HexColor('#2c3e50'),
            alignment=TA_CENTER
        ))
        
        self.styles.add(ParagraphStyle(
            name='SectionHeader',
            parent=self.styles['Heading2'],
            fontSize=16,
            spaceAfter=12,
            textColor=HexColor('#34495e'),
            borderWidth=1,
            borderColor=HexColor('#34495e'),
            borderPadding=5
        ))
        
        self.styles.add(ParagraphStyle(
            name='IssueTitle',
            parent=self.styles['Heading3'],
            fontSize=12,
            spaceBefore=10,
            spaceAfter=6,
            textColor=HexColor('#e74c3c')
        ))
        
    def generate_3d_views(self, step_file_path: str) -> Dict[str, str]:
        """Generate 3D views from STEP file using CadQuery and STL"""
        views = {}
        
        try:
            import cadquery as cq
            import signal
            import os
            
            # Check file size first - if too large, use fallback immediately
            try:
                file_size = os.path.getsize(step_file_path) / (1024 * 1024)  # Size in MB
                if file_size > 50:  # Files > 50MB
                    print(f"Large STEP file ({file_size:.1f}MB), using fallback views")
                    return self._generate_fallback_views()
            except:
                pass
            
            # Set timeout for CadQuery operations
            def timeout_handler(signum, frame):
                raise TimeoutError("CadQuery operation timed out")
            
            signal.signal(signal.SIGALRM, timeout_handler)
            signal.alarm(30)  # 30 second timeout
            
            try:
                # Load the STEP file
                workplane = cq.importers.importStep(step_file_path)
                
                # Get bounding box
                bbox = workplane.val().BoundingBox()
                dimensions = (bbox.xlen, bbox.ylen, bbox.zlen)
                
                # Cancel timeout
                signal.alarm(0)
                
            except (TimeoutError, Exception) as e:
                print(f"Failed to load STEP file: {e}")
                signal.alarm(0)
                return self._generate_fallback_views()
            
            # Try to use STL file for realistic rendering
            try:
                # Find the corresponding STL file
                base_name = os.path.splitext(os.path.basename(step_file_path))[0]
                stl_path = os.path.join('converted', f"{base_name.split('_', 1)[0]}.stl")
                
                if os.path.exists(stl_path):
                    from generate_realistic_views import create_all_views_from_stl
                    realistic_views = create_all_views_from_stl(stl_path)
                    
                    # Use realistic views if available
                    for axis in ['x', 'y', 'z']:
                        if axis in realistic_views and realistic_views[axis]:
                            views[axis] = realistic_views[axis]
                        else:
                            views[axis] = self._create_simple_wireframe_view(axis.upper(), dimensions)
                else:
                    # Fallback to wireframe if STL not found
                    for axis in ['x', 'y', 'z']:
                        views[axis] = self._create_simple_wireframe_view(axis.upper(), dimensions)
                        
            except Exception as e:
                print(f"Error with realistic views: {e}")
                # Fallback to simple wireframe views
                for axis in ['x', 'y', 'z']:
                    views[axis] = self._create_simple_wireframe_view(axis.upper(), dimensions)
                    
        except Exception as e:
            print(f"Error generating 3D views: {e}")
            # Fallback to placeholder views
            for axis in ['x', 'y', 'z']:
                views[axis] = self._create_simple_wireframe_view(axis.upper(), (100, 100, 100))
        
        return views
    
    def _generate_svg_view(self, workplane, config) -> str:
        """Generate SVG view of the model from a specific direction"""
        try:
            # Get bounding box for scale and positioning
            bbox = workplane.val().BoundingBox()
            width = bbox.xlen
            height = bbox.ylen
            depth = bbox.zlen
            center = bbox.center
            
            # Try to export actual geometry as SVG
            try:
                # Export the workplane as SVG using CadQuery's built-in exporters
                import tempfile
                import os
                
                # Create temporary file for SVG export
                with tempfile.NamedTemporaryFile(suffix='.svg', delete=False, mode='w') as temp_file:
                    temp_path = temp_file.name
                
                # Try using CadQuery's SVG export capability
                try:
                    # Rotate the workplane based on the view direction
                    rotated_wp = workplane
                    if config['name'] == 'Vue selon X':
                        # Rotate to show YZ plane
                        rotated_wp = workplane.rotate((0, 0, 0), (0, 1, 0), 90)
                    elif config['name'] == 'Vue selon Y':
                        # Rotate to show XZ plane
                        rotated_wp = workplane.rotate((0, 0, 0), (1, 0, 0), -90)
                    # Vue selon Z is default (XY plane)
                    
                    # Export to SVG using CadQuery
                    from cadquery import exporters
                    exporters.export(rotated_wp, temp_path, exportType='SVG')
                    
                    # Read the SVG content
                    with open(temp_path, 'r') as f:
                        svg_content = f.read()
                    
                    # Clean up temp file
                    os.unlink(temp_path)
                    
                    # Process SVG to add our styling and title
                    # Extract viewBox and content from exported SVG
                    import re
                    viewbox_match = re.search(r'viewBox="([^"]+)"', svg_content)
                    content_match = re.search(r'<svg[^>]*>(.*)</svg>', svg_content, re.DOTALL)
                    
                    if viewbox_match and content_match:
                        viewbox = viewbox_match.group(1)
                        content = content_match.group(1)
                        
                        # Create styled SVG
                        return f"""
                        <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}">
                            <defs>
                                <style>
                                    path {{ fill: none; stroke: #0066cc; stroke-width: 0.5; }}
                                    line {{ stroke: #0066cc; stroke-width: 0.5; }}
                                    .title {{ font-family: Arial, sans-serif; font-size: 14px; text-anchor: middle; fill: #333; font-weight: bold; }}
                                    .dimensions {{ font-family: Arial, sans-serif; font-size: 10px; text-anchor: middle; fill: #666; }}
                                </style>
                            </defs>
                            
                            <!-- Background -->
                            <rect x="-150" y="-150" width="300" height="300" fill="#f8f9fa" stroke="#dee2e6" stroke-width="1"/>
                            
                            <!-- Model content -->
                            <g transform="scale(0.8)">
                                {content}
                            </g>
                            
                            <!-- Title -->
                            <text x="0" y="-130" class="title">{config['name']}</text>
                            <text x="0" y="140" class="dimensions">
                                {width:.1f} × {height:.1f} × {depth:.1f} mm
                            </text>
                        </svg>
                        """
                    
                except Exception as e:
                    print(f"SVG export failed: {e}")
                    # Fall back to edge extraction
                    pass
                
                # If SVG export failed, try edge extraction
                edges = workplane.edges()
                
                # Build SVG paths from edges
                svg_paths = []
                
                # Calculate scale to fit in viewport
                max_dim = max(width, height, depth)
                scale = 120 / max_dim if max_dim > 0 else 1
                
                for edge in edges.vals():
                    # Get edge geometry and convert to SVG path
                    try:
                        # Get points along the edge for better curves
                        import numpy as np
                        num_points = 10
                        params = np.linspace(0, 1, num_points)
                        points = []
                        
                        for param in params:
                            try:
                                point = edge.positionAt(param)
                                # Apply view transformation based on axis
                                if config['name'] == 'Vue selon X':
                                    # YZ plane projection
                                    x, y = (point.y - center.y) * scale, -(point.z - center.z) * scale
                                elif config['name'] == 'Vue selon Y':
                                    # XZ plane projection  
                                    x, y = (point.x - center.x) * scale, -(point.z - center.z) * scale
                                else:  # Vue selon Z
                                    # XY plane projection
                                    x, y = (point.x - center.x) * scale, -(point.y - center.y) * scale
                                
                                points.append(f"{x:.2f},{y:.2f}")
                            except:
                                continue
                        
                        if len(points) > 1:
                            svg_paths.append(f'<path d="M {" L ".join(points)}" />')
                    except:
                        continue
                
                # Create comprehensive SVG with actual geometry
                svg_content = f"""
                <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg" viewBox="-150 -150 300 300">
                    <defs>
                        <style>
                            .model-edge {{ fill: none; stroke: #0066cc; stroke-width: 1.2; }}
                            .model-face {{ fill: #e6f3ff; stroke: #0066cc; stroke-width: 0.8; opacity: 0.6; }}
                            .background {{ fill: #f8f9fa; stroke: #dee2e6; stroke-width: 1; }}
                            .title {{ font-family: Arial, sans-serif; font-size: 14px; text-anchor: middle; fill: #333; font-weight: bold; }}
                            .dimensions {{ font-family: Arial, sans-serif; font-size: 10px; text-anchor: middle; fill: #666; }}
                        </style>
                    </defs>
                    
                    <!-- Background -->
                    <rect x="-150" y="-150" width="300" height="300" class="background"/>
                    
                    <!-- Model geometry -->
                    <g id="model-geometry">
                        {''.join([f'<path d="{path}" class="model-edge"/>' for path in svg_paths[:50]])}
                    </g>
                    
                    <!-- Title and dimensions -->
                    <text x="0" y="-130" class="title">{config['name']}</text>
                    <text x="0" y="140" class="dimensions">
                        Dimensions: {width:.1f} × {height:.1f} × {depth:.1f} mm
                    </text>
                    
                    <!-- Axis indicators -->
                    <g id="axis-indicators" transform="translate(120, 120)">
                        <line x1="0" y1="0" x2="20" y2="0" stroke="#ff6b6b" stroke-width="2"/>
                        <text x="25" y="4" font-size="10" fill="#ff6b6b">X</text>
                        <line x1="0" y1="0" x2="0" y2="-20" stroke="#51cf66" stroke-width="2"/>
                        <text x="4" y="-25" font-size="10" fill="#51cf66">Y</text>
                    </g>
                </svg>
                """
                
                # Clean up temp file
                try:
                    os.unlink(temp_path)
                except:
                    pass
                
                return svg_content
                
            except Exception as e:
                print(f"Could not export actual geometry: {e}")
                # Fall back to enhanced schematic with actual dimensions
                pass
            
            # Enhanced schematic representation with real dimensions
            scale_factor = min(80 / max(width, height, depth), 1.0)
            scaled_width = width * scale_factor
            scaled_height = height * scale_factor
            scaled_depth = depth * scale_factor
            
            svg_content = f"""
            <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
                <defs>
                    <style>
                        .wireframe {{ fill: none; stroke: #0066cc; stroke-width: 1.5; }}
                        .surface {{ fill: #e6f3ff; stroke: #0066cc; stroke-width: 1; opacity: 0.7; }}
                        .background {{ fill: #f8f9fa; stroke: #dee2e6; stroke-width: 1; }}
                        .title {{ font-family: Arial, sans-serif; font-size: 14px; text-anchor: middle; fill: #333; font-weight: bold; }}
                        .label {{ font-family: Arial, sans-serif; font-size: 11px; text-anchor: middle; fill: #495057; }}
                        .dimensions {{ font-family: Arial, sans-serif; font-size: 10px; text-anchor: middle; fill: #666; }}
                    </style>
                </defs>
                
                <!-- Background -->
                <rect width="300" height="300" class="background"/>
                
                <!-- Model representation with proper proportions -->
                <g transform="translate(150, 150)">
                    <!-- Main projection based on selected axis -->
                    <g id="main-projection">
                        <rect x="-{scaled_width/2}" y="-{scaled_height/2}" 
                              width="{scaled_width}" height="{scaled_height}" class="surface"/>
                        
                        <!-- 3D depth representation -->
                        <g id="depth-lines">
                            <line x1="-{scaled_width/2}" y1="-{scaled_height/2}" 
                                  x2="-{scaled_width/2 - scaled_depth/3}" y2="-{scaled_height/2 - scaled_depth/3}" class="wireframe"/>
                            <line x1="{scaled_width/2}" y1="-{scaled_height/2}" 
                                  x2="{scaled_width/2 - scaled_depth/3}" y2="-{scaled_height/2 - scaled_depth/3}" class="wireframe"/>
                            <line x1="{scaled_width/2}" y1="{scaled_height/2}" 
                                  x2="{scaled_width/2 - scaled_depth/3}" y2="{scaled_height/2 - scaled_depth/3}" class="wireframe"/>
                            <line x1="-{scaled_width/2}" y1="{scaled_height/2}" 
                                  x2="-{scaled_width/2 - scaled_depth/3}" y2="{scaled_height/2 - scaled_depth/3}" class="wireframe"/>
                        </g>
                        
                        <!-- Back face -->
                        <rect x="-{scaled_width/2 - scaled_depth/3}" y="-{scaled_height/2 - scaled_depth/3}" 
                              width="{scaled_width}" height="{scaled_height}" class="wireframe"/>
                    </g>
                    
                    <!-- Dimension lines and labels -->
                    <g id="dimensions">
                        <line x1="-{scaled_width/2}" y1="{scaled_height/2 + 15}" 
                              x2="{scaled_width/2}" y2="{scaled_height/2 + 15}" stroke="#999" stroke-width="1"/>
                        <text x="0" y="{scaled_height/2 + 30}" class="dimensions">{width:.1f} mm</text>
                        
                        <line x1="-{scaled_width/2 + 15}" y1="-{scaled_height/2}" 
                              x2="-{scaled_width/2 + 15}" y2="{scaled_height/2}" stroke="#999" stroke-width="1"/>
                        <text x="-{scaled_width/2 + 30}" y="0" class="dimensions" transform="rotate(-90, -{scaled_width/2 + 30}, 0)">{height:.1f} mm</text>
                    </g>
                </g>
                
                <!-- Title -->
                <text x="150" y="30" class="title">{config['name']}</text>
                <text x="150" y="280" class="label">Projection orthographique du modèle 3D</text>
            </svg>
            """
            
            return svg_content
            
        except Exception as e:
            print(f"Error generating enhanced SVG view: {e}")
            return self._create_placeholder_view(config['name'])
    
    def _generate_enhanced_svg_view(self, workplane, config) -> str:
        """Generate enhanced SVG view with actual model edges"""
        try:
            # Get bounding box
            bbox = workplane.val().BoundingBox()
            width = bbox.xlen
            height = bbox.ylen
            depth = bbox.zlen
            center = bbox.center
            
            # Extract edges from model
            edges = workplane.edges()
            
            # Calculate viewport and scale
            max_dim = max(width, height, depth)
            scale = 250 / max_dim if max_dim > 0 else 1
            
            # Build SVG paths from edges
            svg_paths = []
            
            for edge in edges.vals():
                try:
                    # Sample multiple points along edge for curves
                    points = []
                    for i in range(20):
                        param = i / 19.0
                        pt = edge.positionAt(param)
                        
                        # Project based on view
                        if config['name'] == 'Vue selon X':
                            x = (pt.y - center.y) * scale
                            y = -(pt.z - center.z) * scale
                        elif config['name'] == 'Vue selon Y':
                            x = (pt.x - center.x) * scale
                            y = -(pt.z - center.z) * scale
                        else:  # Vue selon Z
                            x = (pt.x - center.x) * scale
                            y = -(pt.y - center.y) * scale
                        
                        points.append(f"{x:.1f},{y:.1f}")
                    
                    if points:
                        svg_paths.append(f'<polyline points="{" ".join(points)}" fill="none" stroke="#0066cc" stroke-width="1.5"/>')
                        
                except Exception:
                    continue
            
            # Create complete SVG
            svg_content = f"""
            <svg width="400" height="400" xmlns="http://www.w3.org/2000/svg" viewBox="-200 -200 400 400">
                <defs>
                    <style>
                        .title {{ font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; fill: #333; text-anchor: middle; }}
                        .dims {{ font-family: Arial, sans-serif; font-size: 12px; fill: #666; text-anchor: middle; }}
                        .axis-label {{ font-family: Arial, sans-serif; font-size: 10px; fill: #999; }}
                    </style>
                </defs>
                
                <!-- Background -->
                <rect x="-200" y="-200" width="400" height="400" fill="#fafafa" stroke="#ddd" stroke-width="1"/>
                
                <!-- Model edges -->
                <g id="model">
                    {''.join(svg_paths)}
                </g>
                
                <!-- Axis indicators -->
                <g id="axes" transform="translate(150, 150)">
                    <line x1="0" y1="0" x2="30" y2="0" stroke="#d9534f" stroke-width="2" marker-end="url(#arrowX)"/>
                    <text x="35" y="5" class="axis-label">X</text>
                    <line x1="0" y1="0" x2="0" y2="-30" stroke="#5cb85c" stroke-width="2" marker-end="url(#arrowY)"/>
                    <text x="5" y="-35" class="axis-label">Y</text>
                </g>
                
                <!-- Arrow markers -->
                <defs>
                    <marker id="arrowX" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                        <path d="M0,0 L0,6 L9,3 z" fill="#d9534f"/>
                    </marker>
                    <marker id="arrowY" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                        <path d="M0,0 L0,6 L9,3 z" fill="#5cb85c"/>
                    </marker>
                </defs>
                
                <!-- Title and dimensions -->
                <text x="0" y="-170" class="title">{config['name']}</text>
                <text x="0" y="180" class="dims">Dimensions: {width:.1f} × {height:.1f} × {depth:.1f} mm</text>
            </svg>
            """
            
            return svg_content
            
        except Exception as e:
            print(f"Error in enhanced SVG generation: {e}")
            return None
    
    def _create_simple_wireframe_view(self, axis: str, dimensions: Tuple[float, float, float]) -> str:
        """Create a realistic 3D view representation as PNG with shading"""
        try:
            from PIL import Image, ImageDraw, ImageFont
            import io
            import base64
            import math
            
            # Create image with light background
            img_size = 200
            img = Image.new('RGB', (img_size, img_size), color='#f8f9fa')
            draw = ImageDraw.Draw(img)
            
            # Draw subtle border
            draw.rectangle([0, 0, img_size-1, img_size-1], outline='#e0e0e0', width=1)
            
            # Draw title
            title = f"Vue selon {axis}"
            draw.text((img_size//2, 15), title, fill='#333333', anchor='mt')
            
            # Draw a 3D box with shading
            center_x, center_y = img_size//2, img_size//2 + 20
            
            # Scale dimensions to fit in image
            width, height, depth = dimensions
            max_dim = max(width, height, depth)
            scale = 70 / max_dim if max_dim > 0 else 1
            
            # Calculate view dimensions based on axis
            if axis == 'X':
                # YZ plane view
                w, h = height * scale, depth * scale
                view_depth = width * scale
            elif axis == 'Y':
                # XZ plane view  
                w, h = width * scale, depth * scale
                view_depth = height * scale
            else:  # Z
                # XY plane view
                w, h = width * scale, height * scale
                view_depth = depth * scale
                
            # 3D offset for isometric effect
            offset_x = min(25, w * 0.4)
            offset_y = min(25, h * 0.4)
            
            # Define corners for the box
            x1, y1 = center_x - w/2, center_y - h/2
            x2, y2 = center_x + w/2, center_y + h/2
            
            # Draw the 3D box with faces (back to front)
            # Top face (darkest)
            if offset_y > 0:
                top_face = [
                    (x1, y1),
                    (x1 + offset_x, y1 - offset_y),
                    (x2 + offset_x, y1 - offset_y),
                    (x2, y1)
                ]
                draw.polygon(top_face, fill='#808080', outline='#606060')
            
            # Right face (medium)
            if offset_x > 0:
                right_face = [
                    (x2, y1),
                    (x2 + offset_x, y1 - offset_y),
                    (x2 + offset_x, y2 - offset_y),
                    (x2, y2)
                ]
                draw.polygon(right_face, fill='#a0a0a0', outline='#808080')
            
            # Front face (lightest)
            front_face = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
            draw.polygon(front_face, fill='#c0c0c0', outline='#999999')
            
            # Add subtle gradient effect on front face
            for i in range(int(h/4)):
                shade = int(192 + i * 16 / (h/4))
                if shade > 216:
                    shade = 216
                color = f'#{shade:02x}{shade:02x}{shade:02x}'
                draw.rectangle([x1+1, y1+i*4, x2-1, y1+i*4+4], fill=color, outline=None)
            
            # Draw dimensions
            dim_text = f"{width:.1f} × {height:.1f} × {depth:.1f} mm"
            draw.text((img_size//2, img_size-10), dim_text, fill='#666666', anchor='mt')
            
            # Convert to base64 PNG
            buffer = io.BytesIO()
            img.save(buffer, format='PNG')
            buffer.seek(0)
            return base64.b64encode(buffer.getvalue()).decode()
            
        except Exception as e:
            print(f"Error creating realistic view: {e}")
            return self._create_placeholder_view(f'Vue selon {axis}')
    
    def _create_placeholder_view(self, view_name: str) -> str:
        """Create a placeholder view representation"""
        # Create a simple SVG placeholder
        svg_content = f"""
        <svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
            <rect width="200" height="200" fill="#f8f9fa" stroke="#dee2e6" stroke-width="2"/>
            <text x="100" y="90" text-anchor="middle" font-family="Arial" font-size="14" fill="#6c757d">
                {view_name}
            </text>
            <text x="100" y="110" text-anchor="middle" font-family="Arial" font-size="12" fill="#6c757d">
                Vue 3D générée
            </text>
            <rect x="60" y="120" width="80" height="50" fill="none" stroke="#007bff" stroke-width="2"/>
            <line x1="60" y1="120" x2="80" y2="100" stroke="#007bff" stroke-width="1"/>
            <line x1="140" y1="120" x2="160" y2="100" stroke="#007bff" stroke-width="1"/>
            <line x1="140" y1="170" x2="160" y2="150" stroke="#007bff" stroke-width="1"/>
            <line x1="60" y1="170" x2="80" y2="150" stroke="#007bff" stroke-width="1"/>
            <rect x="80" y="100" width="80" height="50" fill="none" stroke="#007bff" stroke-width="2"/>
        </svg>
        """
        
        # Convert SVG to base64 (placeholder)
        import base64
        return base64.b64encode(svg_content.encode()).decode()
        
    def generate_report(self, dfm_data: Dict[str, Any], step_file_path: str, 
                       filename: str, original_filename: str, material_recommendations: List[Dict] = None, lang: str = 'fr') -> str:
        """Generate complete DFM PDF report"""
        try:
            # Generate 3D views from STEP file
            model_views = self.generate_3d_views(step_file_path)
            
            # Create PDF document
            doc = SimpleDocTemplate(
                filename,
                pagesize=A4,
                rightMargin=20*mm,
                leftMargin=20*mm,
                topMargin=20*mm,
                bottomMargin=20*mm
            )
            
            # Build story (content)
            story = []
            
            # Title page
            story.extend(self._create_title_page(original_filename, dfm_data, lang))
            story.append(PageBreak())
            
            # Executive summary
            story.extend(self._create_executive_summary(dfm_data))
            story.append(Spacer(1, 20))
            
            # Model views section
            story.extend(self._create_model_views_section(model_views))
            story.append(PageBreak())
            
            # Detailed analysis
            story.extend(self._create_detailed_analysis(dfm_data))
            story.append(PageBreak())
            
            # Material recommendations
            if material_recommendations:
                story.extend(self._create_material_recommendations_section(material_recommendations))
                story.append(PageBreak())
            
            # Recommendations
            story.extend(self._create_recommendations_section(dfm_data))
            
            # Build PDF
            doc.build(story)
            
            return filename
            
        except Exception as e:
            print(f"Error generating PDF report: {e}")
            # Create a minimal PDF to avoid corrupted download
            try:
                doc = SimpleDocTemplate(filename, pagesize=A4)
                story = [Paragraph("Erreur lors de la génération du rapport PDF", self.styles['Normal'])]
                doc.build(story)
            except:
                pass
            return filename
        
    def _create_title_page(self, original_filename: str, dfm_data: Dict[str, Any], lang: str = 'fr') -> List:
        """Create title page"""
        content = []
        
        # Main title
        # Traduire selon la langue
        title = "DFM Analysis Report" if lang == 'en' else "Rapport d'Analyse DFM"
        content.append(Paragraph(title, self.styles['CustomTitle']))
        content.append(Spacer(1, 30))
        
        # File info
        file_label = "Analyzed file:" if lang == 'en' else "Fichier analysé:"
        content.append(Paragraph(f"<b>{file_label}</b> {original_filename}", self.styles['Normal']))
        content.append(Spacer(1, 10))
        
        # Date
        date_format = "%m/%d/%Y at %H:%M" if lang == 'en' else "%d/%m/%Y à %H:%M"
        current_date = datetime.now().strftime(date_format)
        date_label = "Report date:" if lang == 'en' else "Date du rapport:"
        content.append(Paragraph(f"<b>{date_label}</b> {current_date}", self.styles['Normal']))
        content.append(Spacer(1, 30))
        
        # Overall score box
        score = dfm_data.get('score', 0)
        rating = dfm_data.get('rating', 'unknown')
        color = self._get_rating_color(rating)
        
        # Score labels
        score_label = "Moldability Score" if lang == 'en' else "Score de Moulabilité"
        eval_label = "Evaluation" if lang == 'en' else "Évaluation"
        
        score_table = Table([
            [score_label, f'{score}/10'],
            [eval_label, self._get_rating_text(rating, lang)]
        ], colWidths=[100*mm, 60*mm])
        
        score_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), color),
            ('TEXTCOLOR', (0, 0), (-1, -1), white),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, -1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 14),
            ('GRID', (0, 0), (-1, -1), 1, white)
        ]))
        
        content.append(score_table)
        content.append(Spacer(1, 40))
        
        # Summary stats
        issues_count = dfm_data.get('issues_count', 0)
        dimensions = dfm_data.get('dimensions', {})
        
        # Translate table headers and labels
        param_label = "Parameter" if lang == 'en' else "Paramètre"
        value_label = "Value" if lang == 'en' else "Valeur"
        issues_label = "Issues detected" if lang == 'en' else "Problèmes détectés"
        dimensions_label = "Dimensions (mm)" if lang == 'en' else "Dimensions (mm)"
        volume_label = "Volume" if lang == 'en' else "Volume"
        thickness_label = "Max thickness" if lang == 'en' else "Épaisseur max"
        
        stats_data = [
            [param_label, value_label],
            [issues_label, str(issues_count)],
            [dimensions_label, f"X: {dimensions.get('x', 0)} | Y: {dimensions.get('y', 0)} | Z: {dimensions.get('z', 0)}"],
            [volume_label, f"{dimensions.get('volume', 0)} mm³"],
            [thickness_label, f"{dimensions.get('max_wall_thickness', 0)} mm"]
        ]
        
        stats_table = Table(stats_data, colWidths=[80*mm, 80*mm])
        stats_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), HexColor('#34495e')),
            ('TEXTCOLOR', (0, 0), (-1, 0), white),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('GRID', (0, 0), (-1, -1), 1, HexColor('#bdc3c7'))
        ]))
        
        content.append(stats_table)
        
        return content
        
    def _create_executive_summary(self, dfm_data: Dict[str, Any]) -> List:
        """Create executive summary section"""
        content = []
        
        content.append(Paragraph("Résumé Exécutif", self.styles['SectionHeader']))
        
        # Overall assessment
        score = dfm_data.get('score', 0)
        rating = dfm_data.get('rating', 'unknown')
        issues_count = dfm_data.get('issues_count', 0)
        
        if score >= 8:
            summary_text = f"La pièce présente une excellente moulabilité avec un score de {score}/10. "
        elif score >= 6:
            summary_text = f"La pièce présente une bonne moulabilité avec un score de {score}/10. "
        elif score >= 4:
            summary_text = f"La pièce présente une moulabilité acceptable avec un score de {score}/10. "
        else:
            summary_text = f"La pièce présente des défis de moulabilité avec un score de {score}/10. "
        
        summary_text += f"Au total, {issues_count} problème(s) ont été identifié(s) et nécessitent une attention."
        
        content.append(Paragraph(summary_text, self.styles['Normal']))
        content.append(Spacer(1, 15))
        
        # Key metrics
        dimensions = dfm_data.get('dimensions', {})
        max_thickness = dimensions.get('max_wall_thickness', 0)
        
        if max_thickness > 6:
            thickness_assessment = "CRITIQUE - Épaisseur excessive risquant des défauts de retrait"
        elif max_thickness > 4:
            thickness_assessment = "ATTENTION - Épaisseur élevée nécessitant optimisation"
        elif max_thickness < 0.8:
            thickness_assessment = "CRITIQUE - Épaisseur insuffisante risquant des problèmes de remplissage"
        else:
            thickness_assessment = "OPTIMAL - Épaisseur dans les tolérances recommandées"
        
        content.append(Paragraph(f"<b>Épaisseur maximale:</b> {max_thickness} mm - {thickness_assessment}", self.styles['Normal']))
        
        return content
        
    def _create_model_views_section(self, model_views: Dict[str, str]) -> List:
        """Create 3D model views section"""
        content = []
        
        content.append(Paragraph("Vues du Modèle 3D", self.styles['SectionHeader']))
        content.append(Spacer(1, 10))
        
        # Create table with three views
        view_data = []
        view_images = []
        view_labels = []
        
        axes = ['x', 'y', 'z']
        axis_names = {'x': 'Vue selon X', 'y': 'Vue selon Y', 'z': 'Vue selon Z'}
        
        for axis in axes:
            if axis in model_views and model_views[axis]:
                try:
                    # Decode base64 image data
                    image_data = base64.b64decode(model_views[axis])
                    
                    # Check if it's PNG data (starts with PNG signature)
                    if image_data[:8] == b'\x89PNG\r\n\x1a\n':
                        # It's a PNG image, use it directly
                        from io import BytesIO
                        img_buffer = BytesIO(image_data)
                        img = Image(img_buffer, width=120, height=120)
                        view_images.append(img)
                        view_labels.append(axis_names[axis])
                    else:
                        # It might be SVG data, try to create an image from it
                        # For now, create a better placeholder
                        from reportlab.graphics.shapes import Drawing, Rect, String, Line, Path
                        
                        drawing = Drawing(120, 120)
                        # Try to parse SVG and extract paths
                        try:
                            svg_str = image_data.decode('utf-8')
                            # Simple SVG path extraction (basic implementation)
                            if '<svg' in svg_str and 'path' in svg_str:
                                # This is SVG, but we'll create a more realistic view
                                drawing.add(Rect(5, 5, 110, 110, fillColor=HexColor('#fafafa'), strokeColor=HexColor('#ddd')))
                                # Add axis label
                                drawing.add(String(60, 100, axis_names[axis], fontSize=10, textAnchor='middle', fillColor=black))
                                # Add a note that it's a wireframe view
                                drawing.add(String(60, 15, 'Vue filaire', fontSize=8, textAnchor='middle', fillColor=HexColor('#666')))
                                # Try to add some extracted paths (simplified)
                                drawing.add(Rect(25, 35, 50, 40, fillColor=None, strokeColor=HexColor('#0066cc'), strokeWidth=1.5))
                            else:
                                raise ValueError("Not valid SVG")
                        except:
                            # Fallback to simple box
                            drawing.add(Rect(5, 5, 110, 110, fillColor=HexColor('#f8f9fa'), strokeColor=HexColor('#007bff')))
                            drawing.add(String(60, 85, axis_names[axis], fontSize=10, textAnchor='middle'))
                            drawing.add(String(60, 15, 'Vue générée', fontSize=8, textAnchor='middle'))
                        
                        view_images.append(drawing)
                        view_labels.append(axis_names[axis])
                except Exception as e:
                    print(f"Error processing {axis} view: {e}")
                    # Create a placeholder drawing
                    from reportlab.graphics.shapes import Drawing, Rect, String
                    
                    drawing = Drawing(120, 120)
                    drawing.add(Rect(5, 5, 110, 110, fillColor=HexColor('#f8f9fa'), strokeColor=HexColor('#dee2e6')))
                    drawing.add(String(60, 60, axis_names[axis], fontSize=10, textAnchor='middle'))
                    drawing.add(String(60, 45, 'Non disponible', fontSize=8, textAnchor='middle'))
                    view_images.append(drawing)
                    view_labels.append(axis_names[axis])
            else:
                # Create a placeholder drawing
                from reportlab.graphics.shapes import Drawing, Rect, String
                
                drawing = Drawing(120, 120)
                drawing.add(Rect(5, 5, 110, 110, fillColor=HexColor('#f8f9fa'), strokeColor=HexColor('#dee2e6')))
                drawing.add(String(60, 60, axis_names[axis], fontSize=10, textAnchor='middle'))
                drawing.add(String(60, 45, 'Vue 3D générée', fontSize=8, textAnchor='middle'))
                view_images.append(drawing)
                view_labels.append(axis_names[axis])
        
        # Create table with images and labels
        views_table = Table([
            view_images,
            view_labels
        ], colWidths=[60*mm, 60*mm, 60*mm])
        
        views_table.setStyle(TableStyle([
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('FONTNAME', (0, 1), (-1, 1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 1), (-1, 1), 10),
        ]))
        
        content.append(views_table)
        
        return content
        
    def _create_detailed_analysis(self, dfm_data: Dict[str, Any]) -> List:
        """Create detailed analysis section"""
        content = []
        
        content.append(Paragraph("Analyse Détaillée", self.styles['SectionHeader']))
        
        # Wall thickness issues
        wall_issues = dfm_data.get('wall_thickness_issues', [])
        if wall_issues:
            content.append(Paragraph("Problèmes d'Épaisseur", self.styles['IssueTitle']))
            
            for issue in wall_issues[:5]:  # Limit to 5 issues
                severity = issue.get('severity', 'unknown')
                thickness = issue.get('thickness', 0)
                issue_type = issue.get('issue_type', 'unknown')
                
                severity_color = self._get_severity_color(severity)
                
                if issue_type == 'too_thin':
                    desc = f"Paroi trop fine: {thickness:.2f}mm (min. 0.8mm)"
                elif issue_type == 'too_thick':
                    desc = f"Paroi trop épaisse: {thickness:.2f}mm (max. 4mm)"
                else:
                    desc = f"Épaisseur: {thickness:.2f}mm"
                
                content.append(Paragraph(
                    f"<font color='{severity_color}'>• {severity.upper()}</font>: {desc}", 
                    self.styles['Normal']
                ))
            
            content.append(Spacer(1, 10))
        
        # Geometry issues
        geo_issues = dfm_data.get('geometry_issues', [])
        if geo_issues:
            content.append(Paragraph("Problèmes Géométriques", self.styles['IssueTitle']))
            
            for issue in geo_issues[:5]:  # Limit to 5 issues
                severity = issue.get('severity', 'unknown')
                description = issue.get('description', 'Description non disponible')
                
                severity_color = self._get_severity_color(severity)
                
                content.append(Paragraph(
                    f"<font color='{severity_color}'>• {severity.upper()}</font>: {description}", 
                    self.styles['Normal']
                ))
            
            content.append(Spacer(1, 10))
        
        return content
    
    def _create_material_recommendations_section(self, material_recommendations: List[Dict]) -> List:
        """Create material recommendations section"""
        content = []
        
        content.append(Paragraph("Recommandations Matériaux", self.styles['SectionHeader']))
        
        content.append(Paragraph(
            "Basé sur votre questionnaire d'usage, voici 3 matériaux plastiques recommandés pour votre pièce :",
            self.styles['Normal']
        ))
        content.append(Spacer(1, 15))
        
        for i, material in enumerate(material_recommendations[:3], 1):
            # Material header
            content.append(Paragraph(
                f"{i}. {material.get('name', 'Matériau inconnu')} - {material.get('category', '')}",
                self.styles['Heading3']
            ))
            
            # Score
            score = material.get('score', 0)
            content.append(Paragraph(
                f"Score de compatibilité: {score:.1f}/100",
                self.styles['Normal']
            ))
            
            # Description
            description = material.get('description', '')
            if description:
                content.append(Paragraph(f"Description: {description}", self.styles['Normal']))
            
            # Properties
            properties = material.get('properties', {})
            if properties:
                content.append(Paragraph("Propriétés principales:", self.styles['Normal']))
                for prop, value in properties.items():
                    if isinstance(value, (int, float)):
                        content.append(Paragraph(f"• {prop}: {value}", self.styles['Normal']))
                    else:
                        content.append(Paragraph(f"• {prop}: {value}", self.styles['Normal']))
            
            # Advantages
            advantages = material.get('advantages', [])
            if advantages:
                content.append(Paragraph("Avantages:", self.styles['Normal']))
                for advantage in advantages[:3]:  # Limit to 3
                    content.append(Paragraph(f"✓ {advantage}", self.styles['Normal']))
            
            # Cost level
            cost_level = material.get('cost_level', 'balanced')
            cost_text = {
                'economy': 'Économique',
                'balanced': 'Équilibré',
                'premium': 'Premium'
            }.get(cost_level, 'Équilibré')
            content.append(Paragraph(f"Niveau de coût: {cost_text}", self.styles['Normal']))
            
            content.append(Spacer(1, 15))
        
        return content
        
    def _create_recommendations_section(self, dfm_data: Dict[str, Any]) -> List:
        """Create recommendations section"""
        content = []
        
        content.append(Paragraph("Recommandations", self.styles['SectionHeader']))
        
        recommendations = dfm_data.get('recommendations', [])
        
        for i, rec in enumerate(recommendations, 1):
            content.append(Paragraph(f"{i}. {rec}", self.styles['Normal']))
            content.append(Spacer(1, 8))
        
        # Additional general recommendations
        content.append(Spacer(1, 15))
        content.append(Paragraph("Recommandations Générales", self.styles['Heading3']))
        
        general_recs = [
            "Consulter un expert en injection plastique pour validation finale",
            "Effectuer des simulations de remplissage si nécessaire",
            "Considérer le choix du matériau plastique selon l'application",
            "Prévoir des essais de moulage pour validation"
        ]
        
        for rec in general_recs:
            content.append(Paragraph(f"• {rec}", self.styles['Normal']))
            content.append(Spacer(1, 5))
        
        return content
        
    def _get_rating_color(self, rating: str) -> HexColor:
        """Get color for rating"""
        colors = {
            'excellent': HexColor('#27ae60'),
            'good': HexColor('#3498db'),
            'warning': HexColor('#f39c12'),
            'critical': HexColor('#e74c3c')
        }
        return colors.get(rating, HexColor('#95a5a6'))
        
    def _get_severity_color(self, severity: str) -> str:
        """Get color for severity"""
        colors = {
            'critical': '#e74c3c',
            'warning': '#f39c12',
            'info': '#3498db'
        }
        return colors.get(severity.lower(), '#95a5a6')
        
    def _get_rating_text(self, rating: str, lang: str = 'fr') -> str:
        """Get text for rating based on language"""
        if lang == 'en':
            texts = {
                'excellent': 'Excellent',
                'good': 'Good',
                'warning': 'Acceptable',
                'critical': 'Critical'
            }
            return texts.get(rating, 'Unknown')
        else:
            texts = {
                'excellent': 'Excellente',
                'good': 'Bonne',
                'warning': 'Acceptable',
                'critical': 'Critique'
            }
            return texts.get(rating, 'Inconnue')

    def _generate_fallback_views(self) -> Dict[str, str]:
        """Generate fallback views when STEP import fails"""
        from reportlab.graphics.shapes import Drawing, Rect, String, Circle, Line
        import base64
        from io import BytesIO
        from reportlab.graphics.renderPM import drawToString
        
        views = {}
        
        for axis in ['x', 'y', 'z']:
            # Create a simple fallback drawing
            drawing = Drawing(200, 200)
            
            # Add background
            drawing.add(Rect(10, 10, 180, 180, fillColor=HexColor('#f8f9fa'), strokeColor=HexColor('#dee2e6')))
            
            # Add axis title
            axis_names = {'x': 'Vue selon X', 'y': 'Vue selon Y', 'z': 'Vue selon Z'}
            drawing.add(String(100, 170, axis_names[axis], fontSize=14, textAnchor='middle', fillColor=black))
            
            # Add a simple 3D representation based on axis
            if axis == 'x':
                # YZ plane view - show a rectangle
                drawing.add(Rect(70, 60, 60, 80, fillColor=None, strokeColor=HexColor('#007bff'), strokeWidth=2))
                drawing.add(String(100, 45, 'Plan YZ', fontSize=10, textAnchor='middle', fillColor=HexColor('#666')))
            elif axis == 'y':
                # XZ plane view - show an elongated rectangle
                drawing.add(Rect(50, 70, 100, 60, fillColor=None, strokeColor=HexColor('#28a745'), strokeWidth=2))
                drawing.add(String(100, 45, 'Plan XZ', fontSize=10, textAnchor='middle', fillColor=HexColor('#666')))
            else:  # z
                # XY plane view - show a wide rectangle
                drawing.add(Rect(60, 80, 80, 40, fillColor=None, strokeColor=HexColor('#dc3545'), strokeWidth=2))
                drawing.add(String(100, 45, 'Plan XY', fontSize=10, textAnchor='middle', fillColor=HexColor('#666')))
            
            # Add note about fallback
            drawing.add(String(100, 25, 'Vue simplifiée générée', fontSize=8, textAnchor='middle', fillColor=HexColor('#999')))
            
            # Convert to PNG and encode as base64
            try:
                png_data = drawToString(drawing, 'PNG')
                b64_data = base64.b64encode(png_data).decode('utf-8')
                views[axis] = b64_data
            except Exception as e:
                print(f"Error creating fallback view for {axis}: {e}")
                # Return empty string if conversion fails
                views[axis] = ""
        
        return views
    
    def _create_simple_wireframe_view(self, axis: str, dimensions: tuple) -> str:
        """Create a simple wireframe view for given axis"""
        from reportlab.graphics.shapes import Drawing, Rect, String, Line
        import base64
        from reportlab.graphics.renderPM import drawToString
        
        drawing = Drawing(200, 200)
        
        # Add background
        drawing.add(Rect(10, 10, 180, 180, fillColor=HexColor('#fafafa'), strokeColor=HexColor('#ddd')))
        
        # Add title
        axis_names = {'X': 'Vue selon X', 'Y': 'Vue selon Y', 'Z': 'Vue selon Z'}
        drawing.add(String(100, 170, axis_names.get(axis, f'Vue {axis}'), fontSize=14, textAnchor='middle', fillColor=black))
        
        # Calculate relative dimensions for display
        x_dim, y_dim, z_dim = dimensions
        max_dim = max(x_dim, y_dim, z_dim)
        
        # Scale dimensions to fit in drawing
        scale = 80 / max_dim if max_dim > 0 else 1
        
        if axis == 'X':
            # YZ view
            width = y_dim * scale
            height = z_dim * scale
        elif axis == 'Y':
            # XZ view  
            width = x_dim * scale
            height = z_dim * scale
        else:  # Z
            # XY view
            width = x_dim * scale
            height = y_dim * scale
        
        # Center the rectangle
        x_pos = 100 - width/2
        y_pos = 100 - height/2
        
        # Add wireframe rectangle
        drawing.add(Rect(x_pos, y_pos, width, height, fillColor=None, strokeColor=HexColor('#007bff'), strokeWidth=2))
        
        # Add dimension text
        drawing.add(String(100, 35, f'{width/scale:.1f} × {height/scale:.1f} mm', fontSize=10, textAnchor='middle', fillColor=HexColor('#666')))
        drawing.add(String(100, 20, 'Vue filaire', fontSize=8, textAnchor='middle', fillColor=HexColor('#999')))
        
        try:
            png_data = drawToString(drawing, 'PNG')
            return base64.b64encode(png_data).decode('utf-8')
        except Exception as e:
            print(f"Error creating wireframe view for {axis}: {e}")
            return ""

# Convenience function
def generate_dfm_pdf_report(dfm_data: Dict[str, Any], step_file_path: str, 
                           output_path: str, original_filename: str, material_recommendations: List[Dict] = None, lang: str = 'fr') -> str:
    """Generate DFM PDF report with 3D views from STEP file"""
    try:
        generator = DFMReportGenerator(language=lang)
        return generator.generate_report(dfm_data, step_file_path, output_path, original_filename, material_recommendations, lang)
    except Exception as e:
        print(f"Error generating DFM PDF report: {e}")
        # Return the output path even on error to prevent None return
        return output_path
        return output_path