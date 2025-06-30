"""
DFM (Design for Manufacturing) Analyzer for Plastic Injection Molding
Analyzes STEP files for manufacturability issues and generates comprehensive reports.
"""

import cadquery as cq
import numpy as np
from dataclasses import dataclass
from typing import List, Dict, Tuple, Optional
import math
import trimesh
import tempfile
import os

@dataclass
class DimensionAnalysis:
    """Global dimensions and volume analysis"""
    x_max: float
    y_max: float
    z_max: float
    volume: float
    surface_area: float
    largest_dimension: float
    smallest_dimension: float
    max_wall_thickness: float
    projected_area_x: float  # Surface projetée selon X
    projected_area_y: float  # Surface projetée selon Y
    projected_area_z: float  # Surface projetée selon Z
    cooling_time: float      # Temps de refroidissement estimé en secondes

@dataclass
class WallThicknessIssue:
    """Wall thickness analysis result"""
    location: Tuple[float, float, float]
    thickness: float
    issue_type: str  # 'too_thin', 'too_thick', 'acceptable'
    severity: str    # 'critical', 'warning', 'info'

@dataclass
class GeometryIssue:
    """Generic geometry issue"""
    location: Tuple[float, float, float]
    issue_type: str
    description: str
    severity: str
    recommendation: str

@dataclass
class DFMReport:
    """Complete DFM analysis report"""
    dimensions: DimensionAnalysis
    wall_thickness_issues: List[WallThicknessIssue]
    geometry_issues: List[GeometryIssue]
    overall_score: str  # 'excellent', 'good', 'warning', 'critical'
    moldability_rating: int  # 1-10 scale
    recommendations: List[str]

