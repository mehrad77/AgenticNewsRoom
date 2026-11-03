from typing import Any

from anr_legacy_import.mapping import (
    classic_entries,
    classic_listed,
    news_entries,
    slugify,
    telegram_text,
)

NEWS = [
    {
        "id": 2,
        "date": "2026-10-24",
        "date_status": "post_date",
        "title": "Claude Code v2.1.310",
        "url": "https://github.com/anthropics/claude-code/releases",
        "summary_fa": "نسخه‌ی تازه.",
        "summary_en": "A new release.",
        "org": "Anthropic",
        "kind": "tool",
        "message_ids": [390],
        "links": [{"label": "CHANGELOG", "url": "https://example.com/c"}, {"url": "nope"}],
    },
    {"id": 1, "date": "2026-10-24", "title": "Claude Code v2.1.310", "url": "u"},
]


def test_slugify() -> None:
    assert slugify("On Computable Numbers, with an Application") == (
        "on-computable-numbers-with-an-application"
    )
    assert slugify("هوش مصنوعی") == ""
    assert len(slugify("a" * 10 + " " + "b" * 60, 20)) <= 20


def test_news_entries_follow_the_old_timeline() -> None:
    out = news_entries(NEWS, "chan")
    first, second = out.entries
    assert first.legacy_id == "lab-news:1" and not first.listed  # no Persian summary
    assert second.listed and second.slug == "2026-10-24-claude-code-v2-1-310-2"
    assert second.date_status == "approximate"
    assert second.body == {"fa": {"summary": "نسخه‌ی تازه."}, "en": {"summary": "A new release."}}
    assert second.facts["telegram"] == ["https://t.me/chan/390"]
    assert second.facts["org_names"] == {"fa": "آنتروپیک"}
    assert second.facts["links"] == [{"label": "CHANGELOG", "url": "https://example.com/c"}]
    assert out.url_map == {"/news/": "/news"}


def test_classic_listing_matches_the_old_site() -> None:
    assert classic_listed({"status": "researched"})
    assert classic_listed({"status": "candidate", "summary_fa": "x", "problem_fa": "y"})
    assert not classic_listed({"status": "candidate", "summary_fa": "x"})
    assert not classic_listed({"status": "rejected", "summary_fa": "x", "problem_fa": "y"})


def test_classic_entries_keep_sections_refs_and_posts() -> None:
    news = news_entries(NEWS, None).entries
    cands: list[dict[str, Any]] = [
        {
            "slug": "turing-1936",
            "classic_id": 7,
            "status": "researched",
            "title": "On Computable Numbers",
            "date": "1936-11",
            "year": 1936,
            "summary_fa": "خلاصه",
            "problem_fa": "مسئله",
            "excerpts": [
                {"location": "§1", "original_en": "We may compare", "translation_fa": "ت"}
            ],
            "references_seen": [
                {"kind": "candidate", "ref": "bush-1945", "title": "As We May Think"},
                {"kind": "lab_news", "ref": 2, "title": "news"},
                {"kind": "item", "ref": 5, "title": "x", "url": "https://arxiv.org/abs/1"},
            ],
            "pdf_url": "https://example.com/t.pdf",
        },
        {
            "slug": "bush-1945",
            "status": "posted",
            "title": "As We May Think",
            "year": 1945,
            "message_ids": [11, 10],
        },
        {
            "slug": "x-2000",
            "status": "rejected",
            "title": "X",
            "summary_fa": "s",
            "problem_fa": "p",
        },
    ]
    posts = [
        {
            "message_id": 10,
            "status": "live",
            "html": "<b>بوش</b> نوشت <a href='https://x.org'>این</a>",
        },
        {"message_id": 11, "status": "deleted_by_owner", "html": "حذف شده"},
    ]
    out = classic_entries(cands, posts, news, "chan")
    by = {e.slug: e for e in out.entries}
    t = by["turing-1936"]
    assert t.date == "1936-11-01" and t.facts["date_precision"] == "month"
    assert t.body["fa"]["overview"] == "خلاصه" and t.body["fa"]["excerpts"][0]["original"]
    refs = t.facts["references"]
    assert refs[0]["entry"] == {"kind": "paper", "slug": "bush-1945"}
    assert refs[1]["entry"] == {"kind": "timeline-item", "slug": news[1].slug}
    assert refs[2] == {
        "title": "x",
        "year": None,
        "note": None,
        "entry": None,
        "url": "https://arxiv.org/abs/1",
    }
    assert t.facts["sources"] == [{"label": "Paper PDF", "url": "https://example.com/t.pdf"}]
    b = by["bush-1945"]
    assert b.date == "1945-01-01" and b.facts["date_precision"] == "year"
    assert b.body["fa"]["post"] == "**بوش** نوشت [این](https://x.org)"
    assert b.facts["telegram"] == ["https://t.me/chan/11", "https://t.me/chan/10"]
    assert not by["x-2000"].listed
    assert out.url_map["/papers/turing-1936/"] == "/reference/papers/turing-1936"
    assert "/papers/x-2000/" not in out.url_map


def test_telegram_text() -> None:
    assert telegram_text("a<br>b &amp; <i>c</i>") == "a\nb & c"


def test_english_from_the_translation_cache() -> None:
    from anr_legacy_import.mapping import persian_texts, text_key, with_english

    cands: list[dict[str, Any]] = [
        {
            "slug": "t-1936",
            "status": "researched",
            "title": "T",
            "year": 1936,
            "summary_fa": "خلاصه",
            "problem_fa": "مسئله",
            "excerpts": [{"original_en": "We may", "translation_fa": "ما", "note_fa": "یادداشت"}],
            "references_seen": [{"kind": "x", "ref": 1, "title": "R", "note_fa": "یادداشت مرجع"}],
        }
    ]
    entry = classic_entries(cands, [], [], None).entries[0]
    assert sorted(persian_texts(entry)) == sorted(["خلاصه", "مسئله", "یادداشت", "یادداشت مرجع"])
    cache = {text_key("خلاصه"): "Summary", text_key("یادداشت"): "A note"}
    en = with_english(entry, cache)
    assert en.body["en"]["overview"] == "Summary" and "problem" not in en.body["en"]
    assert en.body["en"]["excerpts"] == [
        {"location": "", "original": "We may", "translation": "", "note": "A note"}
    ]
    assert en.facts["references"][0]["note_en"] is None
    assert "Summary" in en.search_text
    assert "en" not in with_english(entry, {}).body
