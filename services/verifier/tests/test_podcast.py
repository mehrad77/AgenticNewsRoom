"""The podcast format's rules on one well-formed episode, and each rule broken once (D38)."""

import copy
from pathlib import Path
from typing import Any

import pytest

from anr_verifier import rendition
from anr_verifier.bundle import Claim, Rendition

CONFIG = Path(__file__).resolve().parents[3] / "config"
SERIES: dict[str, Any] = {
    "segments": [
        {"kind": "news-recap", "minutes": 1, "from": "week.daily-newsletter"},
        {"kind": "story", "minutes": 1, "from": "week.weekly-classic"},
    ],
    "hosts": {"en": {"maya": "Kore", "leo": "Puck"}},
    "narrator": {"en": "Enceladus"},
}
CLAIMS = {
    "c1": Claim("1", "c1", "fact", "Vaswani led the paper.", "lead", "passage"),
    "c2": Claim("2", "c2", "opinion", "It was elegant.", None, None),
}
WORDS = " ".join(["word"] * 15)
STORY_WORDS = " ".join(["word"] * 12)


def line(speaker: str, text: str = STORY_WORDS, **more: Any) -> dict[str, Any]:
    return {"speaker": speaker, "text": text, **more}


def episode() -> dict[str, Any]:
    beats: list[dict[str, Any]] = [
        {"beat": b, "claim_ids": ["c1"], "lines": [line("narrator"), line("maya")]}
        for b in ("cold-open", "context", "stakes", "turning-point", "resolution", "takeaway")
    ]
    beats[3]["lines"][1] = line("maya", f"Then Vaswani dropped recurrence. {STORY_WORDS}")
    beats[4]["lines"][1] = line("leo", f"Ashish Vaswani and his team won. {STORY_WORDS}")
    beats[0]["lines"].append({"cue": "sting"})
    beats[5]["lines"].insert(0, {"cue": "pause", "seconds": 1.5})
    beats[1]["lines"][0] = line("narrator", direction="hushed")
    return {
        "language": "en",
        "title": "The week",
        "items": [
            {
                "segment": "news-recap",
                "topics": [
                    {
                        "title": "Orbit",
                        "claim_ids": ["c1"],
                        "lines": [
                            {"host": h, "text": WORDS + " " + WORDS}
                            for h in ("maya", "leo", "Maya", "leo", "maya")
                        ],
                    }
                ],
            },
            {
                "segment": "story",
                "title": "Attention",
                "protagonists": [
                    {"name": "Ashish Vaswani", "role": "first author", "claim_ids": ["c1"]}
                ],
                "beats": beats,
            },
        ],
    }


def check(rule_id: str, body: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    [rule] = [r for r in rendition.load_rules(CONFIG, "podcast-episode") if r["id"] == rule_id]
    fn = rendition.RULES[rule_id]
    return fn(rule["rule"], Rendition("r", "en", "podcast-episode", body), CLAIMS, SERIES)


RULE_IDS = [r["id"] for r in rendition.load_rules(CONFIG, "podcast-episode")]


@pytest.mark.parametrize("rule_id", RULE_IDS)
def test_a_well_formed_episode_passes(rule_id: str) -> None:
    ok, detail = check(rule_id, episode())
    assert ok, detail


def story(body: dict[str, Any]) -> dict[str, Any]:
    segment: dict[str, Any] = body["items"][1]
    return segment


def broken(change: Any) -> dict[str, Any]:
    body = copy.deepcopy(episode())
    change(body)
    return body


CASES = {
    "segments-follow-series": lambda b: b["items"].reverse(),
    "speakers-known": lambda b: story(b)["beats"][0]["lines"].append(line("niloofar")),
    "segment-length": lambda b: story(b)["beats"][0]["lines"].extend([line("maya")] * 20),
    "story-arc-complete": lambda b: story(b)["beats"].pop(1),
    "protagonists-grounded": lambda b: story(b)["protagonists"][0].update(claim_ids=["c2"]),
    "arc-follows-protagonists": lambda b: story(b)["beats"][4].update(lines=[line("leo")]),
    "cues-sparing": lambda b: story(b)["beats"][2]["lines"].extend([{"cue": "transition"}] * 2),
    "directions-short": lambda b: [
        ln.update(direction="whispered")
        for bt in story(b)["beats"]
        for ln in bt["lines"]
        if "text" in ln
    ],
}


@pytest.mark.parametrize("rule_id", sorted(CASES))
def test_each_rule_fails_its_break(rule_id: str) -> None:
    ok, detail = check(rule_id, broken(CASES[rule_id]))
    assert not ok, detail


def test_every_podcast_rule_has_a_break() -> None:
    assert sorted(CASES) == sorted(RULE_IDS)


def test_a_narrator_needs_a_voice() -> None:
    no_voice = {**SERIES, "narrator": {}}
    [rule] = [
        r for r in rendition.load_rules(CONFIG, "podcast-episode") if r["id"] == "speakers-known"
    ]
    ok, detail = rendition.RULES["speakers-known"](
        rule["rule"], Rendition("r", "en", "podcast-episode", episode()), CLAIMS, no_voice
    )
    assert not ok and detail["unknown"] == ["narrator"]
