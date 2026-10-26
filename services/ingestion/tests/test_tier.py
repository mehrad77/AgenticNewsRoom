from anr_ingestion.items import Paper
from anr_ingestion.tier import Enrichment, PaperRules, paper_credibility, paper_tier

RULES = PaperRules.from_policy(
    {"papers": {"high_venues": ["NeurIPS", "ICML"], "high_citations": 500}}
)
ABSTRACT = "x" * 400
CATS = {"cs.AI"}


def paper(primary: str = "cs.AI", withdrawn: bool = False) -> Paper:
    return Paper("2610.01234", primary, (primary,), withdrawn)


def test_preprint_is_medium_tier_2() -> None:
    assert paper_credibility(paper(), ABSTRACT, CATS, RULES) == "medium"
    assert paper_tier(paper(), ABSTRACT, CATS, RULES) == 2


def test_withdrawn_is_flagged_and_not_stored() -> None:
    assert paper_tier(paper(withdrawn=True), ABSTRACT, CATS, RULES) is None


def test_short_abstract_or_cross_listed_is_low() -> None:
    assert paper_tier(paper(), "too short", CATS, RULES) == 3
    assert paper_tier(paper("cs.LG"), ABSTRACT, CATS, RULES) == 3
    assert paper_tier(paper("cs.LG"), ABSTRACT, {"cs.AI", "cs.LG"}, RULES) == 2


def test_high_only_from_enrichment() -> None:
    neurips = Enrichment(venues=("Neural Information Processing Systems", "NeurIPS"), citations=3)
    cited = Enrichment(venues=(), citations=900)
    unknown = Enrichment(venues=("Some Workshop",), citations=10)
    assert paper_tier(paper(), ABSTRACT, CATS, RULES, neurips) == 1
    assert paper_tier(paper("cs.LG"), ABSTRACT, CATS, RULES, cited) == 1
    assert paper_tier(paper(), ABSTRACT, CATS, RULES, unknown) == 2
    assert paper_tier(paper(withdrawn=True), ABSTRACT, CATS, RULES, neurips) is None


def test_no_rules_in_policy_means_no_high() -> None:
    rules = PaperRules.from_policy({})
    assert paper_tier(paper(), ABSTRACT, CATS, rules, Enrichment(("NeurIPS",), 10_000)) == 2
