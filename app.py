import os
import logging
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from flask_migrate import Migrate
from werkzeug.utils import secure_filename
import cadquery as cq
import uuid
import time
from pathlib import Path
from datetime import datetime
from models import db, ConversionJob, UserSession
from dfm_analyzer import analyze_dfm, DFMReport

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Create Flask app
app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET", "dev-secret-key-change-in-production")

# Enable CORS for API endpoints
CORS(app)

# Database configuration
database_url = os.environ.get("DATABASE_URL")
if not database_url:
    raise RuntimeError("DATABASE_URL environment variable is not set")

app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_recycle": 300,
    "pool_pre_ping": True,
}

# Initialize database
db.init_app(app)
migrate = Migrate(app, db)

# Configuration
UPLOAD_FOLDER = 'uploads'
CONVERTED_FOLDER = 'converted'
ALLOWED_EXTENSIONS = {'step', 'stp'}
MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50MB max file size

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['CONVERTED_FOLDER'] = CONVERTED_FOLDER
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

# Ensure directories exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(CONVERTED_FOLDER, exist_ok=True)

# Create database tables
with app.app_context():
    db.create_all()

def allowed_file(filename):
    """Check if file extension is allowed"""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/')
def landing():
    """Landing page"""
    return render_template('landing.html')

@app.route('/app')
def index():
    """Main page with file upload and 3D viewer"""
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_file():
    """Handle STEP file upload and conversion"""
    try:
        # Check if file is present
        if 'file' not in request.files:
            return jsonify({'error': 'Aucun fichier sélectionné'}), 400
        
        file = request.files['file']
        
        if file.filename == '':
            return jsonify({'error': 'Aucun fichier sélectionné'}), 400
        
        if not allowed_file(file.filename):
            return jsonify({'error': 'Type de fichier invalide. Seuls les fichiers STEP (.step, .stp) sont autorisés'}), 400
        
        # Get tolerance parameter
        tolerance = float(request.form.get('tolerance', 0.1))
        if tolerance <= 0 or tolerance > 1:
            tolerance = 0.1
        
        # Generate unique filename
        file_id = str(uuid.uuid4())
        original_filename = secure_filename(file.filename)
        step_filename = f"{file_id}_{original_filename}"
        stl_filename = f"{file_id}.stl"
        
        # Save uploaded file
        step_path = os.path.join(app.config['UPLOAD_FOLDER'], step_filename)
        file.save(step_path)
        step_size = os.path.getsize(step_path)
        
        logger.info(f"Saved STEP file: {step_path}")
        
        # Create database record
        conversion_job = ConversionJob(
            id=file_id,
            original_filename=original_filename,
            step_filename=step_filename,
            stl_filename=stl_filename,
            tolerance=tolerance,
            step_file_size=step_size,
            status='processing'
        )
        db.session.add(conversion_job)
        db.session.commit()
        
        # Convert STEP to STL using CadQuery
        try:
            logger.info(f"Starting STEP to STL conversion with tolerance: {tolerance}")
            
            # Import STEP file with timeout handling
            import signal
            
            def timeout_handler(signum, frame):
                raise TimeoutError("La conversion prend trop de temps")
            
            # Set timeout based on file size (larger files need more time)
            file_size_mb = step_size / (1024 * 1024)
            timeout_seconds = max(30, min(300, int(file_size_mb * 3)))  # 3 seconds per MB, max 5 minutes
            
            signal.signal(signal.SIGALRM, timeout_handler)
            signal.alarm(timeout_seconds)
            
            try:
                result = cq.importers.importStep(step_path)
                
                if result is None:
                    raise Exception("Échec de l'importation du fichier STEP - le fichier peut être corrompu ou invalide")
                
                # Export to STL
                stl_path = os.path.join(app.config['CONVERTED_FOLDER'], stl_filename)
                
                # Create workplane and export to STL using correct CadQuery API
                if hasattr(result, 'val'):
                    # If result is a Workplane, get the solid
                    solid = result.val()
                else:
                    # If result is already a solid/shape
                    solid = result
                
                # Export using cq.exporters
                cq.exporters.export(solid, stl_path, tolerance=tolerance)
            finally:
                # Cancel the alarm
                signal.alarm(0)
            
            logger.info(f"Successfully converted to STL: {stl_path}")
            
            # Verify STL file was created
            if not os.path.exists(stl_path):
                raise Exception("Le fichier STL n'a pas été créé")
            
            # Get STL file size and update database (without DFM analysis for now)
            stl_size = os.path.getsize(stl_path)
            
            conversion_job.stl_file_size = stl_size
            conversion_job.status = 'completed'
            conversion_job.completed_at = datetime.utcnow()
            db.session.commit()
            
            return jsonify({
                'success': True,
                'file_id': file_id,
                'stl_filename': stl_filename,
                'original_filename': original_filename,
                'tolerance': tolerance,
                'step_size': step_size,
                'stl_size': stl_size,
                'message': f'Fichier converti avec succès. Tolérance: {tolerance}'
            })
            
        except Exception as e:
            logger.error(f"Conversion error: {str(e)}")
            # Update database with error
            conversion_job.status = 'failed'
            conversion_job.error_message = str(e)
            conversion_job.completed_at = datetime.utcnow()
            db.session.commit()
            
            # Clean up uploaded file on conversion failure
            if os.path.exists(step_path):
                os.remove(step_path)
            return jsonify({'error': f'Échec de la conversion : {str(e)}'}), 500
            
    except Exception as e:
        logger.error(f"Upload error: {str(e)}")
        return jsonify({'error': f'Échec du téléchargement : {str(e)}'}), 500



