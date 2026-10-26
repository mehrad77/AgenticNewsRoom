"""The whole pipeline against anr_test, with the fake web: sources into leads."""

import json
from typing import Any

import pytest
from conftest import Database, FakeWeb, Newsroom, rows

from anr_ingestion.net import Refused
from anr_ingestion.pipeline import CapReached, Ingestor, NotFound


def leads(db: Database, n: Newsroom) -> list[dict[str, Any]]:
    return rows(db, n.id, "select * from leads where newsroom_id = %s order by fetched_at, uri")


def sightings(db: Database, n: Newsroom) -> list[dict[str, Any]]:
    return rows(
        db,
        n.id,
        """select s.uri, s.match, src.slug as source, l.uri as lead_uri
           from lead_sightings s join leads l on l.id = s.lead_id
           left join sources src on src.id = s.source_id
           where s.newsroom_id = %s order by s.seen_at, s.uri""",
    )


def test_rss_run_stores_frozen_leads_with_ninjs_fields(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    assert len(report.new_leads) == 2
    assert report.errors == [
        ("https://openai.com/index/gone/", "https://openai.com/index/gone/: HTTP 404")
    ]
    orbit, safety = leads(database, newsroom)
    # The feed's tracking link redirected; the lead keeps the page's canonical URL.
    assert orbit["uri"] == "https://openai.com/index/introducing-orbit/"
    assert orbit["headline"] == "Introducing Orbit, a smaller model for long documents"
    assert orbit["byline"] == "Ada Example"
    assert orbit["language"] == "en"
    assert orbit["tier"] == 1
    assert str(orbit["raw_key"]).startswith("raw/")
    assert "two million tokens" in str(orbit["body"])
    assert orbit["simhash"] is not None and orbit["summary"] is None
    assert safety["uri"] == "https://openai.com/index/orbit-safety/"
    state = rows(database, newsroom.id, "select * from source_fetch_state where newsroom_id = %s")
    assert state[0]["etag"] == '"feed-v1"' and state[0]["consecutive_failures"] == 0


def test_text_is_frozen(ingestor: Ingestor, database: Database, newsroom: Newsroom) -> None:
    lead_id = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"]).new_leads[0]
    with pytest.raises(Exception, match="frozen"):
        database.system.execute("update leads set body = 'changed' where id = %s", (lead_id,))


def test_second_run_is_conditional_and_stores_nothing_new(
    ingestor: Ingestor, web: FakeWeb, newsroom: Newsroom
) -> None:
    ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    page_fetches = len([u for u in web.urls() if "/index/" in u])
    again = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    assert again.not_modified and again.new_leads == []
    assert web.requests[-1].headers["if-none-match"] == '"feed-v1"'
    assert len([u for u in web.urls() if "/index/" in u]) == page_fetches


def test_syndicated_copy_joins_the_original_lead(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    fetches_before = web.urls().count("https://openai.com/index/orbit-safety/")
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["digest"])
    assert report.new_leads == [] and report.sightings == 2
    assert len(leads(database, newsroom)) == 2  # no second lead for either copy
    seen = {(s["uri"], s["match"], s["source"]) for s in sightings(database, newsroom)}
    # The repost names openai.com as its canonical: another site, so ignored; its text matched.
    assert ("https://huggingface.co/blog/orbit-repost", "near-duplicate", "digest") in seen
    # The aggregator listed the lab's own URL: matched before fetching the page again.
    assert ("https://openai.com/index/orbit-safety/", "same-uri", "digest") in seen
    assert web.urls().count("https://openai.com/index/orbit-safety/") == fetches_before


def test_arxiv_papers_follow_the_paper_tier_rules(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    # Semantic Scholar's terms not checked yet: no enrichment, so no paper can be tier 1.
    database.system.execute(
        "update sources set terms_checked = null where id = %s",
        (newsroom.sources["semantic-scholar"],),
    )
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["arxiv-cs-ai"])
    assert report.dropped == 1  # the withdrawn paper
    by_uri = {lead["uri"]: lead for lead in leads(database, newsroom)}
    assert set(by_uri) == {"https://arxiv.org/abs/2610.01234", "https://arxiv.org/abs/2610.03333"}
    assert by_uri["https://arxiv.org/abs/2610.01234"]["tier"] == 2  # a preprint
    # Primary cs.LG, only cross-listed into cs.AI: low. Its "Accepted at NeurIPS" comment is
    # the authors' own claim and counts for nothing.
    assert by_uri["https://arxiv.org/abs/2610.03333"]["tier"] == 3
    assert report.retiered == 0
    assert not any("semanticscholar" in u for u in web.urls())


def test_enrichment_raises_a_paper_to_tier_1(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["arxiv-cs-ai"])
    by_uri = {lead["uri"]: lead for lead in leads(database, newsroom)}
    assert by_uri["https://arxiv.org/abs/2610.03333"]["tier"] == 1
    assert by_uri["https://arxiv.org/abs/2610.01234"]["tier"] == 2
    assert report.retiered == 1
    batch = next(r for r in web.requests if "/paper/batch" in str(r.url))
    assert json.loads(batch.content) == {"ids": ["ARXIV:2610.01234", "ARXIV:2610.03333"]}


def test_hacker_news_stores_metadata_never_the_linked_page(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["hn"])
    assert len(report.new_leads) == 2  # two stories; the job ad is not one
    story = next(lead for lead in leads(database, newsroom) if lead["uri"].endswith("41000001"))
    assert story["tier"] == 3
    assert story["links"] == [
        {"href": "https://openai.com/index/introducing-orbit/", "rel": "related"}
    ]
    assert not any(u.startswith("https://openai.com/") for u in web.urls())
    again = ingestor.ingest_source(newsroom.id, newsroom.sources["hn"])
    assert again.known == 2 and again.new_leads == []


def test_site_listing(ingestor: Ingestor, database: Database, newsroom: Newsroom) -> None:
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["anthropic-news"])
    assert len(report.new_leads) == 1
    (lead,) = leads(database, newsroom)
    assert lead["uri"] == "https://www.anthropic.com/news/claude-orbit-comparison"
    assert lead["headline"] == "Comparing long-context models" and lead["language"] == "en"


