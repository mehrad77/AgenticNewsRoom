import json
import uuid
from pathlib import Path
from typing import Any

from conftest import Database
from fastapi.testclient import TestClient

from anr_verifier.app import create_app

CONFIG = Path(__file__).resolve().parents[3] / "config"
POLICY = {"sources": {"min_independent": 2, "tier1_alone": True}, "auto_publish": []}


def one(db: Database, sql: str, *params: object) -> dict[str, Any]:
    row = db.system.execute(sql, params).fetchone()
    assert row is not None
    return row


def story(db: Database) -> dict[str, str]:
    slug = f"v-{uuid.uuid4().hex[:8]}"
    newsroom = one(
        db,
        """insert into newsrooms (slug, subdomain, name, languages, timezone, editor_in_chief,
                                  corrections_owner, planning, policy)
           values (%s, %s, '{"en": "T"}', '{fa,en}', 'UTC', 'E', 'E', '{}', %s) returning id""",
        slug,
        slug,
        json.dumps(POLICY),
    )["id"]
    labs = one(
        db,
        """insert into beats (newsroom_id, slug, status, media_topics)
           values (%s, 'labs', 'open', '{medtop:20001298}') returning id""",
        newsroom,
    )["id"]
    source = one(
        db,
        """insert into sources (newsroom_id, slug, kind, url, publisher, tier, fetch_every)
           values (%s, 'lab', 'rss', 'https://lab.example/feed', 'Example Lab', 1, '1 hour')
           returning id""",
        newsroom,
    )["id"]
    lead = one(
        db,
        """insert into leads (newsroom_id, source_id, uri, headline, body, language,
                              content_hash, tier, summary)
           values (%s, %s, 'https://lab.example/orbit', 'Orbit',
                   'Example Lab released Orbit. It is 40 percent faster than Comet, the lab said.',
                   'en', 'h', 1, 's') returning id""",
        newsroom,
        source,
    )["id"]
    db.system.execute(
        "insert into lead_beats (newsroom_id, lead_id, beat_id) values (%s, %s, %s)",
        (newsroom, lead, labs),
    )
    series = one(
        db,
        """insert into series (newsroom_id, slug, format_id, languages, config)
           select %s, 'daily', f.id, '{fa,en}', '{}' from formats f
           where f.slug = 'newsletter-issue' returning id""",
        newsroom,
    )["id"]
    assignment = one(
        db,
        """insert into assignments (newsroom_id, series_id, slot)
           values (%s, %s, now() + interval '5 hours') returning id""",
        newsroom,
        series,
    )["id"]
    story_id = one(
        db,
        """insert into stories (newsroom_id, assignment_id, summary, beat_id)
           values (%s, %s, 's', %s) returning id""",
        newsroom,
        assignment,
        labs,
    )["id"]
    claim = one(
        db,
        """insert into claims (newsroom_id, story_id, ref, kind, text, lead_id, quoted_passage)
           values (%s, %s, 'c1', 'fact', 'Orbit is 40 percent faster than Comet.', %s,
                   'It is 40 percent faster than Comet') returning id""",
        newsroom,
        story_id,
        lead,
    )["id"]
    items = [
        {
            "kind": "news",
            "headline": "Orbit",
            "body": f"Orbit is 40% faster than Comet {n}.",
            "claim_ids": ["c1"],
        }
        for n in range(1, 6)
    ]
    for language, title in (("en", "Daily"), ("fa", "خبرنامه")):
        db.system.execute(
            """insert into renditions (newsroom_id, story_id, format_id, language, body)
               select %s, %s, f.id, %s, %s from formats f where f.slug = 'newsletter-issue'""",
            (
                newsroom,
                story_id,
                language,
                json.dumps({"language": language, "title": title, "items": items}),
            ),
        )
    return {"newsroom": str(newsroom), "story": str(story_id), "claim": str(claim)}


def test_verify_stores_every_code_check(database: Database) -> None:
    s = story(database)
    with TestClient(create_app(database.app, CONFIG)) as client:
        response = client.post(
            "/verify", json={"newsroom_id": s["newsroom"], "story_id": s["story"]}
        )
    assert response.status_code == 200, response.text
    checks = response.json()["checks"]
    stored = database.system.execute(
        "select name, result, claim_id, rendition_id, item from checks where newsroom_id = %s",
        (s["newsroom"],),
    ).fetchall()
    assert len(stored) == len(checks)
    by_name: dict[str, list[str]] = {}
    for c in stored:
        by_name.setdefault(c["name"], []).append(c["result"])
    assert by_name["quote-match"] == ["pass"]
    assert by_name["source-independence"] == ["pass"]
    # Story-wide checks are stored once per rendition.
    assert by_name["beats"] == ["pass", "pass"]
    assert by_name["schema"] == ["pass", "pass"]
    # The numbers 1-5 in the items are not in the claim: the item check catches them.
    assert set(by_name["item-claims"]) == {"fail"}
    # The Persian rendition is in English: the lint says so.
    assert sorted(by_name["style-lint"]) == ["fail", "pass"]
    assert by_name["format:news-item-count"] == ["pass", "pass"]


def test_another_newsrooms_story_is_not_found(database: Database) -> None:
    s = story(database)
    other = story(database)
    with TestClient(create_app(database.app, CONFIG)) as client:
        response = client.post(
            "/verify", json={"newsroom_id": other["newsroom"], "story_id": s["story"]}
        )
    assert response.status_code == 404


def test_a_claim_copied_from_a_corrected_one_fails(database: Database) -> None:
    s = story(database)
    # A person corrected the claim; a later story copied it, and another copied the copy (D107).
    database.system.execute(
        """insert into checks (newsroom_id, claim_id, kind, name, result)
           values (%s, %s, 'correction', 'correction', 'fail')""",
        (s["newsroom"], s["claim"]),
    )
    source = s["claim"]
    for _ in range(2):
        later = one(
            database,
            """with a as (
                 insert into assignments (newsroom_id, series_id, slot)
                 select newsroom_id, series_id,
                        slot + interval '1 day' * (select count(*) from assignments)
                 from assignments
                 where id = (select assignment_id from stories where id = %s) returning *
               ), st as (
                 insert into stories (newsroom_id, assignment_id, summary, beat_id)
                 select a.newsroom_id, a.id, 's', o.beat_id from a, stories o where o.id = %s
                 returning *
               )
               insert into claims (newsroom_id, story_id, ref, kind, text, lead_id,
                                   quoted_passage, copied_from)
               select st.newsroom_id, st.id, 'c1', c.kind, c.text, c.lead_id, c.quoted_passage,
                      c.id
               from st, claims c where c.id = %s returning story_id, id""",
            s["story"],
            s["story"],
            source,
        )
        source = later["id"]
    with TestClient(create_app(database.app, CONFIG)) as client:
        response = client.post(
            "/verify", json={"newsroom_id": s["newsroom"], "story_id": str(later["story_id"])}
        )
    assert response.status_code == 200, response.text
    names = [(c["name"], c["result"]) for c in response.json()["checks"]]
    assert ("corrected-claim", "fail") in names
