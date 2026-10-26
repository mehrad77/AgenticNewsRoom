"""What a source yields before it becomes a lead. Field names follow ninjs where one exists."""

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True)
class Paper:
    """An arXiv paper's metadata, for the paper tier rules (D59)."""

    arxiv_id: str
    primary_category: str | None
    categories: tuple[str, ...]
    withdrawn: bool


@dataclass
class Candidate:
    """One item a source listed: a feed entry, an API record or a link on a listing page."""

    uri: str
    """Where the item lives; canonicalised before any lookup."""
    fetch_page: bool
    """Fetch `uri` and extract its text; otherwise `body` is the item's whole text."""
    headline: str | None = None
    by: str | None = None
    language: str | None = None
    first_created: datetime | None = None
    version_created: datetime | None = None
    body: str | None = None
    """Text the source itself gave: a feed's content or summary, an abstract. The fallback when
    page extraction fails, and the body when `fetch_page` is false."""
    raw: bytes | None = None
    """The item's own raw bytes when no page is fetched (the API record)."""
    raw_type: str = "application/octet-stream"
    links: list[dict[str, str]] = field(default_factory=list)
    """ninjs `links`, such as `{"href": ..., "rel": "related"}` for a Hacker News item's page."""
    paper: Paper | None = None
    article_only: bool = False
    """Keep the fetched page only if it says it is an article: a listing page's links include
    category and tag pages it cannot tell apart from posts (D69)."""


@dataclass(frozen=True)
class Listing:
    """What one fetch of a source's URL produced."""

    candidates: list[Candidate]
    language: str | None = None
    """The feed's declared language, used when an item has none of its own."""
