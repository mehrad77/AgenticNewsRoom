"""Internal HTTP API. Only TypeScript pg-boss jobs (and, from milestone 3, the agents' request
tool) call it; it is never exposed publicly.

Errors map onto statuses the caller can act on: 404 unknown ids, 422 never fetched (no terms,
private address, robots.txt) or not an image, 429 the run's request cap, 502 the source failed
(retry later).
"""

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request

from anr_ingestion.db import create_pool
from anr_ingestion.heartbeat import start_heartbeat
from anr_ingestion.net import Fetcher, FetchError, GuardedTransport, Refused
from anr_ingestion.pipeline import HOST_DELAYS, CapReached, Ingestor, NotFound
from anr_ingestion.replay import ReplayWeb
from anr_ingestion.settings import Settings
from anr_schemas.config.ingest_result import Error, IngestResult
from anr_schemas.config.ingest_run import IngestRun
from anr_schemas.config.media_request import MediaRequest
from anr_schemas.config.media_request_result import MediaRequestResult
from anr_schemas.config.source_request import SourceRequest
from anr_schemas.config.source_request_result import SourceRequestResult


def ingestor_from_env() -> Ingestor:
    settings = Settings.from_env()
    pool = create_pool(settings.database_url)
    pool.open()
    if settings.replay is not None:
        # Recorded fixtures: nothing leaves the machine, so no politeness delays either.
        fetcher = Fetcher(
            ReplayWeb.load(settings.replay).transport(),
            user_agent=settings.user_agent,
            min_delay=0.0,
        )
    else:
        fetcher = Fetcher(
            GuardedTransport(), user_agent=settings.user_agent, host_delays=HOST_DELAYS
        )
    return Ingestor(pool, fetcher, settings.raw_store())


def create_app(make_ingestor: Callable[[], Ingestor] | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        ingestor = (make_ingestor or ingestor_from_env)()
        app.state.ingestor = ingestor
        # Only the service's own run beats (D128); tests bring their own ingestor.
        own = make_ingestor is None
        stop_heartbeat = start_heartbeat(ingestor.pool, "ingestion") if own else None
        try:
            yield
        finally:
            if stop_heartbeat:
                stop_heartbeat()
            ingestor.fetcher.close()
            ingestor.pool.close()

    app = FastAPI(title="ANR ingestion", docs_url=None, redoc_url=None, lifespan=lifespan)

    def ingestor(request: Request) -> Ingestor:
        value: Ingestor = request.app.state.ingestor
        return value

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "ingestion"}

    # Plain `def` handlers: FastAPI runs them in its thread pool, so blocking fetches and
    # database calls never stall the event loop.
    @app.post("/ingest")
    def ingest(body: IngestRun, request: Request) -> IngestResult:
        try:
            report = ingestor(request).ingest_source(str(body.newsroom_id), str(body.source_id))
        except NotFound as error:
            raise HTTPException(404, str(error)) from error
        except Refused as error:
            raise HTTPException(422, str(error)) from error
        except FetchError as error:
            raise HTTPException(502, str(error)) from error
        return IngestResult.model_validate(
            {
                "source_id": report.source_id,
                "not_modified": report.not_modified,
                "new_leads": report.new_leads,
                "sightings": report.sightings,
                "known": report.known,
                "dropped": report.dropped,
                "retiered": report.retiered,
                "errors": [Error(url=u, error=e) for u, e in report.errors],
            }
        )

    @app.post("/request-source")
    def request_source(body: SourceRequest, request: Request) -> SourceRequestResult:
        try:
            lead, created = ingestor(request).request_source(
                str(body.newsroom_id), str(body.agent_run_id), str(body.url)
            )
        except NotFound as error:
            raise HTTPException(404, str(error)) from error
        except CapReached as error:
            raise HTTPException(429, str(error)) from error
        except Refused as error:
            raise HTTPException(422, str(error)) from error
        except FetchError as error:
            raise HTTPException(502, str(error)) from error
        return SourceRequestResult.model_validate(
            {
                "lead_id": lead["id"],
                "uri": lead["uri"],
                "headline": lead["headline"],
                "tier": lead["tier"],
                "created": created,
            }
        )

    @app.post("/media")
    def media(body: MediaRequest, request: Request) -> MediaRequestResult:
        try:
            media_id, created, licence = ingestor(request).add_media(
                str(body.newsroom_id),
                str(body.url),
                str(body.source_url) if body.source_url is not None else None,
                str(body.lead_id) if body.lead_id is not None else None,
                str(body.added_by),
            )
        except NotFound as error:
            raise HTTPException(404, str(error)) from error
        except Refused as error:
            raise HTTPException(422, str(error)) from error
        except FetchError as error:
            raise HTTPException(502, str(error)) from error
        return MediaRequestResult.model_validate(
            {"media_id": media_id, "created": created, "licence": licence}
        )

    return app


app = create_app()
