"""OpenTelemetry for ANR's Python services (D137), the twin of @anr/telemetry/register.

With OTEL_EXPORTER_OTLP_ENDPOINT set, `setup()` sends traces, metrics and logs over OTLP to the
collector and instruments FastAPI, httpx and psycopg. Without it (tests, dev without the telemetry
stack) it does nothing, and every span the code makes is a no-op.
"""

import atexit
import logging
import os
import socket
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from fastapi import FastAPI
from opentelemetry import _logs, metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.logging.handler import LoggingHandler
from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor, LogRecordExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter
from opentelemetry.sdk.trace.sampling import (
    ALWAYS_ON,
    Decision,
    ParentBased,
    Sampler,
    SamplingResult,
)
from opentelemetry.trace import Link, SpanKind, TraceState
from opentelemetry.util.types import Attributes

from anr_telemetry.scrub import ScrubbingLogProcessor, ScrubbingSpanProcessor, scrub_text

__all__ = [
    "Telemetry",
    "enabled",
    "install",
    "instrument_app",
    "scrub_text",
    "setup",
    "traceparent",
]

SHUTDOWN_SECONDS = 5.0


def enabled() -> bool:
    return bool(os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")) and (
        os.environ.get("OTEL_SDK_DISABLED", "").strip().lower() != "true"
    )


class _NoRootClientSpans(Sampler):
    """Drops client spans outside any trace: heartbeats and pool queries would be most of them
    (as `requireParentSpan` in the TypeScript pg instrumentation)."""

    def should_sample(
        self,
        parent_context: Context | None,
        trace_id: int,
        name: str,
        kind: SpanKind | None = None,
        attributes: Attributes = None,
        links: Sequence[Link] | None = None,
        trace_state: TraceState | None = None,
    ) -> SamplingResult:
        if kind == SpanKind.CLIENT:
            return SamplingResult(Decision.DROP)
        return ALWAYS_ON.should_sample(
            parent_context, trace_id, name, kind, attributes, links, trace_state
        )

    def get_description(self) -> str:
        return "NoRootClientSpans"


@dataclass
class Telemetry:
    tracer_provider: TracerProvider
    meter_provider: MeterProvider
    logger_provider: LoggerProvider
    handler: logging.Handler

    def shutdown(self) -> None:
        """Flushes and stops every provider, giving up after SHUTDOWN_SECONDS in all."""

        def run() -> None:
            for logger in (logging.getLogger(), logging.getLogger("uvicorn.error")):
                logger.removeHandler(self.handler)
            for provider in (self.tracer_provider, self.meter_provider, self.logger_provider):
                provider.shutdown()

        worker = threading.Thread(target=run, name="otel-shutdown", daemon=True)
        worker.start()
        worker.join(SHUTDOWN_SECONDS)


def install(
    service_name: str,
    span_exporter: SpanExporter,
    metric_reader: MetricReader,
    log_exporter: LogRecordExporter,
    *,
    span_processor: Callable[[SpanExporter], SpanProcessor] = BatchSpanProcessor,
) -> Telemetry:
    """Providers wired to the given exporters. Sets nothing global; tests use it directly."""
    name = os.environ.get("OTEL_SERVICE_NAME") or service_name
    resource = Resource.create(
        {
            # The detector merges OTEL_RESOURCE_ATTRIBUTES (service.version, the environment).
            "service.name": name,
            "service.namespace": "anr",
            # One instance per service on one host: a redeploy keeps the same series (D158).
            "service.instance.id": name,
            "host.name": socket.gethostname(),
        }
    )
    tracer_provider = TracerProvider(
        resource=resource, sampler=ParentBased(root=_NoRootClientSpans()), shutdown_on_exit=False
    )
    tracer_provider.add_span_processor(ScrubbingSpanProcessor(span_processor(span_exporter)))
    meter_provider = MeterProvider(
        metric_readers=[metric_reader], resource=resource, shutdown_on_exit=False
    )
    logger_provider = LoggerProvider(resource=resource, shutdown_on_exit=False)
    logger_provider.add_log_record_processor(
        ScrubbingLogProcessor(BatchLogRecordProcessor(log_exporter))
    )
    handler = LoggingHandler(logger_provider=logger_provider)
    # The SDK's own warnings (an export that failed) stay on stderr: through this handler they
    # would become log records that fail to export in turn.
    handler.addFilter(lambda record: not record.name.startswith("opentelemetry"))
    return Telemetry(tracer_provider, meter_provider, logger_provider, handler)


def instrument_app(app: FastAPI, telemetry: Telemetry) -> None:
    FastAPIInstrumentor.instrument_app(
        app,
        # Compose health checks would be most of the traces.
        excluded_urls="/healthz",
        tracer_provider=telemetry.tracer_provider,
        meter_provider=telemetry.meter_provider,
    )


_installed: Telemetry | None = None


def setup(service_name: str, app: FastAPI | None = None) -> bool:
    """Starts telemetry for this process (once) and instruments `app`; False when disabled."""
    global _installed
    if not enabled():
        return False
    if _installed is None:
        from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        interval = float(os.environ.get("OTEL_METRIC_EXPORT_INTERVAL") or 60_000)
        _installed = install(
            service_name,
            OTLPSpanExporter(),
            PeriodicExportingMetricReader(OTLPMetricExporter(), export_interval_millis=interval),
            OTLPLogExporter(),
        )
        trace.set_tracer_provider(_installed.tracer_provider)
        metrics.set_meter_provider(_installed.meter_provider)
        _logs.set_logger_provider(_installed.logger_provider)
        # Root for the app's loggers; uvicorn's error log (tracebacks) does not propagate to it.
        for logger in (logging.getLogger(), logging.getLogger("uvicorn.error")):
            logger.addHandler(_installed.handler)
        HTTPXClientInstrumentor().instrument(
            tracer_provider=_installed.tracer_provider, meter_provider=_installed.meter_provider
        )
        # Statements with their placeholders only: no parameters, no SQL comments.
        PsycopgInstrumentor().instrument(
            tracer_provider=_installed.tracer_provider,
            meter_provider=_installed.meter_provider,
            enable_commenter=False,
            capture_parameters=False,
        )
        atexit.register(_installed.shutdown)
    if app is not None:
        instrument_app(app, _installed)
    return True


def traceparent() -> str | None:
    """The current span's W3C traceparent (`00-<trace id>-<span id>-<flags>`), None outside one."""
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    return carrier.get("traceparent")
