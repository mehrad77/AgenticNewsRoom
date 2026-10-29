"""Sources into stored leads (docs/technical-design.md#ingestion):
fetch → extract (raw page kept) → deduplicate → tier → store with frozen text.

Network work happens outside transactions; each item is stored in its own short transaction,
so one bad item never undoes the run, and a crash mid-run loses only the item in flight.
"""

from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any
from urllib.parse import urlencode, urljoin, urlsplit

from psycopg_pool import ConnectionPool

from anr_ingestion import enrich, store
from anr_ingestion.canonical import (
    arxiv_id,
    canonical_url,
    registrable_domain,
    same_site,
    section,
)
from anr_ingestion.db import Conn, with_newsroom
from anr_ingestion.dedupe import content_hash, is_near_duplicate, simhash
from anr_ingestion.extract import detect_language, extract_page
from anr_ingestion.items import Candidate, Listing
from anr_ingestion.kinds import (
    api_kind,
    arxiv_query_url,
    hn_candidate,
    hn_item_page_url,
    hn_item_url,
    hn_story_ids,
    parse_arxiv,
    parse_feed,
    parse_site,
    query_categories,
)
from anr_ingestion.media import (
    CONTENT_TYPES,
    NoSuchFile,
    commons_api_url,
    commons_page_url,
    commons_title,
    parse_commons,
    read_xmp,
    sniff_type,
)
from anr_ingestion.net import Fetched, Fetcher, FetchError, Refused, check_url
from anr_ingestion.rawstore import RawStore
from anr_ingestion.tier import PaperRules, is_high, paper_tier

MAX_NEW_LEADS = 50
"""New leads per scheduled run: a source's first fetch never floods the pool or its host."""
UNVOUCHED_TIER = 3
"""An agent-requested page no source vouches for (D61)."""
MAX_REQUESTS_PER_RUN = 5
"""Leads one agent run may have ingestion fetch for it (D61)."""
RETIER_DAYS = 30
ARXIV_API = "https://export.arxiv.org/api/query"
# Papers asked about per request when re-checking for withdrawals; arXiv asks for small queries.
RECHECK_BATCH = 50
WITHDRAWN_ON_ARXIV = "withdrawn on arXiv"
SEMANTIC_SCHOLAR_HOST = "api.semanticscholar.org"
HOST_DELAYS = {"export.arxiv.org": 3.0}
"""Seconds between requests where a source's terms ask for more than the default second."""
RUN_ERRORS = (FetchError, ValueError, KeyError, TypeError)
"""A failed fetch, or what a malformed answer raises (bad JSON, a missing field, an unknown API)."""


class NotFound(LookupError):
    pass


class CapReached(Exception):
    pass


class Outcome(StrEnum):
    NEW = "new"
    KNOWN = "known"
    SIGHTING = "sighting"
    DROPPED = "dropped"


@dataclass
class Report:
    source_id: str
    not_modified: bool = False
    new_leads: list[str] = field(default_factory=list)
    sightings: int = 0
    known: int = 0
    dropped: int = 0
    retiered: int = 0
    withdrawn: int = 0
    """Stored papers arXiv now calls withdrawn, marked this run (D78)."""
    errors: list[tuple[str, str]] = field(default_factory=list)

    def count(self, outcome: Outcome, lead_id: str | None) -> None:
        if outcome is Outcome.NEW and lead_id:
            self.new_leads.append(lead_id)
        elif outcome is Outcome.SIGHTING:
            self.sightings += 1
        elif outcome is Outcome.KNOWN:
            self.known += 1
        else:
            self.dropped += 1


@dataclass(frozen=True)
class Origin:
    """Where an item came from, and what it is worth before its own rules."""

    source_id: str | None
    tier: int
    language: str | None = None
    paper_rules: PaperRules | None = None
    categories: frozenset[str] = frozenset()
    requested_by_run: str | None = None
    not_before: datetime | None = None
    """A scheduled run's age limit: older or undated items are not stored (D68)."""
    vouched_section: str | None = None
    """For an agent's request: the section its source vouches for. A page that redirects out of
    it is stored as an unknown site's (tier 3, no source): D61."""


def too_old(
    origin: Origin, first: datetime | None, version: datetime | None, *, undated: bool
) -> bool:
    """Past the run's age limit by its newest date; `undated` says what no date at all means."""
    if origin.not_before is None:
        return False
    dates = [d if d.tzinfo else d.replace(tzinfo=UTC) for d in (first, version) if d]
    return max(dates) < origin.not_before if dates else undated


