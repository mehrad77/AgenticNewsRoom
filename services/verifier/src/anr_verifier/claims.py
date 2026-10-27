"""Checks on a story's claims: quotes, withdrawn leads, source independence, opinion, beats."""

import re

from anr_schemas.text import normalize_text
from anr_verifier.bundle import Bundle, CheckOut, Claim, Lead

MIN_PASSAGE_CHARS = 20
"""A passage shorter than this proves nothing: a word or two occurs in almost any text."""


def quote_key(text: str, language: str | None = None) -> str:
    """Normalised text for quote matching: the shared normaliser, then whitespace collapsed
    (extraction and models both move line breaks and spaces; D79). Verifier-only: the shared
    normaliser and its SQL twin keep whitespace."""
    return re.sub(r"\s+", " ", normalize_text(text, language)).strip()


def quote_found(passage: str, lead: Lead) -> bool:
    return quote_key(passage, lead.language) in quote_key(lead.body, lead.language)


def quotes(b: Bundle) -> list[CheckOut]:
    """Every passage a claim cites is in its lead's frozen text, and the lead is not withdrawn."""
    out: list[CheckOut] = []
    for claim in b.claims:
        if claim.kind == "opinion" and not claim.sources():
            continue
        missing, withdrawn, short = [], [], []
        for source in claim.sources():
            lead = b.leads.get(source.lead_id)
            if lead is None:
                missing.append(source.lead_id)
            elif lead.withdrawn:
                withdrawn.append({"lead_id": lead.id, "reason": lead.withdrawn})
            elif len(quote_key(source.quoted_passage)) < MIN_PASSAGE_CHARS:
                short.append(source.lead_id)
            elif not quote_found(source.quoted_passage, lead):
                missing.append(source.lead_id)
        if not claim.sources():
            out.append(CheckOut("quote-match", "fail", claim.id, detail={"error": "no source"}))
            continue
        detail = {"not_found": missing, "too_short": short}
        failed = bool(missing or short)
        out.append(CheckOut("quote-match", "fail" if failed else "pass", claim.id, detail=detail))
        out.append(
            CheckOut(
                "lead-withdrawn",
                "fail" if withdrawn else "pass",
                claim.id,
                detail={"withdrawn": withdrawn},
            )
        )
    return out


def independent_publishers(claim: Claim, b: Bundle) -> tuple[set[str], bool]:
    """Publishers of the claim's sources whose passage matched, and whether one is tier 1.
    A syndicated copy is a sighting of the same lead (D57), so it never adds a publisher."""
    publishers: set[str] = set()
    tier1 = False
    for source in claim.sources():
        lead = b.leads.get(source.lead_id)
        if lead is None or lead.withdrawn or not quote_found(source.quoted_passage, lead):
            continue
        publishers.add(lead.publisher.lower())
        tier1 = tier1 or lead.tier == 1
    return publishers, tier1


def independence(b: Bundle) -> list[CheckOut]:
    """Each fact claim has a tier-1 source (where policy allows one alone) or sources from
    `min_independent` different publishers."""
    out: list[CheckOut] = []
    for claim in b.claims:
        if claim.kind != "fact":
            continue
        publishers, tier1 = independent_publishers(claim, b)
        ok = (tier1 and b.policy.tier1_alone) or len(publishers) >= b.policy.min_independent
        out.append(
            CheckOut(
                "source-independence",
                "pass" if ok else "fail",
                claim.id,
                detail={
                    "publishers": sorted(publishers),
                    "tier1": tier1,
                    "needs": b.policy.min_independent,
                },
            )
        )
    return out


def opinion(b: Bundle) -> list[CheckOut]:
    """A newsroom whose policy does not allow opinion publishes no opinion claim."""
    if b.policy.opinion == "allowed_marked":
        return []
    return [
        CheckOut("opinion", "fail", c.id, detail={"policy": b.policy.opinion})
        for c in b.claims
        if c.kind == "opinion"
    ]


def beats(b: Bundle) -> list[CheckOut]:
    """The story's beat is live and not banned, and so is every beat of every cited lead; a lead
    not yet placed in beats cannot be cleared. Restricted beats pass here and are listed for the
    policy layer, which sends them to an editor."""
    banned: set[str] = set()
    restricted: set[str] = set()
    unplaced: set[str] = set()
    if b.beat is None or b.beat not in b.beats:
        return [CheckOut("beats", "fail", detail={"error": f"unknown beat {b.beat}"})]
    for slug, status in [(b.beat, b.beats[b.beat])] + [
        item
        for c in b.claims
        for s in c.sources()
        if (lead := b.leads.get(s.lead_id))
        for item in lead.beats.items()
    ]:
        if status == "banned":
            banned.add(slug)
        elif status == "restricted":
            restricted.add(slug)
    for c in b.claims:
        for s in c.sources():
            lead = b.leads.get(s.lead_id)
            if lead is not None and not lead.beats:
                unplaced.add(lead.id)
    return [
        CheckOut(
            "beats",
            "fail" if banned or unplaced else "pass",
            detail={
                "banned": sorted(banned),
                "restricted": sorted(restricted),
                "unplaced_leads": sorted(unplaced),
            },
        )
    ]
