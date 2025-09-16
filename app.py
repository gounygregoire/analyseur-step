import logging
import os
from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import RequestEntityTooLarge

from site_views import site_bp
from api_views import api_bp


def create_app():
    app = Flask(__name__, static_folder='static', template_folder='templates')
    app.config['UPLOAD_FOLDER'] = os.environ.get('UPLOAD_FOLDER', '/tmp/uploads')
    app.config['OUTPUT_FOLDER'] = os.environ.get('OUTPUT_FOLDER', '/tmp/converted')
    app.config['MAX_CONTENT_LENGTH'] = int(float(os.environ.get('MAX_UPLOAD_MB', '50'))) * 1024 * 1024
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    os.makedirs(app.config['OUTPUT_FOLDER'], exist_ok=True)

    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

    app.register_blueprint(site_bp)
    app.register_blueprint(api_bp, url_prefix='/api')

    @app.errorhandler(RequestEntityTooLarge)
    @app.errorhandler(413)
    def handle_413(error):
        message = "Fichier trop volumineux"
        if request.path.startswith('/api/'):
            return jsonify(error=message), 413
        return message, 413

    @app.errorhandler(404)
    def handle_404(error):
        if request.path.startswith('/api/'):
            return jsonify(error='Ressource API introuvable'), 404
        return render_template('500.html'), 404

    @app.errorhandler(500)
    def handle_500(e):
        app.logger.exception("Internal Server Error")
        if request.path.startswith('/api/'):
            return jsonify(error='Erreur interne du serveur'), 500
        return render_template('500.html'), 500

    return app


app = create_app()


@app.route('/__routes')
def __routes():
    return "<pre>" + "\n".join(sorted(str(r) for r in app.url_map.iter_rules())) + "</pre>"