def refuse_unless_fetchable(src: store.Source) -> None:
    """D17: never fetched without terms_checked. Enrichment sources never add leads."""
    if src.removed:
        raise Refused(f"source {src.slug} was removed from sources.yaml")
    if src.terms_checked is None:
        raise Refused(f"source {src.slug} has no terms_checked; a person must read its terms first")
    if src.use != "leads":
        raise Refused(f"source {src.slug} is an enrichment source; it adds no leads")


class Ingestor:
    def __init__(
        self,
        pool: ConnectionPool[Conn],
        fetcher: Fetcher,
        raw_store: RawStore,
        *,
        max_new_leads: int = MAX_NEW_LEADS,
        max_requests_per_run: int = MAX_REQUESTS_PER_RUN,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.now = now
        self.pool = pool
        self.fetcher = fetcher
        self.raw_store = raw_store
        self.max_new_leads = max_new_leads
        self.max_requests_per_run = max_requests_per_run

    # A scheduled run: the ingest-source job.

    def ingest_source(self, newsroom_id: str, source_id: str) -> Report:
        with with_newsroom(self.pool, newsroom_id) as conn:
            src = store.source(conn, source_id)
            if src is None:
                raise NotFound(f"no source {source_id} in newsroom {newsroom_id}")
            refuse_unless_fetchable(src)
            state = store.fetch_state(conn, src.id)
            policy = store.policy(conn)
            enrichment = next(
                (
                    s
                    for s in store.sources(conn)
                    if s.use == "enrichment"
                    and urlsplit(s.url).hostname == SEMANTIC_SCHOLAR_HOST
                    and s.terms_checked is not None
                    and not s.removed
                ),
                None,
            )
        report = Report(source_id=src.id)
        try:
            api = api_kind(src.url) if src.kind == "api" else None
            url = arxiv_query_url(src.url) if api == "arxiv" else src.url
            # An API source's own requests answer to its API terms (read before terms_checked),
            # not robots.txt, which speaks to crawlers; arXiv's API host disallows every
            # crawler (D64). Pages are always fetched under robots.txt.
            fetched = self.fetcher.get(
                url,
                etag=state.etag,
                last_modified=state.last_modified,
                robots=src.kind != "api",
            )
            complete = True
            if fetched.status == 304:
                report.not_modified = True
            else:
                listing = self._listing(newsroom_id, src, api, fetched, report)
                origin = Origin(
                    source_id=src.id,
                    tier=src.tier,
                    language=listing.language,
                    paper_rules=PaperRules.from_policy(policy),
                    categories=query_categories(src.url),
                    not_before=self._not_before(policy),
                )
                for candidate in listing.candidates:
                    if not src.fetch_pages:
                        candidate = replace(candidate, fetch_page=False)
                    if len(report.new_leads) >= self.max_new_leads:
                        complete = False
                        break
                    try:
                        outcome, lead_id = self.store_item(newsroom_id, origin, candidate)
                    except RUN_ERRORS as error:
                        report.errors.append((candidate.uri, str(error)))
                        # A gone page (4xx) stays gone; anything else is tried again next run.
                        status = error.status if isinstance(error, FetchError) else None
                        if status is None or not 400 <= status < 500:
                            complete = False
                        continue
                    report.count(outcome, lead_id)
                if api == "arxiv":
                    try:
                        report.withdrawn = self._recheck_withdrawn(newsroom_id, src)
                    except RUN_ERRORS as error:
                        report.errors.append((src.url, str(error)))
                if api == "arxiv" and enrichment is not None:
                    try:
                        report.retiered = self._retier(newsroom_id, src, enrichment, origin)
                    except RUN_ERRORS as error:
                        report.errors.append((enrichment.url, str(error)))
        except RUN_ERRORS as error:
            # A failing fetch or an answer we cannot read is recorded on the source, then retried.
            with with_newsroom(self.pool, newsroom_id) as conn:
                status = error.status if isinstance(error, FetchError) else None
                store.record_fetch(conn, src, status=status, error=str(error))
            if isinstance(error, FetchError):
                raise
            raise FetchError(f"{src.url}: unreadable answer: {error!r}") from error
        with with_newsroom(self.pool, newsroom_id) as conn:
            # Validators are kept only when every listed item was handled: after the cap or an
            # item's error, the next run fetches the listing in full and takes the rest.
            store.record_fetch(
                conn,
                src,
                status=fetched.status,
                error=None,
                etag=fetched.etag if complete else None,
                last_modified=fetched.last_modified if complete else None,
            )
        return report

    def _not_before(self, policy: dict[str, Any]) -> datetime | None:
        days = (policy.get("leads") or {}).get("max_age_days")
        return self.now() - timedelta(days=int(days)) if days else None

    def _listing(
        self, newsroom_id: str, src: store.Source, api: str | None, fetched: Fetched, report: Report
    ) -> Listing:
        if src.kind == "rss":
            return parse_feed(fetched.content)
        if src.kind == "site":
            return parse_site(fetched.content, fetched.url, self.max_new_leads * 2)
        if api == "arxiv":
            return parse_arxiv(fetched.content)
        # Hacker News: a list of ids, then one small request per story not yet stored.
        candidates: list[Candidate] = []
        for item_id in hn_story_ids(fetched.content, self.max_new_leads):
            with with_newsroom(self.pool, newsroom_id) as conn:
                known = store.lead_by_uri(conn, hn_item_page_url(item_id)) is not None
            if known:
                report.known += 1
                continue
            try:
                item = self.fetcher.get(hn_item_url(src.url, item_id), robots=False)  # D64
            except FetchError as error:
                report.errors.append((hn_item_url(src.url, item_id), str(error)))
                continue
            candidate = hn_candidate(item.content)
            if candidate is not None:
                candidates.append(candidate)
        return Listing(candidates, language="en")

    # One item, from any path.

    def store_item(
        self, newsroom_id: str, origin: Origin, candidate: Candidate
    ) -> tuple[Outcome, str | None]:
        listed_uri = canonical_url(candidate.uri)
        # An item the listing dates too old is skipped before any lookup or fetch (D68).
        if too_old(origin, candidate.first_created, candidate.version_created, undated=False):
            return Outcome.DROPPED, None
        with with_newsroom(self.pool, newsroom_id) as conn:
            existing = store.lead_by_uri(conn, listed_uri)
            if existing and candidate.paper is not None and candidate.paper.withdrawn:
                store.mark_withdrawn(conn, existing, WITHDRAWN_ON_ARXIV)
            if existing:
                # Seen from another source: a sighting; from this one again: already known.
                new = self._sighted(conn, newsroom_id, existing, listed_uri, origin, "same-uri")
                return (Outcome.SIGHTING if new else Outcome.KNOWN), existing

        lead = self._build_lead(origin, candidate, listed_uri)
        if lead is None:
            return Outcome.DROPPED, None
        if lead.source_id != origin.source_id:
            origin = replace(origin, source_id=None, tier=UNVOUCHED_TIER)

        with with_newsroom(self.pool, newsroom_id) as conn:
            # After a redirect or a rel=canonical the page may turn out to be a known one.
            if lead.uri != listed_uri:
                existing = store.lead_by_uri(conn, lead.uri)
                if existing:
                    self._sighted(conn, newsroom_id, existing, lead.uri, origin, "same-uri")
                    self._sighted(conn, newsroom_id, existing, listed_uri, origin, "same-uri")
                    return Outcome.KNOWN, existing
            same = store.lead_by_hash(conn, lead.content_hash)
            match = "same-hash"
            if same is None and lead.simhash is not None:
                match = "near-duplicate"
                same = next(
                    (
                        lead_id
                        for lead_id, body in store.near_candidates(conn, lead.simhash)
                        if is_near_duplicate(lead.body, body, lead.language)
                    ),
                    None,
                )
            if same is not None:
                self._sighted(conn, newsroom_id, same, lead.uri, origin, match)
                return Outcome.SIGHTING, same
            lead_id = store.insert_lead(conn, newsroom_id, lead)
            if lead_id is None:
                return Outcome.KNOWN, store.lead_by_uri(conn, lead.uri)
            if listed_uri != lead.uri:
                # The listed spelling, so the next run skips this item before fetching it.
                store.add_sighting(
                    conn, newsroom_id, lead_id, listed_uri, origin.source_id, "same-uri"
                )
            return Outcome.NEW, lead_id

    @staticmethod
    def _sighted(
        conn: Conn, newsroom_id: str, lead_id: str, uri: str, origin: Origin, match: str
    ) -> bool:
        """Records a copy; a copy from a better-tier source raises the lead and credits it (D67)."""
        new = store.add_sighting(conn, newsroom_id, lead_id, uri, origin.source_id, match)
        if origin.source_id is not None:
            store.credit_lead(conn, lead_id, origin.source_id, origin.tier)
        return new

    def _build_lead(
        self, origin: Origin, candidate: Candidate, listed_uri: str
    ) -> store.NewLead | None:
        uri = listed_uri
        text = candidate.body
        headline = candidate.headline
        by = candidate.by
        language = candidate.language
        first_created: datetime | None = candidate.first_created
        raw_key = None
        if candidate.fetch_page:
            page_response = self.fetcher.get(candidate.uri)
            raw_key = self.raw_store.put(
                page_response.content, page_response.content_type or "text/html"
            )
            page = extract_page(
                page_response.content, page_response.url, page_response.content_type
            )
            uri = canonical_url(page_response.url)
            if origin.vouched_section and section(page_response.url) != origin.vouched_section:
                origin = replace(origin, source_id=None, tier=UNVOUCHED_TIER)
            if page.canonical:
                declared = canonical_url(urljoin(page_response.url, page.canonical))
                # A page may only name a canonical on its own site, or it could claim another's.
                if same_site(declared, page_response.url):
                    uri = declared
            if candidate.article_only and not page.article:
                return None  # a category or tag page, not a post (D69)
            text = page.text or text
            headline = headline or page.headline
            by = by or page.by
            language = language or page.language
            first_created = first_created or page.date
        elif candidate.raw is not None:
            raw_key = self.raw_store.put(candidate.raw, candidate.raw_type)
        if not text or not text.strip():
            return None
        if too_old(origin, first_created, candidate.version_created, undated=True):
            return None

        tier = origin.tier
        if candidate.paper is not None and origin.paper_rules is not None:
            paper = paper_tier(candidate.paper, text, origin.categories, origin.paper_rules)
            if paper is None:
                return None
            tier = paper
        language = language or origin.language or detect_language(text)
        return store.NewLead(
            uri=uri,
            headline=headline,
            body=text,
            language=language,
            by=by,
            first_created=first_created,
            version_created=candidate.version_created,
            content_hash=content_hash(text, language),
            simhash=simhash(text, language),
            tier=tier,
            raw_key=raw_key,
            links=candidate.links,
            source_id=origin.source_id,
            requested_by_run=origin.requested_by_run,
        )

    def _retier(
        self, newsroom_id: str, src: store.Source, enrichment: store.Source, origin: Origin
    ) -> int:
        """Raises recent papers to tier 1 once Semantic Scholar shows they are high."""
        rules = origin.paper_rules
        if rules is None or not (rules.high_venues or rules.high_citations):
            return 0
        with with_newsroom(self.pool, newsroom_id) as conn:
            papers = store.recent_papers(conn, src.id, RETIER_DAYS)
        by_paper = {pid: lead_id for lead_id, uri, _tier in papers if (pid := arxiv_id(uri))}
        if not by_paper:
            return 0
        found = enrich.lookup(self.fetcher, enrichment.url, sorted(by_paper))
        raised = 0
        with with_newsroom(self.pool, newsroom_id) as conn:
            for pid, info in found.items():
                if is_high(info, rules) and store.raise_tier(conn, by_paper[pid], 1):
                    raised += 1
        return raised

    def _recheck_withdrawn(self, newsroom_id: str, src: store.Source) -> int:
        """Asks arXiv for its own record of the source's recent papers and marks each one it
        now calls withdrawn (D78). A listing sorted by submission seldom shows a paper again."""
        with with_newsroom(self.pool, newsroom_id) as conn:
            papers = store.recent_live_papers(conn, src.id, RETIER_DAYS)
        by_paper = {pid: lead_id for lead_id, uri in papers if (pid := arxiv_id(uri))}
        ids = sorted(by_paper)
        marked = 0
        for start in range(0, len(ids), RECHECK_BATCH):
            batch = ids[start : start + RECHECK_BATCH]
            query = urlencode({"id_list": ",".join(batch), "max_results": len(batch)})
            fetched = self.fetcher.get(f"{ARXIV_API}?{query}", robots=False)
            withdrawn = [
                c.paper.arxiv_id
                for c in parse_arxiv(fetched.content).candidates
                if c.paper is not None and c.paper.withdrawn
            ]
            with with_newsroom(self.pool, newsroom_id) as conn:
                for pid in withdrawn:
                    if pid in by_paper and store.mark_withdrawn(
                        conn, by_paper[pid], WITHDRAWN_ON_ARXIV
                    ):
                        marked += 1
        return marked

    # An agent's request: the same steps, at once, for one URL (D61).

    def request_source(
        self, newsroom_id: str, run_id: str, url: str
    ) -> tuple[dict[str, Any], bool]:
        check_url(url)
        uri = canonical_url(url)
        with with_newsroom(self.pool, newsroom_id) as conn:
            if not store.agent_run_exists(conn, run_id):
                raise NotFound(f"no agent run {run_id} in newsroom {newsroom_id}")
            existing = store.lead_by_uri(conn, uri)
            if existing:
                return self._lead(conn, existing), False
            site = registrable_domain(url)
            on_site = [
                s
                for s in store.sources(conn)
                if not s.removed and s.use == "leads" and registrable_domain(s.url) == site
            ]
            wanted = section(url)
            # A source vouches only for its own section of its host (`openai.com/index`), never
            # for the rest of a shared host (`huggingface.co/<anyone>`): D61.
            vouching = [
                s
                for s in on_site
                if s.terms_checked is not None
                and wanted in {section(s.url), *store.sections(conn, s.id)}
            ]
        source_id: str | None = None
        tier = UNVOUCHED_TIER  # Not vouched for: an injected page cannot promote itself.
        if vouching:
            best = min(vouching, key=lambda s: s.tier)
            source_id, tier = best.id, best.tier
        elif any(s.terms_checked is None for s in on_site):
            raise Refused(f"{site} is a source whose terms nobody has checked yet")
        with with_newsroom(self.pool, newsroom_id) as conn:
            # Every fetch counts, whatever it turns out to be (a copy, no text): D61.
            if not store.claim_request(conn, newsroom_id, run_id, uri, self.max_requests_per_run):
                raise CapReached(
                    f"agent run {run_id} already requested {self.max_requests_per_run} sources"
                )
        origin = Origin(
            source_id=source_id,
            tier=tier,
            requested_by_run=run_id,
            vouched_section=wanted if vouching else None,
        )
        outcome, lead_id = self.store_item(newsroom_id, origin, Candidate(uri=url, fetch_page=True))
        if lead_id is None:
            raise FetchError(f"{url}: no readable text")
        with with_newsroom(self.pool, newsroom_id) as conn:
            return self._lead(conn, lead_id), outcome is Outcome.NEW

    @staticmethod
    def _lead(conn: Conn, lead_id: str) -> dict[str, Any]:
        row = store.lead_summary(conn, lead_id)
        if row is None:
            raise NotFound(f"no lead {lead_id}")
        return row

    # A desk member's image, by URL (D119).

    def add_media(
        self,
        newsroom_id: str,
        url: str,
        source_url: str | None,
        lead_id: str | None,
        added_by: str,
    ) -> tuple[str, bool, str | None]:
        """Fetches an image, reads its Photo Metadata and stores it: (media id, created, licence).
        A Commons file page records its free licence; any other image stays unlicensed until a
        person records its press kit's, so it must name the page it comes from."""
        check_url(url)
        with with_newsroom(self.pool, newsroom_id) as conn:
            if not store.newsroom_exists(conn):
                raise NotFound(f"no newsroom {newsroom_id}")
            if not store.user_exists(conn, added_by):
                raise NotFound(f"no user {added_by}")
            if lead_id is not None and not store.lead_exists(conn, lead_id):
                raise NotFound(f"no lead {lead_id} in newsroom {newsroom_id}")
        title = commons_title(url)
        commons = None
        if title is not None:
            source_url = commons_page_url(title)
            answer = self.fetcher.get(commons_api_url(title), robots=False)  # an API call: D64
            try:
                commons = parse_commons(answer.content)
            except NoSuchFile as error:
                raise Refused(str(error)) from error
            except (ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
                raise FetchError(f"{url}: unreadable answer from Commons: {error!r}") from error
            if commons.mime not in CONTENT_TYPES:
                raise Refused(f"{url}: {commons.mime} is not a JPEG, PNG or WebP image")
            url = commons.file_url
        elif source_url is None:
            raise Refused(f"{url}: an image not on Commons needs the page it comes from")
        fetched = self.fetcher.get(url)
        content_type = sniff_type(fetched.content)
        if content_type is None:
            raise Refused(f"{fetched.url}: not a JPEG, PNG or WebP image")
        xmp = read_xmp(fetched.content)
        media = store.NewMedia(
            file=self.raw_store.put(fetched.content, content_type),
            lead_id=lead_id,
            # Commons fills what the file's own metadata leaves empty.
            creator=xmp.creator or (commons.creator if commons else None),
            credit_line=xmp.credit_line or (commons.credit_line if commons else None),
            copyright_notice=xmp.copyright_notice,
            web_statement=xmp.web_statement,
            licensor=xmp.licensor,
            digital_source_type=xmp.digital_source_type,
            description=xmp.description or (commons.description if commons else None),
            source_url=source_url,
            file_url=fetched.url,
            content_type=content_type,
            added_by=added_by,
            licence=commons.licence if commons else None,
            licence_url=commons.licence_url if commons else None,
        )
        with with_newsroom(self.pool, newsroom_id) as conn:
            return store.insert_media(conn, newsroom_id, media)
