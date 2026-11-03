"""An ingest run joins the trace of the agents worker's ingest-source job, and its leads keep the
span that stored them (D137)."""

from pathlib import Path

import psycopg
from conftest import Database, Newsroom, anr_test_url, rows
from fastapi.testclient import TestClient
from opentelemetry.instrumentation import dbapi
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, format_span_id, format_trace_id

from anr_ingestion.app import create_app
from anr_ingestion.db import create_pool
from anr_ingestion.net import Fetcher
from anr_ingestion.pipeline import Ingestor
from anr_ingestion.rawstore import LocalRawStore
from anr_telemetry import install, instrument_app

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
CALLER_SPAN_ID = "b7ad6b7169203331"


def test_an_ingest_run_joins_the_callers_trace(
    fetcher: Fetcher, newsroom: Newsroom, database: Database, tmp_path: Path
) -> None:
    def make() -> Ingestor:
        pool = create_pool(anr_test_url("DATABASE_URL"))
        pool.open()
        return Ingestor(pool, fetcher, LocalRawStore(tmp_path))

    spans = InMemorySpanExporter()
    telemetry = install(
        "ingestion",
        spans,
        InMemoryMetricReader(),
        InMemoryLogRecordExporter(),  # type: ignore[no-untyped-call]
        span_processor=SimpleSpanProcessor,
    )
    PsycopgInstrumentor().instrument(tracer_provider=telemetry.tracer_provider)
    app = create_app(make)
    instrument_app(app, telemetry)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/ingest",
                json={"newsroom_id": newsroom.id, "source_id": newsroom.sources["lab"]},
                headers={
                    "traceparent": f"00-{TRACE_ID}-{CALLER_SPAN_ID}-01",
                    "user-agent": "ANR-Agents/test",
                },
            )
        assert response.status_code == 200
    finally:
        FastAPIInstrumentor.uninstrument_app(app)
        PsycopgInstrumentor().uninstrument()
        # uninstrument() unwraps psycopg.connect only.
        dbapi.unwrap_connect(psycopg.Connection, "connect")
        dbapi.unwrap_connect(psycopg.AsyncConnection, "connect")
        telemetry.shutdown()

    finished = spans.get_finished_spans()
    [server] = [s for s in finished if s.kind == SpanKind.SERVER]
    assert server.context is not None and server.parent is not None
    assert format_trace_id(server.context.trace_id) == TRACE_ID
    assert format_span_id(server.parent.span_id) == CALLER_SPAN_ID
    assert not {"client.address", "user_agent.original", "http.user_agent"} & set(
        server.attributes or {}
    )
    queries = [
        s
        for s in finished
        if s.instrumentation_scope is not None
        and s.instrumentation_scope.name == "opentelemetry.instrumentation.psycopg"
    ]
    assert queries and all(
        s.context is not None and format_trace_id(s.context.trace_id) == TRACE_ID for s in queries
    )

    new_leads = response.json()["new_leads"]
    stored = rows(
        database,
        newsroom.id,
        "select traceparent from leads where newsroom_id = %s and id = any(%s::uuid[])",
        new_leads,
    )
    span_id = format_span_id(server.context.span_id)
    assert len(stored) == len(new_leads) == 2
    assert {r["traceparent"] for r in stored} == {f"00-{TRACE_ID}-{span_id}-01"}


def test_leads_stored_outside_a_trace_have_no_traceparent(
    ingestor: Ingestor, newsroom: Newsroom, database: Database
) -> None:
    report = ingestor.ingest_source(newsroom.id, newsroom.sources["lab"])
    stored = rows(
        database,
        newsroom.id,
        "select traceparent from leads where newsroom_id = %s and id = any(%s::uuid[])",
        report.new_leads,
    )
    assert stored and all(r["traceparent"] is None for r in stored)