@app.route('/view/<filename>')
def view_file(filename):
    """Serve STL files for 3D viewer"""
    try:
        return send_from_directory(app.config['CONVERTED_FOLDER'], filename, 
                                 mimetype='application/octet-stream')
    except FileNotFoundError:
        return jsonify({'error': 'Fichier non trouvé'}), 404

@app.route('/api/conversions')
def get_conversions():
    """Get list of conversion jobs - limited to 5 most recent"""
    try:
        # Always return only the 5 most recent conversions
        conversions = ConversionJob.query.order_by(ConversionJob.created_at.desc()).limit(5).all()
        
        return jsonify({
            'conversions': [job.to_dict() for job in conversions],
            'total': len(conversions),
            'pages': 1,
            'current_page': 1
        })
    except Exception as e:
        logger.error(f"Error fetching conversions: {str(e)}")
        return jsonify({'error': 'Échec de la récupération des conversions'}), 500

@app.route('/api/conversions/<conversion_id>')
def get_conversion(conversion_id):
    """Get specific conversion job details"""
    try:
        conversion = ConversionJob.query.get_or_404(conversion_id)
        return jsonify(conversion.to_dict())
    except Exception as e:
        logger.error(f"Error fetching conversion {conversion_id}: {str(e)}")
        return jsonify({'error': 'Conversion non trouvée'}), 404

@app.route('/api/analyze-dfm/<conversion_id>', methods=['POST'])
def analyze_dfm_endpoint(conversion_id):
    """Separate endpoint for DFM analysis"""
    try:
        logger.info(f"DFM analysis request received for conversion {conversion_id}")
        
        # Get request data
        data = request.get_json() or {}
        demolding_axis = data.get('demolding_axis', 'z')
        
        logger.info(f"Demolding axis: {demolding_axis}")
        
        # Get conversion job from database
        conversion_job = ConversionJob.query.get(conversion_id)
        if not conversion_job:
            logger.error(f"Conversion job not found: {conversion_id}")
            return jsonify({
                'success': False,
                'error': 'Job de conversion non trouvé'
            }), 404
        
        if conversion_job.status != 'completed':
            logger.error(f"Conversion job not completed: {conversion_job.status}")
            return jsonify({
                'success': False,
                'error': 'La conversion doit être terminée avant l\'analyse DFM'
            }), 400
        
        # Get STEP file path
        step_path = os.path.join(app.config['UPLOAD_FOLDER'], conversion_job.step_filename)
        if not os.path.exists(step_path):
            logger.error(f"STEP file not found: {step_path}")
            return jsonify({
                'success': False,
                'error': 'Fichier STEP non trouvé'
            }), 404
        
        logger.info(f"Starting DFM analysis for job {conversion_id} with demolding axis: {demolding_axis}")
        
        # Perform DFM analysis
        dfm_report = analyze_dfm(step_path, demolding_axis)
        
        if dfm_report is None:
            logger.error("DFM analysis returned None")
            return jsonify({
                'success': False,
                'error': 'Échec de l\'analyse DFM'
            }), 500
        
        # Update database with DFM results
        conversion_job.dfm_score = dfm_report.moldability_rating
        conversion_job.dfm_issues_count = len(dfm_report.wall_thickness_issues) + len(dfm_report.geometry_issues)
        conversion_job.dfm_overall_rating = dfm_report.overall_score
        db.session.commit()
        
        logger.info(f"DFM Analysis completed - Score: {dfm_report.moldability_rating}/10, Rating: {dfm_report.overall_score}")
        
        return jsonify({
            'success': True,
            'dfm_analysis': {
                'score': dfm_report.moldability_rating,
                'rating': dfm_report.overall_score,
                'issues_count': len(dfm_report.wall_thickness_issues) + len(dfm_report.geometry_issues),
                'dimensions': {
                    'x': round(dfm_report.dimensions.x_max, 2),
                    'y': round(dfm_report.dimensions.y_max, 2),
                    'z': round(dfm_report.dimensions.z_max, 2),
                    'volume': round(dfm_report.dimensions.volume, 2),
                    'max_wall_thickness': round(dfm_report.dimensions.max_wall_thickness, 2),
                    'projected_area_x': round(dfm_report.dimensions.projected_area_x, 2),
                    'projected_area_y': round(dfm_report.dimensions.projected_area_y, 2),
                    'projected_area_z': round(dfm_report.dimensions.projected_area_z, 2),
                    'cooling_time': round(dfm_report.dimensions.cooling_time, 1)
                },
                'recommendations': dfm_report.recommendations[:3],  # First 3 recommendations
                'wall_thickness_issues': [
                    {
                        'location': issue.location,
                        'thickness': issue.thickness,
                        'issue_type': issue.issue_type,
                        'severity': issue.severity
                    } for issue in dfm_report.wall_thickness_issues[:5]  # Limit to 5 issues
                ],
                'geometry_issues': [
                    {
                        'location': issue.location,
                        'issue_type': issue.issue_type,
                        'description': issue.description,
                        'severity': issue.severity,
                        'recommendation': issue.recommendation
                    } for issue in dfm_report.geometry_issues[:5]  # Limit to 5 issues
                ]
            }
        })
        
    except Exception as e:
        logger.error(f"DFM Analysis error: {str(e)}")
        return jsonify({'error': f'Erreur lors de l\'analyse DFM: {str(e)}'}), 500

