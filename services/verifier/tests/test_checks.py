from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from anr_verifier import claims, items, rendition
from anr_verifier.bundle import Bundle, CheckOut, Claim, Lead, Policy, Rendition, Source
from anr_verifier.verify import item_leads, run_checks

CONFIG = Path(__file__).resolve().parents[3] / "config"

LAB = Lead(
    "lead-lab",
    "Example Lab released Orbit on 27 October. It is 40 percent faster than Comet,\n"
    "the lab said, and costs $1,200 a month.",
    "en",
    1,
    "Example Lab",
    None,
    {"labs": "open"},
)
NEWS = Lead(
    "lead-news",
    "Orbit, Example Lab's new model, runs 40 percent faster than Comet, according to the lab.",
    "en",
    2,
    "news.example",
    None,
    {"labs": "open"},
)
COPY = replace(NEWS, id="lead-copy", body=NEWS.body)
WITHDRAWN = replace(NEWS, id="lead-gone", withdrawn="withdrawn on arXiv")
POLICY_LEAD = replace(
    NEWS, id="lead-policy", publisher="court.example", beats={"policy": "restricted"}
)


DEFAULT_POLICY = Policy(2, True, "not_allowed")


def claim(ref: str = "c1", **over: Any) -> Claim:
    base: dict[str, Any] = {
        "id": f"id-{ref}",
        "ref": ref,
        "kind": "fact",
        "text": "Orbit is 40 percent faster than Comet.",
        "lead_id": LAB.id,
        "quoted_passage": "It is 40 percent faster than Comet, the lab said",
    }
    return Claim(**(base | over))


def news(
    *refs: str, body: str = "Orbit is 40% faster than Comet.", headline: str = "Orbit"
) -> dict[str, Any]:
    return {"kind": "news", "headline": headline, "body": body, "claim_ids": list(refs)}


def bundle(
    story_claims: list[Claim],
    body_items: list[dict[str, Any]] | None = None,
    language: str = "en",
    beat: str = "labs",
    policy: Policy | None = None,
) -> Bundle:
    body = {"language": language, "title": "Daily", "items": body_items or [news("c1")]}
    return Bundle(
        story_id="story",
        beat=beat,
        beats={"labs": "open", "policy": "restricted", "gossip": "banned"},
        claims=tuple(story_claims),
        leads={lead.id: lead for lead in (LAB, NEWS, COPY, WITHDRAWN, POLICY_LEAD)},
        renditions=(Rendition("r1", language, "newsletter-issue", body),),
        policy=policy or DEFAULT_POLICY,
    )


def results(checks: list[CheckOut], name: str) -> list[str]:
    return [c.result for c in checks if c.name == name]


def test_quotes_match_after_normalising_whitespace() -> None:
    out = claims.quotes(
        bundle([claim(quoted_passage="It is 40 percent   faster than Comet,\n the lab said")])
    )
    assert results(out, "quote-match") == ["pass"]
    assert results(out, "lead-withdrawn") == ["pass"]


def test_quotes_fail_when_missing_short_or_withdrawn() -> None:
    out = claims.quotes(
        bundle(
            [
                claim("c1", quoted_passage="It is 50 percent faster than Comet"),
                claim("c2", quoted_passage="Orbit"),
                claim(
                    "c3", lead_id=WITHDRAWN.id, quoted_passage="runs 40 percent faster than Comet"
                ),
                claim("c4", also=(Source(NEWS.id, "this sentence is not in the lead at all"),)),
            ]
        )
    )
    by_claim = {(c.claim_id, c.name): c for c in out}
    assert by_claim[("id-c1", "quote-match")].detail["not_found"] == [LAB.id]
    assert by_claim[("id-c2", "quote-match")].detail["too_short"] == [LAB.id]
    assert by_claim[("id-c3", "lead-withdrawn")].result == "fail"
    assert by_claim[("id-c4", "quote-match")].detail["not_found"] == [NEWS.id]


