from typing import Any

from anr_legacy_import.entities import link_entities, norm, person_key
from anr_legacy_import.mapping import classic_entries, news_entries


def test_names_compare_without_case_accents_or_suffixes() -> None:
    assert norm("The RAND Corporation") == "rand"
    assert norm("Université de Montréal") == "universite de montreal"
    assert person_key("Geoffrey E. Hinton") == person_key("Geoffrey Hinton") == "geoffrey hinton"
    assert person_key("Quoc V. Le") == "quoc le"


def test_entries_and_links_for_what_the_news_and_papers_name() -> None:
    kb = [
        {"id": 2, "kind": "lab", "name": "Anthropic", "aliases": ["Anthropic", "آنتروپیک"]},
        {"id": 11, "kind": "lab", "name": "Mistral", "aliases": ["Mistral"]},
        {"id": 25, "kind": "product", "name": "Claude Code", "aliases": ["Claude Code"]},
        {"id": 99, "kind": "lab", "name": "Unused Lab", "aliases": []},
    ]
    cache: dict[str, Any] = {
        "lab:2": {"qid": "Q1", "label": {"fa": "آنتروپیک", "en": "Anthropic"}, "facts": {}},
        "lab:11": {"qid": "Q2", "label": {"en": "Mistral AI"}},
        "news:mistral ai": {"qid": None},
        "org:university of toronto": {"qid": "Q3", "label": {"en": "University of Toronto"}},
        "author:geoffrey hinton": {
            "qid": "Q4",
            "label": {"fa": "جفری هینتون", "en": "Geoffrey Hinton"},
        },
    }
    news_rows = [
        {
            "id": 1,
            "date": "2026-10-24",
            "title": "Claude Code 2",
            "url": "u",
            "summary_fa": "خ",
            "org": "Anthropic",
            "entities": ["Anthropic", "Claude Code", "Kaggle"],
        },
        {
            "id": 2,
            "date": "2026-10-20",
            "title": "Mistral 9",
            "url": "u",
            "summary_fa": "خ",
            "org": "Mistral AI",
            "entities": [],
        },
    ]
    classic_rows = [
        {
            "slug": "a-1986",
            "status": "researched",
            "title": "A",
            "year": 1986,
            "summary_fa": "s",
            "problem_fa": "p",
            "authors": ["Geoffrey E. Hinton", "X Y"],
            "affiliations": ["Department of Computer Science, University of Toronto"],
        },
        {
            "slug": "b-2012",
            "status": "researched",
            "title": "B",
            "year": 2012,
            "summary_fa": "s",
            "problem_fa": "p",
            "authors": ["Geoffrey Hinton"],
            "affiliations": [],
        },
    ]
    news = news_entries(news_rows, None).entries
    papers = classic_entries(classic_rows, [], news, None).entries
    out = link_entities(kb, cache, {}, news_rows, classic_rows, news + papers)
    by_title = {e.title: e for e in out.entries}

    # Only what something points at; "Mistral AI" on the news is the KB's Mistral.
    assert "Unused Lab" not in by_title and "X Y" not in by_title
    assert by_title["Anthropic"].facts["names"] == {"fa": "آنتروپیک", "en": "Anthropic"}
    assert (
        by_title["Anthropic"].slug == "anthropic" and by_title["Anthropic"].kind == "organisation"
    )
    assert by_title["Mistral"].facts["qid"] == "Q2"
    assert by_title["Kaggle"].kind == "product"
    assert by_title["Geoffrey Hinton"].kind == "person"
    assert set(by_title["Geoffrey Hinton"].facts["aliases"]) == {"Geoffrey E. Hinton"}

    kinds = {(src, kind, label) for src, _, kind, label in out.links}
    assert ("lab-news:1", "made-by", "Anthropic") in kinds
    assert ("lab-news:1", "mentions", "Claude Code") in kinds
    assert ("lab-news:1", "mentions", "Anthropic") not in kinds  # the maker is not also a mention
    assert ("lab-news:2", "made-by", "Mistral AI") in kinds
    assert ("classic:a-1986", "written-by", "Geoffrey E. Hinton") in kinds
    assert ("classic:b-2012", "written-by", "Geoffrey Hinton") in kinds
    assert (
        "classic:a-1986",
        "affiliated-with",
        "Department of Computer Science, University of Toronto",
    ) in kinds
