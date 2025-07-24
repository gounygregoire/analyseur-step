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
from heatmap import generate_heatmap
from material_recommender import recommend_materials_for_questionnaire
from flask_login import LoginManager, login_required, current_user
from translations import get_translation, get_all_translations
from log import log_action
from flask_dance.contrib.google import make_google_blueprint, google
from dotenv import load_dotenv
from kombu.exceptions import OperationalError as KombuOperationalError
from redis.exceptions import ConnectionError as RedisConnectionError
load_dotenv()

# Create Flask app once
app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET", os.getenv("SECRET_KEY", "dev"))

app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

# OAuth Blueprint - CONFIGURATION CORRIGÉE
google_bp = make_google_blueprint(
    client_id=os.getenv("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_OAUTH_CLIENT_SECRET"),
    scope=["profile", "email"],
    redirect_url="https://cadlytics.app/google_login/authorized"  # 👈 explicit
)

app.register_blueprint(google_bp, url_prefix="/auth")

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Enable CORS for API endpoints
CORS(app)

# Session configuration to prevent large cookies
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100MB max file size
# Execute Celery tasks synchronously when no worker is running
app.config['CELERY_TASK_ALWAYS_EAGER'] = os.getenv('CELERY_TASK_ALWAYS_EAGER', 'False').lower() == 'true'

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

# Celery pour traiter les conversions en arrière-plan
from celery import Celery

def make_celery(flask_app):
    broker = os.getenv('CELERY_BROKER_URL', 'redis://localhost:6379/0')
    celery = Celery(flask_app.import_name, broker=broker, backend=broker)
    celery.conf.update(flask_app.config)
    celery.conf.update(task_always_eager=flask_app.config['CELERY_TASK_ALWAYS_EAGER'])

    class ContextTask(celery.Task):
        def __call__(self, *args, **kwargs):
            with flask_app.app_context():
                return super().__call__(*args, **kwargs)

    celery.Task = ContextTask
    return celery

celery = make_celery(app)

@celery.task()
def convert_step_to_stl(job_id):
    """Conversion asynchrone STEP vers STL"""
    job = ConversionJob.query.get(job_id)
    if not job:
        return

    job.status = 'processing'
    db.session.commit()

    step_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], job.step_filename))
    stl_path = os.path.abspath(os.path.join(app.config['CONVERTED_FOLDER'], job.stl_filename))

    try:
        result = cq.importers.importStep(step_path)
        cq.exporters.export(result, stl_path, "STL", tolerance=job.tolerance)
        job.stl_file_size = os.path.getsize(stl_path)
        job.status = 'completed'
        job.completed_at = datetime.utcnow()
    except Exception as e:
        job.status = 'failed'
        job.error_message = str(e)

    db.session.commit()

# Configuration
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
CONVERTED_FOLDER = os.path.join(BASE_DIR, 'converted')
ALLOWED_EXTENSIONS = {'step', 'stp'}

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['CONVERTED_FOLDER'] = CONVERTED_FOLDER

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

@app.before_request
def get_locale():
    """Détermine la langue à utiliser pour l'utilisateur"""
    # Si l'utilisateur est connecté, utiliser sa préférence
    if current_user.is_authenticated and hasattr(current_user, 'preferred_language'):
        session['language'] = current_user.preferred_language
    # Sinon, utiliser la langue de la session
    elif 'language' not in session:
        # Français par défaut
        session['language'] = 'fr'

@app.context_processor
def inject_translations():
    """Injecte les traductions dans tous les templates"""
    lang = session.get('language', 'fr')
    return {
        't': get_all_translations(lang),
        'current_language': lang
    }

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
    """Main page with file upload and 3D viewer"""
    return render_template('index.html')

@app.route('/pricing')
def pricing():
    """Page des tarifs"""
    return render_template('pricing.html')

@app.route('/mentions-legales')
def mentions_legales():
    """Page des mentions légales"""
    return render_template('mentions_legales.html')

@app.route('/rgpd')
def rgpd():
    """Page de politique RGPD"""
    return render_template('rgpd.html')

@app.route('/cgv')
def cgv():
    """Page des conditions générales de vente"""
    return render_template('cgv.html')

