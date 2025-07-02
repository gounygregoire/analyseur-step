import os
import logging
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory, session, Response, redirect, url_for, flash
from flask_cors import CORS
from flask_migrate import Migrate
from werkzeug.utils import secure_filename
import cadquery as cq
import uuid
import time
from pathlib import Path
from datetime import datetime
from models import db, ConversionJob, UserSession, User, OAuth
from dfm_analyzer import analyze_dfm, DFMReport
from material_recommender import recommend_materials_for_questionnaire
from flask_login import LoginManager, login_required, current_user

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

# Initialize Flask-Login
login_manager = LoginManager(app)
login_manager.login_view = 'auth.login'
login_manager.login_message = 'Veuillez vous connecter pour accéder à cette page.'

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(user_id)

# Create database tables
with app.app_context():
    db.create_all()

# Register authentication blueprints
from auth import auth_bp
from google_auth import google_auth_bp
from stripe_payment import stripe_bp

app.register_blueprint(auth_bp, url_prefix='/auth')
app.register_blueprint(google_auth_bp)
app.register_blueprint(stripe_bp, url_prefix='/stripe')

# Make session permanent
@app.before_request
def make_session_permanent():
    session.permanent = True

def allowed_file(filename):
    """Check if file extension is allowed"""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/')
def landing():
    """Landing page"""
    return render_template('landing.html')

@app.route('/app')
@login_required
def index():
    """Redirect to upload page for backward compatibility"""
    return redirect(url_for('upload_page'))

@app.route('/upload')
@login_required
def upload_page():
    """Page for file upload"""
    return render_template('upload.html')

@app.route('/result/<conversion_id>')
@login_required
def result_page(conversion_id):
    """Page showing analysis results and 3D viewer"""
    conversion = ConversionJob.query.filter_by(id=conversion_id, user_id=current_user.id).first()
    if not conversion:
        flash('Conversion non trouvée', 'error')
        return redirect(url_for('upload_page'))
    
    return render_template('result.html', conversion=conversion)

@app.route('/pricing')
def pricing():
    """Page des tarifs"""
    return render_template('pricing.html')

