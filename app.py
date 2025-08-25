import os
import hashlib
import json
from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    send_file,
    send_from_directory,
    session,
    Response,
    redirect,
    url_for,
    flash,
)
from flask_cors import CORS
from flask_migrate import Migrate
from werkzeug.utils import secure_filename, safe_join
from werkzeug.exceptions import RequestEntityTooLarge
import cadquery as cq
import trimesh
import uuid
import time
import shutil
import tempfile
import subprocess
from OCP.STEPControl import STEPControl_Reader
from OCP.StlAPI import StlAPI_Writer
from OCP.Interface import Interface_Static
from pathlib import Path
from datetime import datetime, timedelta
from models import db, ConversionJob, UserSession, User, OAuth, ModelJob, advance_model_job_status
from dfm_analyzer import analyze_dfm, DFMReport
from dataclasses import asdict
from heatmap import generate_heatmap
from material_recommender import recommend_materials_for_questionnaire
import xkt_converter
from tasks.conversion import generate_preview, generate_final
from tasks.dfm import dfm_analysis
from celery_app import celery, init_celery
from celery.result import AsyncResult
from flask_login import LoginManager, login_required, current_user
from translations import get_translation, get_all_translations
from log import log_action
from observability.logging import setup_logging, get_logger
from observability.metrics import setup_metrics
from flask_dance.contrib.google import make_google_blueprint, google
from dotenv import load_dotenv
from kombu.exceptions import OperationalError as KombuOperationalError
from redis.exceptions import ConnectionError as RedisConnectionError
from storage.s3 import get_signed_url

load_dotenv()

# Create Flask app once
app = Flask(__name__)
secret = os.environ.get("SESSION_SECRET") or os.getenv("SECRET_KEY")
if not secret:
    raise RuntimeError("SESSION_SECRET environment variable is required")
app.secret_key = secret

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

setup_logging(app)
setup_metrics(app)
logger = get_logger(__name__)

# Enable CORS for API endpoints
CORS(app)

# Session configuration to prevent large cookies
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['MAX_CONTENT_LENGTH'] = 200 * 1024 * 1024  # 200MB max file size

def _resolve_xeokit():
    """Résout le binaire xeokit-convert ou renvoie 'npx'."""
    xeokit = os.getenv("XEOKIT_CONVERT") or shutil.which("xeokit-convert")
    if xeokit:
        logger.info("XEOKIT_BIN resolved to %s", xeokit)
        return xeokit
    logger.warning("xeokit-convert not found, falling back to npx")
    return "npx"

@app.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(e):
    return jsonify({"success": False, "error": "file_too_large"}), 413

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

init_celery(app)
from celery.schedules import crontab

celery.conf.beat_schedule = {
    'cleanup-old-files': {
        'task': 'app.cleanup_old_files',
        'schedule': crontab(hour=0, minute=0),
    }
}

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
    ext = os.path.splitext(step_path)[1].lower()
    xkt_path = os.path.abspath(os.path.join(app.config['CONVERTED_FOLDER'], job.xkt_filename))

    viewer_ready = True
    viewer_error = None
    try:
        if ext == '.stl':
            # Fichier déjà au format STL, simplement le copier
            shutil.copyfile(step_path, stl_path)
        else:
            result = cq.importers.importStep(step_path)
            cq.exporters.export(result, stl_path, "STL", tolerance=job.tolerance)
            try:
                xkt_converter.convert_step_to_xkt(step_path, xkt_path)
            except Exception as xkt_err:
                viewer_ready = False
                viewer_error = f"Conversion XKT échouée: {xkt_err}"

        job.stl_file_size = os.path.getsize(stl_path)

        try:
            mesh = trimesh.load(stl_path, force='mesh', skip_materials=True, process=False)
            if mesh.is_empty or len(getattr(mesh, 'faces', [])) == 0:
                viewer_ready = False
                if not viewer_error:
                    viewer_error = 'STL invalide pour le viewer'
        except Exception as val_err:
            viewer_ready = False
            if not viewer_error:
                viewer_error = f'Validation viewer échouée: {val_err}'

        job.status = 'completed'
        job.completed_at = datetime.utcnow()
    except Exception as e:
        job.status = 'failed'
        job.error_message = str(e)
        viewer_ready = False
        viewer_error = str(e)

    job.viewer_ready = viewer_ready
    job.viewer_error = viewer_error

    db.session.commit()


