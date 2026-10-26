"""HTTP for ingestion, the only part of ANR that fetches from the web.

Every request goes through `Fetcher.get`:
- http and https only; redirects followed by hand (at most five), each hop checked again;
- the host resolved once at connect time, every answer required to be a public address, and
  the connection made to that checked address, so a DNS answer that changes between check and
  connect (DNS rebinding) cannot reach a private network (D58);
- robots.txt honoured per origin (RFC 9309: a 4xx means no rules, an unreachable or 5xx
  robots.txt means fetch nothing), a minimum delay between requests to one host, a size cap.
"""

import ipaddress
import socket
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpcore
import httpx

MAX_REDIRECTS = 5
REDIRECTS = frozenset({301, 302, 303, 307, 308})
ROBOTS_TOKEN = "ANR-Ingestion"
ROBOTS_RETRY_SECONDS = 300.0
"""How long an unreachable robots.txt (timeout, 5xx) keeps a host off before it is asked again."""


class FetchError(Exception):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class Refused(FetchError):
    """Never fetched: not http(s), not a public address, or disallowed by robots.txt."""


type Resolver = Callable[[str, int], list[str]]


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos})


def check_address(ip: str) -> None:
    """Raises Refused unless `ip` is a public unicast address."""
    addr = ipaddress.ip_address(ip)
    # An IPv4-mapped IPv6 address (::ffff:127.0.0.1) is judged as the IPv4 address it carries.
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    if not addr.is_global or addr.is_multicast:
        raise Refused(f"{ip} is not a public address")


