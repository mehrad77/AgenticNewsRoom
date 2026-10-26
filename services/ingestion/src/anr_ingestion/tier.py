"""Tiers (docs/technical-design.md#ingestion, step 4). Every lead has one tier, 1 to 3; a lead
takes its source's tier, except arXiv papers, which follow the paper tier rules (D59):

- flagged, not stored: withdrawn on arXiv;
- low, tier 3: no usable abstract, or only cross-listed into the source's categories;
- medium, tier 2: any other preprint;
- high, tier 1: only when Semantic Scholar, never the authors, shows a venue on the policy's
  `papers.high_venues` or at least `papers.high_citations` citations.

The words come from `policy.papers.tiers` (flagged, high, medium, low).
"""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from anr_ingestion.items import Paper

PAPER_TIERS = {"high": 1, "medium": 2, "low": 3}
MIN_ABSTRACT_CHARS = 200


@dataclass(frozen=True)
class PaperRules:
    high_venues: frozenset[str]
    """Case-folded venue names and abbreviations."""
    high_citations: int | None

    @staticmethod
    def from_policy(policy: dict[str, Any]) -> "PaperRules":
        papers = policy.get("papers") or {}
        return PaperRules(
            high_venues=frozenset(str(v).casefold() for v in papers.get("high_venues", [])),
            high_citations=papers.get("high_citations"),
        )


@dataclass(frozen=True)
class Enrichment:
    """What Semantic Scholar says about a paper."""

    venues: tuple[str, ...]
    """Its venue and the venue's alternate names."""
    citations: int


def is_high(enrichment: Enrichment, rules: PaperRules) -> bool:
    if any(v.casefold() in rules.high_venues for v in enrichment.venues):
        return True
    return rules.high_citations is not None and enrichment.citations >= rules.high_citations


def paper_credibility(
    paper: Paper,
    abstract: str,
    source_categories: Iterable[str],
    rules: PaperRules,
    enrichment: Enrichment | None = None,
) -> str:
    """flagged, high, medium or low."""
    if paper.withdrawn:
        return "flagged"
    if enrichment is not None and is_high(enrichment, rules):
        return "high"
    wanted = set(source_categories)
    cross_listed = bool(wanted) and paper.primary_category not in wanted
    if len(abstract) < MIN_ABSTRACT_CHARS or cross_listed:
        return "low"
    return "medium"


def paper_tier(
    paper: Paper,
    abstract: str,
    source_categories: Iterable[str],
    rules: PaperRules,
    enrichment: Enrichment | None = None,
) -> int | None:
    """The paper's tier, or None when it is flagged and must not be stored."""
    credibility = paper_credibility(paper, abstract, source_categories, rules, enrichment)
    return PAPER_TIERS.get(credibility)
