import httpx
import pytest
from conftest import FakeWeb

from anr_ingestion.net import (
    Fetcher,
    FetchError,
    GuardedBackend,
    GuardedTransport,
    Refused,
    check_address,
)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.1.2.3",
        "192.168.0.10",
        "172.16.5.4",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "fd00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
        "224.0.0.1",
    ],
)
def test_refuses_private_and_internal_addresses(ip: str) -> None:
    with pytest.raises(Refused):
        check_address(ip)


@pytest.mark.parametrize("ip", ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
def test_allows_public_addresses(ip: str) -> None:
    check_address(ip)


def test_backend_refuses_when_any_answer_is_private() -> None:
    # A host that answers with one public and one private address could be steered to the second.
    backend = GuardedBackend(resolver=lambda host, port: ["93.184.216.34", "10.0.0.5"])
    with pytest.raises(Refused):
        backend.connect_tcp("rebinding.example", 443)


def test_backend_tries_each_checked_address_ipv4_first() -> None:
    import httpcore

    tried: list[str] = []

    class Inner:
        def connect_tcp(self, host: str, port: int, **_: object) -> httpcore.NetworkStream:
            tried.append(host)
            raise httpcore.ConnectError("unreachable")

    backend = GuardedBackend(
        resolver=lambda host, port: ["2606:4700::1", "93.184.216.34", "93.184.216.35"]
    )
    backend._inner = Inner()  # type: ignore[assignment]
    with pytest.raises(httpcore.ConnectError):
        backend.connect_tcp("example.com", 443)
    assert tried == ["93.184.216.34", "93.184.216.35", "2606:4700::1"]


def test_guarded_transport_refuses_loopback_before_connecting() -> None:
    fetcher = Fetcher(GuardedTransport(), user_agent="test", sleep=lambda _: None)
    with pytest.raises(Refused):
        fetcher.get("http://127.0.0.1:9/secret", robots=False)
    with pytest.raises(Refused):
        fetcher.get("http://localhost:9/secret", robots=False)


def test_refuses_address_literals_whatever_the_transport(fetcher: Fetcher) -> None:
    with pytest.raises(Refused):
        fetcher.get("http://169.254.169.254/latest/meta-data/")
    with pytest.raises(Refused):
        fetcher.get("http://[::1]:8101/ingest")


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "ftp://example.com/x", "http://user:pw@example.com/"]
)
def test_refuses_other_schemes_and_credentials(fetcher: Fetcher, url: str) -> None:
    with pytest.raises(Refused):
        fetcher.get(url)


def test_follows_redirects_and_checks_each_hop(fetcher: Fetcher, web: FakeWeb) -> None:
    got = fetcher.get("https://openai.com/index/introducing-orbit/?utm_source=rss&utm_medium=feed")
    assert got.url == "https://openai.com/index/introducing-orbit/"
    web.routes["https://openai.com/to-file"] = {
        "status": 302,
        "headers": {"Location": "file:///etc/passwd"},
    }
    with pytest.raises(Refused):
        fetcher.get("https://openai.com/to-file")


def test_robots_txt(fetcher: Fetcher, web: FakeWeb) -> None:
    with pytest.raises(Refused, match=r"robots\.txt"):
        fetcher.get("https://blocked.example/page")
    assert "https://blocked.example/page" not in web.urls()
    # A 404 robots.txt means no rules; a failing one means fetch nothing (RFC 9309).
    assert fetcher.allowed("https://huggingface.co/blog/x")
    web.routes["https://down.example/robots.txt"] = {"status": 503}
    assert not fetcher.allowed("https://down.example/page")
    # Fetched once per origin, then cached.
    fetcher.get("https://openai.com/index/orbit-safety/")
    fetcher.get("https://openai.com/index/introducing-orbit/")
    assert web.urls().count("https://openai.com/robots.txt") == 1


def test_conditional_get(fetcher: Fetcher) -> None:
    first = fetcher.get("https://openai.com/news/rss.xml")
    assert first.status == 200 and first.etag == '"feed-v1"'
    again = fetcher.get("https://openai.com/news/rss.xml", etag=first.etag)
    assert again.status == 304 and again.content == b""


def test_errors_and_size_cap(web: FakeWeb) -> None:
    fetcher = Fetcher(
        httpx.MockTransport(web.handler), user_agent="t", max_bytes=100, sleep=lambda _: None
    )
    with pytest.raises(FetchError, match="404") as info:
        fetcher.get("https://openai.com/index/gone/")
    assert info.value.status == 404
    with pytest.raises(FetchError, match="larger than"):
        fetcher.get("https://openai.com/index/orbit-safety/")


def test_politeness_delay_per_host(web: FakeWeb) -> None:
    now = [0.0]
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        now[0] += seconds

    fetcher = Fetcher(
        httpx.MockTransport(web.handler),
        user_agent="t",
        host_delays={"export.arxiv.org": 3.0},
        clock=lambda: now[0],
        sleep=sleep,
    )
    web.routes["https://export.arxiv.org/api/query"] = {"file": "arxiv.xml"}
    fetcher.get("https://openai.com/index/orbit-safety/")  # robots.txt, then the page: 1 s apart
    fetcher.get("https://export.arxiv.org/api/query", robots=False)  # another host: no wait
    fetcher.get("https://export.arxiv.org/api/query", robots=False)  # 3 s for arXiv
    assert slept == [1.0, 3.0]


def test_crawl_delay_from_robots_txt(web: FakeWeb) -> None:
    now = [0.0]
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        now[0] += seconds

    web.routes["https://slow.example/robots.txt"] = {"file": "robots-slow.txt"}
    web.routes["https://slow.example/a"] = {"file": "site-post.html"}
    fetcher = Fetcher(
        httpx.MockTransport(web.handler), user_agent="t", clock=lambda: now[0], sleep=sleep
    )
    fetcher.get("https://slow.example/a")  # robots.txt first: 1 s default, then 15 s apply
    fetcher.get("https://slow.example/a")
    assert slept == [1.0, 15.0]
