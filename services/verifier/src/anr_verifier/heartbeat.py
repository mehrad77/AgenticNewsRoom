"""Heartbeats (D128): the service beats every 30 seconds through anr.beat(), which records a gap of
more than 3 minutes between beats as an outage, by Postgres's clock."""

import logging
import threading
from collections.abc import Callable

from psycopg_pool import ConnectionPool

from anr_verifier.db import Conn

HEARTBEAT_SECONDS = 30
log = logging.getLogger(__name__)


def start_heartbeat(pool: ConnectionPool[Conn], worker: str) -> Callable[[], None]:
    """Beats now and every 30 seconds on a daemon thread; returns the function that stops it."""
    stopped = threading.Event()

    def run() -> None:
        while True:
            try:
                with pool.connection() as conn:
                    conn.execute("select anr.beat(%s)", (worker,))
            except Exception as error:  # a missed beat shows as a gap once Postgres is back
                log.error("heartbeat: %s", error)
            if stopped.wait(HEARTBEAT_SECONDS):
                return

    threading.Thread(target=run, name=f"{worker}-heartbeat", daemon=True).start()
    return stopped.set
