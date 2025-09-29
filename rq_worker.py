# rq_worker.py — lance un worker RQ avec un sys.path correct et Redis TLS si besoin
import os, sys
from urllib.parse import urlparse, unquote
import redis
from rq import Worker, Queue, Connection

def _normalize_redis_url(url: str) -> str:
    if not url:
        return url
    url = url.strip().strip('"').strip("'")
    p = urlparse(url)
    host = (p.hostname or "")
    needs_tls = host.endswith("redis-cloud.com") or host.endswith("redns.redis-cloud.com") or (p.port == 12922)
    if needs_tls and p.scheme == "redis":
        url = url.replace("redis://", "rediss://", 1)
    return url

# s'assurer que la racine du projet est dans le PYTHONPATH
project_root = os.getcwd()
if project_root not in sys.path:
    sys.path.insert(0, project_root)

REDIS_URL = _normalize_redis_url(
    os.environ.get("REDIS_URL")
    or os.environ.get("REDIS_TLS_URL")
    or "redis://localhost:6379/0"
)
p = urlparse(REDIS_URL)
use_ssl = (p.scheme or "").lower().startswith("rediss")

conn = redis.Redis(
    host=p.hostname,
    port=p.port or 6379,
    username=(p.username or "default"),
    password=unquote(p.password or ""),
    db=int((p.path or "/0").lstrip("/")),
    ssl=use_ssl,
    ssl_cert_reqs=None,
    socket_timeout=10,
)

queue_name = os.environ.get("RQ_QUEUE_NAME", "default")
print(f"[rq_worker] starting. cwd={project_root} queue={queue_name} redis={REDIS_URL}")

with Connection(conn):
    Worker([Queue(queue_name)]).work(with_scheduler=False)
