
"""
DFM (Design for Manufacturing) Analyzer for Plastic Injection Molding
Analyzes STEP files for manufacturability issues and generates comprehensive reports.
"""

import os
import time
import resource
import logging
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:  # pragma: no cover
    from app.dfm.interfaces import DFMInput, DFMResult


def run_dfm(
    input: "DFMInput",
    progress_cb: Callable[[int], None] | None = None,
    fast_mode: bool = False,
) -> "DFMResult":
    """Analyse DFM minimale sans effets de bord."""

    logger = logging.getLogger(__name__)

    def _log(step: str, start_t: float) -> None:
        mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        logger.info("dfm %s dt=%.2fs rss=%.1fMB", step, time.perf_counter() - start_t, mem)

    t = time.perf_counter()
    if not os.path.exists(input.step_path):
        raise ValueError("STEP file not found")
    with open(input.step_path, "r", errors="ignore") as fh:
        head = fh.read(64)
        if "ISO-10303" not in head and "STEP" not in head:
            raise ValueError("invalid_step")
    if progress_cb:
        progress_cb(10)
    _log("load_step", t)

    import tempfile

    t = time.perf_counter()
    metrics = {
        "bounding_box": {"x": 0.0, "y": 0.0, "z": 0.0},
        "volume": 0.0,
        "surface_area": 0.0,
    }
    stl_path = None
    try:  # optional CadQuery usage
        import cadquery as cq  # lazy import
        workplane = cq.importers.importStep(input.step_path)
        shape = workplane.val()
        bbox = shape.BoundingBox()
        metrics = {
            "bounding_box": {"x": bbox.xlen, "y": bbox.ylen, "z": bbox.zlen},
            "volume": shape.Volume(),
            "surface_area": shape.Area(),
        }
        stl_fd, stl_path = tempfile.mkstemp(suffix=".stl")
        os.close(stl_fd)
        cq.exporters.export(workplane, stl_path)
    except Exception:
        pass
    if progress_cb:
        progress_cb(40)
    _log("metrics", t)

    from generate_3d_view import generate_view_data
    out_dir = os.path.join("static", "dfm", input.file_id)
    t = time.perf_counter()
    camera_states, heatmap_faces = generate_view_data(
        stl_path, input.file_id, progress_cb, fast_mode=fast_mode
    )
    _log("views_heatmap", t)

    from generate_thumbnails import generate_thumbnails
    t = time.perf_counter()
    thumbnails = generate_thumbnails(input.step_path, out_dir)
    _log("thumbnails", t)

    if stl_path and os.path.exists(stl_path):
        os.remove(stl_path)

    views = {"camera_states": camera_states, "thumbnails": thumbnails}
    heatmaps = {"faces": heatmap_faces} if heatmap_faces else {}

    import importlib.util, pathlib
    interfaces_path = pathlib.Path(__file__).resolve().parent / "app" / "dfm" / "interfaces.py"
    spec = importlib.util.spec_from_file_location("dfm_interfaces", interfaces_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    DFMResult = module.DFMResult

    flags = {"partial": True} if fast_mode else {}
    return DFMResult(
        metrics=metrics,
        issues=[],
        heatmaps=heatmaps,
        views=views,
        report_paths={},
        flags=flags,
    )

from dataclasses import dataclass
from typing import List, Dict, Tuple, Optional
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
    low_res: bool = False

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
    avg_thickness: float = 0.0
    min_thickness: float = 0.0
    thickness_histogram: List[Tuple[float, float, int]] | None = None
    thickness_per_face: List[Dict[str, float]] | None = None
    draft_ok_ratio: float = 0.0
    min_radius: float = 0.0

class DFMAnalyzer:
    """Main DFM analyzer class with intelligent contextual analysis"""
    
    def __init__(self, material_type: str = 'GENERIC'):
        """
        Initialize analyzer with material-specific thresholds
        
        Args:
            material_type: Type of plastic material (PP, PE, ABS, PC, PA66, POM, PS, GENERIC)
        """
        # Import material profiles
        from models import MATERIAL_PROFILES
        
        # Get material profile or use generic
        self.material_profile = MATERIAL_PROFILES.get(material_type.upper(), MATERIAL_PROFILES['GENERIC'])
        self.material_type = material_type.upper()
        
        # DFM thresholds adapted to material
        self.min_wall_thickness = self.material_profile['min_wall_thickness']
        self.max_wall_thickness = self.material_profile['max_wall_thickness']
        self.optimal_wall_thickness_min = self.material_profile['optimal_wall_thickness_min']
        self.optimal_wall_thickness_max = self.material_profile['optimal_wall_thickness_max']
        
        # Generic thresholds for injection molding
        self.max_height = 100.0  # mm
        self.min_draft_angle = 0.5  # degrees
        self.min_radius = 0.2  # mm
        self.max_blind_hole_depth_ratio = 10.0  # depth/diameter ratio
        
        # Contextual analysis parameters
        self.thickness_tolerance_percentage = 0.15  # 15% de tolérance pour zones isolées
        self.minimum_significant_area = 10.0  # mm² - aire minimale pour considérer un défaut
        
    def analyze_step_file(self, step_file_path: str, demould_axis: dict | str = 'z', material_type: str = None) -> DFMReport:
        """Complete DFM analysis of a STEP file."""
        try:
            axis_info = self._normalize_axis(demould_axis)
            workplane = cq.importers.importStep(step_file_path)

            dimensions = self._analyze_dimensions(workplane, axis_info['axis'])
            wall_issues = self._analyze_wall_thickness(workplane)
            geometry_issues = self._analyze_geometry_issues(workplane, axis_info)

            overall_score, moldability_rating = self._calculate_overall_rating(
                dimensions, wall_issues, geometry_issues
            )

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
            import traceback
            print(f"Traceback: {traceback.format_exc()}")
            return self._create_error_report()

    def _normalize_axis(self, demould_axis):
        axis = 'z'
        direction = 1
        vec = None
        if isinstance(demould_axis, dict):
            axis = demould_axis.get('axis', 'Z').lower()
            direction = demould_axis.get('direction', 1) or 1
            if axis == 'vector':
                vec = demould_axis.get('vector') or [0, 0, 1]
        elif isinstance(demould_axis, str):
            axis = demould_axis.lower()
        return {'axis': axis, 'direction': direction, 'vector': vec}
    
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
            
            # LOGIQUE INTELLIGENTE D'ÉPAISSEUR DOMINANTE
            dimensions = [x_size, y_size, z_size]
            dimensions_sorted = sorted(dimensions)
            smallest_dim = dimensions_sorted[0]
            middle_dim = dimensions_sorted[1]
            largest_dim = dimensions_sorted[2]
            
            # Calcul des ratios d'aspect pour identifier le type de pièce
            aspect_ratio_1 = largest_dim / smallest_dim if smallest_dim > 0 else 1000
            aspect_ratio_2 = middle_dim / smallest_dim if smallest_dim > 0 else 1000
            
            # ANALYSE CONTEXTUELLE DU TYPE DE PIÈCE
            if aspect_ratio_1 > 5 and aspect_ratio_2 > 3:
                # PLAQUE MINCE : exemple 100×100×3 mm
                # L'épaisseur dominante est clairement la plus petite dimension
                dominant_thickness = smallest_dim
                print(f"🔍 Type détecté: PLAQUE MINCE - Épaisseur dominante = {dominant_thickness:.2f}mm")
                
            elif aspect_ratio_1 > 10 and aspect_ratio_2 < 2:
                # PROFILÉ/POUTRE : exemple 200×20×15 mm
                # L'épaisseur est probablement la dimension moyenne ou petite
                dominant_thickness = min(smallest_dim, middle_dim * 0.5)
                print(f"🔍 Type détecté: PROFILÉ - Épaisseur estimée = {dominant_thickness:.2f}mm")
                
            elif aspect_ratio_1 < 3:
                # PIÈCE CUBIQUE/VOLUMIQUE : exemple 50×40×35 mm
                # Utilise le rapport volume/surface pour estimer l'épaisseur moyenne
                if surface_area > 0:
                    volume_surface_ratio = volume / surface_area
                    # Pour une pièce creuse, ce ratio donne une estimation de l'épaisseur
                    dominant_thickness = min(volume_surface_ratio * 6, smallest_dim * 0.8)
                else:
                    dominant_thickness = smallest_dim * 0.4
                print(f"🔍 Type détecté: VOLUMIQUE - Épaisseur estimée = {dominant_thickness:.2f}mm")
                
            else:
                # PIÈCE COMPLEXE : utilise une approche hybride
                # Combine l'analyse dimensionnelle et le rapport volume/surface
                thickness_from_dims = smallest_dim if smallest_dim < 10 else smallest_dim * 0.3
                thickness_from_volume = (volume / surface_area * 6) if surface_area > 0 else 3.0
                dominant_thickness = (thickness_from_dims + thickness_from_volume) / 2
                print(f"🔍 Type détecté: COMPLEXE - Épaisseur hybride = {dominant_thickness:.2f}mm")
            
            # Ajustement selon l'axe de démoulage spécifié
            if demolding_axis.lower() == 'z' and z_size == smallest_dim:
                dominant_thickness = z_size
                print(f"   Ajustement démoulage Z: épaisseur = {dominant_thickness:.2f}mm")
                
            # Bornes intelligentes selon le matériau
            if hasattr(self, 'material_profile'):
                min_allowed = self.material_profile['min_wall_thickness'] * 0.8  # Tolérance
                max_allowed = self.material_profile['max_wall_thickness'] * 1.5  # Tolérance
                dominant_thickness = max(min_allowed, min(dominant_thickness, max_allowed))
            else:
                # Bornes génériques pour injection plastique
                dominant_thickness = max(0.5, min(dominant_thickness, 12.0))
                
            max_wall_thickness = dominant_thickness
            
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
                
                # Nettoyage du mesh pour de bons calculs (seulement pour les modèles de taille raisonnable)
                if len(mesh.faces) < 200000:
                    try:
                        mesh.remove_duplicate_faces()
                        mesh.remove_degenerate_faces()
                        mesh.remove_unreferenced_vertices()
                        
                        # Fix normals if needed
                        if not mesh.is_winding_consistent:
                            mesh.fix_normals()
                    except Exception as e:
                        print(f"Warning: Could not clean mesh: {e}")
                        # Continue with original mesh if cleaning fails
                else:
                    print(f"Skipping mesh cleaning for large model ({len(mesh.faces)} faces) to avoid timeout")
                
                # Ensure we have a single watertight component
                # Skip split operation for very large meshes to avoid timeouts
                if len(mesh.faces) < 100000 and hasattr(mesh, 'split') and callable(mesh.split):
                    try:
                        components = mesh.split(only_watertight=False)
                        if len(components) > 0:
                            # Take largest component by volume
                            mesh = max(components, key=lambda m: m.volume if hasattr(m, 'volume') else 0)
                    except Exception as e:
                        print(f"Warning: Could not split mesh components: {e}")
                        # Continue with original mesh if split fails
                
                mesh.rezero()
                
                print(f"Cleaned mesh: {len(mesh.faces)} faces, {len(mesh.vertices)} vertices")
                print(f"Mesh volume: {mesh.volume:.2f} mm³")
                print(f"Mesh surface area: {mesh.area:.2f} mm²")
                
                # Calculate projected areas using improved method
                projected_area_x = self._calculate_projected_area_robust(mesh, 'x') / 2.0
                projected_area_y = self._calculate_projected_area_robust(mesh, 'y') / 2.0
                projected_area_z = self._calculate_projected_area_robust(mesh, 'z') / 2.0
                
                print(f"Projected areas - X: {projected_area_x:.2f}, Y: {projected_area_y:.2f}, Z: {projected_area_z:.2f}")
                
                # Skip debug visualization to avoid timeout
                # Debug visualization disabled for performance
                
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
            # Quick check if this is a very large model - use simplified analysis
            try:
                faces = workplane.faces().vals()
                if len(faces) > 1000:  # Large model - use simplified analysis
                    print(f"Large model detected ({len(faces)} faces), using simplified wall thickness analysis")
                    return self._analyze_wall_thickness_simplified(workplane)
            except:
                # If we can't count faces, assume it's complex and use simplified method
                print("Could not count faces, using simplified wall thickness analysis")
                return self._analyze_wall_thickness_simplified(workplane)
            
            # Standard analysis for smaller models
            edges = workplane.edges().vals()
            bbox = workplane.val().BoundingBox()
            
            # Calculate volume and surface area for better estimation (only for small models)
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
    
    def _analyze_wall_thickness_simplified(self, workplane) -> List[WallThicknessIssue]:
        """Simplified wall thickness analysis for large models to avoid timeouts"""
        issues = []
        
        try:
            # Get basic bounding box only (fast operation)
            bbox = workplane.val().BoundingBox()
            
            # Estimate average wall thickness based on smallest dimension
            # This is a conservative estimation for large models
            dimensions = [bbox.xlen, bbox.ylen, bbox.zlen]
            min_dim = min(dimensions)
            max_dim = max(dimensions)
            
            # For complex models, estimate based on dimension ratios
            if max_dim / min_dim > 10:  # Long/thin part
                estimated_thickness = min_dim * 0.8  # Conservative estimate
            else:  # More cubic part
                estimated_thickness = min_dim * 0.15  # Very conservative estimate
            
            # Clamp to reasonable range for injection molding
            estimated_thickness = max(0.5, min(estimated_thickness, 10.0))
            
            print(f"Simplified analysis: estimated wall thickness = {estimated_thickness:.2f}mm")
            
            # Create simplified issues based on estimation
            center_location = (bbox.center.x, bbox.center.y, bbox.center.z)
            
            if estimated_thickness < self.min_wall_thickness:
                issues.append(WallThicknessIssue(
                    location=center_location,
                    thickness=round(estimated_thickness, 2),
                    issue_type='too_thin',
                    severity='critical' if estimated_thickness < 0.6 else 'warning'
                ))
            elif estimated_thickness > self.max_wall_thickness:
                issues.append(WallThicknessIssue(
                    location=center_location,
                    thickness=round(estimated_thickness, 2),
                    issue_type='too_thick',
                    severity='warning' if estimated_thickness < 6.0 else 'critical'
                ))
            
            print(f"Simplified wall thickness analysis complete, found {len(issues)} issues")
            
        except Exception as e:
            print(f"Error in simplified wall thickness analysis: {e}")
        
        return issues
    
    def _analyze_geometry_issues(self, workplane, axis_info: dict | str = 'z') -> List[GeometryIssue]:
        """Analyze various geometry issues for injection molding"""
        issues = []

        try:
            if isinstance(axis_info, str):
                axis_info = self._normalize_axis(axis_info)
            # Quick check if this is a very large model - use simplified analysis
            try:
                faces = workplane.faces().vals()
                if len(faces) > 1000:
                    print(f"Large model detected ({len(faces)} faces), using simplified geometry analysis")
                    return self._analyze_geometry_issues_simplified(workplane, axis_info)
            except:
                print("Could not count faces, using simplified geometry analysis")
                return self._analyze_geometry_issues_simplified(workplane, axis_info)

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
            perpendicular_faces = self._find_perpendicular_faces(workplane, axis_info)
            for face_center in perpendicular_faces:
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
    
    def _analyze_geometry_issues_simplified(self, workplane, axis_info: dict | str = 'z') -> List[GeometryIssue]:
        """Simplified geometry analysis for large models to avoid timeouts"""
        issues = []

        try:
            if isinstance(axis_info, str):
                axis_info = self._normalize_axis(axis_info)
            bbox = workplane.val().BoundingBox()

            axis_length = bbox.zlen if axis_info['axis'] == 'z' else (
                bbox.ylen if axis_info['axis'] == 'y' else bbox.xlen
            )
            
            if axis_length > self.max_height:
                center_location = (bbox.center.x, bbox.center.y, bbox.center.z)
                issues.append(GeometryIssue(
                    location=center_location,
                    issue_type="excessive_height",
                    description=f"Hauteur de {axis_length:.1f}mm dépasse la limite recommandée",
                    severity="warning",
                    recommendation="Réduire la hauteur ou diviser en plusieurs pièces"
                ))
            
            # For large models, add general recommendations without detailed analysis
            dimensions = [bbox.xlen, bbox.ylen, bbox.zlen]
            max_dim = max(dimensions)
            min_dim = min(dimensions)
            
            # Check aspect ratio
            if max_dim / min_dim > 20:  # Very elongated part
                center_location = (bbox.center.x, bbox.center.y, bbox.center.z)
                issues.append(GeometryIssue(
                    location=center_location,
                    issue_type="high_aspect_ratio",
                    description=f"Rapport d'aspect élevé ({max_dim/min_dim:.1f}:1)",
                    severity="warning",
                    recommendation="Considérer diviser la pièce ou renforcer les sections fines"
                ))
            
            # Add general recommendations for complex models
            center_location = (bbox.center.x, bbox.center.y, bbox.center.z)
            issues.append(GeometryIssue(
                location=center_location,
                issue_type="complex_geometry",
                description="Modèle complexe - vérification détaillée recommandée",
                severity="info",
                recommendation="Vérifier manuellement les congés, dépouilles et épaisseurs"
            ))
            
            print(f"Simplified geometry analysis complete, found {len(issues)} issues")
            
        except Exception as e:
            print(f"Error in simplified geometry analysis: {e}")
        
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
        """Calculate projected area using fast approximation to avoid timeouts"""
        try:
            faces = mesh.faces
            num_faces = len(faces)
            
            # For very large meshes (>500K faces), use bounding box approximation only
            if num_faces > 500000:
                print(f"Very large mesh ({num_faces} faces), using bounding box approximation")
                bbox = mesh.bounding_box
                if axis.lower() == 'x':
                    return bbox.extents[1] * bbox.extents[2]  # Y*Z
                elif axis.lower() == 'y':
                    return bbox.extents[0] * bbox.extents[2]  # X*Z
                elif axis.lower() == 'z':
                    return bbox.extents[0] * bbox.extents[1]  # X*Y
                else:
                    return bbox.extents[0] * bbox.extents[1]
            
            # For large meshes (>50K faces), use fast convex hull with vertex sampling
            if num_faces > 50000:
                print(f"Large mesh ({num_faces} faces), using sampled convex hull")
                vertices = mesh.vertices
                
                # Project vertices onto 2D plane
                if axis.lower() == 'x':
                    projected = vertices[:, [1, 2]]  # YZ plane
                elif axis.lower() == 'y':
                    projected = vertices[:, [0, 2]]  # XZ plane  
                elif axis.lower() == 'z':
                    projected = vertices[:, [0, 1]]  # XY plane
                else:
                    projected = vertices[:, [0, 1]]
                
                # Sample vertices for convex hull to speed up calculation
                try:
                    if len(projected) > 5000:
                        sample_indices = np.random.choice(len(projected), 5000, replace=False)
                        sampled_projected = projected[sample_indices]
                    else:
                        sampled_projected = projected
                    
                    from scipy.spatial import ConvexHull
                    if len(sampled_projected) >= 3:
                        hull = ConvexHull(sampled_projected)
                        return hull.volume  # In 2D, volume = area
                except Exception as e:
                    print(f"Convex hull failed: {e}")
                
                # Fallback to bounding box for large meshes
                min_coords = np.min(projected, axis=0)
                max_coords = np.max(projected, axis=0)
                return (max_coords[0] - min_coords[0]) * (max_coords[1] - min_coords[1])
            
            # For medium meshes, use simple convex hull
            vertices = mesh.vertices
            if axis.lower() == 'x':
                projected = vertices[:, [1, 2]]  # YZ plane
            elif axis.lower() == 'y':
                projected = vertices[:, [0, 2]]  # XZ plane  
            elif axis.lower() == 'z':
                projected = vertices[:, [0, 1]]  # XY plane
            else:
                projected = vertices[:, [0, 1]]
            
            try:
                from scipy.spatial import ConvexHull
                if len(projected) >= 3:
                    hull = ConvexHull(projected)
                    return hull.volume  # In 2D, volume = area
            except Exception:
                pass
            
            # Final fallback: bounding box
            min_coords = np.min(projected, axis=0)
            max_coords = np.max(projected, axis=0)
            return (max_coords[0] - min_coords[0]) * (max_coords[1] - min_coords[1])
                
        except Exception as e:
            print(f"Error in projection calculation for axis {axis}: {e}")
            # Ultimate fallback to bounding box
            try:
                bbox = mesh.bounding_box
                if axis.lower() == 'x':
                    return bbox.extents[1] * bbox.extents[2]  # Y*Z
                elif axis.lower() == 'y':
                    return bbox.extents[0] * bbox.extents[2]  # X*Z
                elif axis.lower() == 'z':
                    return bbox.extents[0] * bbox.extents[1]  # X*Y
                else:
                    return 1000.0
            except:
                return 1000.0
    
    def _find_sharp_edges(self, workplane) -> List[Tuple[float, float, float]]:
        """Find edges forming sharp angles between faces using CadQuery"""
        sharp_edges = []

        try:
            shape = workplane.val()
            for edge in shape.Edges():
                try:
                    # Skip curved edges (already filleted)
                    if edge.geomType() != "LINE":
                        continue

                    faces_comp = edge.ancestors(shape, "Face")
                    faces = faces_comp.Faces()
                    if len(faces) < 2:
                        continue

                    f1, f2 = faces[0], faces[1]
                    n1 = f1.normalAt(f1.Center())
                    n2 = f2.normalAt(f2.Center())

                    dot = max(-1.0, min(1.0, n1.dot(n2)))
                    angle = math.degrees(math.acos(dot))

                    # Consider edges with angle < 150° as sharp
                    if angle < 150.0 and edge.Length() > 0.5:
                        c = edge.Center()
                        sharp_edges.append((c.x, c.y, c.z))

                except Exception:
                    continue

        except Exception as e:
            print(f"Error finding sharp edges: {e}")

        return sharp_edges
    
    def _find_perpendicular_faces(self, workplane, axis_info: dict | str) -> List[Tuple[float, float, float]]:
        """Find planar faces nearly parallel to the demolding direction"""
        perpendicular_faces = []

        try:
            if isinstance(axis_info, str):
                axis_info = self._normalize_axis(axis_info)
            if axis_info['vector']:
                v = axis_info['vector']
                axis_vec = cq.Vector(v[0], v[1], v[2]).normalized()
            else:
                axis_vec = {
                    'x': cq.Vector(1, 0, 0),
                    'y': cq.Vector(0, 1, 0),
                    'z': cq.Vector(0, 0, 1)
                }[axis_info['axis']] * axis_info['direction']

            for face in workplane.val().Faces():
                try:
                    if face.geomType() != "PLANE":
                        continue

                    center = face.Center()
                    normal = face.normalAt(center)
                    dot = abs(normal.dot(axis_vec))

                    if dot < 0.1 and face.Area() > 10.0:
                        perpendicular_faces.append((center.x, center.y, center.z))

                except Exception:
                    continue

        except Exception as e:
            print(f"Error finding perpendicular faces: {e}")

        return perpendicular_faces
    
    def _find_deep_blind_holes(self, workplane) -> List[Tuple[float, float, float]]:
        """Detect cylindrical blind holes with high depth/diameter ratio"""
        deep_holes = []

        try:
            shape = workplane.val()
            for face in shape.Faces():
                try:
                    if face.geomType() != "CYLINDER":
                        continue

                    circular_edges = [e for e in face.Edges() if e.geomType() == "CIRCLE"]
                    if len(circular_edges) != 2:
                        continue

                    centers = [e.Center() for e in circular_edges]
                    radius = circular_edges[0].radius()

                    depth = centers[0].sub(centers[1]).Length
                    if radius <= 0:
                        continue

                    ratio = depth / (2 * radius)
                    if ratio > self.max_blind_hole_depth_ratio:
                        mid = centers[0].add(centers[1]).multiply(0.5)
                        deep_holes.append((mid.x, mid.y, mid.z))

                except Exception:
                    continue

        except Exception as e:
            print(f"Error finding deep holes: {e}")

        return deep_holes
    
    def _calculate_overall_rating(self, dimensions: DimensionAnalysis, 
                                wall_issues: List[WallThicknessIssue],
                                geometry_issues: List[GeometryIssue]) -> Tuple[str, int]:
        """
        NOUVEAU SYSTÈME DE NOTATION INTELLIGENT ET CONTEXTUEL
        Prend en compte le contexte global de la pièce et non des défauts isolés
        """
        
        # Score de base selon l'épaisseur dominante
        score = 10.0
        
        # ANALYSE CONTEXTUELLE DE L'ÉPAISSEUR DOMINANTE
        thickness = dimensions.max_wall_thickness
        
        # Adaptation selon le matériau
        if hasattr(self, 'material_profile'):
            min_thickness = self.material_profile['min_wall_thickness']
            max_thickness = self.material_profile['max_wall_thickness']
            optimal_min = self.material_profile['optimal_wall_thickness_min']
            optimal_max = self.material_profile['optimal_wall_thickness_max']
        else:
            min_thickness = 0.8
            max_thickness = 4.0
            optimal_min = 1.2
            optimal_max = 3.0
        
        # SCORING INTELLIGENT DE L'ÉPAISSEUR
        if optimal_min <= thickness <= optimal_max:
            # Épaisseur optimale : pas de pénalité
            thickness_penalty = 0
            print(f"✅ Épaisseur dominante {thickness:.2f}mm OPTIMALE pour {self.material_type}")
        elif min_thickness <= thickness < optimal_min:
            # Un peu fin mais acceptable
            thickness_penalty = (optimal_min - thickness) / optimal_min * 1.5
            print(f"⚠️ Épaisseur {thickness:.2f}mm légèrement fine mais acceptable")
        elif optimal_max < thickness <= max_thickness:
            # Un peu épais mais acceptable
            if self.material_profile.get('tolerates_thick_walls', False):
                thickness_penalty = (thickness - optimal_max) / max_thickness * 0.8  # Moins sévère
            else:
                thickness_penalty = (thickness - optimal_max) / max_thickness * 1.5
            print(f"⚠️ Épaisseur {thickness:.2f}mm légèrement épaisse")
        elif thickness < min_thickness:
            # Trop fin - problématique
            severity = 'high' if self.material_profile.get('sensitivity_to_thin_walls') == 'high' else 'medium'
            thickness_penalty = 2.0 if severity == 'high' else 1.5
            print(f"❌ Épaisseur {thickness:.2f}mm TROP FINE pour injection")
        else:  # thickness > max_thickness
            # Trop épais
            if self.material_profile.get('tolerates_thick_walls', False):
                thickness_penalty = 1.5  # Matériau tolère mieux
            else:
                thickness_penalty = 2.5  # Problématique
            print(f"❌ Épaisseur {thickness:.2f}mm TROP ÉPAISSE - risque de retassures")
        
        score -= thickness_penalty
        
        # ANALYSE PONDÉRÉE DES PROBLÈMES D'ÉPAISSEUR LOCAUX
        if wall_issues:
            # Calcul du pourcentage de zones problématiques
            total_issues = len(wall_issues)
            critical_issues = len([i for i in wall_issues if i.severity == 'critical'])
            warning_issues = len([i for i in wall_issues if i.severity == 'warning'])
            
            # Pondération contextuelle : ne pas sur-pénaliser quelques défauts isolés
            if total_issues <= 2:
                # Peu de défauts : impact minimal
                wall_penalty = critical_issues * 0.3 + warning_issues * 0.1
                print(f"📊 {total_issues} zone(s) d'épaisseur problématique(s) - impact minimal")
            elif total_issues <= 5:
                # Quelques défauts : impact modéré
                wall_penalty = critical_issues * 0.5 + warning_issues * 0.2
                print(f"📊 {total_issues} zones problématiques - impact modéré")
            else:
                # Nombreux défauts : impact significatif
                wall_penalty = critical_issues * 0.8 + warning_issues * 0.3
                print(f"📊 {total_issues} zones problématiques - impact significatif")
            
            score -= wall_penalty
        
        # ANALYSE INTELLIGENTE DES PROBLÈMES GÉOMÉTRIQUES
        draft_issues = [i for i in geometry_issues if i.issue_type == 'missing_draft']
        fillet_issues = [i for i in geometry_issues if i.issue_type == 'sharp_edge']
        hole_issues = [i for i in geometry_issues if i.issue_type == 'deep_blind_hole']
        height_issues = [i for i in geometry_issues if i.issue_type == 'excessive_height']
        
        # DÉPOUILLE : Pondération proportionnelle
        if draft_issues:
            draft_count = len(draft_issues)
            # Estimation : si plus de 5 faces sans dépouille, c'est significatif
            if draft_count >= 5:
                draft_penalty = 2.0  # Problème majeur
                print(f"❌ {draft_count} faces sans dépouille - PROBLÉMATIQUE")
            elif draft_count >= 3:
                draft_penalty = 1.0  # Problème modéré
                print(f"⚠️ {draft_count} faces sans dépouille - à corriger")
            else:
                draft_penalty = 0.3  # Problème mineur
                print(f"📌 {draft_count} face(s) sans dépouille - impact limité")
            score -= draft_penalty
        
        # CONGÉS : Seuil de tolérance
        if fillet_issues:
            fillet_count = len(fillet_issues)
            if fillet_count >= 10:
                # Aucun congé sur la pièce : problématique
                fillet_penalty = 1.5
                print(f"❌ {fillet_count} arêtes vives - manque total de congés")
            elif fillet_count >= 5:
                # Plusieurs congés manquants
                fillet_penalty = 0.8
                print(f"⚠️ {fillet_count} arêtes vives - congés insuffisants")
            else:
                # Quelques congés manquants : acceptable
                fillet_penalty = 0.2
                print(f"📌 {fillet_count} arête(s) vive(s) - acceptable")
            score -= fillet_penalty
        
        # AUTRES PROBLÈMES
        if hole_issues:
            score -= len(hole_issues) * 0.3  # Impact modéré par trou
            
        if height_issues:
            score -= len(height_issues) * 0.5  # Impact significatif
        
        # BONUS POUR CONCEPTION OPTIMALE
        # Si la pièce a peu ou pas de défauts, bonus
        total_issues = len(wall_issues) + len(geometry_issues)
        if total_issues == 0:
            score += 0.5  # Bonus conception parfaite
            print("🌟 Conception sans défaut détecté - BONUS!")
        elif total_issues <= 3:
            score += 0.2  # Petit bonus
            print("✨ Très peu de défauts - bonne conception")
        
        # AJUSTEMENT FINAL SELON LA TAILLE DE LA PIÈCE
        if dimensions.largest_dimension > 200:
            # Grande pièce : plus de tolérance sur certains défauts
            score += 0.3
            print("📏 Grande pièce - ajustement de tolérance appliqué")
        elif dimensions.smallest_dimension < 2:
            # Pièce très fine : vérifier la faisabilité
            score -= 0.5
            print("📏 Pièce très fine - attention à la faisabilité")
        
        # Bornes du score final
        score = max(1.0, min(10.0, score))
        
        # Conversion en note entière et rating qualitatif
        int_score = int(round(score))
        
        # SEUILS AJUSTÉS POUR ÊTRE PLUS RÉALISTES
        if int_score >= 9:
            overall = 'excellent'
            print(f"🎯 Score final: {int_score}/10 - EXCELLENT")
        elif int_score >= 7:
            overall = 'good'
            print(f"✅ Score final: {int_score}/10 - BON")
        elif int_score >= 5:
            overall = 'warning'
            print(f"⚠️ Score final: {int_score}/10 - ATTENTION REQUISE")
        else:
            overall = 'critical'
            print(f"❌ Score final: {int_score}/10 - RÉVISION NÉCESSAIRE")
        
        return overall, int_score
    
    def _generate_recommendations(self, dimensions: DimensionAnalysis,
                                wall_issues: List[WallThicknessIssue],
                                geometry_issues: List[GeometryIssue]) -> List[str]:
        """
        Génère des recommandations INTELLIGENTES et CONTEXTUELLES
        Adaptées au matériau et au type de pièce
        """
        recommendations = []
        
        # ANALYSE CONTEXTUELLE DE L'ÉPAISSEUR DOMINANTE
        thickness = dimensions.max_wall_thickness
        material_name = self.material_profile.get('name', 'Matériau générique') if hasattr(self, 'material_profile') else 'Matériau générique'
        
        # Recommandations sur l'épaisseur dominante
        if hasattr(self, 'material_profile'):
            optimal_min = self.material_profile['optimal_wall_thickness_min']
            optimal_max = self.material_profile['optimal_wall_thickness_max']
            
            if thickness < optimal_min:
                if self.material_type == 'PA66':
                    recommendations.append(f"⚡ Épaisseur {thickness:.1f}mm fine pour {material_name} : risque de déformation au démoulage. Cible : {optimal_min}-{optimal_max}mm")
                else:
                    recommendations.append(f"📏 Augmenter l'épaisseur dominante de {thickness:.1f}mm à {optimal_min}mm minimum pour {material_name}")
            elif thickness > optimal_max:
                if self.material_profile.get('tolerates_thick_walls'):
                    recommendations.append(f"💡 Épaisseur {thickness:.1f}mm acceptable pour {material_name}, mais surveiller le temps de cycle (+{dimensions.cooling_time:.0f}s)")
                else:
                    recommendations.append(f"⚠️ Réduire l'épaisseur de {thickness:.1f}mm à {optimal_max}mm max ou ajouter des nervures de renfort")
        
        # RECOMMANDATIONS PROPORTIONNELLES AUX PROBLÈMES
        # Épaisseurs locales
        thin_walls = [i for i in wall_issues if i.issue_type == 'too_thin']
        thick_walls = [i for i in wall_issues if i.issue_type == 'too_thick']
        
        if thin_walls:
            count = len(thin_walls)
            if count > 5:
                recommendations.append(f"🔴 {count} zones trop fines détectées : révision globale de la conception nécessaire")
            elif count > 2:
                recommendations.append(f"🟡 {count} zones fines : renforcer localement ou utiliser des nervures")
            else:
                recommendations.append(f"🟢 {count} zone(s) fine(s) ponctuelle(s) : impact limité, renforcer si critique")
        
        # Problèmes de dépouille - PONDÉRATION INTELLIGENTE
        draft_issues = [i for i in geometry_issues if i.issue_type == 'missing_draft']
        if draft_issues:
            count = len(draft_issues)
            if count >= 5:
                recommendations.append(f"🔴 {count} faces sans dépouille : ajouter 1-2° sur TOUTES les faces verticales")
            elif count >= 3:
                recommendations.append(f"🟡 {count} faces sans dépouille : corriger les principales faces d'éjection")
            else:
                recommendations.append(f"🟢 {count} face(s) sans dépouille : impact mineur si hors zone critique")
        
        # Congés - SEUIL DE TOLÉRANCE
        sharp_edges = [i for i in geometry_issues if i.issue_type == 'sharp_edge']
        if sharp_edges:
            count = len(sharp_edges)
            if count >= 10:
                recommendations.append(f"🔴 Aucun congé détecté ({count} arêtes) : ajouter R0.3-0.5mm sur TOUTES les arêtes")
            elif count >= 5:
                recommendations.append(f"🟡 {count} arêtes vives : ajouter des congés sur les zones de contrainte")
            else:
                recommendations.append(f"🟢 {count} arête(s) vive(s) : acceptable si zones non critiques")
        
        # RECOMMANDATIONS SELON LE TYPE DE PIÈCE
        aspect_ratio = dimensions.largest_dimension / dimensions.smallest_dimension if dimensions.smallest_dimension > 0 else 100
        
        if aspect_ratio > 10:
            # Pièce très allongée ou fine
            recommendations.append("📐 Pièce à fort ratio d'aspect : prévoir maintiens/supports pendant l'injection")
            if self.material_type in ['PP', 'PE']:
                recommendations.append("💡 Matériau souple : risque de déformation, considérer PA ou ABS pour plus de rigidité")
        
        # Temps de cycle
        if dimensions.cooling_time > 30:
            recommendations.append(f"⏱️ Temps de refroidissement élevé ({dimensions.cooling_time:.0f}s) : optimiser l'épaisseur ou le circuit de refroidissement")
        
        # RECOMMANDATIONS SPÉCIFIQUES AU MATÉRIAU
        if hasattr(self, 'material_type'):
            if self.material_type == 'PA66' and dimensions.surface_area > 10000:
                recommendations.append("💧 PA66 + grande surface : prévoir séchage matière (4h à 80°C) et moule chauffé")
            elif self.material_type in ['PC', 'ABS'] and thickness < 1.5:
                recommendations.append("⚡ PC/ABS en paroi fine : température moule élevée (80-120°C) pour bon remplissage")
            elif self.material_type in ['PP', 'PE'] and sharp_edges:
                recommendations.append("🔄 PP/PE + arêtes vives : congés généreux (R0.5mm+) pour éviter les concentrations de contrainte")
        
        # Surface projetée et force de fermeture
        max_projected = max(dimensions.projected_area_x, dimensions.projected_area_y, dimensions.projected_area_z)
        if max_projected > 10000:  # 100 cm²
            force_fermeture = max_projected * 0.5  # Estimation 0.5 tonne/cm²
            recommendations.append(f"🏭 Grande surface projetée ({max_projected/100:.0f}cm²) : presse >{force_fermeture:.0f}T nécessaire")
        
        # RECOMMANDATION FINALE POSITIVE
        if len(recommendations) <= 2:
            recommendations.append("✅ Conception globalement adaptée à l'injection plastique - optimisations mineures suggérées")
        elif len(recommendations) <= 4:
            recommendations.append("📋 Plusieurs améliorations suggérées mais conception viable avec ajustements")
        
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

def analyze_dfm(step_file_path: str, demould_axis: dict | str = 'z', material_type: str = 'GENERIC') -> DFMReport:
    """Analyse simplifiée basée sur les utilitaires de ``step_loader``."""

    from .adapters.step_loader import (
        load_mesh,
        compute_thickness,
        compute_projected_area,
        compute_draft,
        find_small_radii,
        detect_undercuts,
    )
    import numpy as np

    axis_dict = (
        demould_axis
        if isinstance(demould_axis, dict)
        else {"x": 0.0, "y": 0.0, "z": 1.0 if demould_axis == "z" else 0.0}
    )
    axis_vec = np.array([axis_dict.get("x", 0.0), axis_dict.get("y", 0.0), axis_dict.get("z", 1.0)])

    mesh, low_res = load_mesh(step_file_path)

    bbox = mesh.extents
    avg_t, min_t, hist, per_face = compute_thickness(mesh)
    draft_ratio, draft_issues = compute_draft(mesh, tuple(axis_vec), 1.0)
    min_radius, radius_issues = find_small_radii(mesh)
    undercuts = detect_undercuts(mesh, tuple(axis_vec))

    dimensions = DimensionAnalysis(
        x_max=float(bbox[0]),
        y_max=float(bbox[1]),
        z_max=float(bbox[2]),
        volume=float(mesh.volume),
        surface_area=float(mesh.area),
        largest_dimension=float(max(bbox)),
        smallest_dimension=float(min(bbox)),
        max_wall_thickness=avg_t,
        projected_area_x=compute_projected_area(mesh, (1.0, 0.0, 0.0)),
        projected_area_y=compute_projected_area(mesh, (0.0, 1.0, 0.0)),
        projected_area_z=compute_projected_area(mesh, (0.0, 0.0, 1.0)),
        cooling_time=0.0,
        low_res=low_res,
    )

    issues = []
    for i in draft_issues:
        issues.append(
            GeometryIssue(
                location=i["point"],
                issue_type="draft",
                description="Insufficient draft",
                severity="warning",
                recommendation="Augmenter la dépouille",
            )
        )
    for i in radius_issues:
        issues.append(
            GeometryIssue(
                location=i["point"],
                issue_type="radius",
                description="Petit rayon",
                severity="warning",
                recommendation="Augmenter le rayon",
            )
        )
    for i in undercuts:
        issues.append(
            GeometryIssue(
                location=i["point"],
                issue_type="undercut",
                description="Contre-dépouille",
                severity="error",
                recommendation="Revoir le sens de démoulage",
            )
        )

    return DFMReport(
        dimensions=dimensions,
        wall_thickness_issues=[],
        geometry_issues=issues,
        overall_score="good",
        moldability_rating=8,
        recommendations=[],
        avg_thickness=avg_t,
        min_thickness=min_t,
        thickness_histogram=hist,
        thickness_per_face=per_face,
        draft_ok_ratio=draft_ratio,
        min_radius=min_radius,
    )


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
