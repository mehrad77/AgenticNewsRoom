"""Fingerprints of a lead's text, for the second and third deduplication steps (D56).

1. Canonical URL: the same page (canonical.py, checked in the database).
2. Content hash: the same text once normalised (case, Unicode forms, Persian letters, spacing).
3. Near-duplicate: nearly the same text, such as a syndicated copy with another intro line.
   Two stages: Postgres finds candidates whose SimHash is within NEAR_DUPLICATE_BITS
   (`bit_count(a # b)`), then Python confirms each one by the Jaccard overlap of the two texts'
   word 3-shingles. SimHash alone is noisy on short posts (a one-line intro moved one copy by
   8 bits, while unrelated texts sit around 32), so it only narrows the search.
"""

import hashlib
import re

from anr_schemas.text import normalize_text

SIMHASH_BITS = 64
NEAR_DUPLICATE_BITS = 12
"""SimHash candidates: at most this many differing bits. Loose on purpose; Jaccard decides."""
NEAR_DUPLICATE_JACCARD = 0.8
"""Shared share of word 3-shingles above which two texts are one lead."""
MIN_SHINGLES = 24
"""Shorter texts get no SimHash: a few shingles cannot tell a copy from a different short note."""

_WORD = re.compile(r"\w+")


def normalised(text: str, language: str | None = None) -> str:
    return " ".join(normalize_text(text, language).split())


def content_hash(text: str, language: str | None = None) -> str:
    return hashlib.sha256(normalised(text, language).encode()).hexdigest()


def shingles(text: str, language: str | None = None) -> set[str]:
    words = _WORD.findall(normalised(text, language))
    return {" ".join(words[i : i + 3]) for i in range(len(words) - 2)}


def jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a or b else 0.0


def is_near_duplicate(text: str, other: str, language: str | None = None) -> bool:
    return jaccard(shingles(text, language), shingles(other, language)) >= NEAR_DUPLICATE_JACCARD


def simhash(text: str, language: str | None = None) -> int | None:
    """A signed 64-bit SimHash (Postgres `bigint`) of the text's word 3-shingles, or None."""
    shingles_ = shingles(text, language)
    if len(shingles_) < MIN_SHINGLES:
        return None
    votes = [0] * SIMHASH_BITS
    for shingle in shingles_:
        h = int.from_bytes(hashlib.blake2b(shingle.encode(), digest_size=8).digest(), "big")
        for bit in range(SIMHASH_BITS):
            votes[bit] += 1 if h >> bit & 1 else -1
    value = sum(1 << bit for bit, v in enumerate(votes) if v > 0)
    return value - (1 << SIMHASH_BITS) if value >= 1 << (SIMHASH_BITS - 1) else value


def hamming(a: int, b: int) -> int:
    return ((a ^ b) & ((1 << SIMHASH_BITS) - 1)).bit_count()