class DFMAnalyzer:
    """Main DFM analyzer class"""
    
    def __init__(self):
        # DFM thresholds for plastic injection molding
        self.min_wall_thickness = 0.8  # mm
        self.max_wall_thickness = 4.0  # mm
        self.optimal_wall_thickness_min = 1.2  # mm
        self.optimal_wall_thickness_max = 3.0  # mm
        
        self.max_height = 60.0  # mm
        self.min_draft_angle = 0.5  # degrees
        self.min_radius = 0.2  # mm
        self.max_blind_hole_depth_ratio = 10.0  # depth/diameter ratio
        
    def analyze_step_file(self, step_file_path: str, demolding_axis: str = 'z') -> DFMReport:
        """
        Complete DFM analysis of a STEP file
        """
        try:
            # Import the STEP file
            workplane = cq.importers.importStep(step_file_path)
            
            # Perform all analyses
            dimensions = self._analyze_dimensions(workplane)
            wall_issues = self._analyze_wall_thickness(workplane)
            geometry_issues = self._analyze_geometry_issues(workplane)
            
            # Calculate overall rating
            overall_score, moldability_rating = self._calculate_overall_rating(
                dimensions, wall_issues, geometry_issues
            )
            
            # Generate recommendations
            recommendations = self._generate_recommendations(
                dimensions, wall_issues, geometry_issues
            )
            
            return DFMReport(
                dimensions=dimensions,
                wall_thickness_issues=wall_issues,
                geometry_issues=geometry_issues,
                overall_score=overall_score,
                moldability_rating=moldability_rating,
                recommendations=recommendations
            )
            
        except Exception as e:
            print(f"Error analyzing STEP file: {e}")
            return self._create_error_report()
    
    def _analyze_dimensions(self, workplane, demolding_axis: str = 'z') -> DimensionAnalysis:
        """Analyze global dimensions and calculate maximum wall thickness"""
        try:
            # Get bounding box
            bbox = workplane.val().BoundingBox()
            
            x_size = bbox.xlen
            y_size = bbox.ylen
            z_size = bbox.zlen
            
            # Calculate volume and surface area
            volume = workplane.val().Volume()
            surface_area = workplane.val().Area()
            
            # Find largest and smallest dimensions
            dimensions = [x_size, y_size, z_size]
            largest_dim = max(dimensions)
            smallest_dim = min(dimensions)
            
            # Estimate maximum wall thickness based on smallest dimension (more realistic)
            # For injection molding, wall thickness is typically the smallest feature
            # Use a conservative approach: assume max thickness is related to smallest dimension
            dimensions_sorted = sorted([x_size, y_size, z_size])
            
            # Conservative estimate: wall thickness shouldn't exceed 1/10 of smallest dimension
            # but also consider typical injection molding constraints
            max_wall_thickness = min(dimensions_sorted[0] / 5, 10.0)  # Cap at 10mm max
            
            # If part is very thin in one direction, that's likely the wall thickness
            if dimensions_sorted[0] < 10:  # If smallest dimension < 10mm
                max_wall_thickness = dimensions_sorted[0]
            
            # Calculate real projected areas using Trimesh
            # Export to temporary STL file for Trimesh processing
            with tempfile.NamedTemporaryFile(suffix='.stl', delete=False) as tmp_file:
                temp_stl_path = tmp_file.name
                
            try:
                # Export CadQuery object to STL
                cq.exporters.export(workplane, temp_stl_path)
                
                # Load with Trimesh
                mesh_loaded = trimesh.load(temp_stl_path)
                
                # Handle Scene objects (when multiple objects are loaded)
                if isinstance(mesh_loaded, trimesh.Scene):
                    if len(mesh_loaded.geometry) > 0:
                        mesh = list(mesh_loaded.geometry.values())[0]
                    else:
                        raise ValueError("No geometry found in the file")
                else:
                    mesh = mesh_loaded
                
                # Clean and validate mesh
                print(f"Original mesh: {len(mesh.faces)} faces, {len(mesh.vertices)} vertices")
                
                # Nettoyage du mesh pour de bons calculs
                mesh.remove_duplicate_faces()
                mesh.remove_degenerate_faces()
                mesh.remove_unreferenced_vertices()
                
                # Fix normals if needed
                if not mesh.is_winding_consistent:
                    mesh.fix_normals()
                
                # Ensure we have a single watertight component
                if hasattr(mesh, 'split') and callable(mesh.split):
                    components = mesh.split(only_watertight=False)
                    if len(components) > 0:
                        # Take largest component by volume
                        mesh = max(components, key=lambda m: m.volume if hasattr(m, 'volume') else 0)
                
                mesh.rezero()
                
                print(f"Cleaned mesh: {len(mesh.faces)} faces, {len(mesh.vertices)} vertices")
                print(f"Mesh volume: {mesh.volume:.2f} mm³")
                print(f"Mesh surface area: {mesh.area:.2f} mm²")
                
                # Calculate projected areas using improved method
                projected_area_x = self._calculate_projected_area_robust(mesh, 'x')
                projected_area_y = self._calculate_projected_area_robust(mesh, 'y')
                projected_area_z = self._calculate_projected_area_robust(mesh, 'z')
                
                print(f"Projected areas - X: {projected_area_x:.2f}, Y: {projected_area_y:.2f}, Z: {projected_area_z:.2f}")
                
                # Generate debug visualization
                try:
                    from projection_debug import visualize_projections, debug_mesh_stats
                    debug_mesh_stats(mesh)
                    viz_path = visualize_projections(mesh, "static/debug_projections.png")
                    print(f"Debug visualization saved to: {viz_path}")
                except Exception as viz_error:
                    print(f"Debug visualization failed: {viz_error}")
                
                # Validation: projected area should be reasonable
                max_projected = max(projected_area_x, projected_area_y, projected_area_z)
                if max_projected > mesh.area * 0.8:  # Allow up to 80% of total surface area
                    print(f"Warning: Max projected area ({max_projected:.2f}) is high vs surface area ({mesh.area:.2f})")

                
            except Exception as e:
                print(f"Error calculating projected areas with Trimesh: {e}")
                # Fallback to bounding box estimation
                projected_area_x = y_size * z_size
                projected_area_y = x_size * z_size
                projected_area_z = x_size * y_size
            finally:
                # Clean up temporary file
                if os.path.exists(temp_stl_path):
                    os.unlink(temp_stl_path)
            
            # Calculate cooling time based on wall thickness
            # Formula: t = 3 × s² where:
            # s = wall thickness in mm
            # α = thermal diffusivity (typically 0.1 mm²/s for plastics)
            # Result in seconds
            cooling_time = 3 * max_wall_thickness ** 2
            
            # Add safety factor and minimum cycle time
            cooling_time = max(cooling_time * 1.2, 10.0)  # Minimum 10 seconds
            
            return DimensionAnalysis(
                x_max=x_size,
                y_max=y_size,
                z_max=z_size,
                volume=volume,
                surface_area=surface_area,
                largest_dimension=largest_dim,
                smallest_dimension=smallest_dim,
                max_wall_thickness=max_wall_thickness,
                projected_area_x=projected_area_x,
                projected_area_y=projected_area_y,
                projected_area_z=projected_area_z,
                cooling_time=cooling_time
            )
            
        except Exception as e:
            print(f"Error in dimension analysis: {e}")
            return DimensionAnalysis(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10.0)
    
    def _analyze_wall_thickness(self, workplane) -> List[WallThicknessIssue]:
        """Analyze wall thickness throughout the part with improved accuracy"""
        issues = []
        
        try:
            # Get all faces and edges
            faces = workplane.faces().vals()
            edges = workplane.edges().vals()
            bbox = workplane.val().BoundingBox()
            
            # Calculate volume and surface area for better estimation
            volume = workplane.val().Volume()
            surface_area = workplane.val().Area()
            
            # More accurate thickness estimation
            # For injection molded parts: avg_thickness ≈ 2 * volume / surface_area
            avg_thickness = (2 * volume / surface_area) if surface_area > 0 else 2.0
            
            # Analyze major faces to find actual wall pairs
            face_pairs = []
            analyzed_faces = set()
            
            # Sort faces by area (largest first)
            faces_with_area = [(f, f.Area()) for f in faces]
            faces_with_area.sort(key=lambda x: x[1], reverse=True)
            
            # Find parallel face pairs
            for i, (face1, area1) in enumerate(faces_with_area[:20]):  # Analyze top 20 faces
                if id(face1) in analyzed_faces:
                    continue
                    
                center1 = face1.Center()
                normal1 = face1.normalAt(center1)
                
                for j, (face2, area2) in enumerate(faces_with_area[i+1:]):
                    if id(face2) in analyzed_faces:
                        continue
                        
                    center2 = face2.Center()
                    normal2 = face2.normalAt(center2)
                    
                    # Check if faces are parallel (opposite normals)
                    dot = normal1.x * normal2.x + normal1.y * normal2.y + normal1.z * normal2.z
                    
                    if dot < -0.85:  # Parallel faces with opposite normals
                        # Calculate distance between face centers
                        distance = ((center1.x - center2.x)**2 + 
                                  (center1.y - center2.y)**2 + 
                                  (center1.z - center2.z)**2)**0.5
                        
                        # This is likely a wall thickness
                        if 0.3 < distance < 20:  # Reasonable thickness range
                            face_pairs.append({
                                'thickness': distance,
                                'location': ((center1.x + center2.x)/2, 
                                           (center1.y + center2.y)/2,
                                           (center1.z + center2.z)/2),
                                'area': (area1 + area2) / 2
                            })
                            analyzed_faces.add(id(face1))
                            analyzed_faces.add(id(face2))
                            break
            
            # If we found face pairs, use them for analysis
            if face_pairs:
                # Weight by area to find representative thickness
                total_area = sum(p['area'] for p in face_pairs)
                weighted_thickness = sum(p['thickness'] * p['area'] for p in face_pairs) / total_area if total_area > 0 else avg_thickness
                
                # Analyze each significant wall
                for pair in face_pairs[:5]:  # Top 5 wall sections
                    thickness = pair['thickness']
                    location = pair['location']
                    
                    if thickness < self.min_wall_thickness:
                        issues.append(WallThicknessIssue(
                            location=location,
                            thickness=round(thickness, 2),
                            issue_type='too_thin',
                            severity='critical' if thickness < 0.5 else 'warning'
                        ))
                    elif thickness > self.max_wall_thickness:
                        issues.append(WallThicknessIssue(
                            location=location,
                            thickness=round(thickness, 2),
                            issue_type='too_thick',
                            severity='warning' if thickness < 6.0 else 'critical'
                        ))
            else:
                # Fallback to average thickness estimation
                center = bbox.center
                
                # Refine estimation based on bounding box
                min_dim = min(bbox.xlen, bbox.ylen, bbox.zlen)
                if min_dim < 10:  # If any dimension is small, it might be the thickness
                    avg_thickness = min(avg_thickness, min_dim)
                
                if avg_thickness < self.min_wall_thickness:
                    issues.append(WallThicknessIssue(
                        location=(center.x, center.y, center.z),
                        thickness=round(avg_thickness, 2),
                        issue_type='too_thin',
                        severity='critical' if avg_thickness < 0.5 else 'warning'
                    ))
                elif avg_thickness > self.max_wall_thickness:
                    issues.append(WallThicknessIssue(
                        location=(center.x, center.y, center.z),
                        thickness=round(avg_thickness, 2),
                        issue_type='too_thick',
                        severity='warning' if avg_thickness < 6.0 else 'critical'
                    ))
            
        except Exception as e:
            print(f"Error in wall thickness analysis: {e}")
        
        return issues
    
    def _analyze_geometry_issues(self, workplane, demolding_axis: str = 'z') -> List[GeometryIssue]:
        """Analyze various geometry issues for injection molding"""
        issues = []
        
        try:
            # Check overall height
            bbox = workplane.val().BoundingBox()
            if bbox.zlen > self.max_height:
                issues.append(GeometryIssue(
                    location=(bbox.center.x, bbox.center.y, bbox.zmax),
                    issue_type="excessive_height",
                    description=f"Hauteur de {bbox.zlen:.1f}mm dépasse la limite recommandée",
                    severity="warning",
                    recommendation="Réduire la hauteur ou diviser en plusieurs pièces"
                ))
            
            # Check for sharp edges (missing fillets)
            sharp_edges = self._find_sharp_edges(workplane)
            for edge_center in sharp_edges:
                issues.append(GeometryIssue(
                    location=edge_center,
                    issue_type="sharp_edge",
                    description="Arête vive détectée",
                    severity="warning",
                    recommendation="Ajouter un congé d'au moins 0.2mm"
                ))
            
            # Check for draft angles
            perpendicular_faces = self._find_perpendicular_faces(workplane, demolding_axis)
            for face_center in perpendicular_faces:
                axis_name = {'x': 'X', 'y': 'Y', 'z': 'Z'}[demolding_axis]
                issues.append(GeometryIssue(
                    location=face_center,
                    issue_type="missing_draft",
                    description="Face verticale sans dépouille détectée",
                    severity="critical",
                    recommendation="Ajouter un angle de dépouille d'au moins 0.5°"
                ))
            
            # Check for deep blind holes
            deep_holes = self._find_deep_blind_holes(workplane)
            for hole_center in deep_holes:
                issues.append(GeometryIssue(
                    location=hole_center,
                    issue_type="deep_blind_hole",
                    description="Trou borgne profond détecté",
                    severity="warning",
                    recommendation="Réduire la profondeur ou augmenter le diamètre"
                ))
            
        except Exception as e:
            print(f"Error in geometry analysis: {e}")
        
        return issues
    
    def _estimate_wall_thickness_at_point(self, workplane, center, normal) -> float:
        """Estimate wall thickness at a given point (simplified method)"""
        try:
            bbox = workplane.val().BoundingBox()
            avg_size = (bbox.xlen + bbox.ylen + bbox.zlen) / 3
            
            # Estimate thickness as a fraction of average size
            estimated_thickness = avg_size * 0.05  # 5% of average dimension
            
            return max(0.5, min(5.0, estimated_thickness))  # Clamp between 0.5-5mm
            
        except Exception as e:
            print(f"Error estimating wall thickness: {e}")
            return 2.0  # Default thickness
    
    def _classify_wall_thickness(self, thickness: float) -> str:
        """Classify wall thickness as acceptable, too_thin, or too_thick"""
        if thickness < 0.8:  # Less than 0.8mm is too thin for injection molding
            return 'too_thin'
        elif thickness > 6.0:  # More than 6mm is too thick for injection molding
            return 'too_thick'
        else:
            return 'acceptable'
    
    def _get_thickness_severity(self, thickness: float) -> str:
        """Get severity level for wall thickness"""
        if thickness < 0.5:
            return 'critical'
        elif thickness < self.min_wall_thickness or thickness > self.max_wall_thickness:
            return 'warning'
        else:
            return 'info'
    
    def _calculate_projected_area_robust(self, mesh, axis: str) -> float:
        """Calculate projected area using robust 2D projection with overlap handling"""
        try:
            vertices = mesh.vertices
            faces = mesh.faces
            
            # Project vertices onto 2D plane
            if axis.lower() == 'x':
                projected = vertices[:, [1, 2]]  # YZ plane
            elif axis.lower() == 'y':
                projected = vertices[:, [0, 2]]  # XZ plane  
            elif axis.lower() == 'z':
                projected = vertices[:, [0, 1]]  # XY plane
            else:
                raise ValueError(f"Invalid axis: {axis}")
            
            # Method 1: Sum of projected triangle areas
            total_area_triangles = 0.0
            for face in faces:
                v0, v1, v2 = projected[face]
                # Triangle area using cross product
                area = 0.5 * abs((v1[0] - v0[0]) * (v2[1] - v0[1]) - (v2[0] - v0[0]) * (v1[1] - v0[1]))
                total_area_triangles += area
            
            # Method 2: Convex hull area (fallback for validation)
            try:
                from scipy.spatial import ConvexHull
                if len(projected) >= 3:  # Need at least 3 points for hull
                    hull = ConvexHull(projected)
                    convex_hull_area = hull.volume  # In 2D, volume = area
                else:
                    convex_hull_area = 0.0
            except Exception:
                convex_hull_area = 0.0
            
            # Validation and selection
            if total_area_triangles > 0 and convex_hull_area > 0:
                ratio = total_area_triangles / convex_hull_area
                print(f"Axis {axis.upper()}: Triangles={total_area_triangles:.2f}, Hull={convex_hull_area:.2f}, Ratio={ratio:.1f}")
                
                # If ratio is too high, there's significant overlap - use a hybrid approach
                if ratio > 2.5:
                    # Use average weighted toward the more conservative estimate
                    result = (total_area_triangles + 2 * convex_hull_area) / 3
                    print(f"High overlap detected, using hybrid: {result:.2f}")
                    return result
                else:
                    return total_area_triangles
            elif total_area_triangles > 0:
                return total_area_triangles
            elif convex_hull_area > 0:
                return convex_hull_area
            else:
                return 0.0
                
        except Exception as e:
            print(f"Error in robust projection for axis {axis}: {e}")
            return 0.0
    
    def _find_sharp_edges(self, workplane) -> List[Tuple[float, float, float]]:
        """Find sharp edges that need fillets (simplified for performance)"""
        sharp_edges = []
        
        try:
            # Quick approximation: assume complex parts have sharp edges
            bbox = workplane.val().BoundingBox()
            edges = workplane.edges().vals()
            
            # If part has many edges, likely has sharp corners
            if len(edges) > 20:
                # Add a representative sharp edge at the corner
                sharp_edges.append((bbox.xmax, bbox.ymax, bbox.zmax))
            
        except Exception as e:
            print(f"Error finding sharp edges: {e}")
        
        return sharp_edges
    
    def _find_perpendicular_faces(self, workplane, demolding_axis: str) -> List[Tuple[float, float, float]]:
        """Find faces perpendicular to demolding axis that need draft angles"""
        perpendicular_faces = []
        
        try:
            faces = workplane.faces().vals()
            
            # Define the demolding direction vector
            demolding_vector = {
                'x': (1, 0, 0),
                'y': (0, 1, 0),
                'z': (0, 0, 1)
            }[demolding_axis]
            
            # Analyze each face
            for face in faces[:30]:  # Limit to first 30 faces for performance
                try:
                    center = face.Center()
                    normal = face.normalAt(center)
                    
                    # Calculate dot product between face normal and demolding direction
                    dot_product = (normal.x * demolding_vector[0] + 
                                 normal.y * demolding_vector[1] + 
                                 normal.z * demolding_vector[2])
                    
                    # If dot product is close to 0, face is perpendicular to demolding axis
                    # This means the face is parallel to the demolding direction (vertical wall)
                    if abs(dot_product) < 0.1:  # Tolerance for perpendicularity
                        # Check if it's a significant face (not too small)
                        area = face.Area()
                        if area > 10:  # Minimum area of 10 mm²
                            perpendicular_faces.append((center.x, center.y, center.z))
                            
                            # Limit the number of issues reported
                            if len(perpendicular_faces) >= 5:
                                break
                            
                except Exception:
                    continue
                    
        except Exception as e:
            print(f"Error finding perpendicular faces: {e}")
            
            # Fallback method if face analysis fails
            try:
                bbox = workplane.val().BoundingBox()
                
                # Check dimension along demolding axis
                if demolding_axis == 'x' and bbox.xlen > 10:
                    perpendicular_faces.append((bbox.center.x, bbox.center.y, bbox.center.z))
                elif demolding_axis == 'y' and bbox.ylen > 10:
                    perpendicular_faces.append((bbox.center.x, bbox.center.y, bbox.center.z))
                elif demolding_axis == 'z' and bbox.zlen > 10:
                    perpendicular_faces.append((bbox.center.x, bbox.center.y, bbox.center.z))
            except:
                pass
        
        return perpendicular_faces
    
    def _find_deep_blind_holes(self, workplane) -> List[Tuple[float, float, float]]:
        """Find deep blind holes that may cause molding issues (simplified for performance)"""
        deep_holes = []
        
        try:
            bbox = workplane.val().BoundingBox()
            volume = workplane.val().Volume()
            bbox_volume = bbox.xlen * bbox.ylen * bbox.zlen
            
            # If actual volume is much less than bounding box, likely has holes/cavities
            volume_ratio = volume / bbox_volume if bbox_volume > 0 else 1
            
            if volume_ratio < 0.7:  # Less than 70% solid
                deep_holes.append((bbox.center.x, bbox.center.y, bbox.center.z))
            
        except Exception as e:
            print(f"Error finding deep holes: {e}")
        
        return deep_holes
    
    def _calculate_overall_rating(self, dimensions: DimensionAnalysis, 
                                wall_issues: List[WallThicknessIssue],
                                geometry_issues: List[GeometryIssue]) -> Tuple[str, int]:
        """Calculate overall DFM rating"""
        
        # Start with perfect score
        score = 10
        
        # Deduct points for various issues
        critical_issues = len([i for i in wall_issues if i.severity == 'critical'])
        warning_issues = len([i for i in wall_issues if i.severity == 'warning'])
        
        critical_geo_issues = len([i for i in geometry_issues if i.severity == 'critical'])
        warning_geo_issues = len([i for i in geometry_issues if i.severity == 'warning'])
        
        # Deduct points
        score -= critical_issues * 2
        score -= warning_issues * 1
        score -= critical_geo_issues * 2
        score -= warning_geo_issues * 1
        
        # Check max wall thickness
        if dimensions.max_wall_thickness > 6:
            score -= 3  # Very thick walls are problematic  
        elif dimensions.max_wall_thickness < 0.8:
            score -= 2  # Very thin walls are problematic
        
        # Ensure score is within bounds
        score = max(1, min(10, score))
        
        # Convert to qualitative rating
        if score >= 8:
            overall = 'excellent'
        elif score >= 6:
            overall = 'good'
        elif score >= 4:
            overall = 'warning'
        else:
            overall = 'critical'
        
        return overall, score
    
    def _generate_recommendations(self, dimensions: DimensionAnalysis,
                                wall_issues: List[WallThicknessIssue],
                                geometry_issues: List[GeometryIssue]) -> List[str]:
        """Generate specific recommendations"""
        recommendations = []
        
        # Wall thickness recommendations
        thin_walls = len([i for i in wall_issues if i.issue_type == 'too_thin'])
        thick_walls = len([i for i in wall_issues if i.issue_type == 'too_thick'])
        
        if thin_walls > 0:
            recommendations.append(f"Augmenter l'épaisseur de {thin_walls} zone(s) trop fine(s) à minimum 0.8mm")
        
        if thick_walls > 0:
            recommendations.append(f"Réduire l'épaisseur de {thick_walls} zone(s) trop épaisse(s) pour éviter les retassures")
        
        # Geometry recommendations
        draft_issues = len([i for i in geometry_issues if i.issue_type == 'missing_draft'])
        if draft_issues > 0:
            recommendations.append("Ajouter des angles de dépouille de 0.5° minimum sur les faces verticales")
        
        sharp_edges = len([i for i in geometry_issues if i.issue_type == 'sharp_edge'])
        if sharp_edges > 0:
            recommendations.append("Ajouter des congés d'au moins 0.2mm sur les arêtes vives")
        
        # Max wall thickness recommendation
        if dimensions.max_wall_thickness > 6:
            recommendations.append("Épaisseur paroi critique (>6mm): réduire ou ajouter des nervures")
        elif dimensions.max_wall_thickness < 0.8:
            recommendations.append("Épaisseur paroi insuffisante (<0.8mm): renforcer la structure")
        elif 0.8 <= dimensions.max_wall_thickness <= 4:
            recommendations.append("Épaisseur paroi optimale pour injection plastique")
        
        # Material recommendations based on dimensions
        if dimensions.largest_dimension > 100:
            recommendations.append("Pièce volumineuse: privilégier PP ou PE pour réduire les contraintes")
        elif dimensions.smallest_dimension < 1:
            recommendations.append("Pièce fine: privilégier ABS ou PC pour rigidité")
        
        # Default recommendation if no issues
        if not recommendations:
            recommendations.append("Conception acceptable pour injection plastique")
        
        return recommendations
    
    def _create_error_report(self) -> DFMReport:
        """Create error report when analysis fails"""
        return DFMReport(
            dimensions=DimensionAnalysis(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10.0),
            wall_thickness_issues=[],
            geometry_issues=[GeometryIssue(
                location=(0, 0, 0),
                issue_type="analysis_error",
                description="Erreur lors de l'analyse DFM",
                severity="critical",
                recommendation="Vérifier le fichier STEP"
            )],
            overall_score='critical',
            moldability_rating=1,
            recommendations=["Impossible d'analyser le fichier - vérifier le format STEP"]
        )

