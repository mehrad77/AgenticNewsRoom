"""Checks on each rendition as a whole: its format schema, the style lint for its language, and
its format's checks.yaml rules. A rule id the verifier does not know is an error, so it holds."""

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ValidationError

from anr_schemas.formats.artist_story import ArtistStoryDraft
from anr_schemas.formats.classic_article import ClassicArticleDraft
from anr_schemas.formats.newsletter_issue import NewsletterIssueDraft
from anr_schemas.formats.podcast_episode import PodcastEpisodeDraft
from anr_verifier.bundle import Bundle, CheckOut, Claim, Rendition
from anr_verifier.items import SKIP_KEYS, walk

DRAFTS: dict[str, type[BaseModel]] = {
    "artist-story": ArtistStoryDraft,
    "classic-article": ClassicArticleDraft,
    "newsletter-issue": NewsletterIssueDraft,
    "podcast-episode": PodcastEpisodeDraft,
}


def schema(b: Bundle) -> list[CheckOut]:
    out = []
    for r in b.renditions:
        model = DRAFTS.get(r.format)
        if model is None:
            out.append(
                CheckOut("schema", "error", rendition_id=r.id, detail={"error": "no schema"})
            )
            continue
        try:
            model.model_validate({"rendition": r.body})
            out.append(CheckOut("schema", "pass", rendition_id=r.id))
        except ValidationError as error:
            issues = [f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in error.errors()[:20]]
            out.append(CheckOut("schema", "fail", rendition_id=r.id, detail={"errors": issues}))
    return out


