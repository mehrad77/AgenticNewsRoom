"""What the code checks read: one story with its claims, the leads they cite, its renditions and
the newsroom's policy. Loaded from Postgres by `load.py`; the checks never touch the database."""

from dataclasses import dataclass, field
from typing import Any, Literal

Result = Literal["pass", "fail", "partial", "error", "timed-out"]


@dataclass(frozen=True)
class Lead:
    id: str
    body: str
    language: str
    tier: int
    publisher: str
    withdrawn: str | None
    beats: dict[str, str]
    """Beat slug -> status (open, restricted, banned); empty until the summariser has run."""


@dataclass(frozen=True)
class Source:
    lead_id: str
    quoted_passage: str


@dataclass(frozen=True)
class Claim:
    id: str
    ref: str
    kind: str
    text: str
    lead_id: str | None
    quoted_passage: str | None
    also: tuple[Source, ...] = ()

    def sources(self) -> tuple[Source, ...]:
        """The claim's lead and passage, then its corroborating ones (D74)."""
        first = (
            (Source(self.lead_id, self.quoted_passage),)
            if self.lead_id and self.quoted_passage is not None
            else ()
        )
        return first + self.also


@dataclass(frozen=True)
class Rendition:
    id: str
    language: str
    format: str
    body: dict[str, Any]


@dataclass(frozen=True)
class Policy:
    min_independent: int
    tier1_alone: bool
    opinion: str
    """not_allowed or allowed_marked."""


@dataclass(frozen=True)
class Bundle:
    story_id: str
    beat: str | None
    beats: dict[str, str]
    """Every live beat of the newsroom: slug -> status."""
    claims: tuple[Claim, ...]
    leads: dict[str, Lead]
    renditions: tuple[Rendition, ...]
    policy: Policy
    series: dict[str, Any] = field(default_factory=dict)
    """The story's series config (hosts, narrator, segments), for format rules."""


@dataclass
class CheckOut:
    """One stored Check: about a claim, a rendition (item) or the story's renditions."""

    name: str
    result: Result
    claim_id: str | None = None
    rendition_id: str | None = None
    item: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)
