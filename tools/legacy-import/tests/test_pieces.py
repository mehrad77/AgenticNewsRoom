from anr_legacy_import.mapping import Entry
from anr_legacy_import.pieces import classic_pieces, news_issues


def news(legacy: str, day: str, title: str, **facts: object) -> Entry:
    return Entry(
        legacy_id=legacy,
        kind="news-event",
        slug=f"{day}-{title.lower()}",
        title=title,
        date=day,
        date_status="verified",
        facts={"org": "Anthropic", "news_kind": "tool", "url": "https://x.org/a", **facts},
        body={"fa": {"summary": "خلاصه"}, "en": {"summary": "Summary"}},
        listed=True,
        search_text=title,
    )


def test_news_becomes_one_issue_per_day_and_language() -> None:
    entries = [
        news("lab-news:1", "2026-10-24", "A", telegram=["https://t.me/c/5"]),
        news("lab-news:2", "2026-10-24", "B"),
        news("lab-news:3", "2026-10-23", "C"),
    ]
    links = [("lab-news:1", "product:x", "mentions", "Claude Code")]
    pieces = news_issues(entries, links, "Europe/Istanbul")
    assert [(p.day, p.language) for p in pieces] == [
        ("2026-10-23", "fa"),
        ("2026-10-23", "en"),
        ("2026-10-24", "fa"),
        ("2026-10-24", "en"),
    ]
    day = pieces[2]
    # 21:00 in Istanbul is 18:00 UTC.
    assert day.slot.isoformat() == "2026-10-24T18:00:00+00:00"
    assert day.title == "A و ۱ خبر دیگر"  # noqa: RUF001 (a Persian digit)
    first = day.body["items"][0]
    assert first == {
        "kind": "news",
        "headline": "A",
        "body": "خلاصه",
        "claim_ids": [],
        "anchor": "2026-10-24-a",
        "news_kind": "tool",
        "org": "Anthropic",
        "related": ["Claude Code"],
        "url": "https://x.org/a",
        "url_type": "official",
        "links": [{"url": "https://t.me/c/5", "label": "telegram"}],
    }
    assert pieces[3].body["items"][0]["body"] == "Summary"
    assert pieces[3].title == "A and 1 more"


def test_a_posted_classic_becomes_a_piece_on_its_posted_day() -> None:
    paper = Entry(
        legacy_id="classic:x",
        kind="paper",
        slug="x",
        title="On X",
        date="1950-01-01",
        date_status="recorded",
        facts={"posted_date": "2026-10-22"},
        body={"fa": {"overview": "یک.\n\nدو.", "why": "چرا"}},
        listed=True,
        search_text="",
    )
    unposted = Entry(**{**paper.__dict__, "legacy_id": "classic:y", "facts": {}})
    sections = [
        {"key": "overview", "name": {"fa": "چیست", "en": "What"}},
        {"key": "why", "name": {"fa": "چرا", "en": "Why"}},
    ]
    pieces = classic_pieces([paper, unposted], "Europe/Istanbul", sections)
    assert [(p.series, p.day, p.language) for p in pieces] == [
        ("weekly-classic", "2026-10-22", "fa"),
        ("weekly-classic", "2026-10-22", "en"),
    ]
    assert pieces[0].body["items"][0] == {
        "heading": "چیست",
        "paragraphs": ["یک.", "دو."],
        "claim_ids": [],
    }
    assert pieces[0].body["paper"] == "x"
    # No English yet: the English piece shows the Persian text under English headings.
    assert pieces[1].body["items"][1]["heading"] == "Why"
