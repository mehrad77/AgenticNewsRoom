from datetime import UTC, datetime

import pytest
from conftest import FIXTURES

from anr_ingestion.extract import extract_page, html_to_text
from anr_ingestion.kinds import (
    api_kind,
    arxiv_query_url,
    hn_candidate,
    parse_arxiv,
    parse_feed,
    parse_site,
    query_categories,
)


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def test_rss() -> None:
    listing = parse_feed(fixture("lab-feed.xml"))
    assert listing.language == "en"
    first = listing.candidates[0]
    assert first.headline == "Introducing Orbit, a smaller model for long documents"
    assert first.fetch_page and first.body == "Orbit reads documents of up to two million tokens."
    assert first.first_created == datetime(2026, 10, 19, 14, 0, tzinfo=UTC)


def test_atom() -> None:
    listing = parse_feed(fixture("aggregator-feed.xml"))
    assert [c.uri for c in listing.candidates] == [
        "https://huggingface.co/blog/orbit-repost",
        "https://openai.com/index/orbit-safety/",
    ]
    assert listing.candidates[0].by == "Digest Desk"


def test_arxiv() -> None:
    listing = parse_arxiv(fixture("arxiv.xml"))
    planning, withdrawn, sparse = listing.candidates
    assert planning.uri == "https://arxiv.org/abs/2610.01234"
    assert planning.headline == "Planning with Long Contexts: A Study of Retrieval Inside the Model"
    assert planning.by == "Mina Example, Jon Sample"
    assert planning.paper is not None and planning.paper.primary_category == "cs.AI"
    assert planning.version_created == datetime(2026, 10, 20, 17, 0, tzinfo=UTC)
    assert not planning.fetch_page and planning.raw is not None
    assert withdrawn.paper is not None and withdrawn.paper.withdrawn
    # The authors' "Accepted at NeurIPS" comment is not evidence of anything (D59).
    assert sparse.paper is not None and not sparse.paper.withdrawn


def test_arxiv_query() -> None:
    url = "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG&max_results=20"
    assert query_categories(url) == {"cs.AI", "cs.LG"}
    assert "max_results=20" in arxiv_query_url(url)
    assert "sortOrder=descending" in arxiv_query_url(url)


def test_api_kind() -> None:
    assert api_kind("https://export.arxiv.org/api/query") == "arxiv"
    assert api_kind("https://hacker-news.firebaseio.com/v0/topstories.json") == "hn"
    with pytest.raises(ValueError, match="no API adapter"):
        api_kind("https://api.example.com/v1")


def test_hacker_news_is_metadata_only() -> None:
    story = hn_candidate(fixture("hn-41000001.json"))
    assert story is not None
    assert story.uri == "https://news.ycombinator.com/item?id=41000001"
    assert not story.fetch_page
    assert story.links == [
        {"href": "https://openai.com/index/introducing-orbit/", "rel": "related"}
    ]
    assert story.body is not None and "310 points" in story.body
    ask = hn_candidate(fixture("hn-41000002.json"))
    assert ask is not None and ask.links == []
    assert ask.body is not None and "What benchmarks do you trust?" in ask.body
    assert hn_candidate(fixture("hn-41000003.json")) is None  # a job ad, not a story


def test_site_listing() -> None:
    listing = parse_site(fixture("site-listing.html"), "https://www.anthropic.com/news", 10)
    assert [c.uri for c in listing.candidates] == [
        "https://www.anthropic.com/news/claude-orbit-comparison"
    ]


def test_extract_page() -> None:
    page = extract_page(fixture("orbit.html"), "https://openai.com/index/introducing-orbit/")
    assert page.language == "en"
    assert page.canonical == "https://openai.com/index/introducing-orbit/"
    assert page.text is not None and "\nToday we are releasing Orbit" in page.text
    assert "All rights reserved" not in page.text  # boilerplate is left out
    assert extract_page(fixture("site-post.html"), "https://x.example/").language == "en"


def test_html_to_text() -> None:
    assert html_to_text("<p>One.</p><p>Two <b>bold</b>.</p>") == "One.\n\nTwo bold."
