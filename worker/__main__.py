# worker/__main__.py
import os
from rq import Worker, Queue, Connection
from redis import from_url

listen = [q.strip() for q in os.getenv("RQ_QUEUES", "convert,default").split(",")]
redis_url = os.getenv("REDIS_URL", "redis://default:gISbsmwsGo5RgJtTA9xX9TQknzx0cvD6@redis-12922.c327.europe-west1-2.gce.redns.redis-cloud.com:12922/0")
conn = from_url(redis_url)

if __name__ == "__main__":
    with Connection(conn):
        Worker([Queue(n) for n in listen]).work(with_scheduler=True)
