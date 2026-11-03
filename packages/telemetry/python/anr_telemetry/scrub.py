"""Telemetry carries no reader data (D137): no client address, user agent, query string, token or
email address leaves a service. The twin of packages/telemetry/src/scrub.ts; a change to one
needs the same change to the other. The collector drops the same attributes again."""

import re
from collections.abc import Mapping

from opentelemetry.context import Context
from opentelemetry.sdk._logs import LogRecordProcessor, ReadWriteLogRecord
from opentelemetry.sdk.trace import Event, ReadableSpan, Span, SpanProcessor
from opentelemetry.trace import Status
from opentelemetry.util.types import AnyValue, Attributes

DROPPED_ATTRIBUTES = frozenset(
    {
        "client.address",
        "client.port",
        "http.client_ip",
        "net.peer.ip",
        "net.peer.port",
        "net.sock.peer.addr",
        "net.sock.peer.port",
        "network.peer.address",
        "network.peer.port",
        "user_agent.original",
        "user_agent.name",
        "user_agent.version",
        "user_agent.synthetic.type",
        "http.user_agent",
        "url.query",
        "enduser.id",
        "user.id",
        "user.email",
    }
)
"""Dropped from every span: old and current semantic-convention names."""
DROPPED_PREFIXES = ("http.request.header.", "http.response.header.")
"""Request and response headers, whatever their name (`http.request.header.cf-connecting-ip`)."""
URL_ATTRIBUTES = frozenset({"url.full", "url.original", "http.url", "http.target"})
"""Kept without their query string: a reader's challenge link carries its token there (D114)."""

# re.ASCII: JavaScript's \w and \b are ASCII-only.
_QUERY = re.compile(r"[?#].*", re.ASCII | re.DOTALL)
_TEXT_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+", re.ASCII), "<jwt>"),
    (re.compile(r"\bbot\d+:[\w-]{20,}", re.ASCII), "bot<token>"),
    (re.compile(r"\?[^\s\"'<>?]*=[^\s\"'<>]*", re.ASCII), ""),
    (re.compile(r"[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}", re.ASCII | re.IGNORECASE), "<email>"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", re.ASCII), "<ip>"),
    # Four or more groups, or a `::`: times such as 14:02:06 are left alone.
    (
        re.compile(
            r"(?<![\w:])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![\w:])"
            r"|(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![\w:])",
            re.ASCII | re.IGNORECASE,
        ),
        "<ip>",
    ),
)


def without_query(url: str) -> str:
    return _QUERY.sub("", url, count=1)


def scrub_text(text: str) -> str:
    """In free text (log lines, error messages): a JWT, a query string, an email, an IP address."""
    for pattern, replacement in _TEXT_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def scrub_attributes(attributes: Mapping[str, AnyValue] | None) -> dict[str, AnyValue]:
    """A copy of `attributes` without reader data."""
    out: dict[str, AnyValue] = {}
    for key, value in (attributes or {}).items():
        if key in DROPPED_ATTRIBUTES or key.startswith(DROPPED_PREFIXES):
            continue
        if isinstance(value, str):
            value = scrub_text(without_query(value) if key in URL_ATTRIBUTES else value)
        out[key] = value
    return out


def scrub_span(span: ReadableSpan) -> ReadableSpan:
    status = span.status
    return ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=scrub_attributes(span.attributes),
        # Recorded exceptions: a constraint error's message can name the row's values.
        events=[Event(e.name, scrub_attributes(e.attributes), e.timestamp) for e in span.events],
        links=span.links,
        kind=span.kind,
        status=Status(status.status_code, scrub_text(status.description))
        if status.description
        else status,
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
    )


class ScrubbingSpanProcessor(SpanProcessor):
    """Hands `inner` (the exporting processor) a scrubbed copy of each ended span.

    The SDK makes a span's attributes immutable before any processor sees it ending, so the span
    itself cannot be edited without its private fields; a copy built with ReadableSpan's
    constructor uses only what an exporter reads.
    """

    def __init__(self, inner: SpanProcessor) -> None:
        self.inner = inner

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        self.inner.on_start(span, parent_context)

    def on_end(self, span: ReadableSpan) -> None:
        self.inner.on_end(scrub_span(span))

    def shutdown(self) -> None:
        self.inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self.inner.force_flush(timeout_millis)


class ScrubbingLogProcessor(LogRecordProcessor):
    """Scrubs each log record's body and attributes (an exception's message and stack trace) before
    `inner` exports it."""

    def __init__(self, inner: LogRecordProcessor) -> None:
        self.inner = inner

    def on_emit(self, log_record: ReadWriteLogRecord) -> None:
        record = log_record.log_record
        if isinstance(record.body, str):
            record.body = scrub_text(record.body)
        attributes: Attributes = record.attributes
        if attributes:
            record.attributes = scrub_attributes(attributes)
        self.inner.on_emit(log_record)

    def shutdown(self) -> None:
        self.inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self.inner.force_flush(timeout_millis)