@app.route('/cookies')
def cookies():
    """Page de politique des cookies"""
    return render_template('cookies.html')

@app.route('/change-language/<lang>')
def change_language(lang):
    """Change la langue de l'interface"""
    if lang in ['fr', 'en']:
        session['language'] = lang
        # Si l'utilisateur est connecté, sauvegarder sa préférence
        if current_user.is_authenticated:
            current_user.preferred_language = lang
            db.session.commit()
            log_action('change_language', current_user.id, {'language': lang})
    
    # Rediriger vers la page précédente ou l'accueil
    return redirect(request.referrer or url_for('landing'))

@app.route('/static/<path:filename>')
def serve_static(filename):
    """Serve static files"""
    return send_from_directory('static', filename)

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
        step_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], step_filename))
        file.save(step_path)
        step_size = os.path.getsize(step_path)
        
        logger.info(f"Saved STEP file: {step_path}")
        
        # Adaptive tolerance for large files to improve performance
        file_size_mb = step_size / (1024 * 1024)
        original_tolerance = tolerance
        
        # Adjust tolerance based on file size for better performance
        if file_size_mb > 5:
            if file_size_mb > 30:
                min_tolerance = 2.0  # Très haute tolérance pour fichiers > 30MB
            elif file_size_mb > 20:
                min_tolerance = 1.5  # Haute tolérance pour fichiers > 20MB
            elif file_size_mb > 10:
                min_tolerance = 1.0  # Tolérance élevée pour fichiers > 10MB
            elif file_size_mb > 5:
                min_tolerance = 0.8  # Tolérance moyenne pour fichiers > 5MB
            else:
                min_tolerance = 0.5  # Tolérance normale pour petits fichiers
            
            tolerance = max(tolerance, min_tolerance)
            if tolerance != original_tolerance:
                logger.info(f"File size: {file_size_mb:.1f}MB, adjusted tolerance from {original_tolerance} to {tolerance} for performance")
        conversion_job = ConversionJob(
            id=file_id,
            user_id=current_user.id if current_user.is_authenticated else None,
            original_filename=original_filename,
            step_filename=step_filename,
            stl_filename=stl_filename,
            tolerance=tolerance,
            step_file_size=step_size,
            status='queued'
        )
        db.session.add(conversion_job)
        db.session.commit()

        try:
            convert_step_to_stl.delay(file_id)
        except (KombuOperationalError, RedisConnectionError) as e:
            logger.exception(f"Celery unavailable for job {file_id}: {e}")
            try:
                convert_step_to_stl(file_id)
            except Exception as sync_e:
                logger.error(f"Synchronous conversion failed for {file_id}: {sync_e}")
                return jsonify({'success': False,
                                'error': 'Service temporairement indisponible'}), 503

        log_action('upload', user_id=current_user.id, extra={
            'filename': original_filename,
            'file_size': step_size,
            'conversion_id': file_id
        })

        return jsonify({'success': True, 'job_id': file_id})
        
            
    except Exception as e:
        logger.error(f"Upload error: {str(e)}")
        return jsonify({'error': f'Échec du téléchargement : {str(e)}'}), 500



@app.route('/view/<filename>')
def view_file(filename):
    """Serve STL files for 3D viewer with chunked streaming for large files"""
    try:
        file_path = os.path.abspath(os.path.join(app.config['CONVERTED_FOLDER'], filename))
        if not os.path.exists(file_path):
            return jsonify({'error': 'Fichier non trouvé'}), 404
        
        file_size = os.path.getsize(file_path)
        
        # For large files (>5MB), use chunked streaming
        if file_size > 5 * 1024 * 1024:
            # Log file size for monitoring
            logger.info(f"Serving large file {filename} ({file_size / (1024*1024):.1f}MB)")
            
            def generate():
                with open(file_path, 'rb') as f:
                    while True:
                        # Use progressively larger chunks for very large files
                        if file_size > 50 * 1024 * 1024:
                            chunk_size = 131072  # 128KB for very large files
                        elif file_size > 20 * 1024 * 1024:
                            chunk_size = 65536   # 64KB for large files
                        else:
                            chunk_size = 32768   # 32KB for medium files
                        
                        data = f.read(chunk_size)
                        if not data:
                            break
                        yield data
            
            response = Response(generate(), mimetype='application/octet-stream')
            response.headers['Content-Length'] = str(file_size)
            response.headers['Content-Disposition'] = f'inline; filename={filename}'
            # Add cache and streaming headers
            response.headers['Cache-Control'] = 'public, max-age=3600'
            response.headers['Accept-Ranges'] = 'bytes'
            return response
        else:
            # For smaller files, use normal send_from_directory
            return send_from_directory(app.config['CONVERTED_FOLDER'], filename, 
                                     mimetype='application/octet-stream')
    except Exception as e:
        logger.error(f"Error serving file {filename}: {str(e)}")
        return jsonify({'error': 'Erreur lors du chargement du fichier'}), 500

