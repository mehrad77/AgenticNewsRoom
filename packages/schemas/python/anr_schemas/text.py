"""Text normalisation: the one Python normaliser, for the verifier's quote matching and
ingestion's content hash.

Mirrors the SQL function anr.normalize_text() (packages/db/migrations/*_normalize_text.sql);
both are tested against packages/schemas/fixtures/normalization.json.
"""

import unicodedata

_PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹"
_ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"
_MAP = str.maketrans(
    {
        "ي": "ی",  # Arabic ye -> Persian ye
        "ى": "ی",  # Arabic alef maksura -> Persian ye
        "ك": "ک",  # Arabic kaf -> Persian kaf
        "‌": None,  # zero-width non-joiner
        "\u2010": "-",  # hyphen (NFKC maps the non-breaking hyphen to it) -> hyphen-minus
        "\u2011": "-",  # non-breaking hyphen
        "\u2212": "-",  # minus sign
        **{d: str(i) for i, d in enumerate(_PERSIAN_DIGITS)},
        **{d: str(i) for i, d in enumerate(_ARABIC_INDIC_DIGITS)},
    }
)


def normalize_text(text: str, language: str | None = None) -> str:
    """NFKC, Persian letter and digit folding, then lower case (Turkish rules for "tr")."""
    mapped = unicodedata.normalize("NFKC", text).translate(_MAP)
    if language == "tr":
        # Dotless capital I -> dotless small i; dotted capital I -> small i.
        mapped = mapped.replace("I", "\u0131").replace("\u0130", "i")
    return mapped.lower()
