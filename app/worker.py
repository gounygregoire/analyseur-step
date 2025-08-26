import logging
from rq import Worker, Connection
from rq.logutils import setup_loghandlers
from .queue import q, conn

setup_loghandlers(logging.INFO)


def run():
    with Connection(conn):
        worker = Worker([q])
        worker.work()


if __name__ == "__main__":
    run()
