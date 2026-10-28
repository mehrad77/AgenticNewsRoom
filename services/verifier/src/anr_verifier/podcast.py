"""The podcast format's checks.yaml rules: segments as the series has them, known speakers, the
story arc and its protagonists, and sparse cues and directions (D38). Numbers are read from each
rule's text, so a changed number in checks.yaml changes the check."""

import re
from typing import Any

from anr_schemas.text import normalize_text
from anr_verifier.bundle import Claim, Rendition

ARC = ("cold-open", "context", "turning-point", "stakes", "resolution", "takeaway")
_WITHIN = re.compile(r"within (\d+)% of minutes \* (\d+)")
_AT_MOST_CUES = re.compile(r"at most (\d+) cue")
_AT_MOST_CHARS = re.compile(r"at most (\d+) characters")
_SHARE = re.compile(r"at most an? (third|quarter|half)")
_SHARES = {"half": 2, "third": 3, "quarter": 4}

Result = tuple[bool, dict[str, Any]]


def _segments(r: Rendition) -> list[dict[str, Any]]:
    return [i for i in r.body.get("items", []) if isinstance(i, dict)]


def _stories(r: Rendition) -> list[tuple[int, dict[str, Any]]]:
    return [(n, s) for n, s in enumerate(_segments(r)) if s.get("segment") == "story"]


def _beats(segment: dict[str, Any]) -> list[dict[str, Any]]:
    return [b for b in segment.get("beats", []) if isinstance(b, dict)]


def _lines(segment: dict[str, Any]) -> list[dict[str, Any]]:
    """Spoken lines of a segment, cues left out."""
    if segment.get("segment") == "news-recap":
        return [ln for t in segment.get("topics", []) for ln in t.get("lines", [])]
    return [ln for b in _beats(segment) for ln in b.get("lines", []) if "text" in ln]


def segments_follow_series(
    _rule: str, r: Rendition, _: dict[str, Claim], series: dict[str, Any]
) -> Result:
    want = [str(s.get("kind")) for s in series.get("segments", [])]
    have = [str(s.get("segment")) for s in _segments(r)]
    return have == want, {"segments": have, "series": want}


def speakers_known(_rule: str, r: Rendition, _: dict[str, Claim], series: dict[str, Any]) -> Result:
    hosts = {h.casefold() for h in (series.get("hosts") or {}).get(r.language, {})}
    narrator = bool((series.get("narrator") or {}).get(r.language))
    allowed = hosts | ({"narrator"} if narrator else set())
    unknown = sorted(
        {
            str(ln.get("host") or ln.get("speaker"))
            for s in _segments(r)
            for ln in _lines(s)
            if str(ln.get("host") or ln.get("speaker", "")).casefold() not in allowed
        }
    )
    return not unknown, {"unknown": unknown, "allowed": sorted(allowed)}


def segment_length(rule: str, r: Rendition, _: dict[str, Claim], series: dict[str, Any]) -> Result:
    m = _WITHIN.search(rule)
    if not m:
        raise ValueError(f"no tolerance in rule {rule!r}")
    tolerance, per_minute = int(m.group(1)) / 100, int(m.group(2))
    planned = series.get("segments", [])
    out = []
    for n, s in enumerate(_segments(r)):
        minutes = planned[n].get("minutes") if n < len(planned) else None
        if minutes is None:
            continue
        words = sum(len(str(ln.get("text", "")).split()) for ln in _lines(s))
        target = minutes * per_minute
        out.append(
            {
                "segment": n,
                "words": words,
                "target": target,
                "ok": abs(words - target) <= tolerance * target,
            }
        )
    return all(x["ok"] for x in out), {"segments": out}


def story_arc_complete(
    _rule: str, r: Rendition, _: dict[str, Claim], _series: dict[str, Any]
) -> Result:
    bad = []
    for n, s in _stories(r):
        order = [str(b.get("beat")) for b in _beats(s)]
        middle = order[2:4]
        ok = (
            len(order) == len(ARC)
            and set(order) == set(ARC)
            and order[0] == "cold-open"
            and order[1] == "context"
            and sorted(middle) == ["stakes", "turning-point"]
            and order[4] == "resolution"
            and order[5] == "takeaway"
        )
        if not ok:
            bad.append({"segment": n, "beats": order})
    return not bad, {"incomplete": bad}


def protagonists_grounded(
    _rule: str, r: Rendition, by_ref: dict[str, Claim], _series: dict[str, Any]
) -> Result:
    bad = []
    for n, s in _stories(r):
        for p in s.get("protagonists", []):
            refs = p.get("claim_ids", [])
            if not refs or any(c not in by_ref or by_ref[c].kind != "fact" for c in refs):
                bad.append({"segment": n, "protagonist": p.get("name"), "claim_ids": refs})
    return not bad, {"ungrounded": bad}


def _name_parts(name: str, language: str) -> set[str]:
    """A protagonist is named by the full name or any part of three letters or more."""
    full = normalize_text(name, language)
    return {full} | {p for p in full.split() if len(p) >= 3}


def arc_follows_protagonists(
    _rule: str, r: Rendition, _: dict[str, Claim], _series: dict[str, Any]
) -> Result:
    bad = []
    for n, s in _stories(r):
        parts = set().union(
            *(_name_parts(str(p.get("name", "")), r.language) for p in s.get("protagonists", []))
        )
        for b in _beats(s):
            if b.get("beat") not in ("turning-point", "resolution"):
                continue
            words = normalize_text(
                " ".join(str(ln.get("text", "")) for ln in b.get("lines", [])), r.language
            )
            tokens = set(re.findall(r"\w+", words))
            if not any(p in tokens or (" " in p and p in words) for p in parts):
                bad.append({"segment": n, "beat": b.get("beat")})
    return not bad, {"beats_without_a_protagonist": bad}


def cues_sparing(rule: str, r: Rendition, _: dict[str, Claim], _series: dict[str, Any]) -> Result:
    m = _AT_MOST_CUES.search(rule)
    if not m:
        raise ValueError(f"no cue limit in rule {rule!r}")
    limit = int(m.group(1))
    bad = []
    for n, s in enumerate(_segments(r)):
        for b in _beats(s):
            cues = [ln for ln in b.get("lines", []) if "cue" in ln]
            if len(cues) > limit:
                bad.append({"segment": n, "beat": b.get("beat"), "cues": len(cues)})
            for c in cues:
                if (c.get("cue") == "pause") != ("seconds" in c):
                    bad.append({"segment": n, "beat": b.get("beat"), "cue": c})
    return not bad, {"too_many_or_malformed": bad}


def directions_short(
    rule: str, r: Rendition, _: dict[str, Claim], _series: dict[str, Any]
) -> Result:
    chars = _AT_MOST_CHARS.search(rule)
    share = _SHARE.search(rule)
    if not chars or not share:
        raise ValueError(f"no limits in rule {rule!r}")
    limit, divisor = int(chars.group(1)), _SHARES[share.group(1)]
    lines = [ln for _, s in _stories(r) for ln in _lines(s)]
    directed = [ln for ln in lines if ln.get("direction")]
    long = [ln["direction"] for ln in directed if len(str(ln["direction"])) > limit]
    sparse = len(directed) * divisor <= len(lines)
    return not long and sparse, {"directed": len(directed), "lines": len(lines), "too_long": long}