def test_independence_counts_publishers_whose_passage_matched() -> None:
    passage = "runs 40 percent faster than Comet"
    tier2 = claim(lead_id=NEWS.id, quoted_passage=passage)
    two = claim(
        lead_id=NEWS.id,
        quoted_passage=passage,
        also=(Source(LAB.id, "It is 40 percent faster than Comet"),),
    )
    same_publisher = claim(
        lead_id=NEWS.id, quoted_passage=passage, also=(Source(COPY.id, passage),)
    )
    bogus = claim(
        lead_id=NEWS.id,
        quoted_passage=passage,
        also=(Source(POLICY_LEAD.id, "not in that lead's text"),),
    )
    no_tier1_alone = Policy(2, False, "not_allowed")
    assert results(claims.independence(bundle([claim()])), "source-independence") == ["pass"]
    assert results(claims.independence(bundle([tier2])), "source-independence") == ["fail"]
    assert results(
        claims.independence(bundle([two], policy=no_tier1_alone)), "source-independence"
    ) == ["pass"]
    assert results(claims.independence(bundle([same_publisher])), "source-independence") == ["fail"]
    assert results(claims.independence(bundle([bogus])), "source-independence") == ["fail"]
    assert results(
        claims.independence(bundle([claim()], policy=no_tier1_alone)), "source-independence"
    ) == ["fail"]
    # Quotes and opinions are not counted.
    assert claims.independence(bundle([claim(kind="quote")])) == []


def test_opinion_only_where_policy_allows_it() -> None:
    opinion = claim(kind="opinion")
    assert results(claims.opinion(bundle([opinion])), "opinion") == ["fail"]
    assert claims.opinion(bundle([opinion], policy=Policy(2, True, "allowed_marked"))) == []


def test_beats_fail_banned_and_unplaced_and_list_restricted() -> None:
    [ok] = claims.beats(bundle([claim()]))
    assert ok.result == "pass"
    [restricted] = claims.beats(bundle([claim(lead_id=POLICY_LEAD.id)]))
    assert restricted.result == "pass" and restricted.detail["restricted"] == ["policy"]
    [banned] = claims.beats(bundle([claim()], beat="gossip"))
    assert banned.result == "fail"
    unplaced = replace(
        bundle([claim(lead_id="lead-new")]),
        leads={"lead-new": replace(LAB, id="lead-new", beats={})},
    )
    assert claims.beats(unplaced)[0].detail["unplaced_leads"] == ["lead-new"]
    assert claims.beats(bundle([claim()], beat="nope"))[0].result == "fail"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("40% faster", {"40"}),
        ("۴۰٪ سریع‌تر", {"40"}),
        ("$1,200 a month", {"1200"}),
        ("\u06f1\u066c\u06f2\u06f0\u06f0 dollars", {"1200"}),
        ("3.50 and 3,5", {"3.5"}),
        ("27 October 2026", {"27", "2026"}),
    ],
)
def test_numbers_fold_scripts_and_separators(text: str, expected: set[str]) -> None:
    assert items.numbers(text) == expected


def test_names_by_script() -> None:
    assert items.names("The lab said Orbit beats GPT-5 on MMLU. It is fast.", "en") == {
        "Orbit",
        "GPT-5",
        "MMLU",
    }
    # A title-cased headline: only acronyms and model-like tokens are names.
    assert items.names("OpenAI Releases New Reasoning Model GPT-6", "en") == {"OpenAI", "GPT-6"}
    assert items.names("آزمایشگاه Example Lab مدل Orbit را منتشر کرد", "fa") == {
        "Example",
        "Lab",
        "Orbit",
    }


def test_items_say_nothing_beyond_their_claims() -> None:
    b = bundle(
        [claim()],
        [
            news("c1"),
            news("c1", body="Orbit is 45% faster than Comet."),
            news("c1", body="Orbit is faster than Gemini."),
            news(),
            news("c7"),
        ],
    )
    out = items.item_claims(b)
    assert [c.result for c in out] == ["pass", "fail", "fail", "fail", "fail"]
    assert out[1].detail["numbers_beyond_claims"] == ["45"]
    assert out[2].detail["names_beyond_claims"] == ["Gemini"]
    assert out[3].detail["no_claims"] and out[4].detail["unknown_claims"] == ["c7"]
    assert out[0].item == "items.0"


