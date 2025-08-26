import os
import logging
from redis import Redis
from rq import Queue
from rq.logutils import setup_loghandlers

setup_loghandlers(logging.INFO)

redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
conn = Redis.from_url(redis_url, ssl=redis_url.startswith("rediss://"))
q = Queue(os.getenv("RQ_QUEUE", "default"), connection=conn)