@app.route('/api/job-status/<job_id>')
def job_status(job_id):
    """Retourne l\'état d\'une conversion"""
    job = ConversionJob.query.get(job_id)
    if not job:
        return jsonify({'error': 'Job introuvable'}), 404

    data = {
        'status': job.status,
        'stl_filename': job.stl_filename if job.status == 'completed' else None,
        'stl_size': job.stl_file_size,
        'error': job.error_message
    }
    return jsonify(data)

@app.route('/view/<job_id>.stl')
def view_stl_job(job_id):
    """Télécharge le STL généré pour un job"""
    job = ConversionJob.query.get_or_404(job_id)
    return view_file(job.stl_filename)

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
        step_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], conversion_job.step_filename))
        if not os.path.exists(step_path):
            logger.error(f"STEP file not found: {step_path}")
            return jsonify({
                'success': False,
                'error': 'Fichier STEP non trouvé'
            }), 404

        # STL path for heatmap generation
        stl_path = os.path.abspath(os.path.join(app.config['CONVERTED_FOLDER'], conversion_job.stl_filename))
        
        # Check user authentication and credits
        if current_user.is_authenticated:
            if not current_user.has_access():
                logger.warning(f"User {current_user.id} has no credits left")
                return jsonify({
                    'success': False,
                    'error': 'Crédits insuffisants. Veuillez acheter des crédits ou vous abonner.'
                }), 403
        
        logger.info(f"Starting DFM analysis for job {conversion_id} with demolding axis: {demolding_axis}")
        
        # Perform DFM analysis with proper error handling
        try:
            dfm_report = analyze_dfm(step_path, demolding_axis)
            heatmap_data = generate_heatmap(stl_path)
            
            if dfm_report is None:
                logger.error("DFM analysis returned None")
                return jsonify({
                    'success': False,
                    'error': 'Échec de l\'analyse DFM - Aucun résultat retourné'
                }), 500
                
        except Exception as dfm_error:
            logger.error(f"DFM analysis exception: {str(dfm_error)}")
            import traceback
            logger.error(traceback.format_exc())

            # Message utilisateur personnalisé pour l'axe
            if "axis" in str(dfm_error).lower() or "démoulage" in str(dfm_error).lower():
                return jsonify({
                    'success': False,
                    'error': '❌ Erreur dans le choix de l’axe de démoulage. Veuillez réessayer avec un autre axe.'
                }), 400

            # Fallback générique
            return jsonify({
                'success': False,
                'error': 'Une erreur est survenue pendant l’analyse DFM. Merci de réessayer.'
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
        
        # Prepare DFM data with safe value conversion
        try:
            # Safe value conversion function
            def safe_float(value, default=0.0):
                try:
                    if value is None:
                        return default
                    if isinstance(value, (int, float)):
                        if str(value) in ['inf', '-inf', 'nan']:
                            return default
                        return float(value)
                    return default
                except (ValueError, TypeError):
                    return default
            
            dfm_data = {
                'score': safe_float(dfm_report.moldability_rating, 1),
                'rating': str(dfm_report.overall_score) if dfm_report.overall_score else 'critical',
                'issues_count': len(dfm_report.wall_thickness_issues) + len(dfm_report.geometry_issues),
                'dimensions': {
                    'x': round(safe_float(dfm_report.dimensions.x_max, 0), 2),
                    'y': round(safe_float(dfm_report.dimensions.y_max, 0), 2),
                    'z': round(safe_float(dfm_report.dimensions.z_max, 0), 2),
                    'volume': round(safe_float(dfm_report.dimensions.volume, 0), 2),
                    'max_wall_thickness': round(safe_float(dfm_report.dimensions.max_wall_thickness, 1), 2),
                    'projected_area_x': round(safe_float(dfm_report.dimensions.projected_area_x, 0), 2),
                    'projected_area_y': round(safe_float(dfm_report.dimensions.projected_area_y, 0), 2),
                    'projected_area_z': round(safe_float(dfm_report.dimensions.projected_area_z, 0), 2),
                    'cooling_time': round(safe_float(dfm_report.dimensions.cooling_time, 10), 1)
                },
                'recommendations': dfm_report.recommendations[:3] if dfm_report.recommendations else [],
                'wall_thickness_issues': [
                    {
                        'location': list(issue.location) if issue.location else [0, 0, 0],
                        'thickness': safe_float(issue.thickness, 0),
                        'issue_type': str(issue.issue_type) if issue.issue_type else 'unknown',
                        'severity': str(issue.severity) if issue.severity else 'unknown'
                    } for issue in dfm_report.wall_thickness_issues if issue
                ],
                'geometry_issues': [
                    {
                        'location': list(issue.location) if issue.location else [0, 0, 0],
                        'issue_type': str(issue.issue_type) if issue.issue_type else 'unknown',
                        'description': str(issue.description) if issue.description else 'Description non disponible',
                        'severity': str(issue.severity) if issue.severity else 'unknown',
                        'recommendation': str(issue.recommendation) if issue.recommendation else 'Recommandation non disponible'
                    } for issue in dfm_report.geometry_issues if issue
                ],
                'heatmap': heatmap_data
            }
            
            # Test JSON serialization
            import json
            json.dumps(dfm_data)
            logger.info(f"DFM data JSON serialization successful")
            
        except Exception as json_error:
            logger.error(f"Error preparing DFM data: {str(json_error)}")
            return jsonify({
                'success': False,
                'error': f'Erreur de sérialisation des données DFM: {str(json_error)}'
            }), 500
        
        # Avoid storing large data in session to prevent 502 errors
        # DFM data is already stored in database via ConversionJob
        session.permanent = True
        
        # Log l'action d'analyse
        user_id = current_user.id if current_user.is_authenticated else None
        user_email = current_user.email if current_user.is_authenticated else None
        log_action('analyze', user_id=user_id, extra={
            'conversion_id': conversion_id,
            'dfm_score': dfm_report.moldability_rating,
            'overall_rating': dfm_report.overall_score,
            'issues_count': len(dfm_report.wall_thickness_issues) + len(dfm_report.geometry_issues),
            'user_email': user_email,
            'filename': conversion_job.original_filename
        })
        
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
        from pdf_generator import DFMReportGenerator
        
        # Get conversion job from database
        conversion_job = ConversionJob.query.get(conversion_id)
        if not conversion_job:
            return jsonify({'error': 'Job de conversion non trouvé'}), 404
        
        if conversion_job.status != 'completed':
            return jsonify({'error': 'La conversion doit être terminée'}), 400
            
        if not conversion_job.dfm_score:
            return jsonify({'error': 'L\'analyse DFM doit être effectuée avant la génération du rapport'}), 400
        
        # Get STEP file path
        step_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], conversion_job.step_filename))
        if not os.path.exists(step_path):
            return jsonify({'error': 'Fichier STEP non trouvé'}), 404
        
        # Use existing DFM data from database instead of re-analyzing (to avoid timeout)
        request_data = request.get_json() or {}
        
        # Create simplified DFM data from database values
        class SimplifiedDFMReport:
            def __init__(self, conversion_job):
                self.overall_score = conversion_job.dfm_overall_rating or 'good'
                self.moldability_rating = conversion_job.dfm_score or 7
                self.dimensions = type('obj', (object,), {
                    'x_max': 100,  # Default values
                    'y_max': 100,
                    'z_max': 100,
                    'volume': 1000,
                    'max_wall_thickness': 3,
                    'projected_area_x': 100,
                    'projected_area_y': 100,
                    'projected_area_z': 100,
                    'cooling_time': 30
                })()
                self.wall_thickness_issues = []
                self.geometry_issues = []
                self.recommendations = [
                    "Rapport PDF généré à partir des données d'analyse existantes",
                    f"Score de moulabilité: {self.moldability_rating}/10",
                    f"Évaluation globale: {self.overall_score}"
                ]
        
        dfm_report = SimplifiedDFMReport(conversion_job)
        
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
        
        # Get material recommendations - generate them if not in session
        material_recommendations = []
        try:
            # Import material recommender
            from material_recommender import recommend_materials_for_questionnaire
            
            # Get questionnaire data from session or use default
            questionnaire_data = session.get('questionnaire_data', {
                'application': 'general',
                'mechanical_requirements': [],
                'use_temperature': {'min': 20, 'max': 50},
                'chemical_environment': 'neutral',
                'aesthetic_requirements': [],
                'regulatory_requirements': [],
                'cost_preference': 'balanced',
                'quantity': {'min': 100, 'max': 1000}
            })
            
            # Get material recommendations
            material_recommendations = recommend_materials_for_questionnaire(questionnaire_data, dfm_data)
            logger.info(f"Generated {len(material_recommendations)} material recommendations for PDF")
        except Exception as e:
            logger.warning(f"Could not generate material recommendations: {str(e)}")
            material_recommendations = []
        
        # Get user language
        user_lang = 'fr'
        if current_user.is_authenticated:
            user_lang = current_user.preferred_language
        else:
            user_lang = session.get('language', 'fr')
        
        # Create PDF with user language
        generator = DFMReportGenerator(language=user_lang)
        generated_path = generator.generate_report(
            dfm_data, 
            step_path, 
            pdf_path, 
            conversion_job.original_filename,
            material_recommendations,
            lang=user_lang
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
        
        # Log l'action de téléchargement
        user_id = current_user.id if current_user.is_authenticated else None
        user_email = current_user.email if current_user.is_authenticated else None
        log_action('download', user_id=user_id, extra={
            'filename': filename,
            'user_email': user_email,
            'file_type': 'pdf_report'
        })
        
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
            step_path = os.path.abspath(os.path.join(UPLOAD_FOLDER, conversion.step_filename))
            if os.path.exists(step_path):
                zip_file.write(step_path, f"original/{conversion.original_filename}")
            
            # 2. Générer et ajouter le rapport PDF
            pdf_filename = f"rapport_dfm_{conversion_id}.pdf"
            pdf_path = os.path.join('reports', pdf_filename)
            
            # Note: PDF generation skipped for ZIP downloads to avoid session dependencies
            # Users can generate PDF separately via the dedicated PDF endpoint
            
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
            
            # Note: Detailed DFM analysis not included in ZIP to avoid session dependencies
            # Analysis summary available through API endpoints
            
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
        
        # Avoid storing large data in session to prevent 502 errors
        # Material recommendations are passed directly to frontend
        
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

@app.route('/admin')
def admin():
    """Page d'administration protégée par mot de passe"""
    # Vérifier le mot de passe dans la session
    if not session.get('admin_authenticated'):
        return redirect(url_for('admin_login'))
    
    # Obtenir les statistiques
    from log import get_stats
    stats = get_stats()
    
    return render_template('admin.html', stats=stats)

@app.route('/admin/login', methods=['GET', 'POST'])
def admin_login():
    """Page de connexion admin"""
    if request.method == 'POST':
        password = request.form.get('password', '')
        admin_password = os.environ.get('ADMIN_PASSWORD', 'admin1234')
        
        if password == admin_password:
            session['admin_authenticated'] = True
            return redirect(url_for('admin'))
        else:
            flash('Mot de passe incorrect', 'danger')
    
    return render_template('admin_login.html')

@app.route('/admin/logout')
def admin_logout():
    """Déconnexion admin"""
    session.pop('admin_authenticated', None)
    return redirect(url_for('landing'))



if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)