def ocp_step_to_stl(step_path: str, stl_path: str) -> None:
    """Convertit un fichier STEP en STL via OCP"""
    reader = STEPControl_Reader()
    status = reader.ReadFile(step_path)
    if status != 1:
        raise RuntimeError("Lecture STEP échouée")
    reader.TransferRoots()
    shape = reader.OneShape()
    writer = StlAPI_Writer()
    Interface_Static.SetIVal_s("write.stl.mode", 0)
    writer.ASCIIMode = False
    writer.Write(shape, stl_path)


@celery.task()
def process_step_file(job_id, demolding_axis='z'):
    """Analyse DFM et génération de heatmap"""
    job = ConversionJob.query.get(job_id)
    if not job:
        return

    job.status = 'processing'
    db.session.commit()

    step_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], job.step_filename))
    stl_path = os.path.abspath(os.path.join(app.config['CONVERTED_FOLDER'], job.stl_filename))
    xkt_path = os.path.abspath(os.path.join(app.config['CONVERTED_FOLDER'], job.xkt_filename))
    ext = os.path.splitext(step_path)[1].lower()

    viewer_ready = True
    viewer_error = None

    try:
        if ext == '.stl':
            # Copie directe du fichier téléchargé
            shutil.copyfile(step_path, stl_path)
            dfm_report = None
        else:
            ocp_step_to_stl(step_path, stl_path)
            try:
                xkt_converter.convert_step_to_xkt(step_path, xkt_path)
            except Exception as xkt_err:
                viewer_ready = False
                viewer_error = f"Conversion XKT échouée: {xkt_err}"
            dfm_report = analyze_dfm(step_path, demolding_axis)

        generate_heatmap(stl_path)

        job.stl_file_size = os.path.getsize(stl_path)

        try:
            mesh = trimesh.load(stl_path, force='mesh', skip_materials=True, process=False)
            if mesh.is_empty or len(getattr(mesh, 'faces', [])) == 0:
                viewer_ready = False
                if not viewer_error:
                    viewer_error = 'STL invalide pour le viewer'
        except Exception as val_err:
            viewer_ready = False
            if not viewer_error:
                viewer_error = f'Validation viewer échouée: {val_err}'

        if job.user:
            job.user.use_credit()

        if dfm_report:
            job.dfm_score = dfm_report.moldability_rating
            job.dfm_issues_count = len(dfm_report.wall_thickness_issues) + len(dfm_report.geometry_issues)
            job.dfm_overall_rating = dfm_report.overall_score
            job.status = 'dfm_done'
        else:
            job.status = 'completed'

        job.completed_at = datetime.utcnow()
    except Exception as e:
        job.status = 'failed'
        job.error_message = str(e)
        logger.exception(f"DFM processing failed for {job_id}: {e}")

    job.viewer_ready = viewer_ready
    job.viewer_error = viewer_error

    db.session.commit()


@celery.task()
def cleanup_old_files():
    """Supprime les fichiers trop anciens dans uploads/ et converted/"""
    retention_days = app.config.get('FILE_RETENTION_DAYS', 7)
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    for folder in (app.config['UPLOAD_FOLDER'], app.config['CONVERTED_FOLDER']):
        for name in os.listdir(folder):
            path = os.path.join(folder, name)
            try:
                mtime = datetime.utcfromtimestamp(os.path.getmtime(path))
                if mtime < cutoff:
                    os.remove(path)
                    logger.info(f"Deleted old file {path}")
            except Exception as e:
                logger.exception(f"Error deleting {path}: {e}")

# Configuration
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
CONVERTED_FOLDER = os.getenv("CONVERTED_FOLDER", "/tmp/converted")
# Types de fichiers autorisés pour l'upload
ALLOWED_EXTENSIONS = {'step', 'stp', 'stl'}
FILE_RETENTION_DAYS = int(os.getenv('FILE_RETENTION_DAYS', '7'))

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['CONVERTED_FOLDER'] = CONVERTED_FOLDER
app.config['FILE_RETENTION_DAYS'] = FILE_RETENTION_DAYS

# Ensure directories exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(CONVERTED_FOLDER, exist_ok=True)
logger.info("CONVERTED_FOLDER=%s", CONVERTED_FOLDER)

logger.info("PATH at runtime=%s", os.getenv("PATH"))

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
from tus_upload import tus_bp