@app.route('/upload', methods=['POST'])
@login_required
def upload_file():
    """Handle STEP file upload and conversion"""
    # Vérifier les crédits/abonnement
    if not current_user.has_access():
        return jsonify({
            'success': False,
            'error': 'Vous n\'avez plus de crédits. Achetez des crédits ou souscrivez à un abonnement.'
        }), 403
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
        
        # Adaptive tolerance for large files to improve performance
        file_size_mb = step_size / (1024 * 1024)
        if file_size_mb > 10:
            # For large files, adjust tolerance to avoid creating too many triangles
            if file_size_mb > 25:
                min_tolerance = 1.0  # Très haute tolérance pour fichiers > 25MB
            elif file_size_mb > 20:
                min_tolerance = 0.8  # Haute tolérance pour fichiers > 20MB  
            elif file_size_mb > 10:
                min_tolerance = 0.5  # Tolérance moyenne pour fichiers > 10MB
            else:
                min_tolerance = 0.3  # Tolérance normale pour petits fichiers
            
            tolerance = max(tolerance, min_tolerance)
            logger.info(f"File size: {file_size_mb:.1f}MB, adjusted tolerance to {tolerance} for performance")
        
        # Create database record
        conversion_job = ConversionJob(
            id=file_id,
            user_id=current_user.id if current_user.is_authenticated else None,
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
                'id': file_id,
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
    """Serve STL files for 3D viewer with chunked streaming for large files"""
    try:
        file_path = os.path.join(app.config['CONVERTED_FOLDER'], filename)
        if not os.path.exists(file_path):
            return jsonify({'error': 'Fichier non trouvé'}), 404
        
        file_size = os.path.getsize(file_path)
        
        # For large files (>10MB), use chunked streaming
        if file_size > 10 * 1024 * 1024:
            # Check if file is too large (>100MB)
            if file_size > 100 * 1024 * 1024:
                logger.warning(f"File {filename} is very large ({file_size / (1024*1024):.1f}MB)")
            
            def generate():
                with open(file_path, 'rb') as f:
                    while True:
                        # Use larger chunks for very large files
                        chunk_size = 65536 if file_size > 50 * 1024 * 1024 else 16384
                        data = f.read(chunk_size)
                        if not data:
                            break
                        yield data
            
            response = Response(generate(), mimetype='application/octet-stream')
            response.headers['Content-Length'] = str(file_size)
            response.headers['Content-Disposition'] = f'inline; filename={filename}'
            # Add cache headers to improve performance
            response.headers['Cache-Control'] = 'public, max-age=3600'
            return response
        else:
            # For smaller files, use normal send_from_directory
            return send_from_directory(app.config['CONVERTED_FOLDER'], filename, 
                                     mimetype='application/octet-stream')
    except Exception as e:
        logger.error(f"Error serving file {filename}: {str(e)}")
        return jsonify({'error': 'Erreur lors du chargement du fichier'}), 500

@app.route('/api/conversions')
def get_conversions():
    """Get list of conversion jobs - limited to 5 most recent for current user"""
    try:
        # Filter by current user if logged in
        if current_user.is_authenticated:
            conversions = ConversionJob.query.filter_by(user_id=current_user.id).order_by(ConversionJob.created_at.desc()).limit(5).all()
        else:
            # Return empty list for non-authenticated users
            conversions = []
        
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
        
        # Check user authentication and credits
        if current_user.is_authenticated:
            if not current_user.has_access():
                logger.warning(f"User {current_user.id} has no credits left")
                return jsonify({
                    'success': False,
                    'error': 'Crédits insuffisants. Veuillez acheter des crédits ou vous abonner.'
                }), 403
        
        logger.info(f"Starting DFM analysis for job {conversion_id} with demolding axis: {demolding_axis}")
        
        # Perform DFM analysis
        dfm_report = analyze_dfm(step_path, demolding_axis)
        
        if dfm_report is None:
            logger.error("DFM analysis returned None")
            return jsonify({
                'success': False,
                'error': 'Échec de l\'analyse DFM'
            }), 500
        
        # Deduct credit after successful analysis
        if current_user.is_authenticated:
            current_user.use_credit()
            logger.info(f"Credit used. User {current_user.id} has {current_user.credits} credits remaining")
        
        # Update database with DFM results
        conversion_job.dfm_score = dfm_report.moldability_rating
        conversion_job.dfm_issues_count = len(dfm_report.wall_thickness_issues) + len(dfm_report.geometry_issues)
        conversion_job.dfm_overall_rating = dfm_report.overall_score
        db.session.commit()
        
        logger.info(f"DFM Analysis completed - Score: {dfm_report.moldability_rating}/10, Rating: {dfm_report.overall_score}")
        
        # Prepare DFM data
        dfm_data = {
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
        
        # Store only essential DFM data in session (avoid cookie size limit)
        session[f'dfm_analysis_{conversion_id}'] = {
            'overall_score': dfm_data['rating'],
            'moldability_rating': dfm_data['score'],
            'generated_at': datetime.utcnow().isoformat()
        }
        session.permanent = True
        
        return jsonify({
            'success': True,
            'dfm_analysis': dfm_data
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
        
        # Get STEP file path
        step_path = os.path.join(app.config['UPLOAD_FOLDER'], conversion_job.step_filename)
        if not os.path.exists(step_path):
            return jsonify({'error': 'Fichier STEP non trouvé'}), 404
        
        # Re-analyze DFM to get full data for PDF generation
        from dfm_analyzer import analyze_dfm
        
        # Get demolding axis from request or use default
        request_data = request.get_json() or {}
        demolding_axis = request_data.get('demolding_axis', 'z')
        material_type = request_data.get('material_type', 'GENERIC')
        
        # Perform DFM analysis
        dfm_report = analyze_dfm(step_path, demolding_axis, material_type)
        
        # Check if analysis was successful
        if not dfm_report:
            return jsonify({'error': 'Échec de l\'analyse DFM'}), 500
        
        # Convert DFM report to dict format
        try:
            dfm_data = {
                'overall_score': getattr(dfm_report, 'overall_score', 'critical'),
                'moldability_rating': getattr(dfm_report, 'moldability_rating', 1),
                'dimensions': {
                    'x': getattr(dfm_report.dimensions, 'x_max', 0),
                    'y': getattr(dfm_report.dimensions, 'y_max', 0),
                    'z': getattr(dfm_report.dimensions, 'z_max', 0),
                    'volume': getattr(dfm_report.dimensions, 'volume', 0),
                    'max_wall_thickness': getattr(dfm_report.dimensions, 'max_wall_thickness', 0),
                    'projected_area_x': getattr(dfm_report.dimensions, 'projected_area_x', 0),
                    'projected_area_y': getattr(dfm_report.dimensions, 'projected_area_y', 0),
                    'projected_area_z': getattr(dfm_report.dimensions, 'projected_area_z', 0),
                    'cooling_time': getattr(dfm_report.dimensions, 'cooling_time', 0)
                },
                'wall_thickness_issues': [
                    {
                        'location': list(issue.location),
                        'thickness': issue.thickness,
                        'type': issue.issue_type,
                        'severity': issue.severity
                    } for issue in getattr(dfm_report, 'wall_thickness_issues', [])
                ],
                'geometry_issues': [
                    {
                        'location': list(issue.location),
                        'type': issue.issue_type,
                        'description': issue.description,
                        'severity': issue.severity,
                        'recommendation': issue.recommendation
                    } for issue in getattr(dfm_report, 'geometry_issues', [])
                ],
                'recommendations': getattr(dfm_report, 'recommendations', [])
            }
        except AttributeError as e:
            logger.error(f"Error accessing DFM report attributes: {e}")
            return jsonify({'error': f'Erreur lors du traitement des données DFM: {str(e)}'}), 500
        
        # Generate PDF
        pdf_filename = f"rapport_dfm_{conversion_id}.pdf"
        pdf_path = os.path.join('reports', pdf_filename)
        
        # Create reports directory if it doesn't exist
        os.makedirs('reports', exist_ok=True)
        
        # Get material recommendations from session if available
        material_recommendations = session.get('material_recommendations', [])
        
        generated_path = generate_dfm_pdf_report(
            dfm_data, 
            step_path, 
            pdf_path, 
            conversion_job.original_filename,
            material_recommendations
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

@app.route('/download/zip/<conversion_id>')
@login_required
def download_zip(conversion_id):
    """Generate and download a ZIP file with all analysis data"""
    import zipfile
    import json
    from io import BytesIO
    
    try:
        # Récupérer les données de conversion
        conversion = ConversionJob.query.get(conversion_id)
        if not conversion:
            return jsonify({'error': 'Conversion non trouvée'}), 404
        
        # Créer un fichier ZIP en mémoire
        zip_buffer = BytesIO()
        
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            # 1. Ajouter le fichier STEP original
            step_path = os.path.join(UPLOAD_FOLDER, conversion.step_filename)
            if os.path.exists(step_path):
                zip_file.write(step_path, f"original/{conversion.original_filename}")
            
            # 2. Générer et ajouter le rapport PDF
            pdf_filename = f"rapport_dfm_{conversion_id}.pdf"
            pdf_path = os.path.join('reports', pdf_filename)
            
            # Générer le PDF automatiquement si les données DFM existent
            dfm_session_key = f'dfm_analysis_{conversion_id}'
            if dfm_session_key in session:
                try:
                    import pdf_generator
                    
                    dfm_data = session[dfm_session_key]
                    material_recommendations = session.get('material_recommendations', [])
                    
                    # Générer le PDF
                    pdf_path = f"reports/rapport_dfm_{conversion_id}.pdf"
                    pdf_filename = pdf_generator.generate_dfm_pdf_report(
                        dfm_data,
                        step_path,
                        pdf_path,
                        conversion.original_filename,
                        material_recommendations
                    )
                    logger.info(f"PDF generated for ZIP: {pdf_filename}")
                except Exception as pdf_error:
                    logger.error(f"PDF generation failed for ZIP: {pdf_error}")
            
            # Ajouter le PDF au ZIP s'il existe maintenant
            if os.path.exists(pdf_path):
                zip_file.write(pdf_path, f"rapport_dfm_{conversion_id}.pdf")
                logger.info(f"PDF added to ZIP: {pdf_path}")
            else:
                logger.warning(f"PDF not found for ZIP: {pdf_path}")
            
            # 3. Créer et ajouter le fichier d'analyse JSON
            analysis_data = {
                'conversion_id': conversion_id,
                'original_filename': conversion.original_filename,
                'created_at': conversion.created_at.isoformat(),
                'status': conversion.status,
                'analysis': {}
            }
            
            # Récupérer l'analyse DFM complète depuis la session
            dfm_session_key = f'dfm_analysis_{conversion_id}'
            if dfm_session_key in session:
                analysis_data['analysis'] = session[dfm_session_key]
            
            # Ajouter les métriques de base
            analysis_data['metrics'] = {
                'dfm_score': conversion.dfm_score,
                'dfm_issues_count': conversion.dfm_issues_count,
                'dfm_overall_rating': conversion.dfm_overall_rating,
                'step_file_size': conversion.step_file_size,
                'stl_file_size': conversion.stl_file_size
            }
            
            # Convertir en JSON et ajouter au ZIP
            json_data = json.dumps(analysis_data, indent=2, ensure_ascii=False)
            zip_file.writestr('analysis/dfm_analysis.json', json_data)
            
            # 4. Ajouter un fichier README
            readme_content = f"""CADlytics - Analyse DFM
========================

Fichier: {conversion.original_filename}
Date d'analyse: {conversion.created_at.strftime('%Y-%m-%d %H:%M:%S')}
Score DFM: {conversion.dfm_score}/10
Évaluation: {conversion.dfm_overall_rating or 'N/A'}

Contenu de l'archive:
- original/ : Fichier STEP original
- reports/ : Rapport PDF détaillé
- analysis/ : Données d'analyse au format JSON

Pour plus d'informations, visitez CADlytics.

Créé par Grégoire GOUNY
"""
            zip_file.writestr('README.txt', readme_content)
        
        # Préparer le téléchargement
        zip_buffer.seek(0)
        
        return send_file(
            zip_buffer,
            mimetype='application/zip',
            as_attachment=True,
            download_name=f'cadlytics_analysis_{conversion_id}.zip'
        )
        
    except Exception as e:
        logger.error(f"Error creating ZIP file: {str(e)}")
        return jsonify({'error': 'Erreur lors de la création du fichier ZIP'}), 500

@app.route('/api/material-recommendations', methods=['POST'])
def get_material_recommendations():
    """Get material recommendations based on questionnaire and DFM data"""
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({'error': 'Données manquantes'}), 400
        
        questionnaire_data = data.get('questionnaire', {})
        conversion_id = data.get('conversion_id')
        
        # Get material recommendations without DFM data for now
        recommendations = recommend_materials_for_questionnaire(questionnaire_data, {})
        
        # Store material recommendations in session for later use in PDF
        session['material_recommendations'] = recommendations
        
        logger.info(f"Generated {len(recommendations)} material recommendations")
        
        return jsonify({
            'success': True,
            'recommendations': recommendations,
            'questionnaire_summary': questionnaire_data
        })
        
    except Exception as e:
        logger.error(f"Material recommendations error: {str(e)}")
        return jsonify({'error': f'Erreur lors de la génération des recommandations: {str(e)}'}), 500

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
