"""Item-claim consistency: every rendition item lists claims of its story, and the numbers and
Latin-script names it states are in those claims (their text or quoted passages). Names in other
scripts are left to the item matcher (D79)."""

import re
from collections.abc import Iterator
from typing import Any

from anr_schemas.text import normalize_text
from anr_verifier.bundle import Bundle, CheckOut, Claim, Rendition

# Arabic decimal separator, thousands separator and percent sign, after the digits are folded.
_ARABIC_MARKS = str.maketrans({"\u066b": ".", "\u066c": ",", "\u066a": "%"})
_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
_GROUPED = re.compile(r"^\d{1,3}(?:,\d{3})+(?:\.\d+)?$")
_LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*")
_SENTENCE_START = re.compile(r"(?:^|[.!?:;]\s+|\n)\s*$")
# Words that start a sentence or a headline in English without naming anything.
_COMMON = {"a", "an", "the", "it", "its", "this", "that", "these", "i", "in", "on", "at", "and"}

# Labels and delivery hints, not reader-facing text: a podcast line's voice is no unsourced name.
SKIP_KEYS = {
    "kind",
    "claim_ids",
    "lead_id",
    "media_id",
    "segment",
    "beat",
    "cue",
    "direction",
    "speaker",
    "host",
}


def numbers(text: str) -> set[str]:
    folded = normalize_text(text).translate(_ARABIC_MARKS)
    out = set()
    for match in _NUMBER.findall(folded):
        value = match.replace(",", "") if _GROUPED.match(match) else match.replace(",", ".")
        out.add(value.rstrip("0").rstrip(".") if "." in value else value)
    return out


def names(text: str, language: str) -> set[str]:
    """Latin-script names an item states: in Persian text every Latin word (names stay in Latin
    script); in Latin-script text capitalised words that do not start a sentence, acronyms and
    model-like tokens (GPT-5). A title-cased string (a headline) capitalises ordinary words, so
    there only acronyms, model-like tokens and words with an inner capital count."""
    words = [w for w in _LATIN_WORD.findall(text) if len(w) > 1 and w.lower() not in _COMMON]
    titled = len(words) >= 3 and sum(w[0].isupper() for w in words) >= 0.6 * len(words)
    found = set()
    for m in _LATIN_WORD.finditer(text):
        word = m.group(0)
        if len(word) < 2:
            continue
        if language == "fa":
            found.add(word)
            continue
        if word.lower() in _COMMON:
            continue
        acronym = word.isupper()
        modelish = any(ch.isdigit() for ch in word) and any(ch.isalpha() for ch in word)
        capital = not titled and word[0].isupper() and not _SENTENCE_START.search(text[: m.start()])
        # A capital inside a word (OpenAI, DeepMind) marks a name even in a headline.
        inner_capital = any(ch.isupper() for ch in word[1:])
        if acronym or modelish or capital or inner_capital:
            found.add(word)
    return found


def walk(value: Any, path: str = "") -> Iterator[tuple[str, dict[str, Any]]]:
    """Every object in a rendition body that lists claim_ids, with its path (items.3)."""
    if isinstance(value, dict):
        if "claim_ids" in value:
            yield path, value
        for key, child in value.items():
            if key != "claim_ids":
                yield from walk(child, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from walk(child, f"{path}.{i}")


def _texts(value: Any) -> list[str]:
    if isinstance(value, str | int | float) and not isinstance(value, bool):
        return [str(value)]
    if isinstance(value, list):
        return [t for v in value for t in _texts(v)]
    if isinstance(value, dict) and "claim_ids" not in value:
        return [t for k, v in value.items() if k not in SKIP_KEYS for t in _texts(v)]
    return []


def item_text(item: dict[str, Any]) -> str:
    """An item's own text, nested lists included (an article's paragraphs); a nested object
    that lists its own claim_ids is checked as its own item."""
    return " ".join(t for k, v in item.items() if k not in SKIP_KEYS for t in _texts(v))


def corpus(claims: list[Claim]) -> str:
    parts = []
    for c in claims:
        parts.append(c.text)
        parts.extend(s.quoted_passage for s in c.sources())
    return "\n".join(parts)


def check_rendition(r: Rendition, by_ref: dict[str, Claim]) -> list[CheckOut]:
    out = []
    for path, item in walk(r.body):
        refs = [str(x) for x in item.get("claim_ids", [])]
        unknown = [x for x in refs if x not in by_ref]
        listed = [by_ref[x] for x in refs if x in by_ref]
        text = item_text(item)
        source = corpus(listed)
        source_numbers = numbers(source)
        source_folded = normalize_text(source)
        extra_numbers = sorted(numbers(text) - source_numbers)
        stated = {
            n
            for s in _texts({k: v for k, v in item.items() if k not in SKIP_KEYS})
            for n in names(s, r.language)
        }
        extra_names = sorted(n for n in stated if n.lower() not in source_folded)
        failed = not refs or unknown or extra_numbers or extra_names
        out.append(
            CheckOut(
                "item-claims",
                "fail" if failed else "pass",
                rendition_id=r.id,
                item=path,
                detail={
                    "no_claims": not refs,
                    "unknown_claims": unknown,
                    "numbers_beyond_claims": extra_numbers,
                    "names_beyond_claims": extra_names,
                },
            )
        )
    return out


def item_claims(b: Bundle) -> list[CheckOut]:
    by_ref = {c.ref: c for c in b.claims}
    return [check for r in b.renditions for check in check_rendition(r, by_ref)]
