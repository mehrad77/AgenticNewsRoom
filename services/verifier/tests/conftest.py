"""Test support: the `anr_test` database, as the production roles (anr_app for the code under
test, anr_system to set up rows). Database tests fail, never skip, without it (D52)."""

import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from anr_verifier.db import Conn, create_pool

REPO = Path(__file__).resolve().parents[3]
MIGRATIONS = REPO / "packages/db/migrations"


def _root_env() -> dict[str, str]:
    env: dict[str, str] = {}
    path = REPO / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip()
    return env


def anr_test_url(name: str) -> str:
    url = os.environ.get(name) or _root_env().get(name)
    if not url:
        raise RuntimeError(f"{name} is not set; copy .env.example to .env")
    return urlunsplit(urlsplit(url)._replace(path="/anr_test", query=""))


@dataclass
class Database:
    app: ConnectionPool[Conn]
    system: Conn


@pytest.fixture(scope="session")
def database() -> Iterator[Database]:
    fix = "start it with `pnpm db:up && pnpm db:migrate`"
    try:
        system = psycopg.connect(
            anr_test_url("DATABASE_SYSTEM_URL"), autocommit=True, row_factory=dict_row
        )
    except psycopg.OperationalError as error:
        raise RuntimeError(f"Postgres test database unreachable ({error}); {fix}") from error
    with psycopg.connect(anr_test_url("DATABASE_MIGRATION_URL"), row_factory=dict_row) as migrator:
        versions = migrator.execute("select version from schema_migrations").fetchall()
    applied = {str(r["version"]) for r in versions}
    missing = [f.name for f in MIGRATIONS.glob("*.sql") if f.name.split("_")[0] not in applied]
    if missing:
        raise RuntimeError(f"anr_test is missing migrations {', '.join(sorted(missing))}; {fix}")
    pool = create_pool(anr_test_url("DATABASE_URL"))
    pool.open()
    yield Database(app=pool, system=system)
    pool.close()
    system.close()
