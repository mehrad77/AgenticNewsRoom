"""The whole pipeline against anr_test, with the fake web: sources into leads."""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from conftest import Database, FakeWeb, Newsroom, rows

from anr_ingestion.net import FetchError, Refused
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


def test_a_copy_from_a_better_source_raises_the_lead(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    # The aggregator (tier 3) runs first; the lab's own feed (tier 1) then sees the same posts.
    ingestor.ingest_source(newsroom.id, newsroom.sources["digest"])
    assert {lead["tier"] for lead in leads(database, newsroom)} == {3}
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    assert report.new_leads == []
    stored = leads(database, newsroom)
    assert len(stored) == 2
    assert {(lead["tier"], str(lead["source_id"])) for lead in stored} == {
        (1, newsroom.sources["lab"])
    }
    # Both sources' sightings stay, so independence is still counted from them.
    assert {s["source"] for s in sightings(database, newsroom)} == {"lab", "digest"}


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


def test_arxiv_runs_mark_stored_papers_arxiv_now_calls_withdrawn(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    # arXiv's own record of 2610.01234 now says withdrawn (issue #3, D78).
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["arxiv-cs-ai"])
    assert report.withdrawn == 1
    by_uri = {lead["uri"]: lead for lead in leads(database, newsroom)}
    withdrawn = by_uri["https://arxiv.org/abs/2610.01234"]
    assert withdrawn["withdrawn_reason"] == "withdrawn on arXiv"
    assert withdrawn["withdrawn_at"] is not None
    assert by_uri["https://arxiv.org/abs/2610.03333"]["withdrawn_at"] is None
    # Its frozen text and tier are untouched; a second run marks nothing new.
    assert withdrawn["tier"] == 2
    assert ingestor.ingest_source(newsroom.id, newsroom.sources["arxiv-cs-ai"]).withdrawn == 0
    assert any("id_list=" in str(r.url) for r in web.requests)


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
    # The category page it also links to is fetched, says it is no article, and is dropped (D69).
    assert len(report.new_leads) == 1 and report.dropped == 1
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


def test_api_sources_follow_their_terms_not_robots_txt(
    ingestor: Ingestor, newsroom: Newsroom, web: FakeWeb
) -> None:
    # Both API hosts answer `Disallow: /` in the fixtures, as export.arxiv.org really does.
    assert ingestor.ingest_source(newsroom.id, newsroom.sources["arxiv-cs-ai"]).new_leads
    assert ingestor.ingest_source(newsroom.id, newsroom.sources["hn"]).new_leads
    assert not any(u.endswith("/robots.txt") for u in web.urls())
    # A page on such a host is still fetched under robots.txt.
    with pytest.raises(Refused, match=r"robots\.txt"):
        ingestor.fetcher.get("https://export.arxiv.org/abs/2610.01234")


def test_capped_run_keeps_no_validators_so_the_next_run_takes_the_rest(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    ingestor.max_new_leads = 1
    first = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    assert len(first.new_leads) == 1
    (state,) = rows(
        database, newsroom.id, "select * from source_fetch_state where newsroom_id = %s"
    )
    assert state["etag"] is None
    second = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    assert not second.not_modified and len(second.new_leads) == 1


def test_unreadable_answer_is_recorded_on_the_source(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    web.routes["https://hacker-news.firebaseio.com/v0/topstories.json"] = {"file": "orbit.html"}
    with pytest.raises(FetchError, match="unreadable"):
        ingestor.ingest_source(newsroom.id, newsroom.sources["hn"])
    (state,) = rows(
        database, newsroom.id, "select * from source_fetch_state where newsroom_id = %s"
    )
    assert state["consecutive_failures"] == 1 and state["last_error"]


def test_request_redirected_out_of_its_section_is_not_vouched_for(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    run = agent_run(database, newsroom)
    ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    web.routes["https://openai.com/index/moved/"] = {
        "status": 301,
        "headers": {"Location": "https://unknown.example/report"},
    }
    lead, created = ingestor.request_source(newsroom.id, run, "https://openai.com/index/moved/")
    assert created and lead["tier"] == 3
    (stored,) = rows(
        database,
        newsroom.id,
        "select * from leads where newsroom_id = %s and requested_by_run is not null",
    )
    assert stored["source_id"] is None


def test_request_cap_counts_every_fetch(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    run = agent_run(database, newsroom)
    ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    ingestor.max_requests_per_run = 1
    # A copy of a stored lead: no new lead, but the page was fetched, so it counts.
    _lead, created = ingestor.request_source(
        newsroom.id, run, "https://huggingface.co/blog/orbit-repost"
    )
    assert not created
    with pytest.raises(CapReached):
        ingestor.request_source(newsroom.id, run, "https://unknown.example/report")


def test_age_limit_skips_old_and_undated_items(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    database.system.execute(
        """update newsrooms set policy = policy || '{"leads": {"max_age_days": 14}}'
           where id = %s""",
        (newsroom.id,),
    )
    # The feed's items are dated 19-21 October; on 4 November only the 21st is within 14 days.
    ingestor.now = lambda: datetime(2026, 11, 4, tzinfo=UTC)
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    assert report.new_leads == [] and report.dropped == 2 and len(report.errors) == 1
    # The older items were skipped before their pages were fetched; the 21st's page is gone.
    assert not any(
        "/index/introducing-orbit" in u or "/index/orbit-safety" in u for u in web.urls()
    )
    # A listing page's link has no date until its page is read; an undated page is not stored.
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["anthropic-news"])
    assert report.new_leads == []


def test_feed_only_source_never_fetches_pages(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    database.system.execute(
        "update sources set fetch_pages = false where id = %s", (newsroom.sources["lab"],)
    )
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    assert len(report.new_leads) == 3  # the gone page is never asked for, so its item stays
    assert not any("/index/" in u for u in web.urls())
    assert {lead["raw_key"] for lead in leads(database, newsroom)} == {None}


# Media (D119)

COMMONS_PAGE = "https://commons.wikimedia.org/wiki/File:North_Hall_concert.jpg"
PRESS_PAGE = "https://label.example/press"


def make_user(db: Database) -> str:
    row = db.system.execute(
        "insert into users (email) values (%s) returning id",
        (f"{uuid.uuid4().hex[:8]}@example.com",),
    ).fetchone()
    assert row is not None
    return str(row["id"])


def media(db: Database, n: Newsroom) -> list[dict[str, Any]]:
    return rows(db, n.id, "select * from media where newsroom_id = %s order by created_at")


def test_a_press_kit_image_is_stored_unlicensed_with_its_photo_metadata(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    user = make_user(database)
    lead_id = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"]).new_leads[0]
    media_id, created, licence = ingestor.add_media(
        newsroom.id, "https://label.example/press/north-tour.jpg", PRESS_PAGE, lead_id, user
    )
    assert created and licence is None
    (row,) = media(database, newsroom)
    assert str(row["id"]) == media_id and str(row["lead_id"]) == lead_id
    assert str(row["file"]).startswith("raw/") and row["content_type"] == "image/jpeg"
    assert row["source_url"] == PRESS_PAGE
    assert row["file_url"] == "https://label.example/press/north-tour.jpg"
    assert row["creator"] == "Ada Example, Bo Example"
    assert row["credit_line"] == "Ada Example / North Label"
    assert row["copyright_notice"] == "© 2026 North Label"
    assert row["web_statement"] == "https://label.example/licensing"
    assert row["licensor"] == "North Label"
    assert row["digital_source_type"] == (
        "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"
    )
    assert row["description"] == "The band on stage in Oslo"
    assert row["licence_kind"] is None and row["licence_recorded_at"] is None
    assert str(row["added_by"]) == user


def test_a_commons_file_records_its_free_licence(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    user = make_user(database)
    _, created, licence = ingestor.add_media(newsroom.id, COMMONS_PAGE, None, None, user)
    assert created and licence == "CC BY-SA 4.0"
    (row,) = media(database, newsroom)
    assert row["licence_kind"] == "commons" and row["licence_recorded_at"] is not None
    assert row["licence_recorded_by"] is None
    assert row["licence_url"] == "https://creativecommons.org/licenses/by-sa/4.0"
    assert row["source_url"] == COMMONS_PAGE
    assert row["file_url"] == (
        "https://upload.wikimedia.org/wikipedia/commons/a/ab/North_Hall_concert.jpg"
    )
    # Commons fills what the file leaves empty; the file's own description wins.
    assert row["credit_line"] == "Dana Example, Wikimedia Commons"
    assert row["creator"] == "Dana Example"
    assert row["description"] == "A hall, from Commons"
    # The API call skips robots.txt (D64); the file itself is fetched under it.
    assert "https://commons.wikimedia.org/robots.txt" not in web.urls()
    assert "https://upload.wikimedia.org/robots.txt" in web.urls()


def test_a_non_free_commons_file_stays_unlicensed(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    user = make_user(database)
    page = "https://commons.wikimedia.org/wiki/File:Backstage_portrait.jpg"
    _, created, licence = ingestor.add_media(newsroom.id, page, None, None, user)
    assert created and licence is None
    (row,) = media(database, newsroom)
    assert row["licence_kind"] is None and row["credit_line"] == "Eli Example, Wikimedia Commons"


def test_the_same_image_twice_is_one_media_item(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    user = make_user(database)
    url = "https://label.example/press/cem.png"
    first, created, _ = ingestor.add_media(newsroom.id, url, PRESS_PAGE, None, user)
    again, created_again, _ = ingestor.add_media(newsroom.id, url, PRESS_PAGE, None, user)
    assert created and not created_again and again == first
    assert len(media(database, newsroom)) == 1


def test_the_same_image_for_another_lead_is_another_media_item(
    ingestor: Ingestor, database: Database, newsroom: Newsroom
) -> None:
    user = make_user(database)
    first_lead, second_lead = ingestor.ingest_source(
        newsroom.id, newsroom.sources["lab"]
    ).new_leads[:2]
    url = "https://label.example/press/cem.png"
    first, _, _ = ingestor.add_media(newsroom.id, url, PRESS_PAGE, first_lead, user)
    second, created, _ = ingestor.add_media(newsroom.id, url, PRESS_PAGE, second_lead, user)
    assert created and second != first
    assert {str(r["lead_id"]) for r in media(database, newsroom)} == {first_lead, second_lead}


def test_media_that_cannot_be_added_is_refused(
    ingestor: Ingestor, database: Database, newsroom: Newsroom, web: FakeWeb
) -> None:
    user = make_user(database)
    with pytest.raises(Refused, match="not a JPEG, PNG or WebP"):
        ingestor.add_media(
            newsroom.id, "https://label.example/press/coming-soon.jpg", PRESS_PAGE, None, user
        )
    with pytest.raises(Refused, match=r"robots\.txt"):
        ingestor.add_media(
            newsroom.id, "https://private-label.example/press/photo.jpg", PRESS_PAGE, None, user
        )
    with pytest.raises(Refused, match="page it comes from"):
        ingestor.add_media(newsroom.id, "https://label.example/press/cem.png", None, None, user)
    with pytest.raises(Refused, match="no such file"):
        ingestor.add_media(
            newsroom.id,
            "https://commons.wikimedia.org/wiki/File:Nothing_here.jpg",
            None,
            None,
            user,
        )
    with pytest.raises(NotFound, match="no lead"):
        ingestor.add_media(
            newsroom.id,
            "https://label.example/press/cem.png",
            PRESS_PAGE,
            "00000000-0000-0000-0000-000000000000",
            user,
        )
    with pytest.raises(NotFound, match="no user"):
        ingestor.add_media(
            newsroom.id,
            "https://label.example/press/cem.png",
            PRESS_PAGE,
            None,
            "00000000-0000-0000-0000-000000000000",
        )
    assert media(database, newsroom) == []
    assert "https://private-label.example/press/photo.jpg" not in web.urls()


def test_media_for_an_unknown_newsroom_is_not_found(ingestor: Ingestor, database: Database) -> None:
    with pytest.raises(NotFound, match="no newsroom"):
        ingestor.add_media(
            "00000000-0000-0000-0000-000000000000",
            "https://label.example/press/cem.png",
            PRESS_PAGE,
            None,
            make_user(database),
        )
