"""SQL for ingestion. Every function takes a connection inside `with_newsroom()`, so row-level
security scopes each statement to one newsroom; no query names a newsroom id except inserts,
whose `with check` policy refuses any other."""

from dataclasses import dataclass
from datetime import date
from typing import Any

from psycopg.types.json import Jsonb

from anr_ingestion.db import Conn
from anr_ingestion.dedupe import NEAR_DUPLICATE_BITS

NEAR_DUPLICATE_DAYS = 30


@dataclass(frozen=True)
class Source:
    id: str
    newsroom_id: str
    slug: str
    kind: str
    url: str
    publisher: str | None
    tier: int
    use: str
    terms_checked: date | None
    removed: bool
    fetch_pages: bool = True
    """False: a feed item's own text is the lead; its page is never fetched (D70)."""


@dataclass(frozen=True)
class FetchState:
    etag: str | None
    last_modified: str | None


@dataclass(frozen=True)
class NewLead:
    uri: str
    headline: str | None
    body: str
    language: str
    by: str | None
    first_created: Any
    version_created: Any
    content_hash: str
    simhash: int | None
    tier: int
    raw_key: str | None
    links: list[dict[str, str]]
    source_id: str | None
    requested_by_run: str | None = None


def _source(row: dict[str, Any]) -> Source:
    return Source(
        id=str(row["id"]),
        newsroom_id=str(row["newsroom_id"]),
        slug=row["slug"],
        kind=row["kind"],
        url=row["url"],
        publisher=row["publisher"],
        tier=row["tier"],
        use=row["use"],
        terms_checked=row["terms_checked"],
        removed=row["removed_at"] is not None,
        fetch_pages=row["fetch_pages"],
    )


_SOURCE_COLUMNS = (
    "id, newsroom_id, slug, kind, url, publisher, tier, use, terms_checked, removed_at, fetch_pages"
)


def source(conn: Conn, source_id: str) -> Source | None:
    row = conn.execute(
        f"select {_SOURCE_COLUMNS} from sources where id = %s", (source_id,)
    ).fetchone()
    return _source(row) if row else None


def sources(conn: Conn) -> list[Source]:
    rows = conn.execute(f"select {_SOURCE_COLUMNS} from sources order by slug").fetchall()
    return [_source(r) for r in rows]


def policy(conn: Conn) -> dict[str, Any]:
    row = conn.execute(
        "select policy from newsrooms where id = (select anr.current_newsroom_id())"
    ).fetchone()
    return dict(row["policy"]) if row else {}


def fetch_state(conn: Conn, source_id: str) -> FetchState:
    row = conn.execute(
        "select etag, last_modified from source_fetch_state where source_id = %s", (source_id,)
    ).fetchone()
    return FetchState(row["etag"], row["last_modified"]) if row else FetchState(None, None)


def record_fetch(
    conn: Conn,
    src: Source,
    *,
    status: int | None,
    error: str | None,
    etag: str | None = None,
    last_modified: str | None = None,
) -> None:
    """The outcome of fetching a source's URL. Validators are kept from a failed fetch."""
    conn.execute(
        """insert into source_fetch_state
             (newsroom_id, source_id, etag, last_modified, last_fetched_at, last_status, last_error,
              consecutive_failures)
           values (%(newsroom)s, %(source)s, %(etag)s, %(modified)s, now(), %(status)s, %(error)s,
              case when %(error)s::text is null then 0 else 1 end)
           on conflict (source_id) do update set
             etag = case when %(error)s::text is null then excluded.etag
                         else source_fetch_state.etag end,
             last_modified = case when %(error)s::text is null then excluded.last_modified
                                  else source_fetch_state.last_modified end,
             last_fetched_at = now(), last_status = excluded.last_status,
             last_error = excluded.last_error,
             consecutive_failures = case when %(error)s::text is null then 0
                                         else source_fetch_state.consecutive_failures + 1 end""",
        {
            "newsroom": src.newsroom_id,
            "source": src.id,
            "etag": etag,
            "modified": last_modified,
            "status": status,
            "error": error,
        },
    )


def lead_by_uri(conn: Conn, uri: str) -> str | None:
    """The lead this canonical URL already belongs to, as its own URL or a copy's."""
    row = conn.execute(
        "select lead_id from lead_sightings where uri = %s limit 1", (uri,)
    ).fetchone()
    return str(row["lead_id"]) if row else None


def lead_by_hash(conn: Conn, content_hash: str) -> str | None:
    row = conn.execute(
        "select id from leads where content_hash = %s order by fetched_at limit 1", (content_hash,)
    ).fetchone()
    return str(row["id"]) if row else None


def near_candidates(conn: Conn, simhash: int, limit: int = 5) -> list[tuple[str, str]]:
    """(id, body) of recent leads whose SimHash is within NEAR_DUPLICATE_BITS, closest first."""
    rows = conn.execute(
        """select id, body from leads
           where simhash is not null
             and fetched_at > now() - make_interval(days => %s)
             and bit_count((simhash # %s)::bit(64)) <= %s
           order by bit_count((simhash # %s)::bit(64)), fetched_at
           limit %s""",
        (NEAR_DUPLICATE_DAYS, simhash, NEAR_DUPLICATE_BITS, simhash, limit),
    ).fetchall()
    return [(str(r["id"]), r["body"]) for r in rows]


