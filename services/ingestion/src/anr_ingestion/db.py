"""Postgres access as anr_app, under forced row-level security. Ingestion never migrates."""

from collections.abc import Iterator
from contextlib import contextmanager

from psycopg import Connection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

type Conn = Connection[DictRow]


def create_pool(url: str, *, max_size: int = 4) -> ConnectionPool[Conn]:
    """A pool whose connections return rows as dicts. Opened lazily by the first request."""
    return ConnectionPool(
        url,
        min_size=0,
        max_size=max_size,
        kwargs={"row_factory": dict_row, "application_name": "ingestion"},
        connection_class=Connection[DictRow],
        open=False,
    )


@contextmanager
def with_newsroom(pool: ConnectionPool[Conn], newsroom_id: str) -> Iterator[Conn]:
    """The twin of `withNewsroom()` in @anr/db: one transaction scoped to one newsroom.

    The newsroom id is a transaction-local setting (`set_config(..., true)`), so a pooled
    connection never carries it into the next transaction; RLS policies read it through
    `anr.current_newsroom_id()`, which raises when it is unset.
    """
    with pool.connection() as conn, conn.transaction():
        conn.execute("select set_config('anr.newsroom_id', %s, true)", (newsroom_id,))
        yield conn