def test_refuses_sources_without_terms_and_enrichment_sources(
    ingestor: Ingestor, newsroom: Newsroom, web: FakeWeb
) -> None:
    with pytest.raises(Refused, match="terms_checked"):
        ingestor.ingest_source(newsroom.id, newsroom.sources["unchecked"])
    with pytest.raises(Refused, match="enrichment"):
        ingestor.ingest_source(newsroom.id, newsroom.sources["semantic-scholar"])
    assert web.requests == []


def test_another_newsrooms_source_is_invisible(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    from conftest import SOURCES, make_newsroom

    other = make_newsroom(database, SOURCES)
    with pytest.raises(NotFound):
        ingestor.ingest_source(newsroom.id, other.sources["lab"])


def agent_run(db: Database, n: Newsroom) -> str:
    row = db.system.execute(
        """insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash)
           values (%s, 'desk', 'fake', 'fake', 'v0', 'x') returning id""",
        (n.id,),
    ).fetchone()
    assert row is not None
    return str(row["id"])


def test_request_source_unknown_site_is_tier_3(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    run = agent_run(database, newsroom)
    lead, created = ingestor.request_source(newsroom.id, run, "https://unknown.example/report")
    assert created and lead["tier"] == 3
    (stored,) = leads(database, newsroom)
    assert stored["source_id"] is None and str(stored["requested_by_run"]) == run
    again, created = ingestor.request_source(newsroom.id, run, "https://unknown.example/report")
    assert not created and again["id"] == lead["id"]


def test_request_source_known_section_takes_its_sources_tier(
    ingestor: Ingestor, newsroom: Newsroom, database: Database
) -> None:
    run = agent_run(database, newsroom)
    # The lab's feed lives at /news, its posts at /index: vouched for once the source gave one.
    ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    lead, created = ingestor.request_source(
        newsroom.id, run, "https://openai.com/index/orbit-pricing/"
    )
    assert created and lead["tier"] == 1
    # The site source's own section (/news) is vouched for from the start.
    lead, _ = ingestor.request_source(
        newsroom.id, run, "https://www.anthropic.com/news/claude-orbit-comparison"
    )
    assert lead["tier"] == 1


def test_request_source_elsewhere_on_a_known_host_is_tier_3(
    ingestor: Ingestor, newsroom: Newsroom, database: Database
) -> None:
    # A shared host's other pages (anyone's model card, a community page) are not the source.
    run = agent_run(database, newsroom)
    lead, created = ingestor.request_source(
        newsroom.id, run, "https://www.anthropic.com/community/someones-page"
    )
    assert created and lead["tier"] == 3
    (stored,) = leads(database, newsroom)
    assert stored["source_id"] is None


def test_request_source_refusals(
    ingestor: Ingestor, newsroom: Newsroom, database: Database, web: FakeWeb
) -> None:
    run = agent_run(database, newsroom)
    with pytest.raises(Refused, match="terms"):
        ingestor.request_source(newsroom.id, run, "https://blocked.example/page")
    with pytest.raises(Refused):
        ingestor.request_source(newsroom.id, run, "http://169.254.169.254/latest/meta-data/")
    with pytest.raises(NotFound):
        ingestor.request_source(
            newsroom.id, "00000000-0000-0000-0000-000000000000", "https://unknown.example/report"
        )
    ingestor.max_requests_per_run = 1
    ingestor.request_source(newsroom.id, run, "https://unknown.example/report")
    with pytest.raises(CapReached):
        ingestor.request_source(
            newsroom.id, run, "https://www.anthropic.com/news/claude-orbit-comparison"
        )
