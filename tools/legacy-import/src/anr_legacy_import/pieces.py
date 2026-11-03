"""The old archive's news and posted classics, as the newsroom's own pieces (D172).

Pure functions: imported entries in, pieces out. The lab news timeline becomes one daily issue per
day it has news, in each language; a classic the channel posted becomes a weekly-classic piece on
the day it was posted. Each piece is one rendition in its series' format, valid against that
format's schema, with no claims: imported text is labelled, not checked (D164).
"""

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from .mapping import Entry

LANGUAGES = ("fa", "en")
NEWS_SERIES = "daily-newsletter"
CLASSIC_SERIES = "weekly-classic"
# The series' cadences (config/newsrooms/ai/series): the slot an imported piece takes on its day.
NEWS_AT = time(21, 0)
CLASSIC_AT = time(10, 0)
MORE = {"fa": "و {n} خبر دیگر", "en": "and {n} more"}
DIGITS_FA = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")


@dataclass
class Piece:
    series: str
    slot: datetime
    language: str
    title: str
    # The rendition's structured body, as the format's schema has it.
    body: dict[str, Any]
    search_text: str

    @property
    def day(self) -> str:
        return self.slot.date().isoformat()


def _slot(day: str, at: time, timezone: str) -> datetime:
    local = datetime.combine(date.fromisoformat(day), at, ZoneInfo(timezone))
    return local.astimezone(UTC)


def _text(entry: Entry, language: str, key: str) -> str | None:
    """A body text in the language, else in Persian (an English page shows it until translated)."""
    for lang in (language, "fa"):
        value = entry.body.get(lang, {}).get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def news_item(entry: Entry, language: str, related: list[str]) -> dict[str, Any]:
    """One lab news item as a newsletter news item, with the timeline's facts (D173)."""
    f = entry.facts
    item: dict[str, Any] = {
        "kind": "news",
        "headline": entry.title,
        "body": _text(entry, language, "summary") or "",
        "claim_ids": [],
        "anchor": entry.slug,
        "news_kind": f.get("news_kind") or "other",
    }
    if f.get("org"):
        item["org"] = f["org"]
    if related:
        item["related"] = related
    if f.get("url"):
        item["url"] = f["url"]
        item["url_type"] = f.get("url_type") or "official"
    links = [*f.get("links", []), *({"url": t, "label": "telegram"} for t in f.get("telegram", []))]
    if links:
        item["links"] = links
    if entry.date_status == "approximate":
        item["approximate"] = True
    return item


def news_issues(
    entries: list[Entry], links: list[tuple[str, str, str, str]], timezone: str
) -> list[Piece]:
    """One daily issue per day of the timeline, per language; a day's items in the old order."""
    related: dict[str, list[str]] = {}
    for a, _b, kind, label in links:
        if kind == "mentions":
            related.setdefault(a, []).append(label)
    by_day: dict[str, list[Entry]] = {}
    for e in entries:
        if e.kind == "news-event" and e.listed and e.date:
            by_day.setdefault(e.date, []).append(e)
    out: list[Piece] = []
    for day, items in sorted(by_day.items()):
        for language in LANGUAGES:
            body_items = [news_item(e, language, related.get(e.legacy_id, [])) for e in items]
            first = items[0].title
            title = first if len(items) == 1 else f"{first} {more(language, len(items) - 1)}"
            out.append(
                Piece(
                    series=NEWS_SERIES,
                    slot=_slot(day, NEWS_AT, timezone),
                    language=language,
                    title=title,
                    body={"language": language, "title": title, "items": body_items},
                    search_text=" ".join(
                        [
                            title,
                            *(
                                f"{i['headline']} {i['body']} {i.get('org') or ''}"
                                for i in body_items
                            ),
                        ]
                    ),
                )
            )
    return out


def more(language: str, n: int) -> str:
    count = str(n).translate(DIGITS_FA) if language == "fa" else str(n)
    return MORE[language].format(n=count)


def paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def classic_pieces(
    entries: list[Entry], sections: list[dict[str, Any]], timezone: str
) -> list[Piece]:
    """Each classic the channel posted, as a weekly-classic piece on its posted day."""
    out: list[Piece] = []
    for e in entries:
        day = e.facts.get("posted_date")
        if e.kind != "paper" or not e.listed or not isinstance(day, str):
            continue
        for language in LANGUAGES:
            items = [
                {
                    "heading": s["name"].get(language) or s["name"].get("fa"),
                    "paragraphs": paragraphs(text),
                    "claim_ids": [],
                }
                for s in sections
                if (text := _text(e, language, s["key"]))
            ]
            if not items:
                continue
            out.append(
                Piece(
                    series=CLASSIC_SERIES,
                    slot=_slot(day, CLASSIC_AT, timezone),
                    language=language,
                    title=e.title,
                    body={
                        "language": language,
                        "title": e.title,
                        "items": items,
                        "paper": e.slug,
                    },
                    search_text=" ".join([e.title, *(p for i in items for p in i["paragraphs"])]),
                )
            )
    return out
