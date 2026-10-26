from conftest import FIXTURES

from anr_ingestion.dedupe import (
    NEAR_DUPLICATE_BITS,
    content_hash,
    hamming,
    is_near_duplicate,
    simhash,
)
from anr_ingestion.extract import extract_page


def text(name: str) -> str:
    page = extract_page((FIXTURES / name).read_bytes(), "https://example.com/")
    assert page.text
    return page.text


def test_content_hash_ignores_case_spacing_and_persian_letter_forms() -> None:
    assert content_hash("Hello   World\n") == content_hash("hello world")
    assert content_hash("كتاب ۱۲") == content_hash("کتاب 12")  # Arabic kaf, Persian digits
    assert content_hash("hello world") != content_hash("hello there")


def test_simhash_finds_a_syndicated_copy() -> None:
    original, copy, other = (
        text("orbit.html"),
        text("orbit-syndicated.html"),
        text("orbit-safety.html"),
    )
    a, b, c = simhash(original), simhash(copy), simhash(other)
    assert a is not None and b is not None and c is not None
    assert content_hash(original) != content_hash(copy)  # the copy adds a line: not the same text
    # SimHash finds the copy as a candidate and keeps unrelated texts far away...
    assert hamming(a, b) <= NEAR_DUPLICATE_BITS < hamming(a, c)
    # ...and the shingle overlap confirms it.
    assert is_near_duplicate(original, copy)
    assert not is_near_duplicate(original, other)


def test_simhash_fits_a_signed_bigint_and_skips_short_texts() -> None:
    value = simhash(text("orbit.html"))
    assert value is not None and -(2**63) <= value < 2**63
    assert simhash("A short note about Orbit.") is None
