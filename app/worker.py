import os
from redis import Redis
from rq import Worker, Queue, Connection

listen = ["dfm"]
redis_conn = Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))


def run():
    with Connection(redis_conn):
        worker = Worker(list(map(Queue, listen)))
        worker.work()


if __name__ == "__main__":
    run()
