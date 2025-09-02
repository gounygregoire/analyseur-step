# web.py — Gunicorn entrypoint for Render (do not change project structure)
# This file must import the existing Flask app without moving files around.

import logging

logging.basicConfig(level=logging.INFO)
logging.info("web.py starting Flask app")

try:
    # Preferred explicit import if your Flask app is exposed as `app` in app/app.py
    from app.app import app  # noqa: F401
except Exception:
    # Fallback: some projects expose the Flask app as `app` in a module named `web` or similar.
    # If your project already has a module-level `app`, keep the import above and delete this block.
    raise

# Optional health endpoint (won't override if already present elsewhere)
try:
    @app.route("/health")
    def _health():
        return {"status": "ok"}, 200
except Exception:
    # If already defined, ignore
    pass

if __name__ == "__main__":
    # Local dev fallback
    app.run(host="0.0.0.0", port=5000)