def analyze_dfm(step_file_path: str, demolding_axis: str = 'z') -> DFMReport:
    """Convenience function to analyze a STEP file"""
    analyzer = DFMAnalyzer()
    return analyzer.analyze_step_file(step_file_path, demolding_axis)


def compute_projected_area(mesh, axis='z'):
    # Cette fonction va calculer la surface visible de ta pièce, vue depuis un axe (X, Y ou Z)

    # On définit ici quels axes garder selon la direction qu'on regarde
    axis_map = {
        'x': [1, 2],  # Si on regarde depuis X → on garde YZ
        'y': [0, 2],  # Si on regarde depuis Y → on garde XZ
        'z': [0, 1],  # Si on regarde depuis Z → on garde XY
    }

    if axis not in axis_map:
        raise ValueError("Axe invalide, choisis 'x', 'y' ou 'z'")

    # On va additionner les surfaces projetées
    projected_areas = []

    for face in mesh.faces:
        vertices = mesh.vertices[face]
        # On garde les 2 dimensions utiles
        projected = vertices[:, axis_map[axis]]

        # On récupère les 3 points du triangle
        v0, v1, v2 = projected

        # Formule pour calculer l'aire d'un triangle 2D
        area = 0.5 * abs(
            (v1[0] - v0[0]) * (v2[1] - v0[1]) -
            (v2[0] - v0[0]) * (v1[1] - v0[1])
        )

        projected_areas.append(area)

    return sum(projected_areas)
