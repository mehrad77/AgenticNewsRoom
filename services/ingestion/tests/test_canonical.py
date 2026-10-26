import pytest

from anr_ingestion.canonical import arxiv_id, canonical_url, host_key, registrable_domain, same_site


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "HTTPS://OpenAI.com:443/index/x/?utm_source=rss&id=7#top",
            "https://openai.com/index/x/?id=7",
        ),
        ("http://example.com:80", "http://example.com/"),
        ("https://example.com:8443/a?fbclid=1&gclid=2", "https://example.com:8443/a"),
        ("http://arxiv.org/abs/2610.01234v2", "https://arxiv.org/abs/2610.01234"),
        ("https://arxiv.org/pdf/2610.01234v1", "https://arxiv.org/abs/2610.01234"),
        ("https://export.arxiv.org/abs/cs/0112017v1", "https://arxiv.org/abs/cs/0112017"),
    ],
)
def test_canonical_url(url: str, expected: str) -> None:
    assert canonical_url(url) == expected


def test_arxiv_id() -> None:
    assert arxiv_id("http://arxiv.org/abs/2610.01234v2") == "2610.01234"
    assert arxiv_id("https://example.com/abs/2610.01234") is None


def test_registrable_domain_uses_the_bundled_suffix_list() -> None:
    assert registrable_domain("https://news.bbc.co.uk/x") == "bbc.co.uk"
    assert registrable_domain("https://deepmind.google/blog") == "deepmind.google"
    assert registrable_domain("https://someone.github.io/") == "someone.github.io"
    assert same_site("https://www.anthropic.com/a", "https://anthropic.com/b")
    assert not same_site("https://huggingface.co/blog/x", "https://openai.com/index/x")
    assert host_key("https://www.anthropic.com/news") == "anthropic.com"
    # Reserved TLDs and addresses have no public suffix: the whole host is the site.
    assert not same_site("https://unknown.example/a", "https://blocked.example/b")
    assert registrable_domain("http://10.0.0.1/x") == "10.0.0.1"
