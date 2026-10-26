"""Readable text and metadata from a fetched page (trafilatura), and the item's language."""

import codecs
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime

import lxml.html
import py3langid
import trafilatura
from lxml.etree import ParserError

_LANG = re.compile(r"^[a-z]{2,3}$")
_WHITESPACE_RUN = re.compile(r"[ \t\r\f\v]+")
_BLANK_LINES = re.compile(r"\n{3,}")


@dataclass(frozen=True)
class Page:
    text: str | None
    headline: str | None
    by: str | None
    date: datetime | None
    language: str | None
    canonical: str | None
    """The page's own `<link rel="canonical">`, if it declares one."""
    article: bool = False
    """The page says it is an article (`og:type` article, or JSON-LD Article data): D69."""


ARTICLE_TYPES = frozenset(
    {
        "Article",
        "NewsArticle",
        "BlogPosting",
        "TechArticle",
        "ScholarlyArticle",
        "AnalysisNewsArticle",
        "ReportageNewsArticle",
    }
)


def _ld_types(node: object) -> set[str]:
    """Every schema.org `@type` in a JSON-LD value, through lists and `@graph`."""
    if isinstance(node, list):
        return {t for item in node for t in _ld_types(item)}
    if not isinstance(node, dict):
        return set()
    kind = node.get("@type")
    found = {kind} if isinstance(kind, str) else {k for k in kind or [] if isinstance(k, str)}
    return found | _ld_types(node.get("@graph"))


def is_article(tree: "lxml.html.HtmlElement") -> bool:
    for meta in tree.iterfind(".//meta[@property]"):
        if meta.get("property") == "og:type" and (meta.get("content") or "").lower() == "article":
            return True
    for script in tree.iterfind(".//script[@type]"):
        if (script.get("type") or "").lower() != "application/ld+json":
            continue
        try:
            data = json.loads(script.text or "")
        except ValueError:
            continue
        if _ld_types(data) & ARTICLE_TYPES:
            return True
    return False


def tidy(text: str) -> str:
    """Collapses runs of spaces and blank lines; the stored text keeps its paragraphs."""
    lines = [
        _WHITESPACE_RUN.sub(" ", line).strip() for line in text.replace("\r\n", "\n").split("\n")
    ]
    return _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()


def html_to_text(fragment: str) -> str:
    """Plain text of a small HTML fragment, such as a feed entry's summary."""
    if "<" not in fragment:
        return tidy(fragment)
    try:
        root = lxml.html.fragment_fromstring(fragment, create_parent="div")
    except (ParserError, ValueError):
        return tidy(fragment)
    for br in root.iter("br"):
        br.tail = "\n" + (br.tail or "")
    for block in root.iter("p", "li", "div", "h1", "h2", "h3", "h4", "blockquote"):
        block.tail = "\n\n" + (block.tail or "")
    return tidy(root.text_content())


def language_tag(value: str | None) -> str | None:
    """`en` for `en-US`, `EN`, `en_GB`; None for anything that is not a language subtag."""
    if not value:
        return None
    primary = value.strip().replace("_", "-").split("-")[0].lower()
    return primary if _LANG.match(primary) else None


def detect_language(text: str) -> str:
    """The language of `text` from character statistics (py3langid), when nothing declares one."""
    code, _score = py3langid.classify(text[:5000])
    return str(code)


_CHARSET = re.compile(rb"""charset\s*=\s*["']?([A-Za-z0-9._:-]+)""", re.IGNORECASE)


def decode_html(content: bytes, content_type: str = "") -> str:
    """The page as text, in the charset its Content-Type or <meta charset> declares (else UTF-8)."""
    for declared in (
        _CHARSET.search(content_type.encode("latin-1", "replace")),
        _CHARSET.search(content[:4096]),
    ):
        if declared:
            try:
                return content.decode(
                    codecs.lookup(declared.group(1).decode("ascii")).name, "replace"
                )
            except LookupError:
                continue
    return content.decode("utf-8", "replace")


def extract_page(content: bytes, url: str, content_type: str = "") -> Page:
    html = decode_html(content, content_type)
    doc = trafilatura.bare_extraction(
        html, url=url, with_metadata=True, include_comments=False, include_tables=False
    )
    declared: str | None = None
    canonical: str | None = None
    article = False
    try:
        tree = lxml.html.document_fromstring(html)
    except (ParserError, ValueError):
        tree = None
    if tree is not None:
        declared = language_tag(tree.get("lang"))
        article = is_article(tree)
        for link in tree.iterfind(".//link[@rel]"):
            if "canonical" in (link.get("rel") or "").lower().split() and link.get("href"):
                canonical = link.get("href")
                break
    if doc is None or isinstance(doc, dict):
        return Page(None, None, None, None, declared, canonical, article)
    text = tidy(doc.text) if doc.text else None
    return Page(
        text=text or None,
        headline=doc.title or None,
        by=doc.author or None,
        date=_parse_date(doc.date),
        language=declared,
        canonical=canonical,
        article=article,
    )


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
