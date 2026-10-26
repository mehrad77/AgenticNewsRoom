"""Turning a source's response into candidates, one function per kind of source.

An `api` source's adapter is chosen by its URL's host; adapters are generic per API (any arXiv
query, any Hacker News list), so a new newsroom never needs code to use them. An unknown API host
is an error, never a guess.
"""

import json
import re
import time
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import feedparser
import lxml.html
from lxml.etree import ParserError

from anr_ingestion.canonical import arxiv_id
from anr_ingestion.extract import html_to_text, language_tag, tidy
from anr_ingestion.items import Candidate, Listing, Paper

type ApiKind = Literal["arxiv", "hn"]

_WITHDRAWN = re.compile(r"\bwithdrawn\b", re.IGNORECASE)
_QUERY_CATEGORY = re.compile(r"cat:([A-Za-z-]+(?:\.[A-Za-z-]+)?)")
HN_ITEM_PAGE = "https://news.ycombinator.com/item?id={id}"


def api_kind(url: str) -> ApiKind:
    host = urlsplit(url).hostname or ""
    if host == "export.arxiv.org":
        return "arxiv"
    if host == "hacker-news.firebaseio.com":
        return "hn"
    raise ValueError(f"no API adapter for {host}")


def _when(parsed: Any) -> datetime | None:
    """feedparser's `*_parsed` values are UTC `time.struct_time`s."""
    if not isinstance(parsed, time.struct_time):
        return None
    return datetime(*parsed[:6], tzinfo=UTC)


def _text(value: Any) -> str | None:
    return tidy(str(value)) or None if value else None


def _line(value: Any) -> str | None:
    """A headline or byline: one line, single spaces."""
    return " ".join(str(value).split()) or None if value else None


def parse_feed(content: bytes) -> Listing:
    """RSS 2.0, RSS 1.0 or Atom. Each entry's page is fetched; its own text is the fallback."""
    feed: Any = feedparser.parse(content)
    candidates = []
    for entry in feed.entries:
        link = entry.get("link")
        if not link:
            continue
        contents = entry.get("content") or []
        body = contents[0].get("value") if contents else entry.get("summary")
        candidates.append(
            Candidate(
                uri=str(link),
                fetch_page=True,
                headline=_line(entry.get("title")),
                by=_line(entry.get("author")),
                language=language_tag(entry.get("language")),
                first_created=_when(entry.get("published_parsed")),
                # dict.get: feedparser's own .get quietly answers `published` for `updated`.
                version_created=_when(dict.get(entry, "updated_parsed")),
                body=html_to_text(str(body)) if body else None,
            )
        )
    return Listing(candidates, language=language_tag(feed.feed.get("language")))


def arxiv_query_url(url: str, max_results: int = 100) -> str:
    """The source's query, newest first, with a page size unless the source sets one."""
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.setdefault("sortBy", "submittedDate")
    query.setdefault("sortOrder", "descending")
    query.setdefault("max_results", str(max_results))
    return urlunsplit(parts._replace(query=urlencode(query)))


def query_categories(url: str) -> frozenset[str]:
    query = dict(parse_qsl(urlsplit(url).query))
    return frozenset(_QUERY_CATEGORY.findall(query.get("search_query", "")))


def parse_arxiv(content: bytes) -> Listing:
    """arXiv's Atom API. The abstract is the stored text; the paper's PDF is never fetched."""
    feed: Any = feedparser.parse(content)
    candidates = []
    for entry in feed.entries:
        paper_id = arxiv_id(str(entry.get("id", "")))
        if not paper_id:
            continue
        abstract = _text(entry.get("summary")) or ""
        comment = str(entry.get("arxiv_comment") or "")
        primary = entry.get("arxiv_primary_category") or {}
        authors = [str(a.get("name")) for a in entry.get("authors", []) if a.get("name")]
        candidates.append(
            Candidate(
                uri=f"https://arxiv.org/abs/{paper_id}",
                fetch_page=False,
                headline=_line(entry.get("title")),
                by=", ".join(authors) or None,
                language="en",
                first_created=_when(entry.get("published_parsed")),
                version_created=_when(entry.get("updated_parsed")),
                body=abstract or None,
                raw=json.dumps(_plain(entry), ensure_ascii=False, sort_keys=True).encode(),
                raw_type="application/json",
                paper=Paper(
                    arxiv_id=paper_id,
                    primary_category=str(primary.get("term")) if primary.get("term") else None,
                    categories=tuple(str(t.get("term")) for t in entry.get("tags", [])),
                    withdrawn=bool(_WITHDRAWN.search(comment))
                    or (len(abstract) < 300 and bool(_WITHDRAWN.search(abstract))),
                ),
            )
        )
    return Listing(candidates, language="en")