class GuardedBackend(httpcore.NetworkBackend):
    """httpcore's socket layer with the address check at the moment of connecting."""

    def __init__(self, resolver: Resolver = system_resolver) -> None:
        self._resolver = resolver
        self._inner = httpcore.SyncBackend()

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.NetworkStream:
        try:
            ips = self._resolver(host, port)
        except OSError as error:
            raise FetchError(f"cannot resolve {host}: {error}") from error
        if not ips:
            raise FetchError(f"cannot resolve {host}")
        # Every answer must be public: otherwise a later connection could pick the private one.
        for ip in ips:
            check_address(ip)
        # Try each checked address, IPv4 first (many networks have no IPv6 route), as httpcore
        # would; TLS still verifies the certificate against `host` (passed on as the SNI name).
        ordered = sorted(ips, key=lambda ip: ipaddress.ip_address(ip).version)
        last: Exception | None = None
        for ip in ordered:
            try:
                return self._inner.connect_tcp(
                    ip,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as error:
                last = error
        assert last is not None
        raise last

    def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.NetworkStream:
        raise Refused("unix sockets are never fetched")

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


class GuardedTransport(httpx.HTTPTransport):
    """httpx's transport on the guarded backend, with no proxy (a proxy would connect for us)."""

    def __init__(self, resolver: Resolver = system_resolver) -> None:
        super().__init__()
        self._pool = httpcore.ConnectionPool(
            ssl_context=httpx.create_ssl_context(),
            max_connections=10,
            keepalive_expiry=5.0,
            network_backend=GuardedBackend(resolver),
        )


@dataclass(frozen=True)
class Fetched:
    url: str
    """The final URL, after redirects."""
    status: int
    """200, or 304 when the conditional headers matched (then `content` is empty)."""
    content: bytes
    content_type: str
    etag: str | None
    last_modified: str | None


def check_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise Refused(f"{url}: only http and https are fetched")
    if not parts.hostname:
        raise Refused(f"{url}: no host")
    if parts.username is not None or parts.password is not None:
        raise Refused(f"{url}: URLs with credentials are never fetched")
    # An address written in the URL is checked here as well as at connect time, whatever the
    # transport; names are resolved and checked by GuardedBackend.
    try:
        ipaddress.ip_address(parts.hostname)
    except ValueError:
        return
    check_address(parts.hostname)


class Fetcher:
    def __init__(
        self,
        transport: httpx.BaseTransport,
        *,
        user_agent: str,
        max_bytes: int = 10_000_000,
        timeout: float = 20.0,
        min_delay: float = 1.0,
        host_delays: dict[str, float] | None = None,
        robots_ttl: float = 24 * 3600.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._client = httpx.Client(
            transport=transport,
            follow_redirects=False,
            timeout=timeout,
            headers={"User-Agent": user_agent},
            trust_env=False,
        )
        self.max_bytes = max_bytes
        self.min_delay = min_delay
        self.host_delays = host_delays or {}
        self.robots_ttl = robots_ttl
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next_at: dict[str, float] = {}
        self._robots: dict[str, tuple[float, float, RobotFileParser]] = {}

    def close(self) -> None:
        self._client.close()

    def get(
        self,
        url: str,
        *,
        etag: str | None = None,
        last_modified: str | None = None,
        robots: bool = True,
    ) -> Fetched:
        headers = {}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        for _ in range(MAX_REDIRECTS + 1):
            check_url(url)
            if robots and not self.allowed(url):
                raise Refused(f"robots.txt disallows {url}")
            status, response_headers, content = self._send(url, headers)
            if status in REDIRECTS:
                location = response_headers.get("location")
                if not location:
                    raise FetchError(f"{url}: HTTP {status} without a Location", status)
                url = urljoin(url, location)
                continue
            if status == 304:
                return Fetched(url, 304, b"", "", etag, last_modified)
            if status >= 400:
                raise FetchError(f"{url}: HTTP {status}", status)
            return Fetched(
                url=url,
                status=status,
                content=content,
                content_type=response_headers.get("content-type", ""),
                etag=response_headers.get("etag"),
                last_modified=response_headers.get("last-modified"),
            )
        raise FetchError(f"{url}: more than {MAX_REDIRECTS} redirects")

    def post_json(self, url: str, payload: object) -> bytes:
        """One JSON POST to an API (no redirects, no robots.txt: an API is not a crawl)."""
        check_url(url)
        self._wait(urlsplit(url).hostname or "")
        try:
            response = self._client.post(url, json=payload)
        except httpx.HTTPError as error:
            raise FetchError(f"{url}: {error}") from error
        if response.status_code >= 400:
            raise FetchError(f"{url}: HTTP {response.status_code}", response.status_code)
        if len(response.content) > self.max_bytes:
            raise FetchError(f"{url}: larger than {self.max_bytes} bytes")
        return response.content

    def allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        cached = self._robots.get(origin)
        if cached is None or self._clock() - cached[0] > cached[1]:
            parser, ttl = self._load_robots(origin)
            cached = (self._clock(), ttl, parser)
            self._robots[origin] = cached
        return cached[2].can_fetch(ROBOTS_TOKEN, url)

    def _load_robots(self, origin: str) -> tuple[RobotFileParser, float]:
        """The host's rules and how long to keep them."""
        parser = RobotFileParser()
        try:
            fetched = self.get(f"{origin}/robots.txt", robots=False)
        except Refused:
            raise
        except FetchError as error:
            # No robots.txt (4xx): no rules. Unreachable or failing (5xx): assume everything is off.
            # An unreachable one is asked again soon, so one network blip never blocks a day.
            unavailable = error.status is not None and 400 <= error.status < 500
            parser.parse([] if unavailable else ["User-agent: *", "Disallow: /"])
            return parser, self.robots_ttl if unavailable else ROBOTS_RETRY_SECONDS
        parser.parse(fetched.content.decode("utf-8", "replace").splitlines())
        # A declared Crawl-delay becomes this host's minimum gap between requests.
        declared = parser.crawl_delay(ROBOTS_TOKEN)
        host = urlsplit(origin).hostname or ""
        if declared is not None:
            with self._lock:
                current = self.host_delays.get(host, self.min_delay)
                self.host_delays[host] = max(current, float(declared))
        return parser, self.robots_ttl

    def _wait(self, host: str) -> None:
        """Reserves this host's next slot, then sleeps until it comes."""
        with self._lock:
            now = self._clock()
            start = max(now, self._next_at.get(host, 0.0))
            self._next_at[host] = start + self.host_delays.get(host, self.min_delay)
        if start > now:
            self._sleep(start - now)

    def _send(self, url: str, headers: dict[str, str]) -> tuple[int, httpx.Headers, bytes]:
        self._wait(urlsplit(url).hostname or "")
        try:
            with self._client.stream("GET", url, headers=headers) as response:
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > self.max_bytes:
                    raise FetchError(f"{url}: larger than {self.max_bytes} bytes")
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise FetchError(f"{url}: larger than {self.max_bytes} bytes")
                    chunks.append(chunk)
                return response.status_code, response.headers, b"".join(chunks)
        except httpx.HTTPError as error:
            raise FetchError(f"{url}: {error}") from error