def strings(value: Any) -> list[str]:
    """The reader-facing text of a rendition body: every string but ids and kinds."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    if isinstance(value, dict):
        return [
            s for k, v in value.items() if k not in SKIP_KEYS | {"language"} for s in strings(v)
        ]
    return []


# --- Style lint per language (D79) ---

_ARABIC_SCRIPT = re.compile(r"[؀-ۿ]")
_LATIN = re.compile(r"[A-Za-z]")
_HYPE = re.compile(
    r"\b(groundbreaking|revolutionary|game[- ]chang\w*|mind[- ]blowing|jaw[- ]dropping|"
    r"unbelievabl\w*|breathtaking|insane(ly)?)\b",
    re.IGNORECASE,
)
# The present-tense prefix written apart from its verb: "می شود" instead of "می‌شود".
_FA_PREFIX_SPACE = re.compile(r"(?<![؀-ۿ‌])(ن?می) (?=[؀-ۿ])")


def mostly_persian(text: str) -> bool:
    """Judged over a whole rendition: a Persian headline may be a Latin-script name alone."""
    letters = [ch for ch in text if ch.isalpha()]
    return not letters or sum(1 for ch in letters if _ARABIC_SCRIPT.match(ch)) >= len(letters) / 2


def lint_text(text: str, language: str) -> list[str]:
    """Issues in one string of a rendition."""
    issues = []
    if "  " in text:
        issues.append("double space")
    arabic = bool(_ARABIC_SCRIPT.search(text))
    if language == "fa":
        if "ي" in text or "ك" in text:
            issues.append("Arabic ye or kaf; use Persian ی and ک")
        if _FA_PREFIX_SPACE.search(text):
            issues.append("می/نمی written apart from its verb; join with a zero-width non-joiner")
    else:
        if arabic:
            issues.append("Arabic-script letters in a Latin-script language")
        if language == "en" and (m := _HYPE.search(text)):
            issues.append(f"hype word: {m.group(0)}")
    return issues


def style_lint(b: Bundle) -> list[CheckOut]:
    out = []
    for r in b.renditions:
        texts = strings(r.body)
        found = {i for s in texts for i in lint_text(s, r.language)}
        if r.language == "fa" and not mostly_persian(" ".join(texts)):
            found.add("mostly not in Persian script")
        issues = sorted(found)
        out.append(
            CheckOut(
                "style-lint",
                "fail" if issues else "pass",
                rendition_id=r.id,
                detail={"issues": issues},
            )
        )
    return out


# --- Format rules from config/formats/<format>/checks.yaml ---

_RANGE = re.compile(r"in (\d+)\.\.(\d+)")
_AT_MOST = re.compile(r"<= (\d+)")
MAX_REASON_CHARS = 200

RuleFn = Callable[[str, Rendition, dict[str, Claim]], tuple[bool, dict[str, Any]]]


def _range(rule: str) -> tuple[int, int]:
    m = _RANGE.search(rule)
    if not m:
        raise ValueError(f"no range in rule {rule!r}")
    return int(m.group(1)), int(m.group(2))


def _items(r: Rendition, kind: str) -> list[dict[str, Any]]:
    return [i for i in r.body.get("items", []) if isinstance(i, dict) and i.get("kind") == kind]


def _count_news(rule: str, r: Rendition, _: dict[str, Claim]) -> tuple[bool, dict[str, Any]]:
    low, high = _range(rule)
    n = len(_items(r, "news"))
    return low <= n <= high, {"count": n, "range": [low, high]}


def _article_limit(rule: str, r: Rendition, _: dict[str, Claim]) -> tuple[bool, dict[str, Any]]:
    m = _AT_MOST.search(rule)
    if not m:
        raise ValueError(f"no limit in rule {rule!r}")
    n = len(_items(r, "article"))
    return n <= int(m.group(1)), {"count": n, "max": int(m.group(1))}


def _article_reason(_rule: str, r: Rendition, _: dict[str, Claim]) -> tuple[bool, dict[str, Any]]:
    bad = [
        i
        for i, a in enumerate(_items(r, "article"))
        if not str(a.get("reason", "")).strip()
        or "\n" in str(a.get("reason"))
        or len(str(a.get("reason"))) > MAX_REASON_CHARS
    ]
    return not bad, {"articles_without_one_line_reason": bad}


def _length(rule: str, r: Rendition, _: dict[str, Claim]) -> tuple[bool, dict[str, Any]]:
    low, high = _range(rule)
    words = sum(len(s.split()) for s in strings(r.body))
    return low <= words <= high, {"words": words, "range": [low, high]}


def _opinion_items(
    _rule: str, r: Rendition, by_ref: dict[str, Claim]
) -> tuple[bool, dict[str, Any]]:
    bad = [
        path
        for path, item in walk(r.body)
        if item.get("opinion") is True
        and any(by_ref[c].kind != "opinion" for c in item.get("claim_ids", []) if c in by_ref)
    ]
    return not bad, {"opinion_items_with_facts": bad}


RULES: dict[str, RuleFn] = {
    "news-item-count": _count_news,
    "article-limit": _article_limit,
    "article-has-reason": _article_reason,
    "length": _length,
    "opinion-has-no-facts": _opinion_items,
}


def load_rules(config_dir: Path, format_slug: str) -> list[dict[str, str]]:
    path = config_dir / "formats" / format_slug / "checks.yaml"
    if not path.exists():
        return []
    rules = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    return [{"id": str(r["id"]), "rule": str(r["rule"])} for r in rules]


def format_rules(b: Bundle, config_dir: Path) -> list[CheckOut]:
    by_ref = {c.ref: c for c in b.claims}
    out = []
    for r in b.renditions:
        for rule in load_rules(config_dir, r.format):
            name = f"format:{rule['id']}"
            fn = RULES.get(rule["id"])
            if fn is None:
                out.append(
                    CheckOut(
                        name,
                        "error",
                        rendition_id=r.id,
                        detail={"error": "rule not implemented", "rule": rule["rule"]},
                    )
                )
                continue
            try:
                ok, detail = fn(rule["rule"], r, by_ref)
            except (ValueError, TypeError) as error:
                out.append(CheckOut(name, "error", rendition_id=r.id, detail={"error": str(error)}))
                continue
            out.append(CheckOut(name, "pass" if ok else "fail", rendition_id=r.id, detail=detail))
    return out