def _plain(entry: Any) -> Any:
    """The entry as plain JSON (feedparser's dicts carry struct_times)."""
    if isinstance(entry, dict):
        return {str(k): _plain(v) for k, v in entry.items() if not str(k).endswith("_parsed")}
    if isinstance(entry, list | tuple):
        return [_plain(v) for v in entry]
    return entry if isinstance(entry, str | int | float | bool) or entry is None else str(entry)


def hn_story_ids(content: bytes, limit: int) -> list[int]:
    ids = json.loads(content)
    if not isinstance(ids, list):
        raise ValueError("Hacker News list is not a JSON array")
    return [int(i) for i in ids[:limit]]


def hn_item_page_url(item_id: int) -> str:
    """The item's discussion page: the URI of its lead."""
    return HN_ITEM_PAGE.format(id=item_id)


def hn_item_url(list_url: str, item_id: int) -> str:
    parts = urlsplit(list_url)
    return f"{parts.scheme}://{parts.netloc}/v0/item/{item_id}.json"


def hn_candidate(content: bytes) -> Candidate | None:
    """A Hacker News story, metadata only: the linked page is never fetched (D60).

    The lead is the HN item itself (its URI is the discussion page); the article it points to is
    a ninjs link, which an agent can request through ingestion like any other page.
    """
    item = json.loads(content)
    if not isinstance(item, dict) or item.get("type") != "story":
        return None
    if item.get("dead") or item.get("deleted") or not item.get("title"):
        return None
    title = tidy(str(item["title"]))
    lines = [title]
    if item.get("text"):
        lines.append(html_to_text(str(item["text"])))
    links = []
    if item.get("url"):
        lines.append(f"Link: {item['url']}")
        links.append({"href": str(item["url"]), "rel": "related"})
    lines.append(
        f"Hacker News: {item.get('score', 0)} points, {item.get('descendants', 0)} comments,"
        f" posted by {item.get('by', 'unknown')}."
    )
    created = (
        datetime.fromtimestamp(int(item["time"]), tz=UTC) if item.get("time") is not None else None
    )
    return Candidate(
        uri=hn_item_page_url(int(item["id"])),
        fetch_page=False,
        headline=title,
        by=str(item["by"]) if item.get("by") else None,
        first_created=created,
        body="\n\n".join(lines),
        raw=content,
        raw_type="application/json",
        links=links,
    )


def parse_site(content: bytes, url: str, limit: int) -> Listing:
    """A listing page without a feed: links on the same host below the listing's path."""
    try:
        root = lxml.html.document_fromstring(content.decode("utf-8", "replace"))
    except (ParserError, ValueError):
        return Listing([])
    root.make_links_absolute(url)
    base = urlsplit(url)
    prefix = base.path.rstrip("/") + "/"
    seen: set[str] = set()
    candidates = []
    for anchor in root.iterfind(".//a[@href]"):
        href = urljoin(url, anchor.get("href") or "").split("#")[0]
        parts = urlsplit(href)
        if parts.hostname != base.hostname or not parts.path.startswith(prefix):
            continue
        if parts.path.rstrip("/") + "/" == prefix or href in seen:
            continue
        seen.add(href)
        candidates.append(Candidate(uri=href, fetch_page=True, article_only=True))
        if len(candidates) >= limit:
            break
    return Listing(candidates, language=language_tag(root.get("lang")))
