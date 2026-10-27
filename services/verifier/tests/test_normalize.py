import json
from pathlib import Path

import pytest

from anr_schemas.text import normalize_text

FIXTURE = Path(__file__).parents[3] / "packages/schemas/fixtures/normalization.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_matches_shared_vectors(case: dict[str, str | None]) -> None:
    text, expected = case["input"], case["expected"]
    assert text is not None
    assert normalize_text(text, case["language"]) == expected