@app.route('/api/generate-pdf/<conversion_id>', methods=['POST'])
def generate_pdf_report(conversion_id):
    """Generate PDF report for DFM analysis"""
    try:
        from pdf_generator import generate_dfm_pdf_report
        
        # Get conversion job from database
        conversion_job = ConversionJob.query.get(conversion_id)
        if not conversion_job:
            return jsonify({'error': 'Job de conversion non trouvé'}), 404
        
        if conversion_job.status != 'completed':
            return jsonify({'error': 'La conversion doit être terminée'}), 400
            
        if not conversion_job.dfm_score:
            return jsonify({'error': 'L\'analyse DFM doit être effectuée avant la génération du rapport'}), 400
        
        # Get STEP file path for re-analysis
        step_path = os.path.join(app.config['UPLOAD_FOLDER'], conversion_job.step_filename)
        if not os.path.exists(step_path):
            return jsonify({'error': 'Fichier STEP non trouvé'}), 404
        
        # Perform fresh DFM analysis to get complete data
        dfm_report = analyze_dfm(step_path)
        
        # Prepare DFM data for PDF
        dfm_data = {
            'score': dfm_report.moldability_rating,
            'rating': dfm_report.overall_score,
            'issues_count': len(dfm_report.wall_thickness_issues) + len(dfm_report.geometry_issues),
            'dimensions': {
                'x': round(dfm_report.dimensions.x_max, 2),
                'y': round(dfm_report.dimensions.y_max, 2),
                'z': round(dfm_report.dimensions.z_max, 2),
                'volume': round(dfm_report.dimensions.volume, 2),
                'max_wall_thickness': round(dfm_report.dimensions.max_wall_thickness, 2)
            },
            'recommendations': dfm_report.recommendations,
            'wall_thickness_issues': [
                {
                    'location': issue.location,
                    'thickness': issue.thickness,
                    'issue_type': issue.issue_type,
                    'severity': issue.severity
                } for issue in dfm_report.wall_thickness_issues
            ],
            'geometry_issues': [
                {
                    'location': issue.location,
                    'issue_type': issue.issue_type,
                    'description': issue.description,
                    'severity': issue.severity,
                    'recommendation': issue.recommendation
                } for issue in dfm_report.geometry_issues
            ]
        }
        
        # Generate PDF
        pdf_filename = f"rapport_dfm_{conversion_id}.pdf"
        pdf_path = os.path.join('reports', pdf_filename)
        
        # Create reports directory if it doesn't exist
        os.makedirs('reports', exist_ok=True)
        
        # Use STEP file path for 3D views generation
        step_file_path = os.path.join(app.config['UPLOAD_FOLDER'], conversion_job.step_filename)
        
        generated_path = generate_dfm_pdf_report(
            dfm_data, 
            step_file_path, 
            pdf_path, 
            conversion_job.original_filename
        )
        
        logger.info(f"PDF report generated: {generated_path}")
        
        return jsonify({
            'success': True,
            'pdf_filename': pdf_filename,
            'message': 'Rapport PDF généré avec succès'
        })
        
    except Exception as e:
        logger.error(f"PDF generation error: {str(e)}")
        return jsonify({'error': f'Erreur lors de la génération du PDF: {str(e)}'}), 500

@app.route('/download-pdf/<filename>')
def download_pdf(filename):
    """Download generated PDF report"""
    try:
        pdf_path = os.path.join('reports', filename)
        if not os.path.exists(pdf_path):
            return jsonify({'error': 'Fichier PDF non trouvé'}), 404
        
        return send_file(pdf_path, as_attachment=True, download_name=filename)
        
    except Exception as e:
        logger.error(f"PDF download error: {str(e)}")
        return jsonify({'error': 'Erreur lors du téléchargement'}), 500

@app.route('/health')
def health_check():
    """Health check endpoint"""
    try:
        # Test database connection
        db.session.execute(db.text('SELECT 1'))
        db_status = True
    except Exception as e:
        logger.error(f"Database health check failed: {str(e)}")
        db_status = False
    
    return jsonify({
        'status': 'sain',
        'database': db_status,
        'cadquery_available': True,
        'upload_folder': os.path.exists(UPLOAD_FOLDER),
        'converted_folder': os.path.exists(CONVERTED_FOLDER)
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
