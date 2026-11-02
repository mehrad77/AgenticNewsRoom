"""anr_telemetry, shared with ingestion: the same cases as packages/telemetry/src/scrub.test.ts."""

import logging

import pytest
from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, Status, StatusCode

import anr_telemetry
from anr_telemetry import install, scrub_text, setup


def test_scrub_text_drops_tokens_queries_emails_and_ips() -> None:
    assert (
        scrub_text('"Cf-Access-Jwt-Assertion":["eyJhbGciOi.eyJlbWFpbCI6.c2lnbmF0dXJl"]')
        == '"Cf-Access-Jwt-Assertion":["<jwt>"]'
    )
    assert (
        scrub_text("https://api.telegram.org/bot123456:AAH-x_9kLmNoPqRsTuVwXyZ012/sendMessage")
        == "https://api.telegram.org/bot<token>/sendMessage"
    )
    assert scrub_text("GET /challenge/0b0c?k=s3cret&x=1 200") == "GET /challenge/0b0c 200"
    assert (
        scrub_text("https://ai.example.org/search?q=war took 12ms")
        == "https://ai.example.org/search took 12ms"
    )
    assert (
        scrub_text("Key (email)=(ed.itor+desk@news.example.org) already exists")
        == "Key (email)=(<email>) already exists"
    )
    assert (
        scrub_text("from 203.0.113.7 and 2001:db8:85a3::8a2e:370:7334 and ::1")
        == "from <ip> and <ip> and <ip>"
    )
    assert (
        scrub_text("2026-11-02T14:02:06Z run a1b2 took 3.2s")
        == "2026-11-02T14:02:06Z run a1b2 took 3.2s"
    )


def test_spans_and_logs_are_scrubbed_before_export() -> None:
    spans = InMemorySpanExporter()
    logs = InMemoryLogRecordExporter()  # type: ignore[no-untyped-call]
    telemetry = install(
        "test", spans, InMemoryMetricReader(), logs, span_processor=SimpleSpanProcessor
    )
    tracer = telemetry.tracer_provider.get_tracer("test")
    span = tracer.start_span(
        "GET /newsroom",
        kind=SpanKind.SERVER,
        attributes={
            "client.address": "203.0.113.7",
            "net.peer.ip": "203.0.113.7",
            "user_agent.original": "Mozilla/5.0",
            "http.user_agent": "Mozilla/5.0",
            "http.request.header.cf-connecting-ip": "203.0.113.7",
            "url.full": "https://ai.example.org/challenge/1?k=token",
            "url.query": "k=token",
            "http.target": "/challenge/1?k=token",
            "http.route": "/newsroom",
        },
    )
    span.record_exception(ValueError("duplicate key: (email)=(a@b.org)"))
    span.set_status(Status(StatusCode.ERROR, "for a@b.org"))
    span.end()

    [exported] = spans.get_finished_spans()
    assert dict(exported.attributes or {}) == {
        "url.full": "https://ai.example.org/challenge/1",
        "http.target": "/challenge/1",
        "http.route": "/newsroom",
    }
    assert (exported.events[0].attributes or {})["exception.message"] == (
        "duplicate key: (email)=(<email>)"
    )
    assert exported.status.description == "for <email>"

    logger = logging.getLogger("anr_telemetry_test")
    logger.addHandler(telemetry.handler)
    try:
        with trace.use_span(tracer.start_span("job"), end_on_exit=True) as job:
            logger.warning("fetch https://example.org/a?token=x from 203.0.113.7 failed")
        telemetry.logger_provider.force_flush()
    finally:
        logger.removeHandler(telemetry.handler)
    [record] = [r.log_record for r in logs.get_finished_logs()]
    assert record.body == "fetch https://example.org/a from <ip> failed"
    assert record.trace_id == job.get_span_context().trace_id
    telemetry.shutdown()


def test_setup_does_nothing_without_an_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    assert setup("verifier", FastAPI()) is False
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    assert setup("verifier", FastAPI()) is False
    assert anr_telemetry._installed is None
    assert anr_telemetry.traceparent() is None
