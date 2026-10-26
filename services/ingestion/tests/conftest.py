"""Test support: a fake web from recorded fixtures, and the `anr_test` database.

Database tests connect as the production roles (anr_app for the code under test, anr_system to
set up rows) and fail, never skip, when the database is missing (D52).
"""

import json
import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from anr_ingestion.db import Conn, create_pool
from anr_ingestion.net import Fetcher
from anr_ingestion.pipeline import Ingestor
from anr_ingestion.rawstore import LocalRawStore
from anr_ingestion.replay import ReplayWeb

FIXTURES = Path(__file__).parent / "fixtures"
REPO = Path(__file__).resolve().parents[3]
MIGRATIONS = REPO / "packages/db/migrations"


FakeWeb = ReplayWeb


@pytest.fixture
def web() -> FakeWeb:
    return ReplayWeb.load(FIXTURES)


@pytest.fixture
def fetcher(web: FakeWeb) -> Iterator[Fetcher]:
    f = Fetcher(
        httpx.MockTransport(web.handler), user_agent="ANR-Ingestion/test", sleep=lambda _: None
    )
    yield f
    f.close()


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
    """The same server and role as `name` (an env var), on the anr_test database."""
    url = os.environ.get(name) or _root_env().get(name)
    if not url:
        raise RuntimeError(f"{name} is not set; copy .env.example to .env")
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path="/anr_test", query=""))


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
    # anr_system cannot read dbmate's table (least privilege); the migrator owns it.
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


POLICY = {
    "sources": {"min_independent": 2, "tier1_alone": True},
    "papers": {
        "tiers": ["flagged", "high", "medium", "low"],
        "newsletter_min": "high",
        "high_venues": ["NeurIPS", "ICML"],
        "high_citations": 500,
    },
    "auto_publish": [],
}


@dataclass
class Newsroom:
    id: str
    sources: dict[str, str]
    """Source slug -> id."""


def make_newsroom(db: Database, sources: list[dict[str, object]]) -> Newsroom:
    slug = f"t-{uuid.uuid4().hex[:8]}"
    row = db.system.execute(
        """insert into newsrooms
             (slug, subdomain, name, languages, timezone, editor_in_chief, corrections_owner,
              planning, policy)
           values (%s, %s, '{"en": "Test"}', '{en}', 'UTC', 'Editor', 'Editor', '{}', %s)
           returning id""",
        (slug, slug, json.dumps(POLICY)),
    ).fetchone()
    assert row is not None
    newsroom_id = str(row["id"])
    ids = {}
    for s in sources:
        r = db.system.execute(
            """insert into sources
                 (newsroom_id, slug, kind, url, publisher, tier, fetch_every, use, terms_checked)
               values (%s, %s, %s, %s, %s, %s, '1 hour', %s, %s) returning id""",
            (
                newsroom_id,
                s["slug"],
                s["kind"],
                s["url"],
                s.get("publisher"),
                s["tier"],
                s.get("use", "leads"),
                s.get("terms_checked", "2026-10-01"),
            ),
        ).fetchone()
        assert r is not None
        ids[str(s["slug"])] = str(r["id"])
    return Newsroom(newsroom_id, ids)


SOURCES: list[dict[str, object]] = [
    {"slug": "lab", "kind": "rss", "url": "https://openai.com/news/rss.xml", "tier": 1},
    {"slug": "digest", "kind": "rss", "url": "https://huggingface.co/blog/feed.xml", "tier": 3},
    {
        "slug": "arxiv-cs-ai",
        "kind": "api",
        "url": "https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate",
        "tier": 2,
    },
    {
        "slug": "hn",
        "kind": "api",
        "url": "https://hacker-news.firebaseio.com/v0/topstories.json",
        "tier": 3,
    },
    {"slug": "anthropic-news", "kind": "site", "url": "https://www.anthropic.com/news", "tier": 1},
    {
        "slug": "unchecked",
        "kind": "rss",
        "url": "https://blocked.example/feed.xml",
        "tier": 1,
        "terms_checked": None,
    },
    {
        "slug": "semantic-scholar",
        "kind": "api",
        "url": "https://api.semanticscholar.org/graph/v1",
        "tier": 2,
        "use": "enrichment",
    },
]


@pytest.fixture
def newsroom(database: Database) -> Newsroom:
    return make_newsroom(database, SOURCES)


@pytest.fixture
def ingestor(database: Database, fetcher: Fetcher, tmp_path: Path) -> Ingestor:
    return Ingestor(database.app, fetcher, LocalRawStore(tmp_path / "raw"))


def rows(db: Database, newsroom_id: str, sql: str, *params: object) -> list[dict[str, Any]]:
    """Reads as anr_system, filtered to one newsroom by the query itself."""
    return list(db.system.execute(sql, (newsroom_id, *params)).fetchall())