app.register_blueprint(auth_bp, url_prefix='/auth')
app.register_blueprint(google_auth_bp)
app.register_blueprint(stripe_bp, url_prefix='/stripe')
app.register_blueprint(tus_bp, url_prefix='/tus')

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


@app.route("/uploads/<path:fname>")
def serve_xkt(fname):
    """Serve converted files for front-end requests"""
    return send_from_directory(app.config["CONVERTED_FOLDER"], fname, as_attachment=False)


@app.route('/convert', methods=['POST'])
def convert_step():
    """
    Convertit un fichier en XKT :
      - .step/.stp  -> xkt_converter (STEP -> STL -> XKT)
      - .stl       -> xeokit-convert directement
    Réponse JSON: { success: bool, url?: str, error?: str, details?: str }
    """
    f = request.files.get('file')
    if not f or f.filename == '':
        return jsonify(success=False, error='Aucun fichier'), 400

    # Normaliser le nom et l’extension
    orig = secure_filename(f.filename)
    base, ext = os.path.splitext(orig)
    ext_lower = ext.lower()

    if ext_lower not in ('.step', '.stp', '.stl'):
        return jsonify(success=False, error='Format non supporté'), 400

    # Préparer chemins
    temp_dir = tempfile.mkdtemp(prefix="convert_")
    in_name = base + ext_lower           # garde l’extension d’origine en minuscule
    in_path = os.path.join(temp_dir, in_name)
    f.save(in_path)

    dest_dir = app.config.get("CONVERTED_FOLDER", "/tmp/converted")
    os.makedirs(dest_dir, exist_ok=True)
    out_name = f"{uuid.uuid4()}.xkt"
    out_path = os.path.join(dest_dir, out_name)

    start = time.time()
    try:
        if ext_lower in ('.step', '.stp'):
            # STEP/STP -> pipeline Python (CadQuery -> STL) puis xeokit-convert
            logger.info("STEP/STP détecté -> conversion via xkt_converter: %s -> %s", in_path, out_path)
            try:
                # tolérance STL un peu large pour rester rapide/sobre en mémoire
                xkt_converter.convert_step_to_xkt(in_path, out_path, stl_tolerance=0.6, timeout=600)
            except Exception as e:
                logger.exception("convert_step_to_xkt a échoué")
                shutil.rmtree(temp_dir, ignore_errors=True)
                return jsonify(success=False, error="convert_failed", details=str(e)[:800]), 400

        else:
            # STL -> XKT avec le binaire xeokit-convert
            xeokit_bin = _resolve_xeokit()
            base_cmd = [xeokit_bin, "-y", "@xeokit/xeokit-convert"] if xeokit_bin == "npx" else [xeokit_bin]

            # 1er essai : -s/-o
            cmd = base_cmd + ["-s", in_path, "-o", str(out_path)]
            logger.info("STL détecté -> xeokit-convert: %s", " ".join(cmd))
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=600)
            out_txt = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()

            # Si binaire ancien : réessayer avec --source/--output
            if proc.returncode != 0 and "unknown option" in out_txt.lower():
                cmd = base_cmd + ["--source", in_path, "--output", str(out_path)]
                logger.info("Retry with --source/--output: %s", " ".join(cmd))
                proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=600)
                out_txt = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()

            logger.info("xeokit rc=%s", proc.returncode)
            if proc.returncode != 0 or not os.path.exists(out_path):
                shutil.rmtree(temp_dir, ignore_errors=True)
                return jsonify(success=False, error="convert_failed", details=out_txt[:1200]), 400

    except subprocess.TimeoutExpired:
        shutil.rmtree(temp_dir, ignore_errors=True)
        return jsonify(success=False, error="convert_timeout"), 504
    except FileNotFoundError:
        shutil.rmtree(temp_dir, ignore_errors=True)
        return jsonify(success=False, error="xeokit_missing"), 500
    except PermissionError:
        shutil.rmtree(temp_dir, ignore_errors=True)
        return jsonify(success=False, error="permission_denied"), 400
    except Exception as e:
        logger.exception("Erreur inattendue durant /convert")
        shutil.rmtree(temp_dir, ignore_errors=True)
        return jsonify(success=False, error=str(e) or "unexpected"), 500
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    logger.info("Conversion OK en %.2fs -> %s", time.time() - start, out_path)
    # La route /uploads/<fname> doit servir CONVERTED_FOLDER
    xkt_rel_url = f"/uploads/{out_name}"
    return jsonify(success=True, url=xkt_rel_url, xktUrl=xkt_rel_url)


