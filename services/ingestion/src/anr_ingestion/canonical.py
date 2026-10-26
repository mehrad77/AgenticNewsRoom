"""Canonical URLs: one spelling per page, so the same item from two feeds is one lead.

The canonical URL is the lead's ninjs `uri`.
"""

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import tldextract

# Query parameters that identify a campaign or a click, never the page.
_TRACKING = re.compile(
    r"^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|mkt_tok|ref_src)$",
    re.IGNORECASE,
)
_ARXIV_HOSTS = frozenset({"arxiv.org", "www.arxiv.org", "export.arxiv.org"})
_ARXIV_PATH = re.compile(
    r"^/(?:abs|pdf)/(?P<id>[a-z-]+(?:\.[A-Z]{2})?/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?"
)

# The public-suffix snapshot bundled with tldextract; never fetched (no network outside fetches).
# Private suffixes count too: alice.github.io and bob.github.io are different sites.
_extract = tldextract.TLDExtract(suffix_list_urls=(), include_psl_private_domains=True)


def arxiv_id(url: str) -> str | None:
    """`2410.01234` for any arXiv abs or pdf URL of any version, else None."""
    parts = urlsplit(url)
    if (parts.hostname or "") not in _ARXIV_HOSTS:
        return None
    match = _ARXIV_PATH.match(parts.path)
    return match.group("id") if match else None


def canonical_url(url: str) -> str:
    """Lower-case scheme and host, no default port, no fragment, no tracking parameters.

    An arXiv paper is always `https://arxiv.org/abs/<id>`, without its version: versions of a
    paper are one lead, whose text stays the version first stored.
    """
    paper = arxiv_id(url)
    if paper:
        return f"https://arxiv.org/abs/{paper}"
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    port = parts.port
    if port is not None and (scheme, port) not in {("http", 80), ("https", 443)}:
        host = f"{host}:{port}"
    query = urlencode(
        [
            (k, v)
            for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if not _TRACKING.match(k)
        ]
    )
    return urlunsplit((scheme, host, parts.path or "/", query, ""))


def registrable_domain(url: str) -> str:
    """`bbc.co.uk` for `https://news.bbc.co.uk/x`: the part a site owner controls."""
    host = (urlsplit(url).hostname or "").lower()
    # No known public suffix (an IP, `localhost`, a reserved TLD): the host is the whole site.
    return _extract(host).top_domain_under_public_suffix or host


def same_site(a: str, b: str) -> bool:
    return registrable_domain(a) == registrable_domain(b) != ""


def host_key(url: str) -> str:
    """The host without a leading `www.`, for matching a requested URL to a known source."""
    host = (urlsplit(url).hostname or "").lower()
    return host.removeprefix("www.")