def add_sighting(
    conn: Conn, newsroom_id: str, lead_id: str, uri: str, source_id: str | None, match: str
) -> bool:
    """Records that `uri` (from `source_id`) is a copy of `lead_id`; False if already recorded."""
    cur = conn.execute(
        """insert into lead_sightings (newsroom_id, lead_id, uri, source_id, match)
           values (%s, %s, %s, %s, %s)
           on conflict (newsroom_id, uri, source_id) do nothing""",
        (newsroom_id, lead_id, uri, source_id, match),
    )
    return cur.rowcount == 1


def insert_lead(conn: Conn, newsroom_id: str, lead: NewLead) -> str | None:
    """Stores a lead and its own sighting; None when its URL was stored first by another run."""
    row = conn.execute(
        """insert into leads
             (newsroom_id, source_id, uri, headline, body, language, byline, first_created,
              version_created, content_hash, simhash, tier, raw_key, links, requested_by_run)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           on conflict (newsroom_id, uri) do nothing
           returning id""",
        (
            newsroom_id,
            lead.source_id,
            lead.uri,
            lead.headline,
            lead.body,
            lead.language,
            lead.by,
            lead.first_created,
            lead.version_created,
            lead.content_hash,
            lead.simhash,
            lead.tier,
            lead.raw_key,
            Jsonb(lead.links),
            lead.requested_by_run,
        ),
    ).fetchone()
    if row is None:
        return None
    lead_id = str(row["id"])
    add_sighting(conn, newsroom_id, lead_id, lead.uri, lead.source_id, "original")
    return lead_id


def lead_summary(conn: Conn, lead_id: str) -> dict[str, Any] | None:
    return conn.execute(
        "select id, uri, headline, tier from leads where id = %s", (lead_id,)
    ).fetchone()


def agent_run_exists(conn: Conn, run_id: str) -> bool:
    return conn.execute("select 1 from agent_runs where id = %s", (run_id,)).fetchone() is not None


def claim_request(conn: Conn, newsroom_id: str, run_id: str, uri: str, cap: int) -> bool:
    """Logs one fetch for an agent run, unless the run already has `cap` (D61). Requests for one
    run are serialised by a transaction lock, so two at once can't both take the last slot."""
    conn.execute("select pg_advisory_xact_lock(hashtextextended(%s, 0))", (run_id,))
    row = conn.execute(
        "select count(*) as n from source_requests where agent_run_id = %s", (run_id,)
    ).fetchone()
    if row and int(row["n"]) >= cap:
        return False
    conn.execute(
        "insert into source_requests (newsroom_id, agent_run_id, uri) values (%s, %s, %s)",
        (newsroom_id, run_id, uri),
    )
    return True


def sections(conn: Conn, source_id: str) -> set[str]:
    """The host-and-first-segment prefixes of every URL this source has given us."""
    rows = conn.execute(
        """select distinct substring(uri from '^[a-z]+://[^/]+/[^/?#]*') as section
           from lead_sightings where source_id = %s""",
        (source_id,),
    ).fetchall()
    return {r["section"] for r in rows if r["section"]}


def recent_papers(conn: Conn, source_id: str, days: int) -> list[tuple[str, str, int]]:
    """(lead id, uri, tier) of this source's papers not yet tier 1, fetched in the last `days`."""
    rows = conn.execute(
        """select id, uri, tier from leads
           where source_id = %s and tier > 1 and fetched_at > now() - make_interval(days => %s)""",
        (source_id, days),
    ).fetchall()
    return [(str(r["id"]), r["uri"], r["tier"]) for r in rows]


def recent_live_papers(conn: Conn, source_id: str, days: int) -> list[tuple[str, str]]:
    """(lead id, uri) of this source's leads from the last `days` not yet marked withdrawn."""
    rows = conn.execute(
        """select id, uri from leads
           where source_id = %s and withdrawn_at is null
             and fetched_at > now() - make_interval(days => %s)
           order by fetched_at""",
        (source_id, days),
    ).fetchall()
    return [(str(r["id"]), r["uri"]) for r in rows]


def mark_withdrawn(conn: Conn, lead_id: str, reason: str) -> bool:
    """Marks a stored lead withdrawn (issue #3, D78): its text stays frozen and claims citing it
    stay readable, but search and assignments skip it and the verifier fails such claims."""
    cur = conn.execute(
        """update leads set withdrawn_at = now(), withdrawn_reason = %s
           where id = %s and withdrawn_at is null""",
        (reason, lead_id),
    )
    return cur.rowcount == 1


def raise_tier(conn: Conn, lead_id: str, tier: int) -> bool:
    """Raises a lead's tier (a lower number); never lowers it."""
    cur = conn.execute(
        "update leads set tier = %s where id = %s and tier > %s", (tier, lead_id, tier)
    )
    return cur.rowcount == 1


def credit_lead(conn: Conn, lead_id: str, source_id: str, tier: int) -> bool:
    """Credits a lead to a better-tier source that also carries it (D67). Papers keep D59's tier
    and their arXiv source, so a copy never makes a paper tier 1."""
    cur = conn.execute(
        """update leads set tier = %s, source_id = %s
           where id = %s and tier > %s and uri not like 'https://arxiv.org/abs/%%'""",
        (tier, source_id, lead_id, tier),
    )
    return cur.rowcount == 1
