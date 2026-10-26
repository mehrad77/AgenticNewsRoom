"""Semantic Scholar, the enrichment source the paper tier rules read venues and citations from.

One batch request per arXiv run (`POST /paper/batch`, up to 500 ids). Used only when the
newsroom's Semantic Scholar source has `terms_checked`; it never adds leads.
"""

import json
from typing import Any

from anr_ingestion.net import Fetcher, FetchError
from anr_ingestion.tier import Enrichment

BATCH_LIMIT = 500
FIELDS = "venue,publicationVenue,citationCount"


def _enrichment(record: Any) -> Enrichment | None:
    if not isinstance(record, dict):
        return None
    venues: list[str] = []
    if record.get("venue"):
        venues.append(str(record["venue"]))
    venue = record.get("publicationVenue") or {}
    if isinstance(venue, dict):
        if venue.get("name"):
            venues.append(str(venue["name"]))
        venues.extend(str(n) for n in venue.get("alternate_names") or [])
    return Enrichment(venues=tuple(venues), citations=int(record.get("citationCount") or 0))


def lookup(fetcher: Fetcher, api_url: str, arxiv_ids: list[str]) -> dict[str, Enrichment]:
    """Venues and citations for each arXiv id Semantic Scholar knows."""
    found: dict[str, Enrichment] = {}
    base = api_url.rstrip("/")
    for start in range(0, len(arxiv_ids), BATCH_LIMIT):
        chunk = arxiv_ids[start : start + BATCH_LIMIT]
        url = f"{base}/paper/batch?fields={FIELDS}"
        records = json.loads(fetcher.post_json(url, {"ids": [f"ARXIV:{i}" for i in chunk]}))
        if not isinstance(records, list):
            raise FetchError(f"{url}: expected a JSON array")
        for paper_id, record in zip(chunk, records, strict=False):
            enrichment = _enrichment(record)
            if enrichment is not None:
                found[paper_id] = enrichment
    return found