def test_item_text_includes_nested_lists_but_not_nested_items() -> None:
    article = {"paragraphs": ["Orbit is fast.", "It beats Gemini."], "claim_ids": ["c1"]}
    assert items.item_text(article) == "Orbit is fast. It beats Gemini."
    segment = {"title": "Recap", "claim_ids": ["c1"], "lines": [{"text": "x", "claim_ids": ["c2"]}]}
    assert items.item_text(segment) == "Recap"


def test_persian_item_against_english_claims() -> None:
    b = bundle(
        [claim()],
        [news("c1", headline="Orbit", body="مدل Orbit از Comet ۴۰٪ سریع‌تر است.")],
        language="fa",
    )
    assert [c.result for c in items.item_claims(b)] == ["pass"]


def test_article_items_name_live_leads() -> None:
    article = {
        "kind": "article",
        "title": "Read",
        "lead_id": WITHDRAWN.id,
        "reason": "Good.",
        "claim_ids": ["c1"],
    }
    unknown = article | {"lead_id": "nope"}
    assert [c.result for c in item_leads(bundle([claim()], [article, unknown]))] == ["fail", "fail"]


def test_schema_and_style_lint() -> None:
    assert results(rendition.schema(bundle([claim()])), "schema") == ["pass"]
    broken = bundle([claim()], [{"kind": "news", "claim_ids": ["c1"]}])
    assert results(rendition.schema(broken), "schema") == ["fail"]
    assert rendition.lint_text("This groundbreaking model  wins.", "en") == [
        "double space",
        "hype word: groundbreaking",
    ]
    assert rendition.lint_text("مدل جدید منتشر می شود و علي آن را ديد", "fa") == [
        "Arabic ye or kaf; use Persian ی and ک",
        "می/نمی written apart from its verb; join with a zero-width non-joiner",
    ]
    assert rendition.lint_text("مدل جدید Orbit منتشر می‌شود.", "fa") == []
    # A Latin-script headline in a Persian rendition is fine; English labelled fa is not.
    persian = bundle(
        [claim()],
        [
            news(
                "c1",
                headline="Orbit",
                body="آزمایشگاه نمونه امروز مدل Orbit را منتشر کرد که از مدل قبلی سریع‌تر است.",
            )
        ],
        "fa",
    )
    assert results(rendition.style_lint(persian), "style-lint") == ["pass"]
    english = bundle([claim()], [news("c1")], "fa")
    assert rendition.style_lint(english)[0].detail["issues"] == ["mostly not in Persian script"]
    assert rendition.lint_text("Orbit سریع است", "en") == [
        "Arabic-script letters in a Latin-script language"
    ]


def test_format_rules_read_their_numbers_from_checks_yaml() -> None:
    article = {
        "kind": "article",
        "title": "Read",
        "lead_id": LAB.id,
        "reason": "Two\nlines",
        "claim_ids": ["c1"],
    }
    out = rendition.format_rules(bundle([claim()], [news("c1"), article, article, article]), CONFIG)
    by_name = {c.name: c for c in out}
    assert by_name["format:news-item-count"].result == "fail"
    assert by_name["format:news-item-count"].detail == {"count": 1, "range": [5, 8]}
    assert by_name["format:article-limit"].result == "fail"
    assert by_name["format:article-has-reason"].detail["articles_without_one_line_reason"] == [
        0,
        1,
        2,
    ]


# Every configured rule has code; a new one without code holds every rendition with an error.
PENDING: set[str] = set()


def test_every_configured_rule_is_implemented_or_pending() -> None:
    configured = {
        r["id"]
        for f in (CONFIG / "formats").iterdir()
        if f.is_dir()
        for r in rendition.load_rules(CONFIG, f.name)
    }
    assert configured - set(rendition.RULES) == PENDING


def test_an_unknown_rule_is_an_error_and_holds(tmp_path: Path) -> None:
    (tmp_path / "formats" / "newsletter-issue").mkdir(parents=True)
    (tmp_path / "formats" / "newsletter-issue" / "checks.yaml").write_text(
        "- id: new-rule\n  rule: x\n"
    )
    [check] = rendition.format_rules(bundle([claim()]), tmp_path)
    assert (check.name, check.result) == ("format:new-rule", "error")


def test_a_story_without_claims_fails() -> None:
    assert [(c.name, c.result) for c in run_checks(bundle([]), CONFIG)] == [
        ("claims", "fail"),
        ("schema", "pass"),
    ]