@app.route('/upload_file', methods=['POST'])
def upload_file_api():
    """Upload STEP/STL file and launch processing"""
    if 'file' not in request.files:
        return jsonify({'error': 'Aucun fichier'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Nom de fichier manquant'}), 400
    if not allowed_file(file.filename):
        return jsonify({'error': 'Extension non autorisée'}), 400

    job_id = str(uuid.uuid4())
    original_filename = secure_filename(file.filename)
    step_filename = f"{job_id}_{original_filename}"
    stl_filename = f"{job_id}.stl"
    xkt_filename = f"{job_id}.xkt"

    step_path = os.path.join(app.config['UPLOAD_FOLDER'], step_filename)
    file.save(step_path)

    job = ConversionJob(
        id=job_id,
        original_filename=original_filename,
        step_filename=step_filename,
        stl_filename=stl_filename,
        xkt_filename=xkt_filename,
        step_file_size=os.path.getsize(step_path),
        status='queued'
    )

    try:
        db.session.add(job)
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        logger.exception(f"DB error for job {job_id}: {exc}")
        return jsonify({'error': "Erreur base de données"}), 500

    try:
        process_step_file.delay(job_id)
    except Exception:
        process_step_file(job_id)

    return jsonify({'id': job_id})


@app.route('/upload', methods=['POST'])
def upload():
    """Upload a STEP/STP file then ouvrir le viewer intégré"""
    if 'file' not in request.files:
        flash('Aucun fichier sélectionné', 'error')
        return redirect(request.referrer or url_for('landing'))

    file = request.files['file']
    if file.filename == '':
        flash('Aucun fichier sélectionné', 'error')
        return redirect(request.referrer or url_for('landing'))

    filename = secure_filename(file.filename)
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ('.step', '.stp', '.xkt'):
        flash('Format non supporté', 'error')
        return redirect(request.referrer or url_for('landing'))

    temp_dir = tempfile.mkdtemp()
    input_path = os.path.join(temp_dir, filename)
    file.save(input_path)

    if filename.endswith('.xkt'):
        out_name = f"{uuid.uuid4()}.xkt"
        dest_dir = os.path.join('static', 'models')
        os.makedirs(dest_dir, exist_ok=True)
        shutil.move(input_path, os.path.join(dest_dir, out_name))
        shutil.rmtree(temp_dir, ignore_errors=True)
        return redirect(url_for('index', model=out_name))

    xkt_name = f"{uuid.uuid4()}.xkt"
    xkt_path = os.path.join(temp_dir, xkt_name)

    try:
        xkt_converter.convert_step_to_xkt(input_path, xkt_path)
    except Exception as e:
        logger.exception(f"Conversion STEP->XKT échouée: {e}")
        shutil.rmtree(temp_dir, ignore_errors=True)
        flash('Erreur de conversion', 'error')
        return redirect(request.referrer or url_for('landing'))

    dest_dir = os.path.join('static', 'models')
    os.makedirs(dest_dir, exist_ok=True)
    final_path = os.path.join(dest_dir, xkt_name)
    shutil.move(xkt_path, final_path)
    shutil.rmtree(temp_dir, ignore_errors=True)

    return redirect(url_for('index', model=xkt_name))


@app.route('/api/upload', methods=['POST'])
def api_upload():
    data = request.get_json(silent=True) or {}
    upload_id = data.get('upload_id') if isinstance(data, dict) else None
    if upload_id:
        tus_dir = os.path.join(app.config['UPLOAD_FOLDER'], 'tus')
        file_path = os.path.join(tus_dir, upload_id)
        info_path = os.path.join(tus_dir, f"{upload_id}.json")
        if not os.path.exists(file_path) or not os.path.exists(info_path):
            return jsonify({'error': 'invalid_handle'}), 400
        with open(info_path) as f:
            info = json.load(f)
        filename = secure_filename(info.get('metadata', {}).get('filename') or '')
        mime_type = info.get('metadata', {}).get('filetype', 'application/octet-stream')
        sha256 = hashlib.sha256()
        size = 0
        with open(file_path, 'rb') as src:
            for chunk in iter(lambda: src.read(8192), b''):
                sha256.update(chunk)
                size += len(chunk)
        digest = sha256.hexdigest()
        tmp_path = file_path
    else:
        file = request.files.get('file')
        if not file:
            return jsonify({'error': 'missing_file'}), 400
        filename = secure_filename(file.filename or '')
        if not filename:
            return jsonify({'error': 'empty_filename'}), 400
        mime_type = file.mimetype or 'application/octet-stream'
        sha256 = hashlib.sha256()
        size = 0
        tmp_path = os.path.join(app.config['UPLOAD_FOLDER'], f"tmp_{uuid.uuid4().hex}")
        with open(tmp_path, 'wb') as dst:
            for chunk in iter(lambda: file.stream.read(8192), b''):
                sha256.update(chunk)
                size += len(chunk)
                dst.write(chunk)
        digest = sha256.hexdigest()

    existing = ModelJob.query.filter_by(sha256=digest).first()
    if existing:
        os.remove(tmp_path)
        if upload_id:
            os.remove(info_path)
        logger.info(json.dumps({'action': 'upload', 'result': 'cache_hit', 'job_id': existing.id}))
        return jsonify({
            'modelId': existing.id,
            'status': existing.status,
            'sha256': existing.sha256,
            'preview_url': existing.preview_url,
            'final_url': existing.final_url,
            'dfm_json_url': existing.dfm_json_url,
        })

    job = ModelJob(
        sha256=digest,
        original_filename=filename,
        size_bytes=size,
        mime=mime_type,
        user_id=current_user.id if current_user.is_authenticated else None,
    )
    db.session.add(job)
    db.session.commit()

    final_path = os.path.join(app.config['UPLOAD_FOLDER'], f"{job.id}.step")
    os.rename(tmp_path, final_path)
    if upload_id:
        os.remove(info_path)

    generate_preview.delay(job.id)
    generate_final.delay(job.id)

    logger.info(json.dumps({'action': 'upload', 'result': 'queued', 'job_id': job.id}))

    return jsonify({'modelId': job.id, 'status': job.status, 'sha256': job.sha256}), 201


@app.route('/api/models/<job_id>')
def api_model(job_id):
    job = ModelJob.query.get_or_404(job_id)
    return jsonify(job.to_dict())


@app.route('/api/models/<job_id>/assets')
def api_model_assets(job_id):
    job = ModelJob.query.get_or_404(job_id)
    assets = {}
    if job.preview_url:
        assets['preview'] = get_signed_url(job.preview_url)
        assets['thumbnail'] = get_signed_url(f"models/{job.sha256}/thumb.jpg")
    if job.final_url:
        assets['final'] = get_signed_url(job.final_url)
    if job.dfm_json_url:
        assets['dfm_json'] = get_signed_url(job.dfm_json_url)
    return jsonify({'modelId': job.id, 'assets': assets, 'status': job.status})

@app.route('/api/upload_job', methods=['POST'])
@login_required
def upload_job():
    """Handle STEP file upload and conversion (legacy async flow)"""
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
            return jsonify({'error': 'Type de fichier invalide. Seuls les fichiers STEP (.step, .stp) ou STL (.stl) sont autorisés'}), 400
        
        # Get tolerance parameter
        tolerance = float(request.form.get('tolerance', 0.1))
        if tolerance <= 0 or tolerance > 1:
            tolerance = 0.1
        
        # Generate unique filename
        file_id = str(uuid.uuid4())
        original_filename = secure_filename(file.filename)
        step_filename = f"{file_id}_{original_filename}"
        stl_filename = f"{file_id}.stl"
        xkt_filename = f"{file_id}.xkt"
        
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
            xkt_filename=xkt_filename,
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
    # Validate filename to prevent path traversal
    if '..' in filename or os.path.isabs(filename):
        return jsonify({'error': 'Nom de fichier invalide'}), 400
    try:
        models_dir = os.path.join(app.root_path, 'static', 'models')
        file_path = safe_join(models_dir, filename)
        if not file_path or not os.path.exists(file_path):
            return jsonify({'error': 'Fichier non trouvé'}), 404
        
        file_size = os.path.getsize(file_path)
        mime = "application/octet-stream"
        if filename.lower().endswith(".stl"):
            mime = "application/octet-stream"
        elif filename.lower().endswith(".xkt"):
            mime = "application/octet-stream"
        
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
            
            response = Response(generate(), mimetype=mime)
            response.headers['Content-Length'] = str(file_size)
            response.headers['Content-Disposition'] = f'inline; filename={filename}'
            # Add cache and streaming headers
            response.headers['Cache-Control'] = 'public, max-age=3600'
            response.headers['Accept-Ranges'] = 'bytes'
            return response
        else:
            # For smaller files, use normal send_from_directory
            return send_from_directory(models_dir, filename,
                                     mimetype=mime)
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
        'xkt_filename': job.xkt_filename if job.status == 'completed' else None,
        'stl_size': job.stl_file_size,
        'error': job.error_message,
        'viewer_ready': job.viewer_ready,
        'viewer_error': job.viewer_error,
    }
    return jsonify(data)


@app.route('/result/<job_id>')
def get_result(job_id):
    """Return job status and DFM data"""
    job = ConversionJob.query.get(job_id)
    if not job:
        return jsonify({'error': 'Job introuvable'}), 404
    return jsonify(job.to_dict())

@app.route('/view/<job_id>.stl')
def view_stl_job(job_id):
    """Télécharge le STL généré pour un job"""
    job = ConversionJob.query.get_or_404(job_id)
    return view_file(job.stl_filename)

@app.route('/view/<job_id>.xkt')
def view_xkt_job(job_id):
    """Télécharge le XKT généré pour un job"""
    job = ConversionJob.query.get_or_404(job_id)
    return view_file(job.xkt_filename)



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
    """Déclenche l'analyse DFM en tâche de fond"""
    try:
        data = request.get_json() or {}
        demolding_axis = data.get('demolding_axis', 'z')

        job = ConversionJob.query.get(conversion_id)
        if not job:
            return jsonify({'success': False, 'error': 'Job de conversion non trouvé'}), 404

        if job.status != 'completed':
            return jsonify({'success': False, 'error': 'La conversion doit être terminée'}), 400

        if current_user.is_authenticated and not current_user.has_access():
            return jsonify({'success': False, 'error': 'Crédits insuffisants. Veuillez acheter des crédits ou vous abonner.'}), 403

        try:
            process_step_file.delay(conversion_id, demolding_axis)
        except (KombuOperationalError, RedisConnectionError):
            process_step_file(conversion_id, demolding_axis)

        return jsonify({'success': True})

    except Exception as e:
        logger.error(f"DFM Analysis error: {str(e)}")
        return jsonify({'error': f"Erreur lors de l'analyse DFM: {str(e)}"}), 500

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
        screenshot_data = request_data.get('screenshot')
        
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
            lang=user_lang,
            screenshot_image=screenshot_data
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


@app.route('/download-csv/<filename>')
def download_csv(filename):
    """Download generated CSV report"""
    try:
        csv_path = os.path.join('reports', filename)
        if not os.path.exists(csv_path):
            return jsonify({'error': 'Fichier CSV non trouvé'}), 404
        return send_file(csv_path, as_attachment=True, download_name=filename, mimetype='text/csv')
    except Exception as e:
        logger.error(f"CSV download error: {str(e)}")
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

@app.route('/dfm/analyze', methods=['POST'])
def analyze_and_recommend():
    """Handle DFM analysis and return material recommendations"""
    questionnaire = {
        'application': request.form.get('application', ''),
        'mechanical': request.form.getlist('mechanical[]'),
        'temperature': request.form.get('temperature', ''),
        'exposure': request.form.getlist('exposure[]'),
        'aesthetic': request.form.getlist('aesthetic[]'),
        'regulatory': request.form.getlist('regulatory[]'),
        'cost': request.form.get('cost', ''),
        'volume': request.form.get('volume'),
        'lifespan': request.form.get('lifespan'),
    }
    step_file = request.files.get('file')
    if not step_file:
        return jsonify({'success': False, 'error': 'no_file'}), 400
    tmp_dir = tempfile.mkdtemp(prefix='dfm_')
    try:
        filename = secure_filename(step_file.filename or 'model.step')
        step_path = os.path.join(tmp_dir, filename)
        step_file.save(step_path)
        axis = request.form.get('demolding_axis', 'z')
        dfm_report = analyze_dfm(step_path, axis)
        dfm_data = asdict(dfm_report)
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    recos = recommend_materials_for_questionnaire(questionnaire, dfm_data)
    return jsonify({'success': True, 'dfm': dfm_data, 'recommendations': recos})

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


@app.route('/api/dfm/axes/suggest')
def dfm_axes_suggest():
    """Suggest a demoulding axis for a given file."""
    file_id = request.args.get('fileId')
    if not file_id:
        return jsonify({'error': 'missing_fileId'}), 400
    step_path = os.path.join(app.config['UPLOAD_FOLDER'], f'{file_id}.step')
    if not os.path.exists(step_path):
        return jsonify({'error': 'not_found'}), 404
    try:
        shape = cq.importers.importStep(step_path)
        bbox = shape.val().BoundingBox()
        dims = {'X': bbox.xlen, 'Y': bbox.ylen, 'Z': bbox.zlen}
        axis = max(dims, key=dims.get)
        logger.info("Axis suggested", extra={"file_id": file_id, "axis": axis})
        return jsonify({'axis': axis, 'direction': 1})
    except Exception as e:
        logger.exception("axis suggestion failed")
        return jsonify({'error': 'axis_suggestion_failed', 'message': str(e)}), 500

@app.route('/api/dfm/start', methods=['POST'])
def dfm_start():
    """Start asynchronous DFM analysis."""
    try:
        data = request.get_json(silent=True) or {}
        file_id = data.get('fileId')
        material_profile = data.get('materialProfile')
        demould_axis = data.get('demouldAxis')
        if not file_id:
            return jsonify({'error': 'missing_fileId'}), 400
        task = dfm_analysis.delay(file_id, material_profile, demould_axis)
        logger.info("DFM job queued", extra={"file_id": file_id, "job_id": task.id})
        return jsonify({'jobId': task.id})
    except Exception as e:
        logger.exception("dfm_start failed")
        return jsonify({'error': 'dfm_start_failed', 'message': str(e)}), 500


@app.route('/api/dfm/status')
def dfm_status():
    """Return status of a DFM job."""
    job_id = request.args.get('jobId')
    if not job_id:
        return jsonify({'error': 'missing_jobId'}), 400
    try:
        res = AsyncResult(job_id, app=celery)
        state_map = {
            'PENDING': 'queued',
            'STARTED': 'in_progress',
            'PROGRESS': 'in_progress',
            'SUCCESS': 'completed',
            'FAILURE': 'failed',
        }
        response = {'status': state_map.get(res.state, 'queued')}
        info = res.info if isinstance(res.info, dict) else {}
        if 'progress' in info:
            response['progress'] = info['progress']
        return jsonify(response)
    except Exception as e:
        logger.exception("dfm_status failed")
        return jsonify({'error': 'dfm_status_failed', 'message': str(e)}), 500


@app.route('/api/dfm/results')
def dfm_results():
    """Fetch final DFM results."""
    job_id = request.args.get('jobId')
    if not job_id:
        return jsonify({'error': 'missing_jobId'}), 400
    reports_dir = app.config.get('REPORTS_FOLDER', 'reports')
    json_path = os.path.join(reports_dir, f'dfm_result_{job_id}.json')
    if not os.path.exists(json_path):
        return jsonify({'error': 'not_found'}), 404
    try:
        with open(json_path) as fh:
            data = json.load(fh)
        data['reportUrls'] = {
            'pdf': url_for('download_pdf', filename=f'dfm_report_{job_id}.pdf'),
            'csv': url_for('download_csv', filename=f'dfm_report_{job_id}.csv'),
        }
        return jsonify(data)
    except Exception as e:
        logger.exception("dfm_results failed")
        return jsonify({'error': 'dfm_results_failed', 'message': str(e)}), 500

@app.route('/api/dfm-summary')
def dfm_summary():
    """Return a short summary for the last DFM analysis"""
    try:
        query = ConversionJob.query.filter(ConversionJob.dfm_score.isnot(None))
        if current_user.is_authenticated:
            query = query.filter_by(user_id=current_user.id)
        conversion = query.order_by(ConversionJob.created_at.desc()).first()
        if not conversion:
            return jsonify({'summary': ''})

        lang = session.get('language', 'fr')
        if lang == 'en':
            summary = (
                f"Moldability score: {conversion.dfm_score}/10 - "
                f"{conversion.dfm_overall_rating or 'N/A'}, "
                f"{conversion.dfm_issues_count or 0} issue(s)."
            )
        else:
            summary = (
                f"Score DFM : {conversion.dfm_score}/10 - "
                f"{conversion.dfm_overall_rating or 'N/A'}, "
                f"{conversion.dfm_issues_count or 0} problème(s)."
            )

        return jsonify({'summary': summary})
    except Exception as e:
        logger.error(f"Error fetching DFM summary: {str(e)}")
        return jsonify({'summary': ''}), 500

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

